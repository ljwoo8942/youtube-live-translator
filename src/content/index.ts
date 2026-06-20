import type { CaptionSegment, PageCaptionSnapshot, TranslatorSettings } from "../shared/types";
import type { CaptionTranslationEntry, MessageResponse, RuntimeMessage } from "../shared/messages";
import { TranslatorOverlay, findVideoElement } from "./overlay";
import {
  fetchTimedTextSegments,
  fetchTimedTextSegmentsWithMetadata,
  getCurrentVideoId,
  getCurrentTimedTextSegment,
  getSelectedOfficialCaptionTrackKey,
  hashCaptionSegments,
  isYouTubeAutoTranslationActive,
  isYouTubeWatchPage,
  readVisibleCaptionSegment
} from "./youtubeCaptions";

const SETTINGS_KEY = "translatorSettings";
const CONTENT_BOOTSTRAP_FLAG = "__yt_live_translator_content_bootstrapped__";
const overlay = new TranslatorOverlay();
const AUDIO_FALLBACK_INITIAL_WAIT_MS = 2200;
const AUDIO_FALLBACK_STALE_CAPTION_MS = 4200;
const TIMED_TEXT_RETRY_MS = 3000;
const TIMED_TEXT_SELECTION_CHECK_MS = 250;
const PRETRANSLATE_RETRY_COOLDOWN_MS = 15_000;
const PRETRANSLATE_PRIORITY_BUCKET_MS = 5_000;
const OVERLAY_REFRESH_DELAY_MS = 100;
const OFFICIAL_CAPTION_DOM_READ_DELAY_MS = 30;
const OFFICIAL_TIMED_TEXT_GRACE_MS = 650;

let settings: TranslatorSettings;
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
let lastSentKey = "";
let lastCaptionSeenAt = 0;
let audioCaptureRequested = false;
let timedTextLoadToken = 0;
let timedTextLoading = false;
let timedTextLoadStartedAt = 0;
let lastTimedTextAttemptAt = 0;
let lastTimedTextSelectionCheckAt = 0;
let tickInProgress = false;
let stoppingAudioCapture = false;
let audioStartBlockedUntil = 0;
let overlayRefreshTimer: number | undefined;
let officialCaptionDomReadTimer: number | undefined;
let captionTrackRefreshTimers: number[] = [];
let pendingTimedTextTrackKey = "";
let lastVisibleOfficialCaptionKey = "";
let pageCaptionSnapshot: PageCaptionSnapshot | undefined;

