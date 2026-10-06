import { loadSettings, loadSettingsSnapshot, patchSettings, toContentSettings } from "../shared/storage";
import type { CaptionSegment, PageCaptionSnapshot, PageCaptionTrack, TranslatorSettings } from "../shared/types";
import type { CaptionTranslationEntry, MessageResponse, RuntimeMessage } from "../shared/messages";
import { BLOCKED_HALLUCINATION_ERROR, getErrorMessage } from "../shared/messages";
import { TRANSLATION_PROMPT_VERSION } from "../shared/translationVersion";
import { assertTranscriptionReady, assertTranslationReady, transcribeAudio, translateSegment, translateSegments } from "./providers";
import {
  createCaptionCacheContext,
  getCachedCaptionTranslations,
  putCachedCaptionTranslations,
  type CaptionCacheContext
} from "./captionCache";
import {
  assistOfficialCaptionSegment,
  assistLyricsSegment,
  createLyricsAssistSession,
  searchLyricsCandidates,
  setLyricsCandidates,
  type LyricsAssistSession,
  type LyricsMediaContext
} from "./lyricsAssist";
import {
  cloneCorrectionMatchSession,
  createCorrectionMatchSession,
  matchCorrectionSegment,
  type CorrectionMatchResult,
  type CorrectionMatchSession
} from "./correctionMatcher";
import {
  getCorrectionPreferences,
  listSongCorrections,
  setCorrectionPreferences
} from "../shared/correctionStore";
import type { CorrectionMediaContext, SongCorrection } from "../shared/corrections";

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
const LOCAL_PRETRANSLATE_FUTURE_WINDOW_MS = 20_000;
const HOT_PRETRANSLATE_PAST_WINDOW_MS = 2_500;
const LOCAL_PRETRANSLATE_REST_MS = 500;
const PRETRANSLATE_PRIORITY_PAST_WINDOW_MS = 10_000;
const PRETRANSLATE_PRIORITY_FUTURE_WINDOW_MS = 180_000;
const PRETRANSLATE_RECENT_PAST_WINDOW_MS = 60_000;
const MAX_REMOTE_PRETRANSLATE_SEGMENTS = 500;
const MAX_REMOTE_PRETRANSLATE_CHARACTERS = 100_000;
const CAPTION_CONTEXT_SEGMENT_COUNT = 2;
const LYRICS_ASSIST_MATCH_BATCH_SIZE = 24;
const DUPLICATE_FINAL_TRANSCRIPT_WINDOW_MS = 6_000;
const TRANSLATION_MEMORY_CACHE_LIMIT = 300;
const STREAM_PARTIAL_TRANSLATION_MIN_INTERVAL_MS = 1_250;
const STREAM_PARTIAL_TRANSLATION_MIN_CHARACTERS = 5;

let creatingOffscreen: Promise<void> | undefined;
let activeAudioTabId: number | undefined;
let activeAudioVideoId: string | undefined;
let lastBroadcastSettingsRevision = -1;
let startingAudioCapture:
  | { tabId: number; videoId?: string; promise: Promise<MessageResponse<{ tabId: number; mode?: string }>> }
  | undefined;
let audioLifecycleQueue: Promise<void> = Promise.resolve();
const translationCache = new Map<string, string>();
const translationInFlight = new Map<string, Promise<MessageResponse<{ translatedText: string; provider: string }>>>();
type AudioChunkMessage = Extract<RuntimeMessage, { type: "AUDIO_CHUNK" }>;
type AudioQueueState = { videoId: string; processing: boolean; pending?: AudioChunkMessage };
const audioQueues = new Map<number, AudioQueueState>();
const audioFailureCooldowns = new Map<number, { until: number; error: string; videoId?: string }>();
const audioNoSpeechNotices = new Map<number, number>();
const audioLastProcessedAt = new Map<number, number>();
const lastFinalTranscriptByTab = new Map<number, { text: string; at: number }>();
const lastPartialTranslationByTab = new Map<number, { text: string; at: number }>();
const streamTranslationGenerationByTab = new Map<number, number>();
const audioContextByTab = new Map<number, string[]>();
const lyricsAssistByTab = new Map<number, LyricsAssistSession>();
type CaptionLyricsAssistState = {
  videoId: string;
  session: LyricsAssistSession;
  ready: Promise<void>;
};
const captionLyricsAssistByTab = new Map<number, CaptionLyricsAssistState>();
type CorrectionSessionState = {
  videoId: string;
  session?: CorrectionMatchSession;
  ready: Promise<void>;
  appliedNotified: boolean;
};
const correctionSessionsByTab = new Map<number, CorrectionSessionState>();
let correctionLibraryCache: SongCorrection[] | undefined;

void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch((error) => {
  console.debug("Could not restrict local storage to trusted extension contexts", error);
});
type PretranslateJob = {
  cancelled: boolean;
  currentTimeMs: number;
};
type PretranslateBudget = { segments: number; characters: number };

