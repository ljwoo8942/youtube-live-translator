import { loadSettings, loadSettingsSnapshot, patchSettings, toContentSettings } from "../shared/storage";
import type { CaptionSegment, PageCaptionSnapshot, PageCaptionTrack, TranslatorSettings } from "../shared/types";
import type { CaptionTranslationEntry, MessageResponse, RuntimeMessage } from "../shared/messages";
import { getErrorMessage } from "../shared/messages";
import { TRANSLATION_PROMPT_VERSION } from "../shared/translationVersion";
import { assertTranscriptionReady, assertTranslationReady, transcribeAudio, translateSegment, translateSegments } from "./providers";
import {
  createCaptionCacheContext,
  getCachedCaptionTranslations,
  putCachedCaptionTranslations,
  type CaptionCacheContext
} from "./captionCache";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const AUDIO_FAILURE_COOLDOWN_MS = 12_000;
const AUDIO_NO_SPEECH_NOTICE_MS = 8_000;
const MIN_STABLE_AUDIO_CHUNK_MS = 8_000;
const AUDIO_MIN_PROCESS_INTERVAL_MS = 1_000;
const PRETRANSLATE_BATCH_SIZE = 8;
const LM_STUDIO_PRETRANSLATE_BATCH_SIZE = 1;
const HOT_PRETRANSLATE_BATCH_SIZE = 1;
const LM_STUDIO_HOT_PRETRANSLATE_BATCH_SIZE = 1;
const HOT_PRETRANSLATE_FUTURE_WINDOW_MS = 75_000;
const HOT_PRETRANSLATE_PAST_WINDOW_MS = 2_500;
const PRETRANSLATE_PRIORITY_PAST_WINDOW_MS = 10_000;
const PRETRANSLATE_PRIORITY_FUTURE_WINDOW_MS = 180_000;
const PRETRANSLATE_RECENT_PAST_WINDOW_MS = 60_000;
const CAPTION_CONTEXT_SEGMENT_COUNT = 2;
const DUPLICATE_FINAL_TRANSCRIPT_WINDOW_MS = 6_000;
const TRANSLATION_MEMORY_CACHE_LIMIT = 300;
const STREAM_PARTIAL_TRANSLATION_MIN_INTERVAL_MS = 1_250;
const STREAM_PARTIAL_TRANSLATION_MIN_CHARACTERS = 5;

let creatingOffscreen: Promise<void> | undefined;
let activeAudioTabId: number | undefined;
let lastBroadcastSettingsRevision = -1;
let startingAudioCapture: { tabId: number; promise: Promise<MessageResponse<{ tabId: number; mode?: string }>> } | undefined;
const translationCache = new Map<string, string>();
const translationInFlight = new Map<string, Promise<MessageResponse<{ translatedText: string; provider: string }>>>();
const audioQueues = new Map<number, { processing: boolean; pending?: Extract<RuntimeMessage, { type: "AUDIO_CHUNK" }> }>();
const audioFailureCooldowns = new Map<number, { until: number; error: string }>();
const audioNoSpeechNotices = new Map<number, number>();
const audioLastProcessedAt = new Map<number, number>();
const lastFinalTranscriptByTab = new Map<number, { text: string; at: number }>();
const lastPartialTranslationByTab = new Map<number, { text: string; at: number }>();
const streamTranslationGenerationByTab = new Map<number, number>();
const audioContextByTab = new Map<number, string[]>();

void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch((error) => {
  console.debug("Could not restrict local storage to trusted extension contexts", error);
});
type PretranslateJob = {
  cancelled: boolean;
  currentTimeMs: number;
};

const pretranslateJobs = new Map<string, PretranslateJob>();
const PROBABLE_AUDIO_HALLUCINATION_KEYS = new Set([
  "you",
  "youyou",
  "youyouyou",
  "youyouyouyou",
  "thankyou",
  "thanks",
  "thankyouforwatching",
  "thanksforwatching",
  "pleasesubscribe",
  "subscribe",
  "dontforgettosubscribe",
  "dontforgettolikeandsubscribe",
  "dontforgettolikecommentandsubscribe",
  "likeandsubscribe",
  "likecommentandsubscribe",
  "hitthesubscribebutton",
  "subscribetomychannel",
  "remembertosubscribe",
  "구독",
  "구독잊지마세요",
  "구독잊지마십시오",
  "구독부탁드립니다",
  "좋아요구독",
  "좋아요와구독",
  "좋아요와구독부탁드립니다",
  "시청감사합니다",
  "시청해주셔서감사합니다",
  "시청해줘서감사합니다",
  "시청해줘서고마워요",
  "끝까지봐주셔서감사합니다",
  "ご視聴ありがとうございました",
  "ご視聴ありがとうございます",
  "ご清聴ありがとうございました",
  "チャンネル登録",
  "チャンネル登録お願いします",
  "高評価とチャンネル登録",
  "字幕by",
  "字幕提供",
  "字幕視聴",
  "字幕をご覧いただきありがとうございます",
  "中文字幕",
  "中文字幕中文字幕",
  "中文字幕中文字幕中文字幕",
  "字幕组",
  "字幕組",
  "字幕翻译",
  "字幕翻譯",
  "字幕制作",
  "字幕製作",
  "请不吝点赞订阅转发打赏支持明镜与点点栏目"
]);
const PROBABLE_AUDIO_PROMPT_LEAK_PARTS = [
  "transcribesungvocals",
  "transcribethemasheard",
  "donotforcetheminto",
  "standardenglishspelling",
  "preserveeachheardphrase",
  "pronunciationadaptedenglish",
  "katakanaenglish",
  "waseieigo",
  "japanglish",
  "donottranslate",
  "ignoreinstruments",
  "livestreamspeech",
  "ignoremusicgamesounds",
  "backgroundnoise",
  "그대로듣고녹음",
  "그대로받아쓰",
  "표준영어",
  "표준영어철자",
  "표준영어스펠",
  "강제하지마",
  "강제로하지마",
  "번역하지마",
  "번역하지마세요",
  "들리는보컬",
  "각언어그대로",
  "カタカナ英語",
  "和製英語",
  "ジャパングリッシュ",
  "標準英語",
  "翻訳しない",
  "聞こえた歌声",
  "请按听到的原语言",
  "不要翻译"
];
const PROBABLE_AUDIO_CREDIT_PARTS = [
  "transcribedby",
  "translatedby",
  "captionedby",
  "captioningby",
  "captionsby",
  "subtitledby",
  "subtitlesby",
  "subtitleby",
  "subtitlesprovidedby",
  "subtitlescreatedby",
  "subtitleseditedby",
  "createdby",
  "텍스트기록",
  "자막제작",
  "자막번역",
  "번역완료",
  "문자기록",
  "文字起こし",
  "字幕作成",
  "翻訳",
  "转录",
  "中文字幕",
  "字幕组",
  "字幕組",
  "字幕翻译",
  "字幕翻譯",
  "字幕制作",
  "字幕製作",
  "翻译"
];
const PROBABLE_NON_SPEECH_CUE_KEYS = new Set([
  "music",
  "backgroundmusic",
  "applause",
  "clapping",
  "laughter",
  "laughs",
  "silence",
  "silent",
  "noise",
  "backgroundnoise",
  "inaudible",
  "unintelligible",
  "foreign",
  "foreignlanguage",
  "speakingforeignlanguage",
  "음악",
  "배경음악",
  "박수",
  "웃음",
  "무음",
  "침묵",
  "소음",
  "잡음",
  "들리지않음",
  "청취불가",
  "音楽",
  "拍手",
  "笑い",
  "無音",
  "雑音",
  "聞き取れない",
  "音乐",
  "掌声",
  "静音",
  "噪音",
  "听不清"
]);
const PROBABLE_API_META_TEXT_PARTS = [
  "asanailanguagemodel",
  "asanai",
  "icannottranscribe",
  "icanttranscribe",
  "unabletotranscribe",
  "notranscriptionavailable",
  "notranscriptavailable",
  "nospeechdetected",
  "couldnotdetectspeech",
  "noaudible",
  "thereisnoaudio",
  "theaudioisempty",
  "theaudioissilent",
  "theprovidedaudio",
  "thetranscriptionis",
  "thecaptionis",
  "thesubtitleis",
  "thelyricsare",
  "captionis",
  "subtitleis",
  "음성을인식할수",
  "전사할수",
  "받아쓸수",
  "말소리가감지되지",
  "자막입니다",
  "번역문입니다",
  "文字起こし",
  "転写",
  "字幕です",
  "音声がありません",
  "语音识别",
  "转写",
  "字幕为"
];
const TRANSLATION_REFUSAL_KEYS = new Set([
  "번역할수없습니다",
  "죄송하지만번역할수없습니다",
  "원문이없습니다",
  "내용을제공해주세요",
  "죄송하지만도와드릴수없습니다",
  "icannottranslate",
  "icanttranslate",
  "icannot",
  "icant",
  "notranslationavailable",
  "pleaseprovidethetext",
  "unabletotranslate",
  "asanai",
  "asanailanguagemodel"
]);
const BLOCKED_HALLUCINATION_ERROR = "환각 의심 번역 결과를 차단했습니다.";