async function loadContentSettings(): Promise<TranslatorSettings> {
  const response = await chrome.runtime.sendMessage<MessageResponse<{ settings: TranslatorSettings }>>({
    type: "GET_SETTINGS"
  });
  if (response?.ok) {
    return response.settings;
  }
  throw new Error(response?.error ?? "설정을 읽지 못했습니다. 확장프로그램을 새로고침해 주세요.");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function segmentKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
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

function currentWatchVideoId(): string {
  return getCurrentVideoId() ?? "";
}

function clearCaptionTrackRefreshTimers(): void {
  for (const timer of captionTrackRefreshTimers) {
    window.clearTimeout(timer);
  }
  captionTrackRefreshTimers = [];
}

function beginVideoSession(videoId: string): void {
  activeVideoId = videoId;
  timedTextLoadToken += 1;
  lastSentKey = "";
  lastCaptionSeenAt = 0;
  pendingTimedTextTrackKey = "";
  lastTimedTextSelectionCheckAt = 0;
  audioStartBlockedUntil = 0;
  resetTimedTextState();
  clearCaptionTrackRefreshTimers();
  if (audioCaptureRequested) {
    void stopAudioFallback();
  }
  overlay.clear();
  scheduleOverlayRefresh();

  if (settings.enabled && videoId && settings.inputMode !== "audio") {
    overlay.showStatus("새 영상의 공식 자막을 확인하는 중...", settings);
    void loadTimedText(videoId);
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

function shouldAcceptAudioSegment(segment?: CaptionSegment): boolean {
  if (segment?.source !== "audioStt") {
    return true;
  }

  return Boolean(
    settings.enabled &&
      audioCaptureRequested &&
      isYouTubeWatchPage() &&
      videoCanProduceAudio() &&
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

function controlStatusText(): string {
  const mode = contentModeStatusLabel();
  const turnMode = settings.speakerTurnDetection && settings.contentMode !== "lyrics" ? " · 발화 분리" : "";
  if (settings.inputMode === "captions") {
    return `선택한 공식 자막만 사용 · ${mode}${turnMode}`;
  }
  if (timedTextSegments.length > 0) {
    return `선택한 공식 자막 ${timedTextTranslations.size}/${timedTextSegments.length} · ${mode}${turnMode}`;
  }
  if (audioCaptureRequested) {
    const sttMode = settings.streamingSttEnabled && settings.sttProvider === "whisper" ? "로컬 스트리밍 STT" : "음성 STT";
    return `${sttMode} · ${mode}${turnMode}`;
  }
  return `음성 STT 대기 · ${mode}${turnMode}`;
}

function ensureOverlay(): void {
  overlay.ensure(settings);
  overlay.bindMiniControls((action) => {
    void handleMiniControl(action);
  });
  overlay.setControlStatus(controlStatusText(), settings);
}

function scheduleOverlayRefresh(): void {
  if (overlayRefreshTimer !== undefined) {
    return;
  }
  overlayRefreshTimer = window.setTimeout(() => {
    overlayRefreshTimer = undefined;
    if (settings.enabled) {
      ensureOverlay();
    }
  }, OVERLAY_REFRESH_DELAY_MS);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function updateSettingsFromMini(patch: Partial<TranslatorSettings>): Promise<void> {
  const response = await chrome.runtime.sendMessage<MessageResponse<{ settings: TranslatorSettings }>>({
    type: "MINI_CONTROL_UPDATE",
    patch
  });
  if (response?.ok) {
    applySettingsUpdate(response.settings);
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
    case "source":
      await updateSettingsFromMini({
        overlayStyle: { ...settings.overlayStyle, showSourceText: !settings.overlayStyle.showSourceText }
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
      await chrome.runtime.sendMessage({ type: "RESET_AUDIO_CAPTURE_COOLDOWN" }).catch(() => undefined);
      audioStartBlockedUntil = 0;
      if (audioCaptureRequested) {
        await stopAudioFallback();
      }
      await startAudioFallbackIfNeeded();
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
  const requestKey = `${timedTextVideoId}:${timedTextCaptionHash}:${settings.targetLanguage}:${settings.translationProvider}:${settings.contentMode}:${priorityBucket}`;
  if (requestKey === pretranslateRequestKey) {
    return;
  }
  pretranslateRequestKey = requestKey;

  try {
    const response = await chrome.runtime.sendMessage<
      MessageResponse<{ translations: CaptionTranslationEntry[]; total: number; cached: number }>
    >({
      type: "PRETRANSLATE_CAPTIONS",
      videoId: timedTextVideoId,
      captionHash: timedTextCaptionHash,
      trackLanguage: timedTextTrackLanguage,
      currentTimeMs: currentVideoTimeMs(),
      segments: timedTextSegments
    });
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

function shouldDisplayCaptionTranslation(segment: CaptionSegment): boolean {
  if (segment.source === "audioStt") {
    return shouldAcceptAudioSegment(segment);
  }
  if (segment.source === "youtubeTimedText") {
    return isCurrentTimedTextSegment(segment);
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
  const key = `pretranslated:${current.id}:${segmentKey(translatedText)}`;
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
    const key = `pretranslated:${segment.id}:${segmentKey(translatedText)}`;
    if (key !== lastSentKey) {
      lastSentKey = key;
      overlay.showTranslation(segment, translatedText, "pretranslated", settings);
    }
    return;
  }

  void processCaptionSegment(withTimedTextContext(segment));
}

function readVisibleOfficialCaption(): void {
  if (!settings.enabled || settings.inputMode === "audio" || !isYouTubeWatchPage()) {
    return;
  }
  // The visible caption DOM is YouTube's translated output when auto-translate
  // is active. Wait for the original official timed-text track instead.
  if (pageCaptionSnapshot?.autoTranslationActive || isYouTubeAutoTranslationActive()) {
    return;
  }
  if (!getSelectedOfficialCaptionTrackKey(settings)) {
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

async function sendSegment(segment: RuntimeMessage & { type: "CAPTION_SEGMENT" }): Promise<void> {
  const requestVideoId = activeVideoId;
  const response = await chrome.runtime.sendMessage<MessageResponse<{ translatedText: string; provider: string }>>(segment);
  if (requestVideoId !== activeVideoId || requestVideoId !== currentWatchVideoId()) {
    return;
  }
  if (response?.ok) {
    if (settings.enabled && shouldDisplayCaptionTranslation(segment.segment)) {
      overlay.showTranslation(segment.segment, response.translatedText, response.provider, settings);
    }
    return;
  }
  if (settings.enabled) {
    overlay.showError(response?.error ?? "background에서 번역 응답을 받지 못했습니다. 확장 프로그램을 새로고침해 주세요.", settings);
  }
}

async function processCaptionSegment(segment: Parameters<typeof overlay.showTranslation>[0]): Promise<void> {
  if (!settings.enabled) {
    overlay.clear();
    return;
  }

  lastCaptionSeenAt = Date.now();
  const key = `${segment.source}:${segmentKey(segment.text)}`;
  if (key === lastSentKey) {
    return;
  }

  lastSentKey = key;
  try {
    await sendSegment({ type: "CAPTION_SEGMENT", segment });
  } catch (error) {
    overlay.showError(getErrorMessage(error), settings);
  }
}

async function loadTimedText(expectedVideoId = activeVideoId): Promise<void> {
  if (!expectedVideoId || expectedVideoId !== activeVideoId || expectedVideoId !== currentWatchVideoId()) {
    return;
  }
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
      if (snapshot) {
        pageCaptionSnapshot = snapshot;
      }
      result = await fetchTimedTextSegmentsWithMetadata(settings, snapshot);
      if (result?.segments.length) {
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
      pendingTimedTextTrackKey = timedTextTrackKey || getSelectedOfficialCaptionTrackKey(settings) || "";
      timedTextCaptionHash = timedTextSegments.length > 0 ? hashCaptionSegments(timedTextSegments) : "";
      timedTextSegmentIndexById = new Map(timedTextSegments.map((segment, index) => [segment.id, index]));
      void requestPretranslation();

      if (timedTextSegments.length === 0) {
        overlay.showStatus(
          settings.inputMode === "captions"
            ? "이 영상의 원문 공식 자막을 아직 읽지 못했습니다."
            : "원문 공식 자막을 아직 읽지 못해 음성 자막을 준비하는 중...",
          settings
        );
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
    }
  }
}

function retryTimedTextIfNeeded(): void {
  if (
    settings.enabled &&
    settings.inputMode !== "audio" &&
    isYouTubeWatchPage() &&
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
  if (timedTextSegments.length > 0) {
    return false;
  }

  const now = Date.now();
  const lastAttemptAge = lastTimedTextAttemptAt > 0 ? now - lastTimedTextAttemptAt : Number.POSITIVE_INFINITY;
  const missingForMs = lastCaptionSeenAt > 0 ? now - lastCaptionSeenAt : Number.POSITIVE_INFINITY;

  if (lastCaptionSeenAt === 0) {
    return lastAttemptAge >= AUDIO_FALLBACK_INITIAL_WAIT_MS;
  }

  return missingForMs >= AUDIO_FALLBACK_STALE_CAPTION_MS;
}

function audioCaptureSettingsKey(value: TranslatorSettings): string {
  const usesStreamingWhisper = value.sttProvider === "whisper" && value.streamingSttEnabled;
  return [
    value.inputMode,
    value.sourceLanguage,
    value.contentMode,
    value.audioChunkMs,
    value.sttProvider,
    value.streamingSttEnabled,
    usesStreamingWhisper ? value.streamingSttEndpoint : "",
    usesStreamingWhisper ? value.whisper.model : "",
    usesStreamingWhisper ? value.speakerTurnDetection : ""
  ].join("|");
}

async function startAudioFallbackIfNeeded(): Promise<void> {
  if (!settings.enabled || settings.inputMode === "captions" || audioCaptureRequested || !isYouTubeWatchPage()) {
    return;
  }
  if (Date.now() < audioStartBlockedUntil) {
    return;
  }

  if (shouldStartAudioFallback()) {
    audioCaptureRequested = true;
    overlay.showStatus("음성 인식을 시작하는 중...", settings);
    try {
      const response = await chrome.runtime.sendMessage<MessageResponse<{ tabId: number }>>({ type: "START_AUDIO_CAPTURE" });
      if (!response?.ok) {
        overlay.showError(response?.error ?? "음성 캡처 시작 응답을 받지 못했습니다. 확장 프로그램을 새로고침해 주세요.", settings);
        audioCaptureRequested = false;
        audioStartBlockedUntil = Date.now() + 12_000;
      }
    } catch (error) {
      overlay.showError(getErrorMessage(error), settings);
      audioCaptureRequested = false;
      audioStartBlockedUntil = Date.now() + 12_000;
    }
  }
}

async function restartAudioFallback(): Promise<void> {
  await stopAudioFallback();
  audioStartBlockedUntil = 0;
  await startAudioFallbackIfNeeded();
}

async function stopAudioFallback(): Promise<void> {
  if (!audioCaptureRequested || stoppingAudioCapture) {
    return;
  }
  stoppingAudioCapture = true;
  audioCaptureRequested = false;
  try {
    await chrome.runtime.sendMessage({ type: "STOP_AUDIO_CAPTURE" });
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
  resetTimedTextState();
  audioCaptureRequested = false;
  audioStartBlockedUntil = 0;
  overlay.destroy();
  await chrome.runtime.sendMessage({ type: "STOP_AUDIO_CAPTURE" }).catch(() => undefined);
}

function applySettingsUpdate(nextSettings: TranslatorSettings): void {
  const previousSettings = settings;
  const wasAudioCaptureActive = Boolean(previousSettings?.enabled && audioCaptureRequested);
  const shouldStopAudio =
    wasAudioCaptureActive && (!nextSettings.enabled || nextSettings.inputMode === "captions");
  const shouldRestartAudio =
    wasAudioCaptureActive &&
    !shouldStopAudio &&
    audioCaptureSettingsKey(previousSettings) !== audioCaptureSettingsKey(nextSettings);
  settings = nextSettings;
  lastSentKey = "";

  if (!settings.enabled) {
    void disableTranslator();
    return;
  }

  if (shouldStopAudio) {
    void stopAudioFallback();
  } else if (shouldRestartAudio) {
    void restartAudioFallback();
  }

  ensureOverlay();
  overlay.applySettings(settings);
  if (!activeVideoId) {
    activeVideoId = currentWatchVideoId();
  }
  void loadTimedText(activeVideoId);
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

async function tick(): Promise<void> {
  handleUrlChange();

  if (!settings.enabled || !isYouTubeWatchPage()) {
    await stopAudioFallback();
    if (!settings.enabled) {
      overlay.destroy();
    } else {
      overlay.clear();
    }
    return;
  }

  if (audioCaptureRequested && !videoCanProduceAudio()) {
    await stopAudioFallback();
  }

  if (settings.inputMode !== "audio") {
    reloadTimedTextIfSelectedTrackChanged();
    retryTimedTextIfNeeded();

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

function installObservers(): void {
  const bodyObserver = new MutationObserver(() => {
    handleUrlChange();
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
  document.addEventListener("yt-navigate-finish", () => {
    currentUrl = "";
    handleUrlChange();
  });
  document.addEventListener("yt-page-data-updated", () => {
    currentUrl = "";
    handleUrlChange();
  });
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
    void loadContentSettings().then(applySettingsUpdate).catch((error) => {
      overlay.showError(getErrorMessage(error), settings);
    });
  });

  chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
    const message = rawMessage as RuntimeMessage;
    if (message.type === "TRANSLATION_READY") {
      if (settings.enabled && shouldAcceptAudioSegment(message.segment)) {
        overlay.showTranslation(message.segment, message.translatedText, message.provider, settings);
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "TRANSLATION_ERROR") {
      if (settings.enabled && shouldAcceptAudioSegment(message.segment)) {
        if (message.segment) {
          overlay.showSegmentError(message.segment, message.error, settings);
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
        message.captionHash === timedTextCaptionHash
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

    if (message.type === "AUDIO_TRANSCRIPT") {
      if (settings.enabled && shouldAcceptAudioSegment(message.segment)) {
        overlay.showStatus(`음성 인식됨, 번역 중... ${compactStatusText(message.segment.text)}`, settings);
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "STREAM_STT_TRANSCRIPT") {
      if (settings.enabled && !message.isFinal && shouldAcceptAudioSegment(message.segment)) {
        overlay.showStatus(`음성 인식 중... ${compactStatusText(message.segment.text)}`, settings);
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "AUDIO_CAPTURE_STATUS") {
      if (message.state === "recording") {
        audioCaptureRequested = true;
        audioStartBlockedUntil = 0;
        overlay.showStatus(message.statusText ?? "음성 인식 중...", settings);
        overlay.setControlStatus(controlStatusText(), settings);
      } else if (message.state === "idle") {
        audioCaptureRequested = false;
        overlay.setControlStatus(controlStatusText(), settings);
      } else if (message.error) {
        audioCaptureRequested = false;
        audioStartBlockedUntil = Date.now() + 12_000;
        overlay.showError(message.error, settings);
        overlay.setControlStatus(controlStatusText(), settings);
      }
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "SETTINGS_UPDATED") {
      applySettingsUpdate(message.settings);
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "GET_TAB_STATUS") {
      sendResponse({
        ok: true,
        audioCaptureRequested,
        timedTextSegments: timedTextSegments.length,
        url: location.href
      });
      return;
    }
  });
}

async function main(): Promise<void> {
  settings = await loadContentSettings();
  activeVideoId = currentWatchVideoId();
  lastCaptionSeenAt = 0;
  ensureOverlay();
  installObservers();
  void loadTimedText(activeVideoId);
  window.setInterval(() => {
    void runTick();
  }, 250);
}

const globalState = globalThis as Record<string, unknown>;
if (!globalState[CONTENT_BOOTSTRAP_FLAG]) {
  globalState[CONTENT_BOOTSTRAP_FLAG] = true;
  void main();
}