const pretranslateJobs = new Map<string, PretranslateJob>();
const pretranslateBudgets = new Map<string, PretranslateBudget>();
const PROBABLE_AUDIO_HALLUCINATION_KEYS = new Set([
  "you",
  "youyou",
  "youyouyou",
  "youyouyouyou",
  "thankyou",
  "thanks",
  "thankyouverymuch",
  "pleasedonottrythisathome",
  "pleasedonotreuploadthisvideo",
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
  "字幕をご覧いただきありがとうございました",
  "字幕をご覧いただきましてありがとうございます",
  "字幕をご覧いただきましてありがとうございました",
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
  "livestreamconversation",
  "clearlyaudiblespokenvoices",
  "ignoremusicgamesounds",
  "backgroundnoise",
  "englishandkoreanlyrics",
  "koreanandenglishlyrics",
  "englishkoreanlyrics",
  "koreanenglishlyrics",
  "lyricsinenglishandkorean",
  "lyricsinkoreanandenglish",
  "영어와한국어가사",
  "한국어와영어가사",
  "영어한국어가사",
  "한국어영어가사",
  "영어와한국어의가사",
  "한국어와영어의가사",
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
const PRESERVED_ENGLISH_LYRIC_HOOKS = new Set(["oh", "yeah", "baby", "la", "wow", "na", "ah", "ah-ah"]);

type OffscreenAudioState = {
  activeTabId?: number;
  activeVideoId?: string;
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
            if (candidateVideoId && candidateVideoId !== expectedVideoId) {
              continue;
            }
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

async function readPageMediaContext(tabId: number, videoId: string): Promise<LyricsMediaContext | undefined> {
  const scripting = (chrome as typeof chrome & { scripting?: ChromeScriptingApi }).scripting;
  if (!scripting) {
    return undefined;
  }
  try {
    const executions = await scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [videoId],
      func: (expectedVideoId: string) => {
        type PlayerElement = HTMLElement & {
          getPlayerResponse?: () => unknown;
          getVideoData?: () => unknown;
        };
        const readString = (value: unknown, key: string): string | undefined => {
          if (!value || typeof value !== "object") return undefined;
          const field = (value as Record<string, unknown>)[key];
          return typeof field === "string" && field.trim() ? field.trim() : undefined;
        };
        const url = new URL(location.href);
        const urlVideoId = url.searchParams.get("v") ?? location.pathname.match(/\/shorts\/([^/?]+)/)?.[1];
        if (urlVideoId !== expectedVideoId) return null;

        const players = [...document.querySelectorAll<PlayerElement>("#movie_player, .html5-video-player")];
        let playerResponse: Record<string, unknown> | undefined;
        for (const player of players) {
          try {
            const response = player.getPlayerResponse?.();
            const details = (response as Record<string, unknown> | undefined)?.videoDetails;
            const responseVideoId = readString(details, "videoId") ?? readString(player.getVideoData?.(), "video_id");
            if (responseVideoId === expectedVideoId) {
              playerResponse = response as Record<string, unknown>;
              break;
            }
          } catch {
            continue;
          }
        }
        const details = playerResponse?.videoDetails as Record<string, unknown> | undefined;
        const microformat = (playerResponse?.microformat as Record<string, unknown> | undefined)
          ?.playerMicroformatRenderer as Record<string, unknown> | undefined;
        const lengthSeconds = Number(readString(details, "lengthSeconds"));
        return {
          videoId: expectedVideoId,
          title:
            readString(details, "title") ??
            document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ??
            document.title.replace(/\s*-\s*YouTube\s*$/i, ""),
          author: readString(details, "author") ?? "",
          description: (readString(details, "shortDescription") ?? readString(microformat, "description") ?? "").slice(0, 12_000),
          durationSeconds: Number.isFinite(lengthSeconds) && lengthSeconds > 0 ? lengthSeconds : undefined,
          isLive: Boolean(details?.isLiveContent ?? microformat?.liveBroadcastDetails)
        };
      }
    });
    const value = executions[0]?.result;
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const source = value as Record<string, unknown>;
    if (source.videoId !== videoId || typeof source.title !== "string") {
      return undefined;
    }
    return {
      videoId,
      title: source.title,
      author: typeof source.author === "string" ? source.author : "",
      description: typeof source.description === "string" ? source.description : "",
      durationSeconds: typeof source.durationSeconds === "number" ? source.durationSeconds : undefined,
      isLive: Boolean(source.isLive)
    };
  } catch (error) {
    console.debug("YouTube media metadata unavailable for lyrics assist", error);
    return undefined;
  }
}

function notifyLyricsAssistStatus(
  tabId: number,
  videoId: string,
  state: "searching" | "ready" | "empty" | "applied",
  candidateCount?: number
): void {
  const statusText =
    state === "searching"
      ? "가사 보완 검색 중"
      : state === "ready"
        ? `가사 후보 ${candidateCount ?? 0}개 확인`
        : state === "applied"
          ? "가사 보완 적용됨"
          : "가사 후보 없음";
  void notifyTab(tabId, {
    type: "LYRICS_ASSIST_STATUS",
    videoId,
    state,
    statusText,
    candidateCount
  });
}

function notifyCorrectionMatchStatus(
  tabId: number,
  videoId: string,
  state: "matched" | "applied" | "none",
  songTitle?: string
): void {
  const statusText =
    state === "matched"
      ? `교정 후보: ${songTitle ?? "확인됨"}`
      : state === "applied"
        ? `사용자 교정 적용: ${songTitle ?? "현재 곡"}`
        : "사용자 교정 없음";
  void notifyTab(tabId, {
    type: "CORRECTION_MATCH_STATUS",
    videoId,
    state,
    statusText,
    songTitle
  });
}

async function correctionLibrary(): Promise<SongCorrection[]> {
  correctionLibraryCache ??= await listSongCorrections();
  return correctionLibraryCache;
}

function invalidateCorrectionLibrary(): void {
  correctionLibraryCache = undefined;
  correctionSessionsByTab.clear();
}

function startCorrectionSession(tabId: number, videoId: string): CorrectionSessionState {
  const existing = correctionSessionsByTab.get(tabId);
  if (existing?.videoId === videoId) {
    return existing;
  }
  const state: CorrectionSessionState = {
    videoId,
    ready: Promise.resolve(),
    appliedNotified: false
  };
  correctionSessionsByTab.set(tabId, state);
  state.ready = (async () => {
    const preferences = await getCorrectionPreferences();
    if (!preferences.enabled || correctionSessionsByTab.get(tabId) !== state) {
      return;
    }
    const [media, songs, settings] = await Promise.all([
      readPageMediaContext(tabId, videoId),
      correctionLibrary(),
      loadSettings()
    ]);
    if (!media || correctionSessionsByTab.get(tabId) !== state) {
      return;
    }
    state.session = createCorrectionMatchSession(media, songs, settings.targetLanguage);
    if (state.session) {
      notifyCorrectionMatchStatus(tabId, videoId, "matched", state.session.song.title);
    }
  })();
  return state;
}

async function correctionSession(tabId: number, videoId: string): Promise<CorrectionSessionState> {
  const state = startCorrectionSession(tabId, videoId);
  await state.ready;
  return state;
}

async function matchUserCorrection(
  tabId: number,
  videoId: string,
  segment: CaptionSegment,
  commit: boolean
): Promise<CorrectionMatchResult | undefined> {
  const state = await correctionSession(tabId, videoId);
  if (correctionSessionsByTab.get(tabId) !== state) {
    return undefined;
  }
  const result = matchCorrectionSegment(state.session, segment, commit);
  if (result && !state.appliedNotified) {
    state.appliedNotified = true;
    notifyCorrectionMatchStatus(tabId, videoId, "applied", result.songTitle);
  }
  return result;
}

async function correctionEntriesForSegments(
  tabId: number,
  videoId: string,
  segments: CaptionSegment[]
): Promise<CaptionTranslationEntry[]> {
  const state = await correctionSession(tabId, videoId);
  if (!state.session || correctionSessionsByTab.get(tabId) !== state) {
    return [];
  }
  const matchingSession = cloneCorrectionMatchSession(state.session);
  const entries: CaptionTranslationEntry[] = [];
  for (let offset = 0; offset < segments.length; offset += LYRICS_ASSIST_MATCH_BATCH_SIZE) {
    if (correctionSessionsByTab.get(tabId) !== state) {
      return [];
    }
    const end = Math.min(segments.length, offset + LYRICS_ASSIST_MATCH_BATCH_SIZE);
    for (let index = offset; index < end; index += 1) {
      const result = matchCorrectionSegment(matchingSession, segments[index], true);
      if (result) {
        entries.push({ id: segments[index].id, translatedText: result.translatedText });
      }
    }
    if (end < segments.length) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    }
  }
  if (entries.length > 0 && !state.appliedNotified) {
    state.appliedNotified = true;
    notifyCorrectionMatchStatus(tabId, videoId, "applied", state.session.song.title);
  }
  return entries;
}

async function prepareLyricsAssist(tabId: number, videoId: string, settings: TranslatorSettings): Promise<void> {
  if (!settings.lyricsAssistEnabled || settings.contentMode === "spoken") {
    lyricsAssistByTab.delete(tabId);
    return;
  }
  const session = createLyricsAssistSession(videoId);
  lyricsAssistByTab.set(tabId, session);
  notifyLyricsAssistStatus(tabId, videoId, "searching");
  const media = await readPageMediaContext(tabId, videoId);
  if (!media || lyricsAssistByTab.get(tabId) !== session || !isActiveAudioSession(tabId, videoId)) {
    if (!media && lyricsAssistByTab.get(tabId) === session) {
      notifyLyricsAssistStatus(tabId, videoId, "empty", 0);
    }
    return;
  }
  const candidates = await searchLyricsCandidates(media);
  if (lyricsAssistByTab.get(tabId) === session && isActiveAudioSession(tabId, videoId)) {
    setLyricsCandidates(session, candidates);
    notifyLyricsAssistStatus(tabId, videoId, candidates.length > 0 ? "ready" : "empty", candidates.length);
  }
}

function startCaptionLyricsAssist(
  tabId: number,
  videoId: string,
  settings: TranslatorSettings
): CaptionLyricsAssistState | undefined {
  if (!settings.lyricsAssistEnabled || settings.contentMode === "spoken") {
    captionLyricsAssistByTab.delete(tabId);
    return undefined;
  }

  const existing = captionLyricsAssistByTab.get(tabId);
  if (existing?.videoId === videoId) {
    return existing;
  }

  const session = createLyricsAssistSession(videoId);
  const state: CaptionLyricsAssistState = {
    videoId,
    session,
    ready: Promise.resolve()
  };
  captionLyricsAssistByTab.set(tabId, state);
  notifyLyricsAssistStatus(tabId, videoId, "searching");
  state.ready = (async () => {
    const media = await readPageMediaContext(tabId, videoId);
    if (!media || captionLyricsAssistByTab.get(tabId) !== state) {
      if (!media && captionLyricsAssistByTab.get(tabId) === state) {
        notifyLyricsAssistStatus(tabId, videoId, "empty", 0);
      }
      return;
    }
    const candidates = await searchLyricsCandidates(media);
    if (captionLyricsAssistByTab.get(tabId) === state) {
      setLyricsCandidates(session, candidates);
      notifyLyricsAssistStatus(tabId, videoId, candidates.length > 0 ? "ready" : "empty", candidates.length);
    }
  })();
  return state;
}

async function captionLyricsAssistSession(
  tabId: number,
  videoId: string,
  settings: TranslatorSettings,
  waitForReady = false
): Promise<LyricsAssistSession | undefined> {
  const state = startCaptionLyricsAssist(tabId, videoId, settings);
  if (!state) {
    return undefined;
  }
  if (waitForReady) {
    await state.ready;
  } else {
    await Promise.race([
      state.ready,
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, 900))
    ]);
  }
  return captionLyricsAssistByTab.get(tabId) === state ? state.session : undefined;
}