type OffscreenAudioState = {
  activeTabId?: number;
  recording?: boolean;
  mode?: string;
};
type ChromeTabLookup = {
  get?: (tabId: number, callback: (tab: { url?: string }) => void) => void;
};
type ChromeScriptingApi = {
  executeScript<T = unknown>(details: {
    target: { tabId: number };
    files?: string[];
    func?: (...args: any[]) => T;
    args?: unknown[];
    world?: "ISOLATED" | "MAIN";
  }): Promise<Array<{ result?: T }>>;
};

function normalizePageCaptionTrack(value: unknown, requireBaseUrl = true): Partial<PageCaptionTrack> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const baseUrl = typeof source.baseUrl === "string" && source.baseUrl.trim() ? source.baseUrl : undefined;
  if (requireBaseUrl && !baseUrl) {
    return undefined;
  }
  const languageCode = typeof source.languageCode === "string" && source.languageCode.trim() ? source.languageCode : undefined;
  const kind = typeof source.kind === "string" && source.kind.trim() ? source.kind : undefined;
  const vssId = typeof source.vssId === "string" && source.vssId.trim() ? source.vssId : undefined;
  return { ...(baseUrl ? { baseUrl } : {}), ...(languageCode ? { languageCode } : {}), ...(kind ? { kind } : {}), ...(vssId ? { vssId } : {}) };
}

function normalizePageCaptionSnapshot(value: unknown, expectedVideoId: string): PageCaptionSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  if (source.videoId !== expectedVideoId || !Array.isArray(source.tracks)) {
    return undefined;
  }
  const tracks = source.tracks
    .map((track) => normalizePageCaptionTrack(track))
    .filter((track): track is PageCaptionTrack => Boolean(track?.baseUrl));
  const selectedTrack = normalizePageCaptionTrack(source.selectedTrack, false);
  return {
    videoId: expectedVideoId,
    tracks,
    ...(selectedTrack ? { selectedTrack } : {}),
    autoTranslationActive: Boolean(source.autoTranslationActive)
  };
}

async function readPageCaptionSnapshot(tabId: number, videoId: string): Promise<MessageResponse<{ snapshot?: PageCaptionSnapshot }>> {
  const scripting = (chrome as typeof chrome & { scripting?: ChromeScriptingApi }).scripting;
  if (!scripting) {
    return { ok: true };
  }

  try {
    const executions = await scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [videoId],
      func: (expectedVideoId: string) => {
        const readString = (value: unknown, key: string): string | undefined => {
          if (!value || typeof value !== "object") return undefined;
          const field = (value as Record<string, unknown>)[key];
          return typeof field === "string" && field.trim() ? field : undefined;
        };
        const normalizeTrack = (value: unknown, requireBaseUrl = true) => {
          const baseUrl = readString(value, "baseUrl");
          if (requireBaseUrl && !baseUrl) return undefined;
          const languageCode = readString(value, "languageCode");
          const kind = readString(value, "kind");
          const vssId = readString(value, "vssId");
          return {
            ...(baseUrl ? { baseUrl } : {}),
            ...(languageCode ? { languageCode } : {}),
            ...(kind ? { kind } : {}),
            ...(vssId ? { vssId } : {})
          };
        };
        type PlayerElement = HTMLElement & {
          getPlayerResponse?: () => unknown;
          getOption?: (module: string, option: string) => unknown;
          getVideoData?: () => unknown;
        };
        const url = new URL(location.href);
        const urlVideoId = url.searchParams.get("v") ?? location.pathname.match(/\/shorts\/([^/?]+)/)?.[1];
        if (urlVideoId !== expectedVideoId) return null;

        const players = [...document.querySelectorAll<PlayerElement>("#movie_player, .html5-video-player")];
        let player: PlayerElement | undefined;
        let playerResponse: unknown;
        for (const candidate of players) {
          try {
            const candidateResponse = candidate.getPlayerResponse?.();
            const candidateVideoId = readString((candidateResponse as Record<string, unknown> | undefined)?.videoDetails, "videoId");
            const candidateDataVideoId = readString(candidate.getVideoData?.(), "video_id");
            if (candidateVideoId === expectedVideoId || candidateDataVideoId === expectedVideoId) {
              player = candidate;
              playerResponse = candidateResponse;
              break;
            }
          } catch {
            continue;
          }
        }

        const globalPlayerResponse = (window as Window & { ytInitialPlayerResponse?: unknown }).ytInitialPlayerResponse;
        const globalVideoId = readString((globalPlayerResponse as Record<string, unknown> | undefined)?.videoDetails, "videoId");
        if ((!playerResponse || typeof playerResponse !== "object") && globalVideoId === expectedVideoId) {
          playerResponse = globalPlayerResponse;
        }
        if (!player) {
          player = players.find((candidate) => {
            try {
              return readString(candidate.getVideoData?.(), "video_id") === expectedVideoId;
            } catch {
              return false;
            }
          });
        }
        if (!player && (!playerResponse || typeof playerResponse !== "object")) return null;

        const captions = (playerResponse as Record<string, unknown> | undefined)?.captions as Record<string, unknown> | undefined;
        const renderer = captions?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
        let rawTracks = Array.isArray(renderer?.captionTracks) ? renderer.captionTracks : undefined;
        if (!rawTracks) {
          try {
            const optionTracks = player?.getOption?.("captions", "tracklist");
            rawTracks = Array.isArray(optionTracks) ? optionTracks : [];
          } catch {
            rawTracks = [];
          }
        }

        let selectedTrack: unknown;
        let translationLanguage: unknown;
        try {
          selectedTrack = player?.getOption?.("captions", "track");
          translationLanguage = player?.getOption?.("captions", "translationLanguage");
        } catch {
          selectedTrack = undefined;
          translationLanguage = undefined;
        }
        const selectedBaseUrl = readString(selectedTrack, "baseUrl") ?? "";
        const translationLanguageSet =
          (typeof translationLanguage === "string" && translationLanguage.trim().length > 0) ||
          Boolean(readString(translationLanguage, "languageCode") || readString(translationLanguage, "languageName"));

        return {
          videoId: expectedVideoId,
          tracks: rawTracks.map((track) => normalizeTrack(track)).filter(Boolean),
          selectedTrack: normalizeTrack(selectedTrack, false),
          autoTranslationActive: translationLanguageSet || /[?&](?:tlang|translate)=/i.test(selectedBaseUrl)
        };
      }
    });
    const snapshot = normalizePageCaptionSnapshot(executions[0]?.result, videoId);
    return snapshot ? { ok: true, snapshot } : { ok: true };
  } catch (error) {
    console.debug("MAIN world caption snapshot unavailable", error);
    return { ok: true };
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });

  if (existingContexts.length > 0) {
    return;
  }

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["USER_MEDIA"],
      justification: "Capture YouTube tab audio for speech-to-text when captions are unavailable."
    });
  }

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = undefined;
  }
}

