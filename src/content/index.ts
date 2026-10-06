import type { CaptionSegment, ContentSettings, MiniControlSettingsPatch, PageCaptionSnapshot } from "../shared/types";
import type { CaptionTranslationEntry, MessageResponse, RuntimeMessage } from "../shared/messages";
import { TranslatorOverlay, findPlayerElement, findVideoElement } from "./overlay";
import {
  fetchTimedTextSegments,
  fetchTimedTextSegmentsWithMetadata,
  getCurrentVideoId,
  getCurrentTimedTextSegment,
  getSelectedOfficialCaptionTrackKey,
  hashCaptionSegments,
  isYouTubeAutoTranslationActive,
  isYouTubeWatchPage,
  readVisibleCaptionSegment,
  resetTimedTextCursor
} from "./youtubeCaptions";
const SETTINGS_KEY = "translatorSettings";
const BLOCKED_HALLUCINATION_ERROR = "환각 의심 번역 결과를 차단했습니다.";
const CONTENT_SCRIPT_VERSION = 28;
const CONTENT_BOOTSTRAP_FLAG = "__yt_live_translator_content_bootstrapped__";
const overlay = new TranslatorOverlay();
const AUDIO_FALLBACK_INITIAL_WAIT_MS = 2200;
const AUDIO_FALLBACK_NO_CAPTION_WAIT_MS = 250;
const AUDIO_FALLBACK_STALE_CAPTION_MS = 4200;
const TIMED_TEXT_RETRY_MS = 3000;
const TIMED_TEXT_SELECTION_CHECK_MS = 250;
const TIMED_TEXT_TRANSLATION_PREFETCH_MS = 4000;
const PRETRANSLATE_RETRY_COOLDOWN_MS = 15_000;
const PRETRANSLATE_PRIORITY_BUCKET_MS = 5_000;
const OVERLAY_REFRESH_DELAY_MS = 100;
const FULLSCREEN_AUDIO_RESUME_DELAY_MS = 180;
const FULLSCREEN_AUDIO_FALLBACK_MS = 1500;
const MANUAL_AUDIO_START_PENDING_MS = 3500;
const OFFICIAL_CAPTION_DOM_READ_DELAY_MS = 30;
const OFFICIAL_TIMED_TEXT_GRACE_MS = 650;
const VIDEO_SESSION_CAPTION_RETRY_DELAYS_MS = [0, 450, 1800, 4200, 8000];
const CAPTION_TRANSLATION_RETRY_MS = 3000;
const OVERLAY_HOST_SELECTOR = "#yt-live-translator-overlay";

let settings: ContentSettings;
let settingsRevision = -1;
let timedTextSegments: Awaited<ReturnType<typeof fetchTimedTextSegments>> = [];
let timedTextVideoId = "";
let timedTextCaptionHash = "";
let timedTextTrackLanguage = "auto";
let timedTextTrackKey = "";
let timedTextTranslations = new Map<string, string>();
let timedTextSegmentIndexById = new Map<string, number>();
let pretranslateRequestKey = "";
let pretranslateRetryBlockedUntil = 0;
let currentUrl = location.href;
let activeVideoId = "";
let lyricsAssistStatus = "";
let correctionMatchStatus = "";
let lastSentKey = "";
let lastCaptionSeenAt = 0;
let audioCaptureRequested = false;
let audioStopRequested = false;
let audioCaptureSuppressed = false;
let timedTextLoadToken = 0;
let timedTextLoading = false;
let timedTextLoadStartedAt = 0;
let lastTimedTextAttemptAt = 0;
let lastTimedTextNoSourceAt = 0;
let lastTimedTextSelectionCheckAt = 0;
let tickInProgress = false;
let stoppingAudioCapture = false;
let audioStartBlockedUntil = 0;
let manualAudioStartPendingUntil = 0;
let overlayRefreshTimer: number | undefined;
let officialCaptionDomReadTimer: number | undefined;
let fullscreenAudioResumeTimer: number | undefined;
let resumeAudioAfterFullscreenIntentRequested = false;
let captionTrackRefreshTimers: number[] = [];
let videoSessionCaptionLoadTimers: number[] = [];
let pendingTimedTextTrackKey = "";
let lastVisibleOfficialCaptionKey = "";
let pageCaptionSnapshot: PageCaptionSnapshot | undefined;
let observedVideoElement: HTMLVideoElement | null = null;
let captionRequestsInFlight = new Set<string>();
let blockedCaptionRequestKeys = new Set<string>();
let captionRequestRetryAfter = new Map<string, number>();

async function loadContentSettings(): Promise<{ settings: ContentSettings; revision: number }> {
  const response = await chrome.runtime.sendMessage<MessageResponse<{ settings: ContentSettings; revision: number }>>({
    type: "GET_SETTINGS"
  });
  if (response?.ok) {
    return { settings: response.settings, revision: response.revision };
  }
  throw new Error(response?.error ?? "설정을 읽지 못했습니다. 확장프로그램을 새로고침해 주세요.");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBlockedTranslationError(error?: string): boolean {
  return Boolean(error && (error === BLOCKED_HALLUCINATION_ERROR || error.includes(BLOCKED_HALLUCINATION_ERROR)));
}

function segmentKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function captionRequestKey(segment: CaptionSegment): string {
  return `${activeVideoId}:${segment.source}:${segment.id}:${segmentKey(segment.text)}`;
}

function translatedSegmentDisplayKey(segment: CaptionSegment, translatedText: string): string {
  return `translated:${segment.id}:${segmentKey(translatedText)}`;
}

function compactStatusText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 70 ? `${normalized.slice(0, 70)}...` : normalized;
}