async function addCaptionLyricsAssist(
  tabId: number,
  videoId: string,
  settings: TranslatorSettings,
  segments: CaptionSegment[],
  waitForReady = false
): Promise<CaptionSegment[]> {
  const session = await captionLyricsAssistSession(tabId, videoId, settings, waitForReady);
  if (!session) {
    return segments;
  }
  const matchingSession =
    segments.length > 1
      ? {
          ...session,
          candidates: session.candidates
        }
      : session;
  const assistedSegments: CaptionSegment[] = [];
  for (let offset = 0; offset < segments.length; offset += LYRICS_ASSIST_MATCH_BATCH_SIZE) {
    const currentState = captionLyricsAssistByTab.get(tabId);
    if (!currentState || currentState.videoId !== videoId || currentState.session !== session) {
      return segments;
    }
    const end = Math.min(segments.length, offset + LYRICS_ASSIST_MATCH_BATCH_SIZE);
    for (let index = offset; index < end; index += 1) {
      assistedSegments.push(assistOfficialCaptionSegment(matchingSession, segments[index]));
    }
    if (end < segments.length) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    }
  }
  if (assistedSegments.some((segment) => segment.detectedContentMode === "lyrics")) {
    notifyLyricsAssistStatus(tabId, videoId, "applied", session.candidates.length);
  }
  return assistedSegments;
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
      type: "GET_OFFSCREEN_AUDIO_STATE",
      target: "offscreen"
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

async function stopAudioCaptureOutsideYouTube(tabId: number, url?: string): Promise<void> {
  const tabUrl = url ?? (await getTabUrl(tabId));
  if (isSupportedYouTubeUrl(tabUrl)) {
    return;
  }
  if (activeAudioTabId !== tabId && !(await liveCapturedTabIds()).includes(tabId)) {
    return;
  }
  await stopAudioCapture(tabId);
}

async function stopStaleAudioCaptureOnStartup(): Promise<void> {
  const state = await getOffscreenAudioState();
  if (!state?.recording || !state.activeTabId) {
    return;
  }
  await stopAudioCaptureOutsideYouTube(state.activeTabId);
}

function youtubeVideoIdFromUrl(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if (!isSupportedYouTubeUrl(url)) {
      return undefined;
    }
    return parsed.searchParams.get("v") ?? parsed.pathname.match(/^\/shorts\/([^/?]+)/)?.[1];
  } catch {
    return undefined;
  }
}

async function currentYouTubeMedia(): Promise<CorrectionMediaContext | undefined> {
  const tabs = await chrome.tabs.query({ url: ["*://www.youtube.com/*", "*://m.youtube.com/*"] });
  const candidates = tabs
    .map((tab) => ({ tab, videoId: youtubeVideoIdFromUrl(tab.url) }))
    .filter((entry): entry is { tab: chrome.tabs.Tab; videoId: string } => Boolean(entry.tab.id && entry.videoId))
    .sort((left, right) => {
      const leftAccessed = (left.tab as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed ?? 0;
      const rightAccessed = (right.tab as chrome.tabs.Tab & { lastAccessed?: number }).lastAccessed ?? 0;
      return rightAccessed - leftAccessed;
    });
  const current = candidates[0];
  if (!current?.tab.id) {
    return undefined;
  }
  const media = await readPageMediaContext(current.tab.id, current.videoId);
  return media
    ? {
        videoId: media.videoId,
        title: media.title,
        author: media.author,
        durationSeconds: media.durationSeconds,
        isLive: media.isLive
      }
    : undefined;
}

async function broadcastCorrectionLibraryUpdated(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ["*://www.youtube.com/*", "*://m.youtube.com/*"] });
  await Promise.all(
    tabs.flatMap((tab) => (tab.id ? [notifyTab(tab.id, { type: "CORRECTION_LIBRARY_UPDATED" })] : []))
  );
}

async function updateActionAvailability(tabId: number, url?: string): Promise<void> {
  const tabUrl = url ?? (await getTabUrl(tabId));
  const isYouTube = isSupportedYouTubeUrl(tabUrl);
  try {
    await chrome.action.setTitle({
      tabId,
      title: isYouTube ? "YouTube Live Translator" : "YouTube에서만 사용할 수 있습니다"
    });
    if (isYouTube) {
      await chrome.action.enable(tabId);
    } else {
      await chrome.action.disable(tabId);
    }
  } catch (error) {
    console.debug("Could not update extension action availability", error);
  }
}