async function hasOffscreenDocument(): Promise<boolean> {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });

  return existingContexts.length > 0;
}

async function getOffscreenAudioState(): Promise<OffscreenAudioState | undefined> {
  if (!(await hasOffscreenDocument())) {
    return undefined;
  }

  try {
    const response = await chrome.runtime.sendMessage<MessageResponse<OffscreenAudioState>>({
      type: "GET_OFFSCREEN_AUDIO_STATE"
    });
    return response?.ok ? response : undefined;
  } catch {
    return undefined;
  }
}

function isSupportedYouTubeUrl(url?: string): boolean {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ["www.youtube.com", "m.youtube.com"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function isContentScriptReady(tabId: number): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage<MessageResponse>(tabId, {
      type: "GET_TAB_STATUS"
    });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

function getTabUrl(tabId: number): Promise<string | undefined> {
  const tabs = chrome.tabs as typeof chrome.tabs & ChromeTabLookup;
  if (!tabs.get) {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    tabs.get?.(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve(undefined);
        return;
      }
      resolve(tab.url);
    });
  });
}

async function ensureContentScript(tabId: number): Promise<boolean> {
  if (await isContentScriptReady(tabId)) {
    return true;
  }

  const tabUrl = await getTabUrl(tabId);
  if (tabUrl && !isSupportedYouTubeUrl(tabUrl)) {
    return false;
  }

  try {
    const scripting = (chrome as typeof chrome & { scripting?: ChromeScriptingApi }).scripting;
    if (!scripting) {
      return false;
    }
    await scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch (error) {
    console.debug("Content script injection failed", error);
    return false;
  }

  return isContentScriptReady(tabId);
}

async function ownsLiveAudioCapture(tabId: number): Promise<boolean> {
  const state = await getOffscreenAudioState();
  return Boolean(state?.recording && state.activeTabId === tabId);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function speechKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function isProbableAudioHallucination(text: string): boolean {
  const key = speechKey(text);
  if (!key) {
    return false;
  }
  if (PROBABLE_AUDIO_HALLUCINATION_KEYS.has(key)) {
    return true;
  }
  if (key.includes("中文字幕") || key.includes("字幕组") || key.includes("字幕組")) {
    return true;
  }
  if (PROBABLE_AUDIO_PROMPT_LEAK_PARTS.some((part) => key.includes(part))) {
    return true;
  }
  if (isProbableCreditHallucination(key)) {
    return true;
  }
  if (
    key.includes("subscribe") &&
    ["dontforget", "please", "like", "channel", "button", "remember"].some((token) => key.includes(token))
  ) {
    return true;
  }
  if (
    key.includes("구독") &&
    ["잊지마세요", "잊지마십시오", "부탁", "눌러", "해주세요", "좋아요", "알림"].some((token) => key.includes(token))
  ) {
    return true;
  }
  if (key.includes("チャンネル登録") && ["お願い", "高評価", "よろしく"].some((token) => key.includes(token))) {
    return true;
  }
  if (key.includes("시청") && key.includes("감사")) {
    return true;
  }
  return false;
}

function isBracketedNonSpeechCue(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const withoutBrackets = trimmed.replace(/^[\s[({（【「『]+|[\s\])}）】」』.。!！]+$/g, "");
  const key = speechKey(withoutBrackets);
  return key.length > 0 && key.length <= 28 && PROBABLE_NON_SPEECH_CUE_KEYS.has(key);
}

function isProbableApiMetaHallucination(text: string): boolean {
  const key = speechKey(text);
  if (!key) {
    return false;
  }
  if (isBracketedNonSpeechCue(text)) {
    return true;
  }
  if (key.length <= 28 && PROBABLE_NON_SPEECH_CUE_KEYS.has(key)) {
    return true;
  }
  if (PROBABLE_API_META_TEXT_PARTS.some((part) => key.includes(part))) {
    return true;
  }
  if ((key.includes("subtitles") || key.includes("captions")) && ["by", "provided", "created", "translated"].some((token) => key.includes(token))) {
    return true;
  }
  if ((key.includes("자막") || key.includes("字幕")) && ["제공", "제작", "번역", "作成", "翻訳", "制作", "提供"].some((token) => key.includes(token))) {
    return true;
  }
  return false;
}

function isProbableGeneratedBoilerplate(text: string): boolean {
  return isProbableAudioHallucination(text) || isProbableApiMetaHallucination(text);
}

function isProbableCreditHallucination(key: string): boolean {
  if (
    PROBABLE_AUDIO_CREDIT_PARTS.some((part) => key.includes(part)) &&
    ["by", "의해", "완료", "제작", "기록", "번역", "による", "作成", "翻訳", "制作"].some((token) => key.includes(token))
  ) {
    return true;
  }
  if ((key.includes("transcribed") || key.includes("translated")) && key.includes("by")) {
    return true;
  }
  if (key.includes("텍스트기록") && (key.includes("의해") || key.includes("완료"))) {
    return true;
  }
  if (key.includes("번역") && key.includes("의해") && (key.includes("완료") || key.includes("기록"))) {
    return true;
  }
  return false;
}

function isProbableCtaHallucination(text: string): boolean {
  const key = speechKey(text);
  if (!key) {
    return false;
  }
  if (PROBABLE_AUDIO_HALLUCINATION_KEYS.has(key)) {
    return true;
  }
  if (
    key.includes("subscribe") &&
    ["dontforget", "please", "like", "channel", "button", "remember", "comment"].some((token) => key.includes(token))
  ) {
    return true;
  }
  if (
    key.includes("구독") &&
    ["잊지", "부탁", "눌러", "해주세요", "좋아요", "알림", "댓글"].some((token) => key.includes(token))
  ) {
    return true;
  }
  if (key.includes("チャンネル登録") && ["お願い", "高評価", "よろしく"].some((token) => key.includes(token))) {
    return true;
  }
  return key.includes("시청") && key.includes("감사");
}

function hasExcessiveTextRepetition(text: string): boolean {
  const normalized = normalizeText(text);
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length >= 3 && new Set(tokens).size === 1) {
    return true;
  }
  if (tokens.length >= 4) {
    const counts = new Map<string, number>();
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    if (Math.max(...counts.values()) / tokens.length >= 0.75) {
      return true;
    }
  }
  const key = speechKey(text);
  for (let unitLength = 2; unitLength <= Math.floor(key.length / 2); unitLength += 1) {
    if (key.length % unitLength === 0) {
      const unit = key.slice(0, unitLength);
      if (unit.length >= 2 && unit.repeat(key.length / unitLength) === key) {
        return true;
      }
    }
  }
  return key.length >= 8 && new Set([...key]).size <= 2;
}

function isIntentionalLyricRefrain(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized || isProbableGeneratedBoilerplate(normalized) || isProbableCtaHallucination(normalized)) {
    return false;
  }

  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length >= 2 && tokens.length <= 4 && new Set(tokens).size === 1) {
    const token = tokens[0];
    return token !== undefined && [...token].length <= 12;
  }

  const key = speechKey(normalized);
  for (let unitLength = 1; unitLength <= Math.min(8, Math.floor(key.length / 2)); unitLength += 1) {
    if (key.length % unitLength !== 0) {
      continue;
    }
    const repeats = key.length / unitLength;
    const unit = key.slice(0, unitLength);
    if (repeats >= 2 && repeats <= 4 && unit.length > 0 && unit.repeat(repeats) === key) {
      return true;
    }
  }
  return false;
}