function captionContextText(index: number): string | undefined {
  // Lyrics need both the lead-in and the following line to resolve imagery
  // and omitted subjects, while still keeping one low-latency request.
  const contextSegmentCount = settings.contentMode === "lyrics" ? 2 : settings.translationProvider === "lmStudio" ? 1 : 2;
  const previous = timedTextSegments
    .slice(Math.max(0, index - contextSegmentCount), index)
    .map((segment) => segment.text.trim())
    .filter(Boolean);
  const next = timedTextSegments
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

function withTimedTextContext(segment: CaptionSegment): CaptionSegment {
  if (segment.source !== "youtubeTimedText") {
    return segment;
  }
  const index = timedTextSegmentIndexById.get(segment.id);
  if (index === undefined) {
    return segment;
  }
  const contextText = captionContextText(index);
  return contextText ? { ...segment, contextText } : segment;
}

function mergeTimedTextTranslations(translations: CaptionTranslationEntry[]): void {
  for (const translation of translations) {
    if (translation.id && translation.translatedText) {
      timedTextTranslations.set(translation.id, translation.translatedText);
    }
  }
}

function resetTimedTextState(): void {
  timedTextSegments = [];
  timedTextSegmentIndexById = new Map();
  timedTextVideoId = "";
  timedTextCaptionHash = "";
  timedTextTrackLanguage = "auto";
  timedTextTrackKey = "";
  timedTextTranslations = new Map();
  pretranslateRequestKey = "";
  pretranslateRetryBlockedUntil = 0;
  lastVisibleOfficialCaptionKey = "";
  pageCaptionSnapshot = undefined;
  resetTimedTextCursor();
}

async function requestPageCaptionSnapshot(videoId: string): Promise<PageCaptionSnapshot | undefined> {
  try {
    const response = await chrome.runtime.sendMessage<MessageResponse<{ snapshot?: PageCaptionSnapshot }>>({
      type: "GET_PAGE_CAPTION_SNAPSHOT",
      videoId
    });
    return response?.ok && response.snapshot?.videoId === videoId ? response.snapshot : undefined;
  } catch (error) {
    console.debug("Page caption snapshot request failed", error);
    return undefined;
  }
}

function prepareCaptionLyricsAssist(videoId: string): void {
  if (!videoId || !settings.lyricsAssistEnabled || settings.inputMode === "audio") {
    return;
  }
  void chrome.runtime
    .sendMessage({ type: "PREPARE_CAPTION_LYRICS_ASSIST", videoId })
    .catch((error) => console.debug("Caption lyrics assist preparation failed", error));
}

function currentWatchVideoId(): string {
  return getCurrentVideoId() ?? "";
}

function clearCaptionTrackRefreshTimers(): void {
  for (const timer of captionTrackRefreshTimers) {
    window.clearTimeout(timer);
  }
  captionTrackRefreshTimers = [];
}

function clearVideoSessionCaptionLoadTimers(): void {
  for (const timer of videoSessionCaptionLoadTimers) {
    window.clearTimeout(timer);
  }
  videoSessionCaptionLoadTimers = [];
}

function scheduleVideoSessionCaptionLoads(videoId: string): void {
  clearVideoSessionCaptionLoadTimers();
  if (!settings.enabled || settings.inputMode === "audio" || !videoId) {
    return;
  }

  for (const delayMs of VIDEO_SESSION_CAPTION_RETRY_DELAYS_MS) {
    const timer = window.setTimeout(() => {
      videoSessionCaptionLoadTimers = videoSessionCaptionLoadTimers.filter((scheduled) => scheduled !== timer);
      if (
        videoId !== activeVideoId ||
        videoId !== currentWatchVideoId() ||
        timedTextSegments.length > 0 ||
        timedTextLoading ||
        !settings.enabled ||
        settings.inputMode === "audio"
      ) {
        return;
      }
      void loadTimedText(videoId);
    }, delayMs);
    videoSessionCaptionLoadTimers.push(timer);
  }
}

async function cancelPretranslation(keepVideoId?: string): Promise<void> {
  await chrome.runtime.sendMessage({ type: "CANCEL_PRETRANSLATION", keepVideoId }).catch(() => undefined);
}

function beginVideoSession(videoId: string): void {
  const previousVideoId = activeVideoId;
  void cancelPretranslation(videoId);
  activeVideoId = videoId;
  lyricsAssistStatus = "";
  correctionMatchStatus = "";
  timedTextLoadToken += 1;
  timedTextLoading = false;
  timedTextLoadStartedAt = 0;
  lastSentKey = "";
  lastCaptionSeenAt = 0;
  lastTimedTextNoSourceAt = 0;
  pendingTimedTextTrackKey = "";
  lastTimedTextSelectionCheckAt = 0;
  audioStartBlockedUntil = 0;
  manualAudioStartPendingUntil = 0;
  audioCaptureSuppressed = false;
  captionRequestsInFlight = new Set();
  blockedCaptionRequestKeys = new Set();
  captionRequestRetryAfter = new Map();
  resetTimedTextState();
  clearCaptionTrackRefreshTimers();
  clearVideoSessionCaptionLoadTimers();
  observedVideoElement = findVideoElement();
  if (audioCaptureRequested) {
    if (videoId) {
      void reconfigureAudioFallback(previousVideoId);
    } else {
      void stopAudioFallback(false, previousVideoId);
    }
  }
  overlay.clear();
  scheduleOverlayRefresh();

  if (settings.enabled && videoId && settings.inputMode !== "audio") {
    overlay.showStatus("새 영상의 공식 자막을 확인하는 중...", settings);
    scheduleVideoSessionCaptionLoads(videoId);
  }
}

function currentVideoTimeMs(): number {
  return Math.round((findVideoElement()?.currentTime ?? 0) * 1000);
}

function videoCanProduceAudio(): boolean {
  const video = findVideoElement();
  if (!video || video.readyState === 0 || video.paused || video.ended) {
    return false;
  }

  if (Number.isFinite(video.duration) && video.duration > 1 && video.duration - video.currentTime < 0.5) {
    return false;
  }

  return true;
}

function videoPlaybackEnded(): boolean {
  const video = findVideoElement();
  if (!video) {
    return false;
  }
  return Boolean(
    video.ended ||
      (Number.isFinite(video.duration) && video.duration > 1 && video.duration - video.currentTime < 0.5)
  );
}

function shouldAcceptAudioSegment(segment?: CaptionSegment): boolean {
  if (segment?.source !== "audioStt") {
    return true;
  }

  return Boolean(
    settings.enabled &&
      audioCaptureRequested &&
      !audioStopRequested &&
      !audioCaptureSuppressed &&
      isYouTubeWatchPage() &&
      (settings.inputMode === "audio" || timedTextSegments.length === 0)
  );
}

function contentModeStatusLabel(): string {
  switch (settings.contentMode) {
    case "lyrics":
      return "노래";
    case "live":
      return "라이브";
    case "spoken":
      return "일반";
    default:
      return "자동";
  }
}

function withLyricsAssistStatus(text: string): string {
  return [correctionMatchStatus, lyricsAssistStatus, text].filter(Boolean).join(" · ");
}

function controlStatusText(): string {
  if (!settings.enabled) {
    return withLyricsAssistStatus("번역 꺼짐");
  }
  const mode = contentModeStatusLabel();
  const turnMode = settings.speakerTurnDetection && settings.contentMode !== "lyrics" ? " · 발화 분리" : "";
  if (settings.inputMode === "captions") {
    return withLyricsAssistStatus(`선택한 공식 자막만 사용 · ${mode}${turnMode}`);
  }
  if (timedTextSegments.length > 0) {
    return withLyricsAssistStatus(
      `선택한 공식 자막 ${timedTextTranslations.size}/${timedTextSegments.length} · ${mode}${turnMode}`
    );
  }
  if (audioCaptureRequested) {
    const sttMode = settings.streamingSttEnabled && settings.sttProvider === "whisper" ? "로컬 스트리밍 STT" : "음성 STT";
    return withLyricsAssistStatus(`${sttMode} · ${mode}${turnMode}`);
  }
  return withLyricsAssistStatus(`음성 STT 대기 · ${mode}${turnMode}`);
}

function ensureOverlay(): void {
  if (!isYouTubeWatchPage()) {
    overlay.destroy();
    return;
  }
  overlay.ensure(settings);
  overlay.bindMiniControls((action) => {
    void handleMiniControl(action);
  });
  overlay.setControlStatus(controlStatusText(), settings);
}

function scheduleOverlayRefresh(delayMs = OVERLAY_REFRESH_DELAY_MS): void {
  if (overlayRefreshTimer !== undefined) {
    return;
  }
  overlayRefreshTimer = window.setTimeout(() => {
    overlayRefreshTimer = undefined;
    if (settings.enabled) {
      ensureOverlay();
    }
  }, delayMs);
}

function showAudioStatus(text: string): void {
  overlay.reconcilePlacement();
  overlay.showStatus(text, settings);
}

function setAudioControlStatus(text: string): void {
  overlay.reconcilePlacement();
  overlay.setControlStatus(text, settings);
}

function showAudioTranslation(
  videoId: string | undefined,
  segment: CaptionSegment,
  translatedText: string,
  provider: string
): void {
  if (settings.enabled && (!videoId || videoId === activeVideoId) && shouldAcceptAudioSegment(segment)) {
    overlay.reconcilePlacement();
    overlay.showTranslation(segment, translatedText, provider, settings, false);
  }
}

function showAudioSegmentError(videoId: string | undefined, segment: CaptionSegment, error: string): void {
  if (settings.enabled && (!videoId || videoId === activeVideoId) && shouldAcceptAudioSegment(segment)) {
    overlay.showSegmentError(segment, error, settings, false);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function updateSettingsFromMini(patch: MiniControlSettingsPatch): Promise<void> {
  const response = await chrome.runtime.sendMessage<MessageResponse<{ settings: ContentSettings; revision: number }>>({
    type: "MINI_CONTROL_UPDATE",
    patch
  });
  if (response?.ok) {
    applySettingsUpdate(response.settings, response.revision);
  } else {
    overlay.showError(response?.error ?? "미니 컨트롤 설정 저장에 실패했습니다.", settings);
  }
}

async function handleMiniControl(action: string): Promise<void> {
  switch (action) {
    case "toggle":
      await updateSettingsFromMini({ enabled: !settings.enabled });
      if (settings.enabled) {
        overlay.setControlStatus("켜짐", settings);
      }
      return;
    case "collapse":
      settings = { ...settings, miniControlsCollapsed: !settings.miniControlsCollapsed };
      overlay.applySettings(settings);
      await updateSettingsFromMini({ miniControlsCollapsed: settings.miniControlsCollapsed });
      return;
    case "source":
      await updateSettingsFromMini({
        overlayStyle: { ...settings.overlayStyle, showSourceText: !settings.overlayStyle.showSourceText }
      });
      return;
    case "inputMode":
      await updateSettingsFromMini({
        inputMode:
          settings.inputMode === "captions"
            ? "captionsThenAudio"
            : settings.inputMode === "captionsThenAudio"
              ? "audio"
              : "captions"
      });
      return;
    case "lyrics":
      await updateSettingsFromMini({ contentMode: settings.contentMode === "lyrics" ? "spoken" : "lyrics" });
      return;
    case "live":
      await updateSettingsFromMini({ contentMode: settings.contentMode === "live" ? "spoken" : "live" });
      return;
    case "fontDown":
      await updateSettingsFromMini({
        overlayStyle: { ...settings.overlayStyle, fontSize: clamp(settings.overlayStyle.fontSize - 2, 14, 42) }
      });
      return;
    case "fontUp":
      await updateSettingsFromMini({
        overlayStyle: { ...settings.overlayStyle, fontSize: clamp(settings.overlayStyle.fontSize + 2, 14, 42) }
      });
      return;
    case "moveUp":
      await updateSettingsFromMini({
        overlayStyle: { ...settings.overlayStyle, bottomOffset: clamp(settings.overlayStyle.bottomOffset + 8, 32, 180) }
      });
      return;
    case "moveDown":
      await updateSettingsFromMini({
        overlayStyle: { ...settings.overlayStyle, bottomOffset: clamp(settings.overlayStyle.bottomOffset - 8, 32, 180) }
      });
      return;
    case "retry":
      audioStopRequested = false;
      audioCaptureSuppressed = false;
      setAudioControlStatus("음성 STT 재시작 중");
      await chrome.runtime.sendMessage({ type: "RESET_AUDIO_CAPTURE_COOLDOWN" }).catch(() => undefined);
      audioStartBlockedUntil = 0;
      await reconfigureAudioFallback(undefined, true);
      return;
    case "options":
      await chrome.runtime.sendMessage({ type: "OPEN_OPTIONS_PAGE" }).catch(() => undefined);
      return;
    default:
      return;
  }
}

async function requestPretranslation(): Promise<void> {
  if (
    !settings.enabled ||
    !settings.pretranslateEnabled ||
    !timedTextVideoId ||
    !timedTextCaptionHash ||
    timedTextSegments.length === 0 ||
    Date.now() < pretranslateRetryBlockedUntil
  ) {
    return;
  }

  const priorityBucket = Math.floor(currentVideoTimeMs() / PRETRANSLATE_PRIORITY_BUCKET_MS);
  const requestVideoId = timedTextVideoId;
  const requestCaptionHash = timedTextCaptionHash;
  const requestTranslationConfigRevision = settings.translationConfigRevision;
  const requestKey = `${requestVideoId}:${requestCaptionHash}:${settings.targetLanguage}:${settings.translationProvider}:${requestTranslationConfigRevision}:${settings.contentMode}:${priorityBucket}`;
  if (requestKey === pretranslateRequestKey) {
    return;
  }
  pretranslateRequestKey = requestKey;

  try {
    const response = await chrome.runtime.sendMessage<
      MessageResponse<{ translations: CaptionTranslationEntry[]; total: number; cached: number }>
    >({
      type: "PRETRANSLATE_CAPTIONS",
      videoId: requestVideoId,
      captionHash: requestCaptionHash,
      trackLanguage: timedTextTrackLanguage,
      currentTimeMs: currentVideoTimeMs(),
      translationConfigRevision: requestTranslationConfigRevision,
      segments: timedTextSegments
    });
    if (
      requestVideoId !== timedTextVideoId ||
      requestCaptionHash !== timedTextCaptionHash ||
      requestTranslationConfigRevision !== settings.translationConfigRevision
    ) {
      return;
    }
    if (response?.ok) {
      mergeTimedTextTranslations(response.translations);
      if (response.total > 0 && response.cached > 0) {
        overlay.showStatus(`캐시된 번역 자막 ${response.cached}/${response.total}`, settings);
      }
    } else if (response && !response.ok) {
      pretranslateRequestKey = "";
      pretranslateRetryBlockedUntil = Date.now() + PRETRANSLATE_RETRY_COOLDOWN_MS;
      overlay.showError(response.error, settings);
    }
  } catch (error) {
    pretranslateRequestKey = "";
    pretranslateRetryBlockedUntil = Date.now() + PRETRANSLATE_RETRY_COOLDOWN_MS;
    console.debug("Caption pretranslation request failed", error);
  }
}

function isCurrentTimedTextSegment(segment: CaptionSegment): boolean {
  if (segment.source !== "youtubeTimedText") {
    return false;
  }
  return getCurrentTimedTextSegment(timedTextSegments, settings)?.id === segment.id;
}

function isCurrentVisibleOfficialCaption(segment: CaptionSegment): boolean {
  const current = readVisibleCaptionSegment();
  return Boolean(current && segmentKey(current.text) === segmentKey(segment.text));
}

function shouldDisplayCaptionTranslation(segment: CaptionSegment): boolean {
  if (segment.source === "audioStt") {
    return shouldAcceptAudioSegment(segment);
  }
  if (segment.source === "youtubeTimedText") {
    return isCurrentTimedTextSegment(segment);
  }
  if (segment.source === "youtubeDom") {
    return isCurrentVisibleOfficialCaption(segment);
  }
  return true;
}

function showCurrentTimedTextTranslation(provider: string): void {
  const current = getCurrentTimedTextSegment(timedTextSegments, settings);
  if (!current) {
    return;
  }
  const translatedText = timedTextTranslations.get(current.id);
  if (!translatedText) {
    return;
  }
  const key = translatedSegmentDisplayKey(current, translatedText);
  if (key === lastSentKey) {
    return;
  }
  lastSentKey = key;
  overlay.showTranslation(current, translatedText, provider, settings);
}

function renderTimedTextSegment(segment: CaptionSegment): void {
  lastCaptionSeenAt = Date.now();
  const translatedText = timedTextTranslations.get(segment.id);
  if (translatedText) {
    const key = translatedSegmentDisplayKey(segment, translatedText);
    if (key !== lastSentKey) {
      lastSentKey = key;
      overlay.showTranslation(segment, translatedText, "pretranslated", settings);
    }
    return;
  }

  void processCaptionSegment(withTimedTextContext(segment));
}

function prefetchUpcomingTimedTextTranslation(): void {
  if (!settings.pretranslateEnabled || timedTextSegments.length === 0) {
    return;
  }
  const video = findVideoElement();
  if (!video) {
    return;
  }
  const currentMs = video.currentTime * 1000 + settings.latencyOffsetMs;
  const segment = timedTextSegments.find(
    (candidate) =>
      candidate.endMs >= currentMs &&
      candidate.startMs <= currentMs + TIMED_TEXT_TRANSLATION_PREFETCH_MS &&
      !timedTextTranslations.has(candidate.id)
  );
  if (segment) {
    void processCaptionSegment(withTimedTextContext(segment));
  }
}

function readVisibleOfficialCaption(): void {
  if (!settings.enabled || settings.inputMode === "audio" || !isYouTubeWatchPage()) {
    return;
  }
  // The visible caption DOM is YouTube's translated output when auto-translate
  // is active. Wait for the original official timed-text track instead.
  if (
    (pageCaptionSnapshot?.videoId === activeVideoId && pageCaptionSnapshot.autoTranslationActive) ||
    isYouTubeAutoTranslationActive()
  ) {
    return;
  }
  if (getCurrentTimedTextSegment(timedTextSegments, settings)) {
    return;
  }
  if (timedTextSegments.length === 0 && timedTextLoading) {
    const remainingGraceMs = OFFICIAL_TIMED_TEXT_GRACE_MS - (Date.now() - timedTextLoadStartedAt);
    if (remainingGraceMs > 0) {
      scheduleVisibleOfficialCaptionRead(remainingGraceMs);
      return;
    }
  }

  const segment = readVisibleCaptionSegment();
  if (!segment) {
    return;
  }
  const key = `${segment.startMs}:${segmentKey(segment.text)}`;
  if (key === lastVisibleOfficialCaptionKey) {
    return;
  }
  lastVisibleOfficialCaptionKey = key;
  lastCaptionSeenAt = Date.now();
  if (audioCaptureRequested) {
    void stopAudioFallback();
  }
  void processCaptionSegment(segment);
}

function scheduleVisibleOfficialCaptionRead(delayMs = OFFICIAL_CAPTION_DOM_READ_DELAY_MS): void {
  if (officialCaptionDomReadTimer !== undefined) {
    return;
  }
  officialCaptionDomReadTimer = window.setTimeout(() => {
    officialCaptionDomReadTimer = undefined;
    readVisibleOfficialCaption();
  }, delayMs);
}

async function sendSegment(
  segment: RuntimeMessage & { type: "CAPTION_SEGMENT" }
): Promise<"success" | "blocked" | "retry"> {
  const requestVideoId = activeVideoId;
  const response = await chrome.runtime.sendMessage<MessageResponse<{ translatedText: string; provider: string }>>(segment);
  if (requestVideoId !== activeVideoId || requestVideoId !== currentWatchVideoId()) {
    return "blocked";
  }
  if (response?.ok) {
    if (segment.segment.source === "youtubeTimedText" && timedTextSegmentIndexById.has(segment.segment.id)) {
      timedTextTranslations.set(segment.segment.id, response.translatedText);
    }
    if (settings.enabled && shouldDisplayCaptionTranslation(segment.segment)) {
      lastSentKey = translatedSegmentDisplayKey(segment.segment, response.translatedText);
      overlay.showTranslation(segment.segment, response.translatedText, response.provider, settings);
    }
    return "success";
  }
  if (response && !response.ok && isBlockedTranslationError(response.error)) {
    overlay.clear();
    return "blocked";
  }
  if (settings.enabled) {
    overlay.showError(response?.error ?? "background에서 번역 응답을 받지 못했습니다. 확장 프로그램을 새로고침해 주세요.", settings);
  }
  return "retry";
}

async function processCaptionSegment(segment: Parameters<typeof overlay.showTranslation>[0]): Promise<void> {
  if (!settings.enabled) {
    overlay.clear();
    return;
  }

  lastCaptionSeenAt = Date.now();
  const key = captionRequestKey(segment);
  if (
    captionRequestsInFlight.has(key) ||
    blockedCaptionRequestKeys.has(key) ||
    (captionRequestRetryAfter.get(key) ?? 0) > Date.now()
  ) {
    return;
  }

  captionRequestsInFlight.add(key);
  try {
    const result = await sendSegment({ type: "CAPTION_SEGMENT", segment });
    if (result === "blocked") {
      blockedCaptionRequestKeys.add(key);
    } else if (result === "retry") {
      captionRequestRetryAfter.set(key, Date.now() + CAPTION_TRANSLATION_RETRY_MS);
    } else {
      captionRequestRetryAfter.delete(key);
    }
  } catch (error) {
    captionRequestRetryAfter.set(key, Date.now() + CAPTION_TRANSLATION_RETRY_MS);
    overlay.showError(getErrorMessage(error), settings);
  } finally {
    captionRequestsInFlight.delete(key);
  }
}

async function loadTimedText(expectedVideoId = activeVideoId): Promise<void> {
  if (!expectedVideoId || expectedVideoId !== activeVideoId || expectedVideoId !== currentWatchVideoId()) {
    return;
  }
  prepareCaptionLyricsAssist(expectedVideoId);
  const token = (timedTextLoadToken += 1);
  const pendingTrackKeyBeforeLoad = pendingTimedTextTrackKey;
  lastTimedTextAttemptAt = Date.now();
  timedTextLoading = true;
  timedTextLoadStartedAt = lastTimedTextAttemptAt;
  resetTimedTextState();
  // Keep the track currently being fetched marked as pending. Otherwise the
  // 250 ms selection watcher restarts this request before it can finish.
  pendingTimedTextTrackKey = pendingTrackKeyBeforeLoad;

  if (!settings.enabled || settings.inputMode === "audio" || !isYouTubeWatchPage()) {
    if (token === timedTextLoadToken) {
      timedTextLoading = false;
    }
    return;
  }

  try {
    let result: Awaited<ReturnType<typeof fetchTimedTextSegmentsWithMetadata>>;
    for (const delayMs of [0, 220, 750, 1600]) {
      if (delayMs > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
      }
      if (token !== timedTextLoadToken || expectedVideoId !== activeVideoId || expectedVideoId !== currentWatchVideoId()) {
        return;
      }
      const snapshot = await requestPageCaptionSnapshot(expectedVideoId);
      if (
        token !== timedTextLoadToken ||
        expectedVideoId !== activeVideoId ||
        expectedVideoId !== currentWatchVideoId() ||
        (snapshot && snapshot.videoId !== expectedVideoId)
      ) {
        return;
      }
      if (snapshot) {
        pageCaptionSnapshot = snapshot;
      }
      result = await fetchTimedTextSegmentsWithMetadata(settings, snapshot);
      if (result?.segments.length) {
        break;
      }
      if (snapshot && !result?.trackKey && !getSelectedOfficialCaptionTrackKey(settings, snapshot)) {
        break;
      }
    }

    if (
      token === timedTextLoadToken &&
      expectedVideoId === activeVideoId &&
      expectedVideoId === currentWatchVideoId()
    ) {
      timedTextSegments = result?.segments ?? [];
      timedTextVideoId = result?.videoId ?? expectedVideoId;
      timedTextTrackLanguage = result?.trackLanguage ?? settings.sourceLanguage;
      timedTextTrackKey = result?.trackKey ?? "";
      pendingTimedTextTrackKey =
        timedTextTrackKey || getSelectedOfficialCaptionTrackKey(settings, pageCaptionSnapshot) || "";
      timedTextCaptionHash = timedTextSegments.length > 0 ? hashCaptionSegments(timedTextSegments) : "";
      timedTextSegmentIndexById = new Map(timedTextSegments.map((segment, index) => [segment.id, index]));
      void requestPretranslation();

      if (timedTextSegments.length === 0) {
        const visibleSegment = readVisibleCaptionSegment();
        if (visibleSegment) {
          lastTimedTextNoSourceAt = 0;
          void processCaptionSegment(visibleSegment);
        } else {
          lastTimedTextNoSourceAt = Date.now();
          overlay.showStatus(
            settings.inputMode === "captions"
              ? "이 영상의 원문 공식 자막을 아직 읽지 못했습니다."
              : "원문 공식 자막을 아직 읽지 못해 음성 자막을 준비하는 중...",
            settings
          );
        }
      } else {
        lastTimedTextNoSourceAt = 0;
        clearVideoSessionCaptionLoadTimers();
      }

      // Do not wait for the next 250 ms timer tick after timed text arrives.
      // This is especially noticeable right after choosing an official track.
      const current = getCurrentTimedTextSegment(timedTextSegments, settings);
      if (current) {
        renderTimedTextSegment(current);
      }
    }
  } catch (error) {
    console.debug("Timed text unavailable", error);
  } finally {
    if (token === timedTextLoadToken) {
      timedTextLoading = false;
      if (lastTimedTextNoSourceAt > 0 && settings.inputMode === "captionsThenAudio") {
        window.setTimeout(() => {
          void startAudioFallbackIfNeeded();
        }, AUDIO_FALLBACK_NO_CAPTION_WAIT_MS);
      }
    }
  }
}

function retryTimedTextIfNeeded(): void {
  if (
    settings.enabled &&
    settings.inputMode !== "audio" &&
    isYouTubeWatchPage() &&
    !timedTextLoading &&
    timedTextSegments.length === 0 &&
    Date.now() - lastTimedTextAttemptAt > TIMED_TEXT_RETRY_MS
  ) {
    void loadTimedText(activeVideoId);
  }
}

function reloadTimedTextIfSelectedTrackChanged(force = false): void {
  if (!settings.enabled || settings.inputMode === "audio" || !isYouTubeWatchPage()) {
    return;
  }
  if (timedTextLoading) {
    return;
  }
  const now = Date.now();
  if (!force && now - lastTimedTextSelectionCheckAt < TIMED_TEXT_SELECTION_CHECK_MS) {
    return;
  }
  lastTimedTextSelectionCheckAt = now;

  const selectedTrackKey = getSelectedOfficialCaptionTrackKey(settings) ?? "";
  if (!force && (selectedTrackKey === timedTextTrackKey || selectedTrackKey === pendingTimedTextTrackKey)) {
    return;
  }

  pendingTimedTextTrackKey = selectedTrackKey;
  resetTimedTextState();
  lastSentKey = "";
  captionRequestsInFlight = new Set();
  blockedCaptionRequestKeys = new Set();
  captionRequestRetryAfter = new Map();
  if (audioCaptureRequested && selectedTrackKey) {
    void stopAudioFallback();
  }
  void loadTimedText(activeVideoId);
}

function refreshOfficialCaptionTrackSoon(): void {
  // YouTube updates the selected caption track asynchronously after its menu closes.
  clearCaptionTrackRefreshTimers();
  for (const delayMs of [0, 160, 600]) {
    const timer = window.setTimeout(() => {
      captionTrackRefreshTimers = captionTrackRefreshTimers.filter((scheduled) => scheduled !== timer);
      if (activeVideoId === currentWatchVideoId()) {
        reloadTimedTextIfSelectedTrackChanged(true);
      }
    }, delayMs);
    captionTrackRefreshTimers.push(timer);
  }
}

function shouldStartAudioFallback(): boolean {
  if (!videoCanProduceAudio()) {
    return false;
  }

  if (settings.inputMode === "audio") {
    return true;
  }
  if (timedTextLoading || timedTextSegments.length > 0) {
    return false;
  }

  const now = Date.now();
  const lastAttemptAge = lastTimedTextAttemptAt > 0 ? now - lastTimedTextAttemptAt : Number.POSITIVE_INFINITY;
  const missingForMs = lastCaptionSeenAt > 0 ? now - lastCaptionSeenAt : Number.POSITIVE_INFINITY;

  if (lastTimedTextNoSourceAt > 0) {
    return now - lastTimedTextNoSourceAt >= AUDIO_FALLBACK_NO_CAPTION_WAIT_MS;
  }
  if (lastCaptionSeenAt === 0) {
    return lastAttemptAge >= AUDIO_FALLBACK_INITIAL_WAIT_MS;
  }

  return missingForMs >= AUDIO_FALLBACK_STALE_CAPTION_MS;
}

function audioCaptureSettingsKey(value: ContentSettings): string {
  const usesStreamingWhisper = value.sttProvider === "whisper" && value.streamingSttEnabled;
  return [
    value.inputMode,
    value.sourceLanguage,
    value.contentMode,
    value.audioChunkMs,
    value.sttProvider,
    value.streamingSttEnabled,
    usesStreamingWhisper ? value.streamingSttEndpoint : "",
    usesStreamingWhisper ? value.streamingSttModel : "",
    usesStreamingWhisper ? value.speakerTurnDetection : ""
  ].join("|");
}

async function startAudioFallbackIfNeeded(): Promise<void> {
  if (
    !settings.enabled ||
    settings.inputMode === "captions" ||
    audioCaptureRequested ||
    audioCaptureSuppressed ||
    stoppingAudioCapture ||
    Date.now() < manualAudioStartPendingUntil ||
    !isYouTubeWatchPage() ||
    document.visibilityState !== "visible"
  ) {
    return;
  }
  if (Date.now() < audioStartBlockedUntil) {
    return;
  }

  if (shouldStartAudioFallback()) {
    const requestedVideoId = activeVideoId;
    audioStopRequested = false;
    audioCaptureRequested = true;
    setAudioControlStatus("음성 STT 시작 중");
    try {
      const response = await chrome.runtime.sendMessage<MessageResponse<{ tabId: number }>>({
        type: "START_AUDIO_CAPTURE",
        videoId: requestedVideoId
      });
      if (requestedVideoId !== activeVideoId || requestedVideoId !== currentWatchVideoId()) {
        return;
      }
      if (!response?.ok) {
        console.debug(
          "Automatic audio capture did not start",
          response?.error ?? "음성 캡처 시작 응답을 받지 못했습니다."
        );
        setAudioControlStatus("음성 STT 대기");
        audioCaptureRequested = false;
        audioStartBlockedUntil = Date.now() + 12_000;
        return;
      }
    } catch (error) {
      if (requestedVideoId !== activeVideoId || requestedVideoId !== currentWatchVideoId()) {
        return;
      }
      console.debug("Automatic audio capture start failed", getErrorMessage(error));
      setAudioControlStatus("음성 STT 대기");
      audioCaptureRequested = false;
      audioStartBlockedUntil = Date.now() + 12_000;
    }
  }
}

async function reconfigureAudioFallback(expectedVideoId?: string, startIfMissing = false): Promise<void> {
  const requestedVideoId = activeVideoId;
  if ((!audioCaptureRequested && !startIfMissing) || !requestedVideoId) {
    return;
  }
  try {
    const response = await chrome.runtime.sendMessage<MessageResponse<{ mode?: string }>>({
      type: "RECONFIGURE_AUDIO_CAPTURE",
      videoId: requestedVideoId,
      expectedVideoId,
      startIfMissing
    });
    if (requestedVideoId !== activeVideoId) {
      return;
    }
    if (!response?.ok) {
      console.debug("Audio capture reconfiguration failed", response?.error);
      setAudioControlStatus("음성 STT 설정 갱신 실패 · 재시도");
      return;
    }
    audioStopRequested = false;
    audioCaptureRequested = true;
    audioStartBlockedUntil = 0;
    setAudioControlStatus(response.mode === "stream" ? "로컬 스트리밍 STT" : "음성 STT");
  } catch (error) {
    if (requestedVideoId === activeVideoId) {
      console.debug("Audio capture reconfiguration failed", getErrorMessage(error));
      setAudioControlStatus("음성 STT 설정 갱신 실패 · 재시도");
    }
  }
}

async function stopAudioFallback(force = false, captureVideoId = activeVideoId): Promise<void> {
  if (stoppingAudioCapture) {
    return;
  }
  if (!audioCaptureRequested && !force) {
    return;
  }
  audioStopRequested = true;
  stoppingAudioCapture = true;
  audioCaptureRequested = false;
  try {
    await chrome.runtime.sendMessage({ type: "STOP_AUDIO_CAPTURE", videoId: captureVideoId });
  } catch (error) {
    console.debug("Audio fallback stop failed", error);
  } finally {
    stoppingAudioCapture = false;
  }
}

async function disableTranslator(): Promise<void> {
  lastSentKey = "";
  timedTextLoadToken += 1;
  clearCaptionTrackRefreshTimers();
  clearVideoSessionCaptionLoadTimers();
  resetTimedTextState();
  audioCaptureRequested = false;
  audioStopRequested = true;
  audioCaptureSuppressed = true;
  audioStartBlockedUntil = 0;
  manualAudioStartPendingUntil = 0;
  await chrome.runtime.sendMessage({ type: "STOP_AUDIO_CAPTURE" }).catch(() => undefined);
  if (settings.miniControlsEnabled && isYouTubeWatchPage()) {
    ensureOverlay();
    overlay.clear();
    overlay.setControlStatus(controlStatusText(), settings);
  } else {
    overlay.destroy();
  }
}

function shouldReloadTimedTextForSettingsChange(
  previousSettings: ContentSettings,
  nextSettings: ContentSettings
): boolean {
  if (nextSettings.inputMode === "audio") {
    return false;
  }
  if (!previousSettings.enabled && nextSettings.enabled) {
    return true;
  }
  return (
    previousSettings.inputMode !== nextSettings.inputMode ||
    previousSettings.sourceLanguage !== nextSettings.sourceLanguage ||
    previousSettings.contentMode !== nextSettings.contentMode
  );
}

function applySettingsUpdate(nextSettings: ContentSettings, revision?: number): void {
  if (revision !== undefined) {
    if (revision <= settingsRevision) {
      return;
    }
    settingsRevision = revision;
  }
  const previousSettings = settings;
  if (JSON.stringify(previousSettings) === JSON.stringify(nextSettings)) {
    return;
  }
  const wasAudioCaptureActive = Boolean(previousSettings?.enabled && audioCaptureRequested);
  const inputModeChanged = previousSettings.inputMode !== nextSettings.inputMode;
  if (
    (!previousSettings.enabled && nextSettings.enabled) ||
    (inputModeChanged && nextSettings.inputMode !== "captions")
  ) {
    audioCaptureSuppressed = false;
  }
  const shouldPauseAudioForOfficialCaptions =
    inputModeChanged &&
    previousSettings.inputMode === "audio" &&
    nextSettings.inputMode === "captionsThenAudio" &&
    timedTextSegments.length > 0;
  const shouldStopAudio = !nextSettings.enabled || nextSettings.inputMode === "captions" || shouldPauseAudioForOfficialCaptions;
  const shouldReconfigureAudio =
    wasAudioCaptureActive &&
    !shouldStopAudio &&
    audioCaptureSettingsKey(previousSettings) !== audioCaptureSettingsKey(nextSettings);
  const translationBehaviorChanged =
    previousSettings.translationConfigRevision !== nextSettings.translationConfigRevision ||
    previousSettings.targetLanguage !== nextSettings.targetLanguage ||
    previousSettings.sourceLanguage !== nextSettings.sourceLanguage ||
    previousSettings.contentMode !== nextSettings.contentMode ||
    previousSettings.translationProvider !== nextSettings.translationProvider ||
    previousSettings.lyricsAssistEnabled !== nextSettings.lyricsAssistEnabled;
  const shouldReloadTimedText = shouldReloadTimedTextForSettingsChange(previousSettings, nextSettings);
  settings = nextSettings;
  if (!settings.lyricsAssistEnabled || settings.contentMode === "spoken") {
    lyricsAssistStatus = "";
  }
  lastSentKey = "";

  if (!settings.enabled) {
    void disableTranslator();
    return;
  }

  if (shouldStopAudio) {
    void stopAudioFallback(true);
  } else if (shouldReconfigureAudio) {
    audioStopRequested = false;
    void reconfigureAudioFallback();
  } else {
    audioStopRequested = false;
  }

  ensureOverlay();
  overlay.applySettings(settings);
  if (!activeVideoId) {
    activeVideoId = currentWatchVideoId();
  }

  if (translationBehaviorChanged) {
    timedTextTranslations = new Map();
    pretranslateRequestKey = "";
    pretranslateRetryBlockedUntil = 0;
    captionRequestsInFlight = new Set();
    blockedCaptionRequestKeys = new Set();
    captionRequestRetryAfter = new Map();
    const currentSegment = getCurrentTimedTextSegment(timedTextSegments, settings);
    if (currentSegment) {
      renderTimedTextSegment(currentSegment);
    }
    void cancelPretranslation().then(() => {
      if (settings.translationConfigRevision === nextSettings.translationConfigRevision) {
        void requestPretranslation();
      }
    });
    if (shouldReloadTimedText) {
      void loadTimedText(activeVideoId);
    }
    return;
  }

  if (shouldReloadTimedText) {
    void loadTimedText(activeVideoId);
  }
}

function handleUrlChange(): void {
  const nextVideoId = currentWatchVideoId();
  if (currentUrl === location.href && nextVideoId === activeVideoId) {
    return;
  }

  currentUrl = location.href;
  if (nextVideoId !== activeVideoId) {
    beginVideoSession(nextVideoId);
    return;
  }
  scheduleOverlayRefresh();
}

function handleVideoElementChange(): void {
  const nextVideoElement = findVideoElement();
  if (nextVideoElement === observedVideoElement) {
    return;
  }
  observedVideoElement = nextVideoElement;

  const videoId = currentWatchVideoId();
  if (!videoId || !settings.enabled || !isYouTubeWatchPage()) {
    return;
  }
  if (videoId !== activeVideoId) {
    beginVideoSession(videoId);
    return;
  }
  // The URL change owns the video session. Replacing the media element for the
  // same video must not invalidate captions or restart tab audio capture.
  if (settings.inputMode !== "audio" && (timedTextVideoId !== videoId || timedTextSegments.length === 0)) {
    scheduleVideoSessionCaptionLoads(videoId);
    void runTick();
  }
}

function resyncVideoSessionAfterNavigation(): void {
  currentUrl = "";
  handleUrlChange();
  handleVideoElementChange();
  if (activeVideoId && settings.enabled && settings.inputMode !== "audio" && timedTextSegments.length === 0) {
    scheduleVideoSessionCaptionLoads(activeVideoId);
  }
}

async function tick(): Promise<void> {
  handleUrlChange();
  handleVideoElementChange();

  if (!isYouTubeWatchPage()) {
    await stopAudioFallback();
    overlay.destroy();
    return;
  }
  if (!settings.enabled) {
    await stopAudioFallback();
    if (settings.miniControlsEnabled) {
      ensureOverlay();
      overlay.clear();
      overlay.setControlStatus(controlStatusText(), settings);
    } else {
      overlay.destroy();
    }
    return;
  }

  // YouTube briefly pauses or swaps media state while entering/exiting fullscreen.
  // Keep the existing tab stream alive through that transition.
  if (audioCaptureRequested && videoPlaybackEnded()) {
    await stopAudioFallback();
  }

  if (settings.inputMode !== "audio") {
    reloadTimedTextIfSelectedTrackChanged();
    retryTimedTextIfNeeded();

    if (settings.inputMode === "captionsThenAudio" && audioCaptureRequested && timedTextSegments.length > 0) {
      await stopAudioFallback();
    }

    prefetchUpcomingTimedTextTranslation();
    const timedTextSegment = getCurrentTimedTextSegment(timedTextSegments, settings);
    if (timedTextSegment) {
      await stopAudioFallback();
      if (settings.pretranslateEnabled && timedTextTranslations.size < timedTextSegments.length) {
        void requestPretranslation();
      }
      renderTimedTextSegment(timedTextSegment);
      return;
    }

    readVisibleOfficialCaption();
  }

  await startAudioFallbackIfNeeded();
}

async function runTick(): Promise<void> {
  overlay.reconcilePlacement();
  if (tickInProgress) {
    return;
  }

  tickInProgress = true;
  try {
    await tick();
  } finally {
    tickInProgress = false;
  }
}

function scheduleFullscreenAudioResume(delayMs: number): void {
  if (fullscreenAudioResumeTimer !== undefined) {
    window.clearTimeout(fullscreenAudioResumeTimer);
  }
  fullscreenAudioResumeTimer = window.setTimeout(() => {
    fullscreenAudioResumeTimer = undefined;
    resumeAudioAfterFullscreenIntent();
  }, delayMs);
}

function resumeAudioAfterFullscreenIntent(): void {
  if (!resumeAudioAfterFullscreenIntentRequested) {
    return;
  }
  if (stoppingAudioCapture) {
    scheduleFullscreenAudioResume(100);
    return;
  }
  resumeAudioAfterFullscreenIntentRequested = false;
  audioCaptureSuppressed = false;
  audioStopRequested = false;
  audioStartBlockedUntil = 0;
  manualAudioStartPendingUntil = 0;
  void startAudioFallbackIfNeeded();
}

async function suspendAudioForFullscreenIntent(): Promise<void> {
  if (
    !settings.enabled ||
    !audioCaptureRequested ||
    audioStopRequested ||
    stoppingAudioCapture ||
    !activeVideoId
  ) {
    return;
  }
  const requestedVideoId = activeVideoId;
  resumeAudioAfterFullscreenIntentRequested = true;
  audioCaptureSuppressed = true;
  setAudioControlStatus("전체화면 전환 · 음성 STT 일시 중지");
  scheduleFullscreenAudioResume(FULLSCREEN_AUDIO_FALLBACK_MS);
  await stopAudioFallback(false, requestedVideoId);
}

function handleFullscreenPointerIntent(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest(".ytp-fullscreen-button")) {
    return;
  }
  const player = findPlayerElement();
  if (document.fullscreenElement || player?.classList.contains("ytp-fullscreen")) {
    return;
  }
  void suspendAudioForFullscreenIntent();
}

function handleFullscreenChange(): void {
  if (resumeAudioAfterFullscreenIntentRequested && document.fullscreenElement) {
    scheduleFullscreenAudioResume(FULLSCREEN_AUDIO_RESUME_DELAY_MS);
  }
}

function isOverlayMutationElement(element: Element): boolean {
  return element.id === OVERLAY_HOST_SELECTOR.slice(1) || Boolean(element.closest(OVERLAY_HOST_SELECTOR));
}

function mutationTouchesPlayer(mutation: MutationRecord): boolean {
  const selector = "#movie_player, .html5-video-player, video, .ytp-caption-segment, .captions-text";
  let changedElementCount = 0;
  let onlyOverlayElements = true;
  for (const nodes of [mutation.addedNodes, mutation.removedNodes]) {
    for (const node of nodes) {
      if (node instanceof Element) {
        changedElementCount += 1;
        onlyOverlayElements &&= isOverlayMutationElement(node);
      }
    }
  }
  if (changedElementCount > 0 && onlyOverlayElements) {
    return false;
  }
  const target = mutation.target;
  if (target instanceof Element && isOverlayMutationElement(target)) {
    return false;
  }
  if (target instanceof Element && target.closest(selector)) {
    return true;
  }
  for (const nodes of [mutation.addedNodes, mutation.removedNodes]) {
    for (const node of nodes) {
      if (node instanceof Element && (node.matches(selector) || node.querySelector(selector))) {
        return true;
      }
    }
  }
  return false;
}

function installObservers(): void {
  const bodyObserver = new MutationObserver((mutations) => {
    const urlChanged = location.href !== currentUrl;
    handleUrlChange();
    if (!urlChanged && !mutations.some(mutationTouchesPlayer)) {
      return;
    }
    handleVideoElementChange();
    if (settings.enabled) {
      scheduleOverlayRefresh();
      scheduleVisibleOfficialCaptionRead();
    }
  });
  bodyObserver.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener(
    "timeupdate",
    (event) => {
      if (event.target === findVideoElement()) {
        void runTick();
      }
    },
    true
  );
  document.addEventListener(
    "seeking",
    (event) => {
      if (event.target === findVideoElement()) {
        void runTick();
        refreshOfficialCaptionTrackSoon();
      }
    },
    true
  );
  document.addEventListener(
    "play",
    (event) => {
      if (event.target === findVideoElement()) {
        void runTick();
      }
    },
    true
  );
  document.addEventListener(
    "playing",
    (event) => {
      if (event.target === findVideoElement()) {
        void runTick();
      }
    },
    true
  );
  document.addEventListener("yt-navigate-finish", resyncVideoSessionAfterNavigation);
  document.addEventListener("yt-page-data-updated", resyncVideoSessionAfterNavigation);
  document.addEventListener("yt-player-updated", resyncVideoSessionAfterNavigation);
  document.addEventListener("pointerdown", handleFullscreenPointerIntent, true);
  document.addEventListener("fullscreenchange", handleFullscreenChange, true);
  window.addEventListener("popstate", resyncVideoSessionAfterNavigation);
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest(
          ".ytp-subtitles-button, .ytp-menuitem[role='menuitemcheckbox'], .ytp-menuitem[role='menuitemradio'], [role='menuitemcheckbox'], [role='menuitemradio']"
        )
      ) {
        refreshOfficialCaptionTrackSoon();
      }
    },
    true
  );
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !(SETTINGS_KEY in changes)) {
      return;
    }
    void loadContentSettings()
      .then((snapshot) => applySettingsUpdate(snapshot.settings, snapshot.revision))
      .catch((error) => {
        overlay.showError(getErrorMessage(error), settings);
      });
  });

  chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
    const message = rawMessage as RuntimeMessage;
    if (message.type === "TRANSLATION_READY") {
      if (
        settings.enabled &&
        shouldAcceptAudioSegment(message.segment) &&
        (!message.videoId || message.videoId === activeVideoId)
      ) {
        if (message.segment.source === "audioStt") {
          showAudioTranslation(message.videoId, message.segment, message.translatedText, message.provider);
        } else {
          overlay.showTranslation(message.segment, message.translatedText, message.provider, settings);
        }
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "TRANSLATION_ERROR") {
      if (
        settings.enabled &&
        shouldAcceptAudioSegment(message.segment) &&
        (!message.videoId || message.videoId === activeVideoId)
      ) {
        if (isBlockedTranslationError(message.error)) {
          overlay.clear();
          sendResponse({ ok: true });
          return;
        }
        if (message.segment) {
          if (message.segment.source === "audioStt") {
            showAudioSegmentError(message.videoId, message.segment, message.error);
          } else {
            overlay.showSegmentError(message.segment, message.error, settings);
          }
        } else {
          overlay.showError(message.error, settings);
        }
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "PRETRANSLATE_RESULT") {
      if (
        settings.enabled &&
        message.videoId === timedTextVideoId &&
        message.captionHash === timedTextCaptionHash &&
        message.translationConfigRevision === settings.translationConfigRevision
      ) {
        mergeTimedTextTranslations(message.translations);
        showCurrentTimedTextTranslation(message.provider || "pretranslated");
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "PRETRANSLATE_PROGRESS") {
      if (
        settings.enabled &&
        message.videoId === timedTextVideoId &&
        message.captionHash === timedTextCaptionHash &&
        message.translationConfigRevision === settings.translationConfigRevision &&
        message.statusText
      ) {
        if (/실패|오류/.test(message.statusText)) {
          pretranslateRequestKey = "";
          pretranslateRetryBlockedUntil = Date.now() + PRETRANSLATE_RETRY_COOLDOWN_MS;
        }
        overlay.showStatus(message.statusText, settings);
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "LYRICS_ASSIST_STATUS") {
      if (message.videoId === activeVideoId) {
        lyricsAssistStatus = message.statusText;
        overlay.setControlStatus(controlStatusText(), settings);
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CORRECTION_MATCH_STATUS") {
      if (message.videoId === activeVideoId) {
        correctionMatchStatus = message.statusText;
        overlay.setControlStatus(controlStatusText(), settings);
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CORRECTION_LIBRARY_UPDATED") {
      correctionMatchStatus = "";
      timedTextTranslations = new Map();
      pretranslateRequestKey = "";
      pretranslateRetryBlockedUntil = 0;
      captionRequestsInFlight = new Set();
      lastSentKey = "";
      overlay.setControlStatus(controlStatusText(), settings);
      void requestPretranslation();
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "AUDIO_TRANSCRIPT") {
      if (settings.enabled && message.videoId === activeVideoId && shouldAcceptAudioSegment(message.segment)) {
        showAudioStatus(`음성 인식됨, 번역 중... ${compactStatusText(message.segment.text)}`);
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "STREAM_STT_TRANSCRIPT") {
      if (
        settings.enabled &&
        message.videoId === activeVideoId &&
        !message.isFinal &&
        shouldAcceptAudioSegment(message.segment)
      ) {
        showAudioStatus(`음성 인식 중... ${compactStatusText(message.segment.text)}`);
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "AUDIO_CAPTURE_STATUS") {
      if (!message.videoId || message.videoId !== activeVideoId) {
        sendResponse({ ok: true });
        return;
      }
      if (message.state === "recording") {
        const shouldStopRecording =
          audioStopRequested ||
          audioCaptureSuppressed ||
          !settings.enabled ||
          settings.inputMode === "captions" ||
          !isYouTubeWatchPage();
        if (shouldStopRecording) {
          audioCaptureRequested = false;
          void chrome.runtime
            .sendMessage({ type: "STOP_AUDIO_CAPTURE", videoId: message.videoId })
            .catch(() => undefined);
          sendResponse({ ok: true });
          return;
        }
        audioCaptureRequested = true;
        manualAudioStartPendingUntil = 0;
        audioStartBlockedUntil = 0;
        showAudioStatus(message.statusText ?? "음성 인식 중...");
        setAudioControlStatus(controlStatusText());
      } else if (message.state === "idle") {
        audioCaptureRequested = false;
        manualAudioStartPendingUntil = 0;
        setAudioControlStatus(controlStatusText());
      } else if (message.error) {
        audioCaptureRequested = false;
        manualAudioStartPendingUntil = 0;
        audioStartBlockedUntil = Date.now() + 12_000;
        console.debug("Audio capture failed", message.error);
        setAudioControlStatus("음성 STT 오류");
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "PREPARE_AUDIO_CAPTURE") {
      audioStopRequested = false;
      audioCaptureSuppressed = false;
      manualAudioStartPendingUntil = Date.now() + MANUAL_AUDIO_START_PENDING_MS;
      audioStartBlockedUntil = 0;
      sendResponse({ ok: true, videoId: activeVideoId });
      return;
    }

    if (message.type === "PREPARE_AUDIO_STOP") {
      audioStopRequested = true;
      audioCaptureSuppressed = true;
      manualAudioStartPendingUntil = 0;
      sendResponse({ ok: true, videoId: activeVideoId });
      return;
    }

    if (message.type === "SETTINGS_UPDATED") {
      applySettingsUpdate(message.settings, message.revision);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "GET_TAB_STATUS") {
      sendResponse({
        ok: true,
        audioCaptureRequested,
        timedTextSegments: timedTextSegments.length,
        contentScriptVersion: CONTENT_SCRIPT_VERSION,
        url: location.href
      });
      return;
    }
  });
}

async function main(): Promise<void> {
  const settingsSnapshot = await loadContentSettings();
  settings = settingsSnapshot.settings;
  settingsRevision = settingsSnapshot.revision;
  activeVideoId = currentWatchVideoId();
  observedVideoElement = findVideoElement();
  lastCaptionSeenAt = 0;
  ensureOverlay();
  installObservers();
  scheduleVideoSessionCaptionLoads(activeVideoId);
  window.setInterval(() => {
    void runTick();
  }, 250);
}

const globalState = globalThis as Record<string, unknown>;
if (!globalState[CONTENT_BOOTSTRAP_FLAG]) {
  globalState[CONTENT_BOOTSTRAP_FLAG] = true;
  void main();
}