async function initializeActionAvailability(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.flatMap((tab) => (tab.id ? [updateActionAvailability(tab.id, tab.url)] : [])));
  } catch (error) {
    console.debug("Could not initialize extension action availability", error);
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
  if (
    (key.includes("자막") && key.includes("감사") && (key.includes("봐주") || key.includes("보아주"))) ||
    (key.includes("字幕") && key.includes("ご覧いただ") && key.includes("ありがとう"))
  ) {
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
    key.length <= 96 &&
    /^(?:transcription|translation|transcript|caption(?:ing|s)?|subtitles?)(?:provided|created|edited)?by[\p{L}\p{N}]+$/u.test(key)
  ) {
    return true;
  }
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
  const latinTokens = normalized.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  if (latinTokens.length >= 2 && latinTokens.length <= 12) {
    const normalizedLatinTokens = latinTokens.map((token) => token.toLowerCase());
    if (
      normalizedLatinTokens.some(
        (token) =>
          token.length <= 16 &&
          normalizedLatinTokens.filter((candidate) => candidate === token).length >= 2
      )
    ) {
      return true;
    }
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

function latinWordCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of text.match(/[A-Za-z][A-Za-z'-]*/g) ?? []) {
    const normalized = token.toLowerCase();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

function isMissingRequiredEnglishLyricHook(sourceText: string, translatedText: string): boolean {
  const sourceCounts = latinWordCounts(sourceText);
  const translatedCounts = latinWordCounts(translatedText);
  for (const [token, count] of sourceCounts) {
    if ((PRESERVED_ENGLISH_LYRIC_HOOKS.has(token) || count >= 2) && (translatedCounts.get(token) ?? 0) < count) {
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

function hasCorruptedSubtitleText(text: string): boolean {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/u.test(text)) {
    return true;
  }
  const placeholderCount = text.match(/(?:^|[\s　])\?(?=[\s　]|$)/gu)?.length ?? 0;
  const wordCount = text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return placeholderCount >= 3 && placeholderCount * 3 >= Math.max(1, wordCount);
}

function sanitizeAudioTranscript(text: string, preserveLyricRefrain = false): string {
  const normalized = normalizeSubtitleLines(text);
  const hasAllowedLyricRefrain = preserveLyricRefrain && isIntentionalLyricRefrain(normalized);
  if (
    !normalized ||
    hasCorruptedSubtitleText(normalized) ||
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

function edgeMarkers(text: string): { leading: string; trailing: string } {
  const trimmed = text.trim();
  const leading = (trimmed.match(/^[\p{S}\p{P}]+/u)?.[0] ?? "").slice(0, 16);
  const trailing = (trimmed.match(/[\p{S}\p{P}]+$/u)?.[0] ?? "").slice(-16);
  return { leading, trailing };
}

function isSentenceTerminalOnly(text: string): boolean {
  return /^[.!?。！？…]+$/u.test(text);
}

function hasEquivalentSentenceTerminal(text: string): boolean {
  return /[.!?。！？…]$/u.test(text.trim());
}

function restoreSourceEdgeMarkers(sourceText: string, translatedText: string): string {
  const source = edgeMarkers(sourceText);
  if (!source.leading && !source.trailing) {
    return translatedText;
  }

  let restored = translatedText.trim();
  if (source.leading) {
    restored = `${source.leading}${restored.replace(/^[\p{S}\p{P}]+/u, "").trimStart()}`;
  }
  if (
    source.trailing &&
    !(isSentenceTerminalOnly(source.trailing) && hasEquivalentSentenceTerminal(restored))
  ) {
    restored = `${restored.replace(/[\p{S}\p{P}]+$/u, "").trimEnd()}${source.trailing}`;
  }
  return restored;
}

function isUnsupportedJapanesePregnancyTranslation(sourceText: string, translatedText: string): boolean {
  const source = sourceText.replace(/[\s　]/g, "");
  const describesHavingAChild = /(?:子供|子ども|こども)(?:が|を)?(?:でき|出来)/u.test(source);
  const explicitlyMentionsPregnancy = /(?:妊娠|身ごも|懐妊|孕)/u.test(source);
  return describesHavingAChild && !explicitlyMentionsPregnancy && /(?:임신|수태|잉태)/u.test(translatedText);
}

function isUnsupportedJapaneseAddedAction(sourceText: string, translatedText: string): boolean {
  const source = sourceText.replace(/[\s　]/g, "");
  const isNeutralRealization = /気付けば/u.test(source);
  const hasExplicitHeartOpening = /(?:心を開|心開|気持ちを開)/u.test(source);
  return isNeutralRealization && !hasExplicitHeartOpening && /마음(?:을)?\s*열/u.test(translatedText);
}

function isUnsupportedJapaneseTelepathyTranslation(sourceText: string, translatedText: string): boolean {
  return /テレパシ(?:ー|ィ)?/u.test(sourceText) && !/텔레파시/u.test(translatedText);
}

function isUnsupportedJapaneseDislikeRelation(sourceText: string, translatedText: string): boolean {
  return /人が嫌いな/u.test(sourceText.replace(/[\s　]/g, "")) && /사람(?:이|가)\s*싫/u.test(translatedText);
}

function isUnsupportedJapaneseGoalTranslation(sourceText: string, translatedText: string): boolean {
  const source = sourceText.replace(/[\s　]/g, "");
  const sportsContext = /(?:サッカー|フットボール|試合|シュート|得点)/u.test(source);
  return /ゴール/u.test(source) && !sportsContext && /골(?:까지|로|에|을|이|은|$)/u.test(translatedText);
}

function isKoreanTargetLanguage(targetLanguage: string): boolean {
  return /^(?:ko|kor|korean|한국어|kr)$/i.test(targetLanguage.trim());
}

function polishKoreanSubtitleDiction(text: string, targetLanguage: string): string {
  if (!isKoreanTargetLanguage(targetLanguage)) {
    return text;
  }
  return text.replace(/(^|[\s"'“‘([{])너가(?=$|[\s"'”’)\]},.!?…])/gu, "$1네가");
}

function polishJapaneseKoreanMeaning(sourceText: string, translatedText: string, targetLanguage: string): string {
  if (!isKoreanTargetLanguage(targetLanguage)) {
    return translatedText;
  }
  const source = sourceText.replace(/[\s　]/g, "");
  if (/BADなダンス(?:腫魔|ハマ)ったらいいじゃん/iu.test(source)) {
    return "BAD한 댄스에 빠져버리면 되잖아";
  }
  if (/[“"]?最高[”"]?で止まらないように更新したい/u.test(source)) {
    return "“최고”에서 멈추지 않도록 갱신하고 싶어";
  }
  if (/ここに居ようとして(?:る|いる)/u.test(source)) {
    return translatedText
      .replace(/여기(?:에)?\s*있으려고\s*(?:하고\s*있는|하는)/gu, "여기에 머물려는")
      .replace(/여기(?:에)?\s*머물려고\s*(?:하고\s*있는|하는)/gu, "여기에 머물려는");
  }
  return translatedText;
}

function translationCorrectionGuidance(
  segment: CaptionSegment,
  translatedText: string,
  settings: Awaited<ReturnType<typeof loadSettings>>
): string | undefined {
  const guidance: string[] = [];
  if (settings.contentMode === "lyrics" && isMissingRequiredEnglishLyricHook(segment.text, translatedText)) {
    const hooks = [...latinWordCounts(segment.text)]
      .filter(([token, count]) => PRESERVED_ENGLISH_LYRIC_HOOKS.has(token) || count >= 2)
      .map(([token, count]) => `${token} ${count}회`);
    guidance.push(`원문 영어 훅을 번역하거나 한글로 음역하지 말고 그대로 유지한다: ${hooks.join(", ")}.`);
  }
  if (isUnsupportedJapaneseTelepathyTranslation(segment.text, translatedText)) {
    guidance.push("テレパシー와 テレパシ는 반드시 텔레파시로 옮긴다.");
  }
  if (isUnsupportedJapanesePregnancyTranslation(segment.text, translatedText)) {
    guidance.push("子供ができた는 임신했다가 아니라 아이가 생겼다로 옮긴다.");
  }
  if (isUnsupportedJapaneseAddedAction(segment.text, translatedText)) {
    guidance.push("気付けば는 어느새 또는 정신 차려 보니이며, 마음을 열었다는 행동을 추가하지 않는다.");
  }
  if (isUnsupportedJapaneseDislikeRelation(segment.text, translatedText)) {
    guidance.push("人が嫌いな子는 사람이 싫은 아이가 아니라 사람을 싫어하는 아이로 옮긴다.");
  }
  if (isUnsupportedJapaneseGoalTranslation(segment.text, translatedText)) {
    guidance.push("스포츠 문맥이 아닌 ゴール은 골이 아니라 끝이나 목표로 옮긴다.");
  }
  return guidance.length > 0 ? guidance.join(" ") : undefined;
}

function sanitizeTranslatedSubtitle(
  segment: CaptionSegment,
  translatedText: string,
  settings: Awaited<ReturnType<typeof loadSettings>>
): string {
  const cleaned = normalizeSubtitleLines(translatedText);
  if (hasCorruptedSubtitleText(segment.text) || hasCorruptedSubtitleText(cleaned)) {
    return "";
  }
  const normalized = cleaned
    ? polishJapaneseKoreanMeaning(
        segment.text,
        polishKoreanSubtitleDiction(restoreSourceEdgeMarkers(segment.text, cleaned), settings.targetLanguage),
        settings.targetLanguage
      )
    : "";
  const hasAllowedLyricRefrain =
    settings.contentMode === "lyrics" && isIntentionalLyricRefrain(segment.text) && isIntentionalLyricRefrain(normalized);
  if (!normalized || isModelRefusalOrMetaText(normalized) || (hasExcessiveTextRepetition(normalized) && !hasAllowedLyricRefrain)) {
    return "";
  }
  if (settings.contentMode === "lyrics" && isMissingRequiredEnglishLyricHook(segment.text, normalized)) {
    console.debug("Blocked translation that removed an English lyric hook", {
      source: segment.text,
      translated: normalized
    });
    return "";
  }
  if (isUnsupportedJapanesePregnancyTranslation(segment.text, normalized)) {
    console.debug("Blocked unsupported pregnancy translation", { source: segment.text, translated: normalized });
    return "";
  }
  if (isUnsupportedJapaneseAddedAction(segment.text, normalized)) {
    console.debug("Blocked unsupported Japanese added action", { source: segment.text, translated: normalized });
    return "";
  }
  if (isUnsupportedJapaneseTelepathyTranslation(segment.text, normalized)) {
    console.debug("Blocked unsupported Japanese telepathy translation", { source: segment.text, translated: normalized });
    return "";
  }
  if (isUnsupportedJapaneseDislikeRelation(segment.text, normalized)) {
    console.debug("Blocked reversed Japanese dislike relation", { source: segment.text, translated: normalized });
    return "";
  }
  if (isUnsupportedJapaneseGoalTranslation(segment.text, normalized)) {
    console.debug("Blocked unsupported Japanese goal translation", { source: segment.text, translated: normalized });
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
    try {
      chrome.tabCapture.getCapturedTabs((result) => {
        if (chrome.runtime.lastError) {
          resolve([]);
          return;
        }
        resolve(result);
      });
    } catch {
      resolve([]);
    }
  });
}

async function liveCapturedTabIds(): Promise<number[]> {
  if (!(await chrome.permissions.contains({ permissions: ["tabCapture"] }))) {
    return [];
  }
  return (await getCapturedTabs()).filter(isLiveCapture).map((info) => info.tabId);
}

async function ensureTabCapturePermission(canRequest: boolean): Promise<boolean> {
  if (await chrome.permissions.contains({ permissions: ["tabCapture"] })) {
    return true;
  }
  if (!canRequest) {
    return false;
  }
  try {
    return await chrome.permissions.request({ permissions: ["tabCapture"] });
  } catch (error) {
    console.debug("Could not request tabCapture permission", error);
    return false;
  }
}

function getAudioFailureCooldown(tabId: number, videoId?: string): { until: number; error: string } | undefined {
  const cooldown = audioFailureCooldowns.get(tabId);
  if (!cooldown) {
    return undefined;
  }

  if (videoId && cooldown.videoId && cooldown.videoId !== videoId) {
    return undefined;
  }
  if (cooldown.until <= Date.now()) {
    audioFailureCooldowns.delete(tabId);
    return undefined;
  }

  return cooldown;
}

function setAudioFailureCooldown(tabId: number, error: string, videoId?: string): void {
  audioFailureCooldowns.set(tabId, {
    until: Date.now() + AUDIO_FAILURE_COOLDOWN_MS,
    error,
    videoId
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
  lyricsAssistByTab.delete(tabId);
  correctionSessionsByTab.delete(tabId);
}

function isActiveAudioSession(tabId: number, videoId: string): boolean {
  return tabId === activeAudioTabId && videoId === activeAudioVideoId;
}

async function stopAudioCaptureAfterFatalError(tabId: number, videoId: string, error: string): Promise<void> {
  if (!isActiveAudioSession(tabId, videoId)) {
    return;
  }
  setAudioFailureCooldown(tabId, error, videoId);
  await notifyTab(tabId, { type: "AUDIO_CAPTURE_STATUS", state: "error", error, videoId });
  await stopAudioCapture(tabId, videoId);
  setAudioFailureCooldown(tabId, error, videoId);
}

async function translateAndRespond(segment: CaptionSegment): Promise<MessageResponse<{ translatedText: string; provider: string }>> {
  const settings = await loadSettings();
  const effectiveSettings =
    segment.detectedContentMode && segment.detectedContentMode !== settings.contentMode
      ? { ...settings, contentMode: segment.detectedContentMode }
      : settings;
  if (!effectiveSettings.enabled) {
    return { ok: false, error: "확장프로그램이 비활성화되어 있습니다." };
  }
  if (hasCorruptedSubtitleText(segment.text)) {
    return { ok: false, error: BLOCKED_HALLUCINATION_ERROR };
  }

  const key = cacheKey(effectiveSettings, segment);
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
      let result = await translateSegment(effectiveSettings, segment);
      let translatedText = sanitizeTranslatedSubtitle(segment, result.translatedText, effectiveSettings);
      if (!translatedText) {
        const correctionGuidance = translationCorrectionGuidance(segment, result.translatedText, effectiveSettings);
        if (correctionGuidance) {
          result = await translateSegment(effectiveSettings, segment, correctionGuidance);
          translatedText = sanitizeTranslatedSubtitle(segment, result.translatedText, effectiveSettings);
        }
      }
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
  for (const key of pretranslateBudgets.keys()) {
    if (key.startsWith(prefix) && key !== exceptKey && (!keepVideoId || !key.startsWith(`${prefix}${keepVideoId}|`))) {
      pretranslateBudgets.delete(key);
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

function isHotPretranslateSegment(segment: CaptionSegment, currentTimeMs: number, futureWindowMs: number): boolean {
  return (
    segment.endMs >= currentTimeMs - HOT_PRETRANSLATE_PAST_WINDOW_MS &&
    segment.startMs <= currentTimeMs + futureWindowMs
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
    const surroundingContext = captionContextText(allSegments, index, settings);
    const contextText = [segment.contextText, surroundingContext].filter(Boolean).join("\n");
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
  const lyricsAssistedSegments = await addCaptionLyricsAssist(tabId, message.videoId, settings, message.segments, true);
  const segments = addCaptionContext(lyricsAssistedSegments, lyricsAssistedSegments, settings);
  const assistedMessage = { ...message, segments };
  const context = createCaptionCacheContext(settings, message.videoId, message.captionHash, message.trackLanguage);
  const cachedMap = await getCachedCaptionTranslations(context, segments);
  const correctionEntries = await correctionEntriesForSegments(tabId, message.videoId, segments);
  for (const entry of correctionEntries) {
    cachedMap.set(entry.id, entry.translatedText);
  }
  const cachedEntries = entriesFromCache(segments, cachedMap);
  if (correctionEntries.length > 0) {
    await notifyTab(tabId, {
      type: "PRETRANSLATE_RESULT",
      videoId: message.videoId,
      captionHash: message.captionHash,
      translations: correctionEntries,
      provider: "사용자 교정",
      translationConfigRevision: message.translationConfigRevision
    });
  }

  if (!settings.enabled || !settings.pretranslateEnabled || segments.length === 0) {
    return { ok: true, translations: cachedEntries, total: segments.length, cached: cachedEntries.length };
  }

  try {
    assertTranslationReady(settings);
  } catch (error) {
    return cachedEntries.length > 0
      ? { ok: true, translations: cachedEntries, total: segments.length, cached: cachedEntries.length }
      : { ok: false, error: getErrorMessage(error) };
  }

  const jobKey = pretranslateJobKey(tabId, context);
  const existingJob = pretranslateJobs.get(jobKey);
  if (existingJob) {
    existingJob.currentTimeMs = message.currentTimeMs;
    return { ok: true, translations: cachedEntries, total: segments.length, cached: cachedEntries.length };
  }

  cancelTabPretranslationJobs(tabId, jobKey);
  const job: PretranslateJob = { cancelled: false, currentTimeMs: message.currentTimeMs };
  pretranslateJobs.set(jobKey, job);

  void runPretranslationJob(tabId, jobKey, job, context, settings, assistedMessage, cachedMap).catch(async (error) => {
    if (pretranslateJobs.get(jobKey) === job) {
      pretranslateJobs.delete(jobKey);
    }
    await notifyTab(tabId, {
      type: "PRETRANSLATE_PROGRESS",
      videoId: message.videoId,
      captionHash: message.captionHash,
      translated: cachedMap.size,
      total: segments.length,
      translationConfigRevision: message.translationConfigRevision,
      statusText: `선번역 실패: ${getErrorMessage(error)}`
    });
  });

  return { ok: true, translations: cachedEntries, total: segments.length, cached: cachedEntries.length };
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
  const budget = pretranslateBudgets.get(jobKey) ?? { segments: 0, characters: 0 };
  pretranslateBudgets.set(jobKey, budget);
  const skippedIds = new Set<string>();
  const usesLocalTranslation = settings.translationProvider === "lmStudio" || settings.translationProvider === "ollama";
  const hotFutureWindowMs = usesLocalTranslation
    ? LOCAL_PRETRANSLATE_FUTURE_WINDOW_MS
    : HOT_PRETRANSLATE_FUTURE_WINDOW_MS;

  await notifyTab(tabId, {
    type: "PRETRANSLATE_PROGRESS",
    videoId: message.videoId,
    captionHash: message.captionHash,
    translated,
    total: message.segments.length,
    translationConfigRevision: message.translationConfigRevision,
    statusText: translated >= message.segments.length ? "캐시된 번역 자막 사용 중" : "현재 위치 자막 우선 번역 중..."
  });

  while (!job.cancelled && (usesLocalTranslation || budget.segments < MAX_REMOTE_PRETRANSLATE_SEGMENTS)) {
    const missing = prioritizeMissingSegments(message.segments, cachedMap, job.currentTimeMs).filter((segment) => !skippedIds.has(segment.id));
    if (missing.length === 0) {
      break;
    }

    const hotMissing = missing.filter((segment) => isHotPretranslateSegment(segment, job.currentTimeMs, hotFutureWindowMs));
    if (usesLocalTranslation && hotMissing.length === 0) {
      break;
    }
    const source = hotMissing.length > 0 ? hotMissing : missing;
    const batchSize = hotMissing.length > 0 ? hotPretranslateBatchSize(settings) : pretranslateBatchSize(settings);
    const remainingSegments = usesLocalTranslation
      ? batchSize
      : Math.min(batchSize, MAX_REMOTE_PRETRANSLATE_SEGMENTS - budget.segments);
    const batch = source.slice(0, remainingSegments);
    while (
      !usesLocalTranslation &&
      batch.length > 0 &&
      budget.characters + batch.reduce((total, segment) => total + segment.text.length, 0) > MAX_REMOTE_PRETRANSLATE_CHARACTERS
    ) {
      batch.pop();
    }
    if (batch.length === 0) {
      break;
    }
    budget.segments += batch.length;
    budget.characters += batch.reduce((total, segment) => total + segment.text.length, 0);
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
        const translatedText = sanitizeTranslatedSubtitle(segment, entry.translatedText, settings);
        return translatedText ? { ...entry, translatedText } : undefined;
      })
      .filter((entry): entry is CaptionTranslationEntry => Boolean(entry));

    await putCachedCaptionTranslations(context, safeTranslations, batch);
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
    if (usesLocalTranslation && !job.cancelled) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, LOCAL_PRETRANSLATE_REST_MS));
    }
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
      if (isBlockedHallucinationError(response.error)) {
        return { translations: [], provider: settings.translationProvider };
      }
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
        if (isBlockedHallucinationError(response.error)) {
          continue;
        }
        throw new Error(response.error);
      }
      translations.push({ id: segment.id, translatedText: response.translatedText });
    }
    return { translations, provider: "lmStudio" };
  }

  return translateSegments(settings, batch);
}

function audioTransportConfig(settings: TranslatorSettings): {
  audioChunkMs: number;
  useStreaming: boolean;
  streamingSttEndpoint: string;
  streamingSttModel: string;
  sourceLanguage: string;
  contentMode: string;
  speakerTurnDetection: boolean;
} {
  const useStreaming = settings.sttProvider === "whisper" && settings.streamingSttEnabled;
  const audioChunkMs =
    settings.contentMode === "lyrics"
      ? Math.max(settings.audioChunkMs, 14_000)
      : settings.contentMode === "live"
        ? Math.max(settings.audioChunkMs, 10_000)
        : settings.audioChunkMs;
  return {
    audioChunkMs: useStreaming ? audioChunkMs : Math.max(audioChunkMs, MIN_STABLE_AUDIO_CHUNK_MS),
    useStreaming,
    streamingSttEndpoint: settings.streamingSttEndpoint,
    streamingSttModel: settings.whisper.model,
    sourceLanguage: settings.sourceLanguage,
    contentMode: settings.contentMode,
    speakerTurnDetection: settings.speakerTurnDetection
  };
}

async function reconfigureAudioCaptureInternal(
  tabId: number,
  videoId: string,
  expectedVideoId?: string,
  startIfMissing = false
): Promise<MessageResponse<{ tabId: number; mode?: string }>> {
  const tabUrl = await getTabUrl(tabId);
  if (!isSupportedYouTubeUrl(tabUrl)) {
    await stopAudioCaptureInternal(tabId);
    return { ok: false, error: "YouTube 영상 탭에서만 음성 자막을 유지할 수 있습니다." };
  }

  const state = await getOffscreenAudioState();
  if (
    !state?.recording ||
    state.activeTabId !== tabId ||
    (expectedVideoId && state.activeVideoId !== expectedVideoId)
  ) {
    if (startIfMissing) {
      return startAudioCaptureInternal(undefined, tabId, videoId);
    }
    return { ok: false, error: "재구성할 활성 오디오 캡처 세션이 없습니다." };
  }

  const settings = await loadSettings();
  try {
    await assertTranscriptionReady(settings);
    assertTranslationReady(settings);
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }

  const response = await chrome.runtime.sendMessage<MessageResponse<{ mode?: string }>>({
    type: "RECONFIGURE_AUDIO_CAPTURE",
    target: "offscreen",
    tabId,
    videoId,
    expectedVideoId,
    ...audioTransportConfig(settings)
  });
  if (!response?.ok) {
    return { ok: false, error: response?.error ?? "오디오 캡처 설정을 갱신하지 못했습니다." };
  }

  activeAudioTabId = tabId;
  activeAudioVideoId = videoId;
  clearAudioQueue(tabId);
  void prepareLyricsAssist(tabId, videoId, settings);
  void correctionSession(tabId, videoId);
  await notifyTab(tabId, {
    type: "AUDIO_CAPTURE_STATUS",
    state: "recording",
    videoId,
    statusText: "음성 캡처 유지 · STT 설정 갱신됨"
  });
  return { ok: true, tabId, mode: response.mode };
}

async function reuseAudioCapture(
  tabId: number,
  videoId: string,
  state: OffscreenAudioState
): Promise<MessageResponse<{ tabId: number; mode?: string }>> {
  activeAudioTabId = tabId;
  activeAudioVideoId = videoId;
  audioFailureCooldowns.delete(tabId);
  await notifyTab(tabId, {
    type: "AUDIO_CAPTURE_STATUS",
    state: "recording",
    videoId,
    statusText: "기존 음성 캡처와 STT 연결 유지"
  });
  return { ok: true, tabId, mode: state.mode };
}

async function startAudioCaptureInternal(
  senderTabId?: number,
  requestedTabId?: number,
  requestedVideoId?: string,
  canRequestTabCapturePermission = false
): Promise<MessageResponse<{ tabId: number; mode?: string }>> {
  const tabId = requestedTabId ?? senderTabId;
  if (!tabId) {
    return { ok: false, error: "오디오를 캡처할 YouTube 탭을 찾지 못했습니다." };
  }

  const tabUrl = await getTabUrl(tabId);
  if (!isSupportedYouTubeUrl(tabUrl)) {
    return { ok: false, error: "YouTube 영상 탭에서만 음성 자막을 시작할 수 있습니다." };
  }
  const videoId = requestedVideoId ?? youtubeVideoIdFromUrl(tabUrl);
  if (!videoId) {
    return { ok: false, error: "재생 중인 YouTube 영상 ID를 확인하지 못했습니다." };
  }

  if (!(await ensureTabCapturePermission(canRequestTabCapturePermission))) {
    return {
      ok: false,
      error: "음성 캡처 권한이 없습니다. YouTube 탭에서 확장 팝업의 음성 시작 버튼을 눌러 권한을 허용하세요."
    };
  }

  const recentFailure = getAudioFailureCooldown(tabId, videoId);
  if (recentFailure) {
    const seconds = Math.max(1, Math.ceil((recentFailure.until - Date.now()) / 1000));
    return { ok: false, error: `최근 API/STT 오류 때문에 ${seconds}초 후 다시 시도하세요: ${recentFailure.error}` };
  }

  let liveTabIds = await liveCapturedTabIds();
  if (liveTabIds.includes(tabId) && (await ownsLiveAudioCapture(tabId))) {
    const state = await getOffscreenAudioState();
    if (state?.activeVideoId === videoId) {
      return reuseAudioCapture(tabId, videoId, state);
    }
    if (state?.activeVideoId) {
      return reconfigureAudioCaptureInternal(tabId, videoId, state.activeVideoId);
    }
    await stopAudioCaptureInternal(tabId);
    liveTabIds = await liveCapturedTabIds();
  }

  if (liveTabIds.includes(tabId)) {
    activeAudioTabId = undefined;
    activeAudioVideoId = undefined;
    clearAudioQueue(tabId);
  }

  if (activeAudioTabId && activeAudioTabId !== tabId) {
    await stopAudioCaptureInternal(activeAudioTabId);
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
        const state = await getOffscreenAudioState();
        if (state?.activeVideoId === videoId) {
          return reuseAudioCapture(tabId, videoId, state);
        }
        if (state?.activeVideoId) {
          return reconfigureAudioCaptureInternal(tabId, videoId, state.activeVideoId);
        }
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
  activeAudioVideoId = videoId;
  void prepareLyricsAssist(tabId, videoId, settings);
  void correctionSession(tabId, videoId);
  let offscreenResponse: MessageResponse | undefined;
  try {
    offscreenResponse = await chrome.runtime.sendMessage<MessageResponse>({
      type: "START_AUDIO_CAPTURE",
      target: "offscreen",
      tabId,
      videoId,
      streamId,
      ...audioTransportConfig(settings)
    });
  } catch (error) {
    activeAudioTabId = undefined;
    activeAudioVideoId = undefined;
    clearAudioQueue(tabId);
    await chrome.runtime
      .sendMessage({ type: "STOP_AUDIO_CAPTURE", target: "offscreen", tabId, videoId })
      .catch(() => undefined);
    throw error;
  }
  if (!offscreenResponse?.ok) {
    activeAudioTabId = undefined;
    activeAudioVideoId = undefined;
    clearAudioQueue(tabId);
    await chrome.runtime
      .sendMessage({ type: "STOP_AUDIO_CAPTURE", target: "offscreen", tabId, videoId })
      .catch(() => undefined);
    throw new Error(offscreenResponse?.error ?? "오프스크린 오디오 캡처를 시작하지 못했습니다.");
  }

  const state = await getOffscreenAudioState();
  return { ok: true, tabId, mode: state?.mode };
}

function enqueueAudioLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = audioLifecycleQueue.then(operation, operation);
  audioLifecycleQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function startAudioCapture(
  senderTabId?: number,
  requestedTabId?: number,
  requestedVideoId?: string,
  canRequestTabCapturePermission = false
): Promise<MessageResponse<{ tabId: number; mode?: string }>> {
  const tabId = requestedTabId ?? senderTabId;
  if (!tabId) {
    return { ok: false, error: "오디오를 캡처할 YouTube 탭을 찾지 못했습니다." };
  }
  const videoId = requestedVideoId ?? youtubeVideoIdFromUrl(await getTabUrl(tabId));

  if (startingAudioCapture?.tabId === tabId && startingAudioCapture.videoId === videoId) {
    return startingAudioCapture.promise;
  }

  const promise = enqueueAudioLifecycle(() =>
    startAudioCaptureInternal(undefined, tabId, videoId, canRequestTabCapturePermission)
  );
  startingAudioCapture = { tabId, videoId, promise };
  try {
    return await promise;
  } finally {
    if (startingAudioCapture?.promise === promise) {
      startingAudioCapture = undefined;
    }
  }
}

function reconfigureAudioCapture(
  tabId: number | undefined,
  videoId: string,
  expectedVideoId?: string,
  startIfMissing = false
): Promise<MessageResponse<{ tabId: number; mode?: string }>> {
  if (!tabId) {
    return Promise.resolve({ ok: false, error: "오디오를 캡처 중인 YouTube 탭을 찾지 못했습니다." });
  }
  return enqueueAudioLifecycle(() =>
    reconfigureAudioCaptureInternal(tabId, videoId, expectedVideoId, startIfMissing)
  );
}

async function stopAudioCaptureInternal(tabId?: number, expectedVideoId?: string): Promise<MessageResponse> {
  const liveTabIds = await liveCapturedTabIds();
  const targetTabId = tabId ?? activeAudioTabId ?? liveTabIds[0];
  const offscreenState = await getOffscreenAudioState();
  const stoppedVideoId = offscreenState?.activeTabId === targetTabId ? offscreenState.activeVideoId : activeAudioVideoId;
  if (expectedVideoId && stoppedVideoId !== expectedVideoId) {
    return { ok: true };
  }

  if (tabId && liveTabIds.length > 0 && !liveTabIds.includes(tabId)) {
    await notifyTab(tabId, { type: "AUDIO_CAPTURE_STATUS", state: "idle", videoId: stoppedVideoId });
    return { ok: true };
  }

  const offscreenAvailable = await hasOffscreenDocument();
  if (offscreenAvailable) {
    await chrome.runtime
      .sendMessage({
        type: "STOP_AUDIO_CAPTURE",
        target: "offscreen",
        tabId: targetTabId,
        videoId: stoppedVideoId
      })
      .catch(() => undefined);
  }

  if (targetTabId && !offscreenAvailable) {
    await notifyTab(targetTabId, { type: "AUDIO_CAPTURE_STATUS", state: "idle", videoId: stoppedVideoId });
  }
  if (!tabId || tabId === activeAudioTabId || (targetTabId && liveTabIds.includes(targetTabId))) {
    activeAudioTabId = undefined;
    activeAudioVideoId = undefined;
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

function stopAudioCapture(tabId?: number, expectedVideoId?: string): Promise<MessageResponse> {
  return enqueueAudioLifecycle(() => stopAudioCaptureInternal(tabId, expectedVideoId));
}

async function notifyTab(tabId: number, message: RuntimeMessage): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    console.debug("Tab notification failed", error);
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
    settings: toContentSettings(settings, translationConfigRevision),
    revision
  };
  await Promise.all(tabs.flatMap((tab) => (tab.id ? [notifyTab(tab.id, message)] : [])));
}

async function saveSettingsPatch(patch: Partial<TranslatorSettings>) {
  const snapshot = await patchSettings(patch);
  if ("targetLanguage" in patch) {
    correctionSessionsByTab.clear();
  }
  await broadcastContentSettings(snapshot.settings, snapshot.revision, snapshot.translationConfigRevision);
  if (
    activeAudioTabId &&
    activeAudioVideoId &&
    ("lyricsAssistEnabled" in patch || "contentMode" in patch)
  ) {
    void prepareLyricsAssist(activeAudioTabId, activeAudioVideoId, snapshot.settings);
  }
  if (!snapshot.settings.enabled || snapshot.settings.inputMode === "captions") {
    await stopAudioCapture();
  }
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

chrome.tabs.onActivated.addListener((activeInfo) => {
  void updateActionAvailability(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const tabUrl = changeInfo.url ?? tab.url;
  if (changeInfo.url || changeInfo.status === "loading") {
    void stopAudioCaptureOutsideYouTube(tabId, tabUrl);
  }
  if (tabUrl) {
    void updateActionAvailability(tabId, tabUrl);
  }
});

void initializeActionAvailability();
void stopStaleAudioCaptureOnStartup();

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

async function handleAudioChunk(message: AudioChunkMessage): Promise<MessageResponse> {
  if (message.tabId !== activeAudioTabId || message.videoId !== activeAudioVideoId) {
    return { ok: true };
  }
  if (getAudioFailureCooldown(message.tabId, message.videoId)) {
    return { ok: true };
  }

  const now = Date.now();
  const lastProcessedAt = audioLastProcessedAt.get(message.tabId) ?? 0;
  if (now - lastProcessedAt < AUDIO_MIN_PROCESS_INTERVAL_MS) {
    return { ok: true };
  }

  const existingQueue = audioQueues.get(message.tabId);
  const queue =
    existingQueue?.videoId === message.videoId
      ? existingQueue
      : { videoId: message.videoId, processing: false };
  if (queue.processing) {
    queue.pending = message;
    audioQueues.set(message.tabId, queue);
    return { ok: true };
  }

  queue.processing = true;
  audioQueues.set(message.tabId, queue);

  void processQueuedAudio(message.tabId, message, queue).catch(async (error) => {
    if (audioQueues.get(message.tabId) === queue) {
      audioQueues.delete(message.tabId);
    }
    if (!isActiveAudioSession(message.tabId, message.videoId)) {
      return;
    }
    await notifyTab(message.tabId, {
      type: "TRANSLATION_ERROR",
      error: getErrorMessage(error),
      videoId: message.videoId
    });
  });
  return { ok: true };
}

async function processQueuedAudio(
  tabId: number,
  initialMessage: AudioChunkMessage,
  ownedQueue: AudioQueueState
): Promise<void> {
  try {
    let message: AudioChunkMessage | undefined = initialMessage;
    while (message) {
      await processAudioChunk(message);
      if (audioQueues.get(tabId) !== ownedQueue) {
        return;
      }
      if (getAudioFailureCooldown(tabId, message.videoId)) {
        ownedQueue.pending = undefined;
        ownedQueue.processing = false;
        return;
      }
      message = ownedQueue.pending;
      ownedQueue.pending = undefined;
      ownedQueue.processing = Boolean(message);
    }

    if (audioQueues.get(tabId) === ownedQueue) {
      ownedQueue.processing = false;
      ownedQueue.pending = undefined;
    }
  } catch (error) {
    if (audioQueues.get(tabId) === ownedQueue) {
      ownedQueue.processing = false;
      ownedQueue.pending = undefined;
    }
    throw error;
  }
}

async function processAudioChunk(message: Extract<RuntimeMessage, { type: "AUDIO_CHUNK" }>): Promise<void> {
  const settings = await loadSettings();
  if (!settings.enabled || message.tabId !== activeAudioTabId || message.videoId !== activeAudioVideoId) {
    return;
  }

  let transcript: string;
  try {
    audioLastProcessedAt.set(message.tabId, Date.now());
    transcript = sanitizeAudioTranscript(
      await transcribeAudio(settings, base64ToArrayBuffer(message.audioBase64), message.mimeType),
      settings.contentMode === "lyrics" ||
        (settings.lyricsAssistEnabled && settings.contentMode !== "spoken")
    );
    audioFailureCooldowns.delete(message.tabId);
  } catch (error) {
    if (!isActiveAudioSession(message.tabId, message.videoId)) {
      return;
    }
    const errorMessage = getErrorMessage(error);
    setAudioFailureCooldown(message.tabId, errorMessage, message.videoId);
    await notifyTab(message.tabId, {
      type: "TRANSLATION_ERROR",
      error: `STT 오류: ${errorMessage}`,
      videoId: message.videoId
    });
    if (shouldStopCaptureAfterApiError(errorMessage)) {
      await stopAudioCaptureAfterFatalError(message.tabId, message.videoId, errorMessage);
    }
    return;
  }
  if (message.tabId !== activeAudioTabId || message.videoId !== activeAudioVideoId) {
    return;
  }

  if (!transcript) {
    const lastNoticeAt = audioNoSpeechNotices.get(message.tabId) ?? 0;
    if (Date.now() - lastNoticeAt > AUDIO_NO_SPEECH_NOTICE_MS) {
      audioNoSpeechNotices.set(message.tabId, Date.now());
      await notifyTab(message.tabId, {
        type: "AUDIO_CAPTURE_STATUS",
        state: "recording",
        videoId: message.videoId,
        statusText: "음성 캡처 중... 인식된 말소리를 기다리는 중"
      });
    }
    return;
  }
  audioNoSpeechNotices.delete(message.tabId);

  const now = Date.now();
  const rawSegment: CaptionSegment = {
    id: `audio-${now}`,
    source: "audioStt",
    startMs: now,
    endMs: now + Math.max(settings.audioChunkMs, 2200),
    text: transcript
  };
  const segment = assistLyricsSegment(lyricsAssistByTab.get(message.tabId), rawSegment, settings.contentMode, true);
  if (segment.detectedContentMode === "lyrics") {
    notifyLyricsAssistStatus(message.tabId, message.videoId, "applied", lyricsAssistByTab.get(message.tabId)?.candidates.length);
  }

  await notifyTab(message.tabId, { type: "AUDIO_TRANSCRIPT", tabId: message.tabId, videoId: message.videoId, segment });

  const correction = await matchUserCorrection(message.tabId, message.videoId, segment, true);
  if (correction) {
    if (isActiveAudioSession(message.tabId, message.videoId)) {
      rememberAudioContext(message.tabId, segment.text);
      await notifyTab(message.tabId, {
        type: "TRANSLATION_READY",
        segment,
        translatedText: correction.translatedText,
        provider: correction.provider,
        videoId: message.videoId
      });
    }
    return;
  }

  const translation = await translateAndRespond(segmentWithAudioContext(message.tabId, segment));
  if (!isActiveAudioSession(message.tabId, message.videoId)) {
    return;
  }
  if (translation.ok) {
    rememberAudioContext(message.tabId, segment.text);
    await notifyTab(message.tabId, {
      type: "TRANSLATION_READY",
      segment,
      translatedText: translation.translatedText,
      provider: translation.provider,
      videoId: message.videoId
    });
  } else {
    if (isBlockedHallucinationError(translation.error)) {
      return;
    }
    await notifyTab(message.tabId, { type: "TRANSLATION_ERROR", segment, error: translation.error, videoId: message.videoId });
    if (shouldStopCaptureAfterApiError(translation.error)) {
      await stopAudioCaptureAfterFatalError(message.tabId, message.videoId, translation.error);
    }
  }
}

async function processStreamTranscript(message: Extract<RuntimeMessage, { type: "STREAM_STT_TRANSCRIPT" }>): Promise<void> {
  const settings = await loadSettings();
  if (!settings.enabled || message.tabId !== activeAudioTabId || message.videoId !== activeAudioVideoId) {
    return;
  }
  const sanitizedText = sanitizeAudioTranscript(
    message.segment.text,
    settings.contentMode === "lyrics" ||
      (settings.lyricsAssistEnabled && settings.contentMode !== "spoken")
  );
  if (!sanitizedText) {
    return;
  }
  const rawSegment = sanitizedText === message.segment.text ? message.segment : { ...message.segment, text: sanitizedText };
  const segment = assistLyricsSegment(
    lyricsAssistByTab.get(message.tabId),
    rawSegment,
    settings.contentMode,
    message.isFinal
  );
  if (segment.detectedContentMode === "lyrics") {
    notifyLyricsAssistStatus(message.tabId, message.videoId, "applied", lyricsAssistByTab.get(message.tabId)?.candidates.length);
  }

  if (!message.isFinal) {
    await notifyTab(message.tabId, { ...message, segment });
    if (settings.translationProvider === "openai" && shouldTranslateStreamPartial(message.tabId, segment)) {
      void translateStreamSegment(message.tabId, message.videoId, segment, false);
    }
    return;
  }

  const normalized = normalizeText(segment.text);
  if (!normalized) {
    return;
  }
  const previous = lastFinalTranscriptByTab.get(message.tabId);
  const now = Date.now();
  if (
    segment.detectedContentMode !== "lyrics" &&
    previous?.text === normalized &&
    now - previous.at < DUPLICATE_FINAL_TRANSCRIPT_WINDOW_MS
  ) {
    return;
  }
  lastFinalTranscriptByTab.set(message.tabId, { text: normalized, at: now });

  await notifyTab(message.tabId, { type: "AUDIO_TRANSCRIPT", tabId: message.tabId, videoId: message.videoId, segment });

  await translateStreamSegment(message.tabId, message.videoId, segment, true);
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

async function translateStreamSegment(tabId: number, videoId: string, segment: CaptionSegment, isFinal: boolean): Promise<void> {
  const generation = (streamTranslationGenerationByTab.get(tabId) ?? 0) + 1;
  streamTranslationGenerationByTab.set(tabId, generation);

  const correction = await matchUserCorrection(tabId, videoId, segment, isFinal);
  if (
    correction &&
    streamTranslationGenerationByTab.get(tabId) === generation &&
    tabId === activeAudioTabId &&
    videoId === activeAudioVideoId
  ) {
    if (isFinal) {
      rememberAudioContext(tabId, segment.text);
    }
    await notifyTab(tabId, {
      type: "TRANSLATION_READY",
      segment,
      translatedText: correction.translatedText,
      provider: isFinal ? correction.provider : `${correction.provider} (partial)`,
      videoId
    });
    return;
  }

  const translation = await translateAndRespond(segmentWithAudioContext(tabId, segment));
  if (
    streamTranslationGenerationByTab.get(tabId) !== generation ||
    tabId !== activeAudioTabId ||
    videoId !== activeAudioVideoId
  ) {
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
      provider: isFinal ? translation.provider : `${translation.provider} (partial)`,
      videoId
    });
  } else {
    if (isBlockedHallucinationError(translation.error)) {
      return;
    }
    if (isFinal) {
      await notifyTab(tabId, { type: "TRANSLATION_ERROR", segment, error: translation.error, videoId });
      if (shouldStopCaptureAfterApiError(translation.error)) {
        await stopAudioCaptureAfterFatalError(tabId, videoId, translation.error);
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
  if ("target" in message && message.target === "offscreen") {
    return false;
  }

  void (async () => {
    try {
      if (message.type === "GET_CORRECTION_STATUS") {
        const [preferences, storedSongs] = await Promise.all([getCorrectionPreferences(), correctionLibrary()]);
        sendResponse({ ok: true, enabled: preferences.enabled, count: storedSongs.length });
        return;
      }

      if (message.type === "SET_CORRECTION_ENABLED") {
        await setCorrectionPreferences({ enabled: message.enabled });
        invalidateCorrectionLibrary();
        for (const job of pretranslateJobs.values()) {
          job.cancelled = true;
        }
        pretranslateJobs.clear();
        await broadcastCorrectionLibraryUpdated();
        sendResponse({ ok: true, enabled: message.enabled });
        return;
      }

      if (message.type === "CORRECTION_LIBRARY_UPDATED") {
        invalidateCorrectionLibrary();
        for (const job of pretranslateJobs.values()) {
          job.cancelled = true;
        }
        pretranslateJobs.clear();
        await broadcastCorrectionLibraryUpdated();
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "GET_CURRENT_YOUTUBE_MEDIA") {
        const media = await currentYouTubeMedia();
        sendResponse(media ? { ok: true, media } : { ok: false, error: "재생 중인 YouTube 영상을 찾지 못했습니다." });
        return;
      }

      if (message.type === "OPEN_CORRECTIONS_PAGE") {
        await chrome.tabs.create({ url: chrome.runtime.getURL("corrections.html") });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "GET_SETTINGS") {
        const snapshot = await loadSettingsSnapshot();
        sendResponse({
          ok: true,
          settings: toContentSettings(snapshot.settings, snapshot.translationConfigRevision),
          revision: snapshot.revision
        });
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

      if (message.type === "PREPARE_CAPTION_LYRICS_ASSIST") {
        if (!sender.tab?.id) {
          sendResponse({ ok: false, error: "YouTube 탭을 찾지 못했습니다." });
          return;
        }
        const settings = await loadSettings();
        startCaptionLyricsAssist(sender.tab.id, message.videoId, settings);
        startCorrectionSession(sender.tab.id, message.videoId);
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "CAPTION_SEGMENT") {
        const tabId = sender.tab?.id;
        const videoId = youtubeVideoIdFromUrl(sender.tab?.url);
        const settings = await loadSettings();
        const [segment] =
          tabId && videoId
            ? await addCaptionLyricsAssist(tabId, videoId, settings, [message.segment])
            : [message.segment];
        const correction =
          settings.enabled && tabId && videoId ? await matchUserCorrection(tabId, videoId, segment, true) : undefined;
        if (correction) {
          sendResponse({
            ok: true,
            translatedText: correction.translatedText,
            provider: correction.provider
          });
          return;
        }
        sendResponse(await translateAndRespond(segment));
        return;
      }

      if (message.type === "PRETRANSLATE_CAPTIONS") {
        sendResponse(await handlePretranslateCaptions(message, sender.tab?.id));
        return;
      }

      if (message.type === "START_AUDIO_CAPTURE") {
        sendResponse(
          await startAudioCapture(
            sender.tab?.id,
            message.tabId,
            message.videoId,
            Boolean(message.ensureTabCapturePermission)
          )
        );
        return;
      }

      if (message.type === "RECONFIGURE_AUDIO_CAPTURE") {
        sendResponse(
          await reconfigureAudioCapture(
            message.tabId ?? sender.tab?.id,
            message.videoId,
            message.expectedVideoId,
            Boolean(message.startIfMissing)
          )
        );
        return;
      }

      if (message.type === "RESET_AUDIO_CAPTURE_BUFFER") {
        const tabId = message.tabId ?? sender.tab?.id;
        if (!tabId || tabId !== activeAudioTabId || message.videoId !== activeAudioVideoId) {
          sendResponse({ ok: true });
          return;
        }
        const response = await chrome.runtime.sendMessage<MessageResponse>({
          type: "RESET_AUDIO_CAPTURE_BUFFER",
          target: "offscreen",
          tabId,
          videoId: message.videoId
        });
        sendResponse(response ?? { ok: true });
        return;
      }

      if (message.type === "STOP_AUDIO_CAPTURE") {
        sendResponse(await stopAudioCapture(message.tabId ?? sender.tab?.id, message.videoId));
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
        if (
          !targetTabId ||
          !message.videoId ||
          targetTabId !== activeAudioTabId ||
          message.videoId !== activeAudioVideoId
        ) {
          sendResponse({ ok: true });
          return;
        }
        await notifyTab(targetTabId, message);
        if (message.state === "idle" || message.state === "error") {
          activeAudioTabId = undefined;
          activeAudioVideoId = undefined;
          clearAudioQueue(targetTabId);
        }
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "MINI_CONTROL_UPDATE") {
        const snapshot = await saveSettingsPatch(message.patch);
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