function isModelRefusalOrMetaText(text: string): boolean {
  const key = speechKey(text);
  if (!key) {
    return true;
  }
  if (TRANSLATION_REFUSAL_KEYS.has(key)) {
    return true;
  }
  return /^(번역|자막|translation|subtitle)\s*[:：-]?\s*$/i.test(text.trim());
}

function sanitizeAudioTranscript(text: string, preserveLyricRefrain = false): string {
  const normalized = normalizeSubtitleLines(text);
  const hasAllowedLyricRefrain = preserveLyricRefrain && isIntentionalLyricRefrain(normalized);
  if (
    !normalized ||
    isProbableGeneratedBoilerplate(normalized) ||
    (hasExcessiveTextRepetition(normalized) && !hasAllowedLyricRefrain) ||
    isModelRefusalOrMetaText(normalized)
  ) {
    return "";
  }
  return normalized;
}

function normalizeSubtitleLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function sanitizeTranslatedSubtitle(segment: CaptionSegment, translatedText: string, contentMode: string): string {
  const normalized = normalizeSubtitleLines(translatedText);
  const hasAllowedLyricRefrain =
    contentMode === "lyrics" && isIntentionalLyricRefrain(segment.text) && isIntentionalLyricRefrain(normalized);
  if (!normalized || isModelRefusalOrMetaText(normalized) || (hasExcessiveTextRepetition(normalized) && !hasAllowedLyricRefrain)) {
    return "";
  }

  const sourceHasBoilerplate = isProbableGeneratedBoilerplate(segment.text);
  if (isProbableGeneratedBoilerplate(normalized) && !sourceHasBoilerplate) {
    return "";
  }

  const sourceHasCta = isProbableCtaHallucination(segment.text);
  if (isProbableCtaHallucination(normalized) && !sourceHasCta) {
    return "";
  }
  if (segment.source === "audioStt" && !sanitizeAudioTranscript(normalized, hasAllowedLyricRefrain)) {
    return "";
  }

  return normalized;
}

function isBlockedHallucinationError(error: string): boolean {
  return error === BLOCKED_HALLUCINATION_ERROR || error.includes(BLOCKED_HALLUCINATION_ERROR);
}

function cacheKey(settings: Awaited<ReturnType<typeof loadSettings>>, segment: CaptionSegment): string {
  const provider =
    settings.translationProvider === "openai"
      ? `${settings.openai.baseUrl}:${settings.openai.model}:${settings.openai.endpointMode}`
      : settings.translationProvider === "lmStudio"
        ? `${settings.lmStudio.baseUrl}:${settings.lmStudio.model}:${settings.lmStudio.endpointMode}`
        : settings.translationProvider === "ollama"
          ? `${settings.ollama.baseUrl}:${settings.ollama.model}`
          : settings.translationProvider;
  return [
    TRANSLATION_PROMPT_VERSION,
    settings.translationProvider,
    provider,
    settings.sourceLanguage,
    settings.targetLanguage,
    settings.contentMode,
    normalizeText(segment.text),
    normalizeText(segment.contextText ?? "")
  ].join("|");
}

function getMemoryCachedTranslation(key: string): string | undefined {
  const translatedText = translationCache.get(key);
  if (!translatedText) {
    return undefined;
  }
  // Refresh recency so active captions stay available during a seek or replay.
  translationCache.delete(key);
  translationCache.set(key, translatedText);
  return translatedText;
}

function rememberTranslation(key: string, translatedText: string): void {
  translationCache.delete(key);
  translationCache.set(key, translatedText);
  while (translationCache.size > TRANSLATION_MEMORY_CACHE_LIMIT) {
    const oldestKey = translationCache.keys().next().value;
    if (!oldestKey) {
      break;
    }
    translationCache.delete(oldestKey);
  }
}

function isLiveCapture(info: chrome.tabCapture.CaptureInfo): boolean {
  return info.status === "active" || info.status === "pending";
}

function getCapturedTabs(): Promise<chrome.tabCapture.CaptureInfo[]> {
  return new Promise((resolve) => {
    chrome.tabCapture.getCapturedTabs((result) => {
      resolve(result);
    });
  });
}

async function liveCapturedTabIds(): Promise<number[]> {
  return (await getCapturedTabs()).filter(isLiveCapture).map((info) => info.tabId);
}

function getAudioFailureCooldown(tabId: number): { until: number; error: string } | undefined {
  const cooldown = audioFailureCooldowns.get(tabId);
  if (!cooldown) {
    return undefined;
  }

  if (cooldown.until <= Date.now()) {
    audioFailureCooldowns.delete(tabId);
    return undefined;
  }

  return cooldown;
}

function setAudioFailureCooldown(tabId: number, error: string): void {
  audioFailureCooldowns.set(tabId, {
    until: Date.now() + AUDIO_FAILURE_COOLDOWN_MS,
    error
  });
}

function shouldStopCaptureAfterApiError(error: string): boolean {
  return /API STT 키|AI API 키|번역 API 키|LM Studio API 토큰|API 키|권한|401|403|429|quota|요청 한도|Base URL|endpoint|연결하지 못했습니다|로컬 STT 서버/i.test(
    error
  );
}

function clearAudioQueue(tabId: number): void {
  audioQueues.delete(tabId);
  audioFailureCooldowns.delete(tabId);
  audioNoSpeechNotices.delete(tabId);
  audioLastProcessedAt.delete(tabId);
  lastFinalTranscriptByTab.delete(tabId);
  lastPartialTranslationByTab.delete(tabId);
  streamTranslationGenerationByTab.delete(tabId);
  audioContextByTab.delete(tabId);
}

async function stopAudioCaptureAfterFatalError(tabId: number, error: string): Promise<void> {
  setAudioFailureCooldown(tabId, error);
  await notifyTab(tabId, { type: "AUDIO_CAPTURE_STATUS", state: "error", error });
  await stopAudioCapture(tabId);
  setAudioFailureCooldown(tabId, error);
}

async function translateAndRespond(segment: CaptionSegment): Promise<MessageResponse<{ translatedText: string; provider: string }>> {
  const settings = await loadSettings();
  if (!settings.enabled) {
    return { ok: false, error: "확장프로그램이 비활성화되어 있습니다." };
  }

  const key = cacheKey(settings, segment);
  const cached = getMemoryCachedTranslation(key);
  if (cached) {
    return { ok: true, translatedText: cached, provider: "cache" };
  }

  const inFlight = translationInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const translationPromise: Promise<MessageResponse<{ translatedText: string; provider: string }>> = (async () => {
    try {
      const result = await translateSegment(settings, segment);
      const translatedText = sanitizeTranslatedSubtitle(segment, result.translatedText, settings.contentMode);
      if (!translatedText) {
        return { ok: false as const, error: BLOCKED_HALLUCINATION_ERROR };
      }
      rememberTranslation(key, translatedText);

      return { ok: true as const, translatedText, provider: result.provider };
    } catch (error) {
      return { ok: false as const, error: getErrorMessage(error) };
    }
  })().finally(() => {
    translationInFlight.delete(key);
  });

  translationInFlight.set(key, translationPromise);
  return translationPromise;
}

function entriesFromCache(segments: CaptionSegment[], cached: Map<string, string>): CaptionTranslationEntry[] {
  return segments
    .map((segment): CaptionTranslationEntry | undefined => {
      const translatedText = cached.get(segment.id);
      return translatedText ? { id: segment.id, translatedText } : undefined;
    })
    .filter((entry): entry is CaptionTranslationEntry => Boolean(entry));
}

function pretranslateJobKey(tabId: number, context: CaptionCacheContext): string {
  return [
    tabId,
    context.videoId,
    context.captionHash,
    context.sourceLanguage,
    context.targetLanguage,
    context.providerKey,
    context.contentMode,
    context.promptVersion
  ].join("|");
}

function cancelTabPretranslationJobs(tabId: number, exceptKey?: string, keepVideoId?: string): void {
  const prefix = `${tabId}|`;
  for (const [key, job] of pretranslateJobs.entries()) {
    if (key.startsWith(prefix) && key !== exceptKey && (!keepVideoId || !key.startsWith(`${prefix}${keepVideoId}|`))) {
      job.cancelled = true;
      pretranslateJobs.delete(key);
    }
  }
}

function segmentDistanceToTime(segment: CaptionSegment, currentTimeMs: number): number {
  if (currentTimeMs >= segment.startMs && currentTimeMs <= segment.endMs) {
    return -1;
  }
  if (segment.startMs > currentTimeMs) {
    return segment.startMs - currentTimeMs;
  }
  return currentTimeMs - segment.endMs + 500;
}

function prioritizeMissingSegments(
  segments: CaptionSegment[],
  cached: Map<string, string>,
  currentTimeMs: number
): CaptionSegment[] {
  const currentWindow: CaptionSegment[] = [];
  const future: CaptionSegment[] = [];
  const recentPast: CaptionSegment[] = [];
  const olderPast: CaptionSegment[] = [];

  for (const segment of segments) {
    if (cached.has(segment.id) || !segment.text.trim()) {
      continue;
    }
    if (
      segment.endMs >= currentTimeMs - PRETRANSLATE_PRIORITY_PAST_WINDOW_MS &&
      segment.startMs <= currentTimeMs + PRETRANSLATE_PRIORITY_FUTURE_WINDOW_MS
    ) {
      currentWindow.push(segment);
      continue;
    }
    if (segment.startMs > currentTimeMs + PRETRANSLATE_PRIORITY_FUTURE_WINDOW_MS) {
      future.push(segment);
      continue;
    }
    if (segment.endMs >= currentTimeMs - PRETRANSLATE_RECENT_PAST_WINDOW_MS) {
      // The source is chronological; unshift preserves the existing newest-first priority.
      recentPast.unshift(segment);
      continue;
    }
    olderPast.push(segment);
  }

  currentWindow.sort((left, right) => segmentDistanceToTime(left, currentTimeMs) - segmentDistanceToTime(right, currentTimeMs));
  return [...currentWindow, ...future, ...recentPast, ...olderPast];
}

function pretranslateBatchSize(settings: Awaited<ReturnType<typeof loadSettings>>): number {
  return settings.translationProvider === "lmStudio" ? LM_STUDIO_PRETRANSLATE_BATCH_SIZE : PRETRANSLATE_BATCH_SIZE;
}

function hotPretranslateBatchSize(settings: Awaited<ReturnType<typeof loadSettings>>): number {
  return settings.translationProvider === "lmStudio" || settings.translationProvider === "ollama"
    ? LM_STUDIO_HOT_PRETRANSLATE_BATCH_SIZE
    : HOT_PRETRANSLATE_BATCH_SIZE;
}

function isHotPretranslateSegment(segment: CaptionSegment, currentTimeMs: number): boolean {
  return (
    segment.endMs >= currentTimeMs - HOT_PRETRANSLATE_PAST_WINDOW_MS &&
    segment.startMs <= currentTimeMs + HOT_PRETRANSLATE_FUTURE_WINDOW_MS
  );
}

function captionContextText(
  segments: CaptionSegment[],
  index: number,
  settings: Awaited<ReturnType<typeof loadSettings>>
): string | undefined {
  const contextSegmentCount =
    settings.contentMode === "lyrics"
      ? 2
      : settings.translationProvider === "lmStudio"
        ? 1
        : CAPTION_CONTEXT_SEGMENT_COUNT;
  const previous = segments
    .slice(Math.max(0, index - contextSegmentCount), index)
    .map((segment) => segment.text.trim())
    .filter(Boolean);
  const next = segments
    .slice(index + 1, index + 1 + contextSegmentCount)
    .map((segment) => segment.text.trim())
    .filter(Boolean);

  const context: string[] = [];
  if (previous.length > 0) {
    context.push(`Previous subtitles: ${previous.join(" / ")}`);
  }
  if (next.length > 0) {
    context.push(`Next subtitles: ${next.join(" / ")}`);
  }
  return context.length > 0 ? context.join("\n") : undefined;
}

function addCaptionContext(
  batch: CaptionSegment[],
  allSegments: CaptionSegment[],
  settings: Awaited<ReturnType<typeof loadSettings>>
): CaptionSegment[] {
  const indexById = new Map(allSegments.map((segment, index) => [segment.id, index]));
  return batch.map((segment) => {
    const index = indexById.get(segment.id);
    if (index === undefined) {
      return segment;
    }
    const contextText = captionContextText(allSegments, index, settings);
    return contextText ? { ...segment, contextText } : segment;
  });
}

async function handlePretranslateCaptions(
  message: Extract<RuntimeMessage, { type: "PRETRANSLATE_CAPTIONS" }>,
  tabId?: number
): Promise<MessageResponse<{ translations: CaptionTranslationEntry[]; total: number; cached: number }>> {
  if (!tabId) {
    return { ok: false, error: "선번역을 요청한 YouTube 탭을 찾지 못했습니다." };
  }

  const settings = await loadSettings();
  const context = createCaptionCacheContext(settings, message.videoId, message.captionHash, message.trackLanguage);
  const cachedMap = await getCachedCaptionTranslations(context, message.segments);
  const cachedEntries = entriesFromCache(message.segments, cachedMap);

  if (!settings.enabled || !settings.pretranslateEnabled || message.segments.length === 0) {
    return { ok: true, translations: cachedEntries, total: message.segments.length, cached: cachedEntries.length };
  }

  try {
    assertTranslationReady(settings);
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }

  const jobKey = pretranslateJobKey(tabId, context);
  const existingJob = pretranslateJobs.get(jobKey);
  if (existingJob) {
    existingJob.currentTimeMs = message.currentTimeMs;
    return { ok: true, translations: cachedEntries, total: message.segments.length, cached: cachedEntries.length };
  }

  cancelTabPretranslationJobs(tabId, jobKey);
  const job: PretranslateJob = { cancelled: false, currentTimeMs: message.currentTimeMs };
  pretranslateJobs.set(jobKey, job);

  void runPretranslationJob(tabId, jobKey, job, context, settings, message, cachedMap).catch(async (error) => {
    if (pretranslateJobs.get(jobKey) === job) {
      pretranslateJobs.delete(jobKey);
    }
    await notifyTab(tabId, {
      type: "PRETRANSLATE_PROGRESS",
      videoId: message.videoId,
      captionHash: message.captionHash,
      translated: cachedMap.size,
      total: message.segments.length,
      translationConfigRevision: message.translationConfigRevision,
      statusText: `선번역 실패: ${getErrorMessage(error)}`
    });
  });

  return { ok: true, translations: cachedEntries, total: message.segments.length, cached: cachedEntries.length };
}

async function runPretranslationJob(
  tabId: number,
  jobKey: string,
  job: PretranslateJob,
  context: CaptionCacheContext,
  settings: Awaited<ReturnType<typeof loadSettings>>,
  message: Extract<RuntimeMessage, { type: "PRETRANSLATE_CAPTIONS" }>,
  cachedMap: Map<string, string>
): Promise<void> {
  let translated = cachedMap.size;
  const skippedIds = new Set<string>();

  await notifyTab(tabId, {
    type: "PRETRANSLATE_PROGRESS",
    videoId: message.videoId,
    captionHash: message.captionHash,
    translated,
    total: message.segments.length,
    translationConfigRevision: message.translationConfigRevision,
    statusText: translated >= message.segments.length ? "캐시된 번역 자막 사용 중" : "현재 위치 자막 우선 번역 중..."
  });

  while (!job.cancelled) {
    const missing = prioritizeMissingSegments(message.segments, cachedMap, job.currentTimeMs).filter((segment) => !skippedIds.has(segment.id));
    if (missing.length === 0) {
      break;
    }

    const hotMissing = missing.filter((segment) => isHotPretranslateSegment(segment, job.currentTimeMs));
    const source = hotMissing.length > 0 ? hotMissing : missing;
    const batchSize = hotMissing.length > 0 ? hotPretranslateBatchSize(settings) : pretranslateBatchSize(settings);
    const batch = addCaptionContext(source.slice(0, batchSize), message.segments, settings);
    const result = await translatePretranslationBatch(settings, batch);
    if (job.cancelled) {
      break;
    }

    const segmentById = new Map(batch.map((segment) => [segment.id, segment]));
    const safeTranslations = result.translations
      .map((entry): CaptionTranslationEntry | undefined => {
        const segment = segmentById.get(entry.id);
        if (!segment) {
          return undefined;
        }
        const translatedText = sanitizeTranslatedSubtitle(segment, entry.translatedText, settings.contentMode);
        return translatedText ? { ...entry, translatedText } : undefined;
      })
      .filter((entry): entry is CaptionTranslationEntry => Boolean(entry));

    await putCachedCaptionTranslations(context, safeTranslations);
    for (const entry of safeTranslations) {
      cachedMap.set(entry.id, entry.translatedText);
    }
    if (safeTranslations.length < batch.length) {
      const translatedIds = new Set(safeTranslations.map((entry) => entry.id));
      for (const segment of batch) {
        if (!translatedIds.has(segment.id)) {
          skippedIds.add(segment.id);
        }
      }
    }
    translated = cachedMap.size;

    await notifyTab(tabId, {
      type: "PRETRANSLATE_RESULT",
      videoId: message.videoId,
      captionHash: message.captionHash,
      translations: safeTranslations,
      provider: result.provider,
      translationConfigRevision: message.translationConfigRevision
    });
    await notifyTab(tabId, {
      type: "PRETRANSLATE_PROGRESS",
      videoId: message.videoId,
      captionHash: message.captionHash,
      translated,
      total: message.segments.length,
      translationConfigRevision: message.translationConfigRevision,
      statusText: translated >= message.segments.length ? "전체 자막 선번역 완료" : `자막 선번역 중 ${translated}/${message.segments.length}`
    });
  }

  if (pretranslateJobs.get(jobKey) === job) {
    pretranslateJobs.delete(jobKey);
  }
}

async function translatePretranslationBatch(
  settings: Awaited<ReturnType<typeof loadSettings>>,
  batch: CaptionSegment[]
): Promise<{ translations: CaptionTranslationEntry[]; provider: string }> {
  if (batch.length === 1) {
    // Near the playback position, reuse the same high-quality single-subtitle
    // request as the visible overlay instead of making it compete with a JSON batch.
    const response = await translateAndRespond(batch[0]);
    if (!response.ok) {
      throw new Error(response.error);
    }
    return {
      translations: [{ id: batch[0].id, translatedText: response.translatedText }],
      provider: response.provider
    };
  }

  if (settings.translationProvider === "lmStudio") {
    const translations: CaptionTranslationEntry[] = [];
    for (const segment of batch) {
      // The visible-caption request and the pretranslation job often arrive together.
      // Reuse the same in-flight LM Studio request so a single local model does not
      // spend two turns translating the same subtitle line.
      const response = await translateAndRespond(segment);
      if (!response.ok) {
        throw new Error(response.error);
      }
      translations.push({ id: segment.id, translatedText: response.translatedText });
    }
    return { translations, provider: "lmStudio" };
  }

  return translateSegments(settings, batch);
}

async function startAudioCaptureInternal(senderTabId?: number, requestedTabId?: number): Promise<MessageResponse<{ tabId: number; mode?: string }>> {
  const tabId = requestedTabId ?? senderTabId;
  if (!tabId) {
    return { ok: false, error: "오디오를 캡처할 YouTube 탭을 찾지 못했습니다." };
  }

  if (!(await ensureContentScript(tabId))) {
    return { ok: false, error: "YouTube 영상 탭에서만 음성 자막을 시작할 수 있습니다." };
  }

  const recentFailure = getAudioFailureCooldown(tabId);
  if (recentFailure) {
    const seconds = Math.max(1, Math.ceil((recentFailure.until - Date.now()) / 1000));
    return { ok: false, error: `최근 API/STT 오류 때문에 ${seconds}초 후 다시 시도하세요: ${recentFailure.error}` };
  }

  const liveTabIds = await liveCapturedTabIds();
  if (liveTabIds.includes(tabId) && (await ownsLiveAudioCapture(tabId))) {
    activeAudioTabId = tabId;
    await notifyTab(tabId, { type: "AUDIO_CAPTURE_STATUS", state: "recording" });
    const state = await getOffscreenAudioState();
    return { ok: true, tabId, mode: state?.mode };
  }

  if (liveTabIds.includes(tabId)) {
    activeAudioTabId = undefined;
    clearAudioQueue(tabId);
  }

  if (activeAudioTabId && activeAudioTabId !== tabId) {
    await stopAudioCapture(activeAudioTabId);
  }

  const settings = await loadSettings();
  try {
    await assertTranscriptionReady(settings);
    assertTranslationReady(settings);
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }

  await ensureOffscreenDocument();

  let streamId: string;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    const message = getErrorMessage(error);
    if (/active stream/i.test(message)) {
      const capturedTabs = await getCapturedTabs();
      if (capturedTabs.some((info) => info.tabId === tabId && isLiveCapture(info)) && (await ownsLiveAudioCapture(tabId))) {
        activeAudioTabId = tabId;
        await notifyTab(tabId, { type: "AUDIO_CAPTURE_STATUS", state: "recording" });
        const state = await getOffscreenAudioState();
        return { ok: true, tabId, mode: state?.mode };
      }
      return {
        ok: false,
        error:
          "이 YouTube 탭에 이미 다른 오디오 캡처가 활성화되어 있습니다. 확장 팝업의 음성 중지를 누르거나 YouTube 탭/확장프로그램을 새로고침한 뒤 다시 시작하세요."
      };
    }
    throw error;
  }

  activeAudioTabId = tabId;
  const useStreaming = settings.sttProvider === "whisper" && settings.streamingSttEnabled;
  const lyricsMode = settings.contentMode === "lyrics";
  const liveMode = settings.contentMode === "live";
  const audioChunkMs = lyricsMode
    ? Math.max(settings.audioChunkMs, 14_000)
    : liveMode
      ? Math.max(settings.audioChunkMs, 10_000)
      : settings.audioChunkMs;
  let offscreenResponse: MessageResponse | undefined;
  try {
    offscreenResponse = await chrome.runtime.sendMessage<MessageResponse>({
      type: "START_AUDIO_CAPTURE",
      tabId,
      streamId,
      audioChunkMs: useStreaming ? audioChunkMs : Math.max(audioChunkMs, MIN_STABLE_AUDIO_CHUNK_MS),
      useStreaming,
      streamingSttEndpoint: settings.streamingSttEndpoint,
      streamingSttModel: settings.whisper.model,
      sourceLanguage: settings.sourceLanguage,
      contentMode: settings.contentMode,
      speakerTurnDetection: settings.speakerTurnDetection
    });
  } catch (error) {
    activeAudioTabId = undefined;
    clearAudioQueue(tabId);
    await chrome.runtime.sendMessage({ type: "STOP_AUDIO_CAPTURE", tabId }).catch(() => undefined);
    throw error;
  }
  if (!offscreenResponse?.ok) {
    activeAudioTabId = undefined;
    clearAudioQueue(tabId);
    await chrome.runtime.sendMessage({ type: "STOP_AUDIO_CAPTURE", tabId }).catch(() => undefined);
    throw new Error(offscreenResponse?.error ?? "오프스크린 오디오 캡처를 시작하지 못했습니다.");
  }

  await notifyTab(tabId, { type: "AUDIO_CAPTURE_STATUS", state: "recording" });
  const state = await getOffscreenAudioState();
  return { ok: true, tabId, mode: state?.mode };
}

async function startAudioCapture(senderTabId?: number, requestedTabId?: number): Promise<MessageResponse<{ tabId: number; mode?: string }>> {
  const tabId = requestedTabId ?? senderTabId;
  if (!tabId) {
    return { ok: false, error: "오디오를 캡처할 YouTube 탭을 찾지 못했습니다." };
  }

  if (startingAudioCapture?.tabId === tabId) {
    return startingAudioCapture.promise;
  }

  if (startingAudioCapture) {
    await startingAudioCapture.promise.catch(() => undefined);
  }

  const promise = startAudioCaptureInternal(undefined, tabId);
  startingAudioCapture = { tabId, promise };
  try {
    return await promise;
  } finally {
    if (startingAudioCapture?.promise === promise) {
      startingAudioCapture = undefined;
    }
  }
}

async function stopAudioCapture(tabId?: number): Promise<MessageResponse> {
  const liveTabIds = await liveCapturedTabIds();
  const targetTabId = tabId ?? activeAudioTabId ?? liveTabIds[0];

  if (tabId && liveTabIds.length > 0 && !liveTabIds.includes(tabId)) {
    await notifyTab(tabId, { type: "AUDIO_CAPTURE_STATUS", state: "idle" });
    return { ok: true };
  }

  if (await hasOffscreenDocument()) {
    await chrome.runtime.sendMessage({ type: "STOP_AUDIO_CAPTURE", tabId: targetTabId }).catch(() => undefined);
  }

  if (targetTabId) {
    await notifyTab(targetTabId, { type: "AUDIO_CAPTURE_STATUS", state: "idle" });
  }
  if (!tabId || tabId === activeAudioTabId || (targetTabId && liveTabIds.includes(targetTabId))) {
    activeAudioTabId = undefined;
  }
  if (targetTabId) {
    clearAudioQueue(targetTabId);
    const settings = await loadSettings();
    if (!settings.enabled) {
      cancelTabPretranslationJobs(targetTabId);
    }
  }
  return { ok: true };
}

async function notifyTab(tabId: number, message: RuntimeMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (await ensureContentScript(tabId)) {
      try {
        await chrome.tabs.sendMessage(tabId, message);
        return;
      } catch (retryError) {
        console.debug("Tab notification retry failed", retryError);
      }
    } else {
      console.debug("Tab notification failed", error);
    }
  }
}

async function broadcastContentSettings(settings: TranslatorSettings, revision: number, translationConfigRevision: number): Promise<void> {
  if (revision <= lastBroadcastSettingsRevision) {
    return;
  }
  lastBroadcastSettingsRevision = revision;
  const tabs = await chrome.tabs.query({ url: ["*://www.youtube.com/*", "*://m.youtube.com/*"] });
  const message: RuntimeMessage = {
    type: "SETTINGS_UPDATED",
    settings: toContentSettings(settings, translationConfigRevision)
  };
  await Promise.all(tabs.flatMap((tab) => (tab.id ? [notifyTab(tab.id, message)] : [])));
}

async function saveSettingsPatch(patch: Partial<TranslatorSettings>) {
  const snapshot = await patchSettings(patch);
  await broadcastContentSettings(snapshot.settings, snapshot.revision, snapshot.translationConfigRevision);
  return snapshot;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName !== "local" ||
    (!changes.translatorSettings && !changes.translatorSettingsRevision && !changes.translatorTranslationConfigRevision)
  ) {
    return;
  }
  void loadSettingsSnapshot()
    .then((snapshot) => broadcastContentSettings(snapshot.settings, snapshot.revision, snapshot.translationConfigRevision))
    .catch((error) => console.debug("Could not broadcast stored settings", error));
});

function segmentWithAudioContext(tabId: number, segment: CaptionSegment): CaptionSegment {
  const context = audioContextByTab.get(tabId) ?? [];
  return context.length > 0 ? { ...segment, contextText: context.join("\n") } : segment;
}

function rememberAudioContext(tabId: number, text: string): void {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return;
  }
  const context = [...(audioContextByTab.get(tabId) ?? []), normalized].slice(-3);
  audioContextByTab.set(tabId, context);
}

async function handleAudioChunk(message: Extract<RuntimeMessage, { type: "AUDIO_CHUNK" }>): Promise<MessageResponse> {
  if (getAudioFailureCooldown(message.tabId)) {
    return { ok: true };
  }

  const now = Date.now();
  const lastProcessedAt = audioLastProcessedAt.get(message.tabId) ?? 0;
  if (now - lastProcessedAt < AUDIO_MIN_PROCESS_INTERVAL_MS) {
    return { ok: true };
  }

  const queue = audioQueues.get(message.tabId) ?? { processing: false };
  if (queue.processing) {
    queue.pending = message;
    audioQueues.set(message.tabId, queue);
    return { ok: true };
  }

  queue.processing = true;
  audioQueues.set(message.tabId, queue);

  void processQueuedAudio(message.tabId, message).catch(async (error) => {
    audioQueues.delete(message.tabId);
    await notifyTab(message.tabId, { type: "TRANSLATION_ERROR", error: getErrorMessage(error) });
  });
  return { ok: true };
}

async function processQueuedAudio(
  tabId: number,
  initialMessage: Extract<RuntimeMessage, { type: "AUDIO_CHUNK" }>
): Promise<void> {
  try {
    let message: Extract<RuntimeMessage, { type: "AUDIO_CHUNK" }> | undefined = initialMessage;
    while (message) {
      await processAudioChunk(message);
      if (getAudioFailureCooldown(tabId)) {
        const queue = audioQueues.get(tabId);
        if (queue) {
          queue.pending = undefined;
          queue.processing = false;
          audioQueues.set(tabId, queue);
        }
        return;
      }
      const queue = audioQueues.get(tabId);
      message = queue?.pending;
      if (queue) {
        queue.pending = undefined;
        queue.processing = Boolean(message);
        audioQueues.set(tabId, queue);
      }
    }

    const queue = audioQueues.get(tabId);
    if (queue) {
      queue.processing = false;
      queue.pending = undefined;
      audioQueues.set(tabId, queue);
    }
  } catch (error) {
    const queue = audioQueues.get(tabId);
    if (queue) {
      queue.processing = false;
      queue.pending = undefined;
      audioQueues.set(tabId, queue);
    }
    throw error;
  }
}

async function processAudioChunk(message: Extract<RuntimeMessage, { type: "AUDIO_CHUNK" }>): Promise<void> {
  const settings = await loadSettings();
  if (!settings.enabled) {
    return;
  }

  let transcript: string;
  try {
    audioLastProcessedAt.set(message.tabId, Date.now());
    transcript = sanitizeAudioTranscript(
      await transcribeAudio(settings, base64ToArrayBuffer(message.audioBase64), message.mimeType),
      settings.contentMode === "lyrics"
    );
    audioFailureCooldowns.delete(message.tabId);
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    setAudioFailureCooldown(message.tabId, errorMessage);
    await notifyTab(message.tabId, { type: "TRANSLATION_ERROR", error: `STT 오류: ${errorMessage}` });
    if (shouldStopCaptureAfterApiError(errorMessage)) {
      await stopAudioCaptureAfterFatalError(message.tabId, errorMessage);
    }
    return;
  }

  if (!transcript) {
    const lastNoticeAt = audioNoSpeechNotices.get(message.tabId) ?? 0;
    if (Date.now() - lastNoticeAt > AUDIO_NO_SPEECH_NOTICE_MS) {
      audioNoSpeechNotices.set(message.tabId, Date.now());
      await notifyTab(message.tabId, {
        type: "AUDIO_CAPTURE_STATUS",
        state: "recording",
        statusText: "음성 캡처 중... 인식된 말소리를 기다리는 중"
      });
    }
    return;
  }
  audioNoSpeechNotices.delete(message.tabId);

  const now = Date.now();
  const segment: CaptionSegment = {
    id: `audio-${now}`,
    source: "audioStt",
    startMs: now,
    endMs: now + Math.max(settings.audioChunkMs, 2200),
    text: transcript
  };

  await notifyTab(message.tabId, { type: "AUDIO_TRANSCRIPT", tabId: message.tabId, segment });

  const translation = await translateAndRespond(segmentWithAudioContext(message.tabId, segment));
  if (translation.ok) {
    rememberAudioContext(message.tabId, segment.text);
    await notifyTab(message.tabId, {
      type: "TRANSLATION_READY",
      segment,
      translatedText: translation.translatedText,
      provider: translation.provider
    });
  } else {
    if (isBlockedHallucinationError(translation.error)) {
      return;
    }
    await notifyTab(message.tabId, { type: "TRANSLATION_ERROR", segment, error: translation.error });
    if (shouldStopCaptureAfterApiError(translation.error)) {
      await stopAudioCaptureAfterFatalError(message.tabId, translation.error);
    }
  }
}

async function processStreamTranscript(message: Extract<RuntimeMessage, { type: "STREAM_STT_TRANSCRIPT" }>): Promise<void> {
  const settings = await loadSettings();
  if (!settings.enabled) {
    return;
  }
  const sanitizedText = sanitizeAudioTranscript(message.segment.text, settings.contentMode === "lyrics");
  if (!sanitizedText) {
    return;
  }
  const segment = sanitizedText === message.segment.text ? message.segment : { ...message.segment, text: sanitizedText };

  if (!message.isFinal) {
    await notifyTab(message.tabId, { ...message, segment });
    if (shouldTranslateStreamPartial(message.tabId, segment)) {
      void translateStreamSegment(message.tabId, segment, false);
    }
    return;
  }

  const normalized = normalizeText(segment.text);
  if (!normalized) {
    return;
  }
  const previous = lastFinalTranscriptByTab.get(message.tabId);
  const now = Date.now();
  if (previous?.text === normalized && now - previous.at < DUPLICATE_FINAL_TRANSCRIPT_WINDOW_MS) {
    return;
  }
  lastFinalTranscriptByTab.set(message.tabId, { text: normalized, at: now });

  await notifyTab(message.tabId, { type: "AUDIO_TRANSCRIPT", tabId: message.tabId, segment });

  await translateStreamSegment(message.tabId, segment, true);
}

function shouldTranslateStreamPartial(tabId: number, segment: CaptionSegment): boolean {
  const normalized = normalizeText(segment.text);
  const compactLength = normalized.replace(/\s/g, "").length;
  if (!normalized || compactLength < STREAM_PARTIAL_TRANSLATION_MIN_CHARACTERS) {
    return false;
  }

  const now = Date.now();
  const previous = lastPartialTranslationByTab.get(tabId);
  if (previous?.text === normalized || (previous && now - previous.at < STREAM_PARTIAL_TRANSLATION_MIN_INTERVAL_MS)) {
    return false;
  }
  lastPartialTranslationByTab.set(tabId, { text: normalized, at: now });
  return true;
}

async function translateStreamSegment(tabId: number, segment: CaptionSegment, isFinal: boolean): Promise<void> {
  const generation = (streamTranslationGenerationByTab.get(tabId) ?? 0) + 1;
  streamTranslationGenerationByTab.set(tabId, generation);

  const translation = await translateAndRespond(segmentWithAudioContext(tabId, segment));
  if (streamTranslationGenerationByTab.get(tabId) !== generation) {
    return;
  }
  if (translation.ok) {
    if (isFinal) {
      rememberAudioContext(tabId, segment.text);
    }
    await notifyTab(tabId, {
      type: "TRANSLATION_READY",
      segment,
      translatedText: translation.translatedText,
      provider: isFinal ? translation.provider : `${translation.provider} (partial)`
    });
  } else {
    if (isBlockedHallucinationError(translation.error)) {
      return;
    }
    if (isFinal) {
      await notifyTab(tabId, { type: "TRANSLATION_ERROR", segment, error: translation.error });
      if (shouldStopCaptureAfterApiError(translation.error)) {
        await stopAudioCaptureAfterFatalError(tabId, translation.error);
      }
    }
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
  const message = rawMessage as RuntimeMessage & { streamId?: string };

  void (async () => {
    try {
      if (message.type === "GET_SETTINGS") {
        const snapshot = await loadSettingsSnapshot();
        sendResponse({ ok: true, settings: toContentSettings(snapshot.settings, snapshot.translationConfigRevision) });
        return;
      }

      if (message.type === "GET_PAGE_CAPTION_SNAPSHOT") {
        if (!sender.tab?.id) {
          sendResponse({ ok: false, error: "YouTube 탭을 찾지 못했습니다." });
          return;
        }
        sendResponse(await readPageCaptionSnapshot(sender.tab.id, message.videoId));
        return;
      }

      if (message.type === "CAPTION_SEGMENT") {
        sendResponse(await translateAndRespond(message.segment));
        return;
      }

      if (message.type === "PRETRANSLATE_CAPTIONS") {
        sendResponse(await handlePretranslateCaptions(message, sender.tab?.id));
        return;
      }

      if (message.type === "START_AUDIO_CAPTURE") {
        sendResponse(await startAudioCapture(sender.tab?.id, message.tabId));
        return;
      }

      if (message.type === "STOP_AUDIO_CAPTURE") {
        sendResponse(await stopAudioCapture(message.tabId));
        return;
      }

      if (message.type === "AUDIO_CHUNK") {
        sendResponse(await handleAudioChunk(message));
        return;
      }

      if (message.type === "STREAM_STT_TRANSCRIPT") {
        await processStreamTranscript(message);
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "AUDIO_CAPTURE_STATUS") {
        const targetTabId = message.tabId ?? activeAudioTabId;
        if (targetTabId) {
          await notifyTab(targetTabId, message);
        }
        if (message.state === "idle" || message.state === "error") {
          if (!targetTabId || targetTabId === activeAudioTabId) {
            activeAudioTabId = undefined;
          }
          if (targetTabId) {
            clearAudioQueue(targetTabId);
          }
        }
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "MINI_CONTROL_UPDATE") {
        const snapshot = await saveSettingsPatch(message.patch);
        if (!snapshot.settings.enabled && sender.tab?.id) {
          await stopAudioCapture(sender.tab.id);
        }
        sendResponse({
          ok: true,
          settings: toContentSettings(snapshot.settings, snapshot.translationConfigRevision),
          revision: snapshot.revision
        });
        return;
      }

      if (message.type === "CANCEL_PRETRANSLATION") {
        if (sender.tab?.id) {
          cancelTabPretranslationJobs(sender.tab.id, undefined, message.keepVideoId);
        }
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "SAVE_SETTINGS") {
        const snapshot = await saveSettingsPatch(message.patch);
        if (!snapshot.settings.enabled && activeAudioTabId) {
          await stopAudioCapture(activeAudioTabId);
        }
        sendResponse({ ok: true, settings: snapshot.settings, revision: snapshot.revision });
        return;
      }

      if (message.type === "RESET_AUDIO_CAPTURE_COOLDOWN") {
        const tabId = message.tabId ?? sender.tab?.id;
        if (tabId) {
          audioFailureCooldowns.delete(tabId);
          audioNoSpeechNotices.delete(tabId);
        }
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "OPEN_OPTIONS_PAGE") {
        await chrome.runtime.openOptionsPage();
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: `알 수 없는 메시지입니다: ${String((message as { type?: unknown }).type)}` });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      if (message.type === "AUDIO_CHUNK") {
        await notifyTab(message.tabId, { type: "TRANSLATION_ERROR", error: errorMessage });
      }
      sendResponse({ ok: false, error: errorMessage });
    }
  })();

  return true;
});
