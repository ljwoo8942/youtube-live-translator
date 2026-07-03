import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assistOfficialCaptionSegment,
  assistLyricsSegment,
  createLyricsAssistSession,
  extractLyricsSearchQueries,
  lyricLineSimilarity,
  searchLyricsCandidates,
  setLyricsCandidates
} from "../src/background/lyricsAssist.ts";

const readSource = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const content = readSource("src/content/index.ts");
const youtubeCaptions = readSource("src/content/youtubeCaptions.ts");
const overlay = readSource("src/content/overlay.ts");
const popup = readSource("src/popup/index.ts");
const offscreen = readSource("src/offscreen/index.ts");
const background = readSource("src/background/index.ts");
const captionCache = readSource("src/background/captionCache.ts");
const lyricsAssistSource = readSource("src/background/lyricsAssist.ts");
const providers = readSource("src/background/providers.ts");
const storage = readSource("src/shared/storage.ts");
const defaults = readSource("src/shared/defaults.ts");
const translationVersion = readSource("src/shared/translationVersion.ts");
const manifest = readSource("public/manifest.json");
const options = readSource("src/options/index.ts");
const localStt = readSource("local_stt/app.py");

test("STT code does not control YouTube fullscreen or video layout", () => {
  const pageCode = `${content}\n${overlay}`;
  assert.doesNotMatch(pageCode, /\b(?:requestFullscreen|exitFullscreen)\s*\(/);
  assert.doesNotMatch(pageCode, /button\.click\(\)/);
  assert.doesNotMatch(
    pageCode,
    /\b(?:video|player)\w*\.(?:style\.(?:width|height|left|right|top|bottom|objectFit)|classList\.(?:add|remove|toggle))/
  );
  assert.doesNotMatch(pageCode, /object-fit\s*:\s*cover|100vw|100vh/i);
});

test("overlay stays inside the YouTube player without browser top-layer APIs", () => {
  assert.match(overlay, /player\.append\(this\.host\)/);
  assert.match(overlay, /this\.host\.dataset\.mount = "player"/);
  assert.doesNotMatch(overlay, /\b(?:showPopover|hidePopover)\s*\(/);
  assert.doesNotMatch(overlay, /(?:setAttribute|removeAttribute)\("popover"/);
  assert.match(
    overlay,
    /:host\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0;[\s\S]*?pointer-events:\s*none;/
  );
  assert.match(overlay, /private placeHost\(player: HTMLElement\): void \{/);
  assert.match(overlay, /reconcilePlacement\(\): void \{/);
  assert.match(
    overlay,
    /if \(this\.host\.parentElement !== this\.player\) \{\s*this\.placeHost\(this\.player\);/
  );
  assert.doesNotMatch(overlay, /ResizeObserver|fullscreenchange/);
  assert.match(overlay, /\.stack\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*calc\(var\(--ytlt-bottom/);
});

test("fullscreen transitions never move the overlay to a document portal", () => {
  const placeStart = overlay.indexOf("private placeHost");
  const placeEnd = overlay.indexOf("private controlButtonFromEvent", placeStart);
  const placeHost = overlay.slice(placeStart, placeEnd);
  assert.ok(placeStart >= 0);
  assert.match(placeHost, /if \(this\.host\.parentElement !== player\) \{\s*player\.append\(this\.host\);/);
  assert.doesNotMatch(placeHost, /document\.fullscreenElement|portalRoot|getBoundingClientRect/);
  assert.doesNotMatch(placeHost, /document\.(?:body|documentElement)\.append/);
});

test("successful popup actions close before a later YouTube fullscreen click", () => {
  assert.match(popup, /function closePopupAfterSuccess\(\): void \{/);
  assert.match(popup, /window\.setTimeout\(\(\) => window\.close\(\), 120\)/);
  assert.match(popup, /setStatus\("자막을 켰습니다\."\);\s*closePopupAfterSuccess\(\)/);
  assert.match(popup, /if \(response\?\.ok\) \{\s*closePopupAfterSuccess\(\);\s*\}/);
});

test("audio status updates do not re-resolve the fullscreen player on every frame", () => {
  const functionStart = content.indexOf("function showAudioStatus");
  const functionEnd = content.indexOf("function showAudioTranslation", functionStart);
  const audioStatusHelpers = content.slice(functionStart, functionEnd);
  const startAudioStart = content.indexOf("async function startAudioFallbackIfNeeded");
  const startAudioEnd = content.indexOf("async function reconfigureAudioFallback", startAudioStart);
  const startAudioFallback = content.slice(startAudioStart, startAudioEnd);
  assert.ok(functionStart >= 0);
  assert.ok(startAudioStart >= 0);
  assert.doesNotMatch(audioStatusHelpers, /fullscreen|ensureOverlay|scheduleOverlayRefresh/);
  assert.match(audioStatusHelpers, /overlay\.showStatus\(text, settings\)/);
  assert.match(audioStatusHelpers, /overlay\.reconcilePlacement\(\)/);
  assert.match(audioStatusHelpers, /overlay\.setControlStatus\(text, settings\)/);
  assert.match(startAudioFallback, /setAudioControlStatus\("음성 STT 시작 중"\)/);
  assert.match(startAudioFallback, /setAudioControlStatus\("음성 STT 대기"\)/);
  assert.doesNotMatch(startAudioFallback, /overlay\.setControlStatus/);
  assert.match(overlay, /setControlStatus\(text: string, _settings: ContentSettings\): void \{\s*if \(!this\.host\?\.isConnected\) \{\s*return;/);
  assert.match(overlay, /showStatus\(text: string, _settings: ContentSettings\): void \{\s*if \(!this\.host\?\.isConnected\) \{\s*return;/);
  assert.doesNotMatch(overlay, /showStatus\(text: string, _settings: ContentSettings\): void \{[\s\S]{0,120}this\.ensure\(/);
});

test("popup mini controls toggle only changes the overlay control visibility setting", () => {
  assert.match(popup, /id="miniControlsEnabled"\s+type="checkbox"/);
  assert.match(popup, /persist\(\{ miniControlsEnabled: miniControlsEnabled\.checked \}\)/);
  assert.match(overlay, /this\.host\.dataset\.controlsEnabled = String\(settings\.miniControlsEnabled\)/);
  assert.doesNotMatch(overlay, /miniControlsEnabled[\s\S]{0,160}(?:requestFullscreen|exitFullscreen|objectFit)/);
});

test("mini controls stay out of the subtitle stack and YouTube control hit area", () => {
  assert.match(overlay, /<div class="controls"[\s\S]*?<div class="stack">/);
  assert.doesNotMatch(overlay, /<div class="stack">\s*<div class="controls"/);
  assert.match(overlay, /\.controls\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?right:\s*12px;[\s\S]*?top:\s*12px;/);
});

test("mini controls can collapse without touching playback layout or audio capture", () => {
  assert.match(defaults, /miniControlsCollapsed:\s*false/);
  assert.match(storage, /miniControlsCollapsed:\s*settings\.miniControlsCollapsed/);
  assert.match(overlay, /data-action="collapse"/);
  assert.match(overlay, /this\.host\.dataset\.controlsCollapsed = String\(settings\.miniControlsCollapsed\)/);
  assert.match(overlay, /\.controls\s*\{[\s\S]*?pointer-events:\s*auto;/);
  assert.match(overlay, /controlButtonFromEvent\(event: Event\): HTMLButtonElement \| null \{[\s\S]*?event\.composedPath\(\)/);
  assert.match(overlay, /const root = this\.shadow \?\? this\.host/);
  assert.match(overlay, /root\.addEventListener\("pointerdown", this\.handleControlPointerEvent, true\)/);
  assert.match(overlay, /root\.addEventListener\("pointerup", this\.handleControlPointerEvent, true\)/);
  assert.match(overlay, /root\.addEventListener\("click", this\.handleControlClick, true\)/);
  assert.match(overlay, /this\.controlAction\?\.\(button\.dataset\.action \?\? ""\)/);
  assert.match(overlay, /root\?\.removeEventListener\("click", this\.handleControlClick, true\)/);
  assert.doesNotMatch(overlay, /window\.addEventListener\("(?:pointerdown|pointerup|click)", this\.handleControl/);
  assert.match(overlay, /:host\(\[data-controls-collapsed="true"\]\) \.controls button:not\(\[data-action="toggle"\]\):not\(\[data-action="collapse"\]\)/);
  assert.match(overlay, /:host\(\[data-controls-collapsed="true"\]\) \.control-status\s*\{[\s\S]*?display:\s*none;/);
  assert.match(content, /MessageResponse<\{ settings: ContentSettings; revision: number \}>/);
  assert.match(content, /applySettingsUpdate\(response\.settings, response\.revision\)/);
  assert.match(content, /case "collapse":[\s\S]*?settings = \{ \.\.\.settings, miniControlsCollapsed: !settings\.miniControlsCollapsed \};[\s\S]*?overlay\.applySettings\(settings\);[\s\S]*?await updateSettingsFromMini\(\{ miniControlsCollapsed: settings\.miniControlsCollapsed \}\);/);
  const collapseCase = content.slice(content.indexOf('case "collapse":'), content.indexOf('case "source":'));
  assert.doesNotMatch(collapseCase, /(?:reconfigureAudioFallback|startAudioFallbackIfNeeded|stopAudioFallback|loadTimedText|scheduleVideoSessionCaptionLoads)/);
  assert.doesNotMatch(overlay, /data-controls-collapsed[\s\S]{0,260}(?:width|height|left|right|top|bottom)\s*=/);
});

test("popup manual audio start is prepared before settings broadcast can auto-start STT", () => {
  const prepareHelperStart = popup.indexOf("async function prepareAudioCapture");
  const prepareHelperEnd = popup.indexOf("function startPreparedAudioCapture", prepareHelperStart);
  const prepareHelper = popup.slice(prepareHelperStart, prepareHelperEnd);
  const startHelperEnd = popup.indexOf("function setStatus", prepareHelperEnd);
  const startHelper = popup.slice(prepareHelperEnd, startHelperEnd);
  const startHandlerStart = popup.indexOf('document.querySelector("#startAudio")');
  const startHandlerEnd = popup.indexOf('document.querySelector("#stopAudio")', startHandlerStart);
  const startHandler = popup.slice(startHandlerStart, startHandlerEnd);
  const prepareIndex = startHandler.indexOf("await prepareAudioCapture()");
  const persistIndex = startHandler.indexOf("await persist({");
  const startIndex = startHandler.indexOf("await startPreparedAudioCapture(prepared)");
  assert.match(prepareHelper, /type: "PREPARE_AUDIO_CAPTURE"/);
  assert.match(startHelper, /type: "START_AUDIO_CAPTURE"/);
  assert.ok(prepareIndex >= 0);
  assert.ok(persistIndex > prepareIndex);
  assert.ok(startIndex > persistIndex);
  assert.match(content, /const MANUAL_AUDIO_START_PENDING_MS = 3500/);
  assert.match(content, /let manualAudioStartPendingUntil = 0/);
  assert.match(content, /Date\.now\(\) < manualAudioStartPendingUntil/);
  assert.match(content, /manualAudioStartPendingUntil = Date\.now\(\) \+ MANUAL_AUDIO_START_PENDING_MS/);
  assert.match(content, /manualAudioStartPendingUntil = 0;[\s\S]*?showAudioStatus\(message\.statusText \?\? "음성 인식 중\.\.\."\)/);
});

test("popup enable pre-arms audio-only capture before playback begins", () => {
  const enabledHandlerStart = popup.indexOf('enabled?.addEventListener("change"');
  const enabledHandlerEnd = popup.indexOf('miniControlsEnabled?.addEventListener("change"', enabledHandlerStart);
  const enabledHandler = popup.slice(enabledHandlerStart, enabledHandlerEnd);
  assert.ok(enabledHandlerStart >= 0);
  assert.match(enabledHandler, /inputMode\?\.value === "audio"/);
  assert.match(enabledHandler, /await prepareAudioCapture\(\)/);
  assert.match(enabledHandler, /await persist\(\{ enabled: true \}\)/);
  assert.match(enabledHandler, /await startPreparedAudioCapture\(prepared\)/);
  assert.ok(enabledHandler.indexOf("await prepareAudioCapture()") < enabledHandler.indexOf("await persist({ enabled: true })"));
});

test("audio setting changes reconfigure STT without reacquiring the tab stream", () => {
  assert.match(content, /function audioCaptureSettingsKey[\s\S]*?value\.contentMode,/);
  assert.match(
    content,
    /if \(shouldStopAudio\) \{\s*void stopAudioFallback\(true\);\s*\} else if \(shouldReconfigureAudio\) \{\s*audioStopRequested = false;\s*void reconfigureAudioFallback\(\);/
  );
  assert.match(content, /type: "RECONFIGURE_AUDIO_CAPTURE"/);
  assert.match(background, /function audioTransportConfig\(settings: TranslatorSettings\)/);
  assert.match(background, /type: "RECONFIGURE_AUDIO_CAPTURE",\s*target: "offscreen"/);
  const reconfigureStart = offscreen.indexOf("async function reconfigureCapture");
  const reconfigureEnd = offscreen.indexOf("async function startCapture", reconfigureStart);
  const reconfigureCapture = offscreen.slice(reconfigureStart, reconfigureEnd);
  assert.ok(reconfigureStart >= 0);
  assert.match(reconfigureCapture, /discardActiveRecorder\(\)/);
  assert.match(reconfigureCapture, /teardownStreamingNodes\(\)/);
  assert.doesNotMatch(reconfigureCapture, /getTracks\(\)|track\.stop\(\)|getUserMedia\(/);
  assert.match(
    offscreen,
    /else if \(message\.type === "RECONFIGURE_AUDIO_CAPTURE"[\s\S]*?relayStatus\(\s*"recording"/
  );
  assert.doesNotMatch(content, /scheduleAudioTransitionAfterFullscreen/);
});

test("transient pause during fullscreen transitions does not restart tab capture", () => {
  assert.match(content, /if \(audioCaptureRequested && videoPlaybackEnded\(\)\) \{\s*await stopAudioFallback\(\);/);
  assert.doesNotMatch(content, /audioCaptureRequested && !videoCanProduceAudio\(\)/);
  assert.match(content, /function videoPlaybackEnded\(\)[\s\S]*?if \(!video\) \{\s*return false;/);
});

test("current audio transcripts are not dropped by transient video readiness state", () => {
  const functionStart = content.indexOf("function shouldAcceptAudioSegment");
  const functionEnd = content.indexOf("function contentModeStatusLabel", functionStart);
  const acceptAudioSegment = content.slice(functionStart, functionEnd);
  assert.ok(functionStart >= 0);
  assert.doesNotMatch(acceptAudioSegment, /videoCanProduceAudio\(\)/);
  assert.match(acceptAudioSegment, /audioCaptureRequested/);
  assert.match(acceptAudioSegment, /!audioStopRequested/);
  assert.match(acceptAudioSegment, /!audioCaptureSuppressed/);
});

test("fullscreen entry suspends tab capture before the click and resumes it after entry", () => {
  assert.match(content, /document\.addEventListener\("fullscreenchange", handleFullscreenChange, true\)/);
  assert.match(content, /document\.addEventListener\("pointerdown", handleFullscreenPointerIntent, true\)/);
  assert.match(
    content,
    /function handleFullscreenPointerIntent\(event: PointerEvent\): void \{[\s\S]*?target\.closest\("\.ytp-fullscreen-button"\)[\s\S]*?void suspendAudioForFullscreenIntent\(\);/
  );
  assert.match(
    content,
    /async function suspendAudioForFullscreenIntent\(\): Promise<void> \{[\s\S]*?await stopAudioFallback\(false, requestedVideoId\);/
  );
  assert.match(
    content,
    /function handleFullscreenChange\(\): void \{[\s\S]*?document\.fullscreenElement[\s\S]*?scheduleFullscreenAudioResume\(FULLSCREEN_AUDIO_RESUME_DELAY_MS\);/
  );
  assert.match(
    content,
    /function resumeAudioAfterFullscreenIntent\(\): void \{[\s\S]*?audioCaptureSuppressed = false;[\s\S]*?audioStopRequested = false;[\s\S]*?void startAudioFallbackIfNeeded\(\);/
  );
  assert.doesNotMatch(content, /fullscreenSettlingUntil|FULLSCREEN_SETTLE_MS|prepareForFullscreenTransition/);
  assert.match(
    content,
    /function showAudioTranslation\(\s*videoId: string \| undefined,\s*segment: CaptionSegment/
  );
  assert.doesNotMatch(content, /scheduleAudioOverlayUpdateAfterFullscreen|isAudioOverlayUpdateDeferred/);
  const audioOverlayStart = content.indexOf("function showAudioStatus");
  const audioOverlayEnd = content.indexOf("function clamp", audioOverlayStart);
  const audioOverlayHelpers = content.slice(audioOverlayStart, audioOverlayEnd);
  assert.doesNotMatch(audioOverlayHelpers, /fullscreen|ensureOverlay|scheduleOverlayRefresh/);
  assert.doesNotMatch(content, /AUDIO_FULLSCREEN_SETTLE_EXTRA_MS|fullscreenTransitionToken|deferredAudioTransition/);
  assert.doesNotMatch(content, /scheduleAudioTransitionAfterFullscreen|recoverStaleYouTubeFullscreenState/);
});

test("STT overlay callbacks never reattach the overlay during fullscreen recovery", () => {
  const translationStart = content.indexOf("function showAudioTranslation");
  const translationEnd = content.indexOf("function showAudioSegmentError", translationStart);
  const audioTranslation = content.slice(translationStart, translationEnd);
  const errorEnd = content.indexOf("function clamp", translationEnd);
  const audioError = content.slice(translationEnd, errorEnd);

  assert.match(audioTranslation, /overlay\.showTranslation\(segment, translatedText, provider, settings, false\)/);
  assert.match(audioError, /overlay\.showSegmentError\(segment, error, settings, false\)/);
  assert.match(overlay, /ensureConnected = true/);
  assert.match(overlay, /if \(!this\.host\?\.isConnected && ensureConnected\)/);
});

test("content script never toggles YouTube's native fullscreen control", () => {
  assert.doesNotMatch(content, /recoverStaleYouTubeFullscreenState|scheduleFullscreenStateVerification/);
  assert.match(content, /target\.closest\("\.ytp-fullscreen-button"\)/);
  assert.doesNotMatch(content, /\b(?:requestFullscreen|exitFullscreen)\s*\(|fullscreenButton\.click\(\)|button\.click\(\)/);
});

test("content script never mutates YouTube fullscreen layout classes or attributes", () => {
  assert.doesNotMatch(content, /ytp-full-bleed-player|ytp-fullscreen-metadata-top|ytp-fullscreen-grid-peeking/);
  assert.doesNotMatch(content, /removeAttribute\("fullscreen"\)|classList\.remove|document\.body\.classList\.remove/);
  assert.doesNotMatch(content, /window\.dispatchEvent\(new Event\("resize"\)\)/);
});

test("fullscreen-scoped player and video are preferred before document fallback", () => {
  assert.match(overlay, /findPlayerInScope\(document\.fullscreenElement\)/);
  assert.match(overlay, /findVideoInScope\(document\.fullscreenElement\) \?\? findVideoInScope\(document\)/);
  assert.match(overlay, /scope\.matches\("#movie_player, \.html5-video-player"\)/);
  assert.match(overlay, /matches\("\.html5-main-video"\)/);
  assert.doesNotMatch(overlay, /querySelector<HTMLElement>\("ytd-player"\)/);
  assert.match(overlay, /findPlayerInScope\(document\.fullscreenElement\)/);
});

test("scroll and resize do not trigger overlay remeasurement", () => {
  assert.doesNotMatch(content, /window\.addEventListener\(\s*"scroll"/);
  assert.doesNotMatch(content, /window\.addEventListener\(\s*"resize"/);
});

test("overlay-only setting changes do not reload captions or restart audio", () => {
  assert.match(
    content,
    /function shouldReloadTimedTextForSettingsChange\(\s*previousSettings: ContentSettings,\s*nextSettings: ContentSettings\s*\)/
  );
  assert.match(content, /if \(nextSettings\.inputMode === "audio"\) \{\s*return false;/);
  assert.match(
    content,
    /previousSettings\.inputMode !== nextSettings\.inputMode \|\|[\s\S]*?previousSettings\.sourceLanguage !== nextSettings\.sourceLanguage \|\|[\s\S]*?previousSettings\.contentMode !== nextSettings\.contentMode/
  );
  assert.match(content, /const shouldReloadTimedText = shouldReloadTimedTextForSettingsChange\(previousSettings, nextSettings\)/);
  assert.match(content, /if \(shouldReloadTimedText\) \{\s*void loadTimedText\(activeVideoId\);/);
});

test("hybrid input waits for caption loading but falls back when timed text stays empty", () => {
  const fallbackStart = content.indexOf("function shouldStartAudioFallback");
  const fallbackEnd = content.indexOf("function audioCaptureSettingsKey", fallbackStart);
  const fallback = content.slice(fallbackStart, fallbackEnd);
  assert.ok(fallbackStart >= 0);
  assert.match(fallback, /if \(timedTextLoading \|\| timedTextSegments\.length > 0\) \{\s*return false;/);
  assert.match(
    fallback,
    /if \(lastTimedTextNoSourceAt > 0\) \{\s*return now - lastTimedTextNoSourceAt >= AUDIO_FALLBACK_NO_CAPTION_WAIT_MS;/
  );
  assert.match(
    content,
    /settings\.inputMode === "captionsThenAudio" && audioCaptureRequested && timedTextSegments\.length > 0/
  );
});

test("captionless startup can enter audio fallback without waiting for the stale-caption timeout", () => {
  assert.match(content, /const AUDIO_FALLBACK_NO_CAPTION_WAIT_MS = 250/);
  assert.match(content, /let lastTimedTextNoSourceAt = 0/);
  assert.match(content, /lastTimedTextNoSourceAt = Date\.now\(\)/);
  assert.match(content, /if \(snapshot && !result\?\.trackKey && !getSelectedOfficialCaptionTrackKey\(settings, snapshot\)\) \{/);
  assert.match(
    content,
    /if \(lastTimedTextNoSourceAt > 0\) \{\s*return now - lastTimedTextNoSourceAt >= AUDIO_FALLBACK_NO_CAPTION_WAIT_MS;/
  );
  assert.match(
    content,
    /if \(lastTimedTextNoSourceAt > 0 && settings\.inputMode === "captionsThenAudio"\) \{[\s\S]*?startAudioFallbackIfNeeded\(\);/
  );
  assert.match(content, /document\.addEventListener\(\s*"playing"/);
  const startAudioStart = content.indexOf("async function startAudioFallbackIfNeeded");
  const startAudioEnd = content.indexOf("async function reconfigureAudioFallback", startAudioStart);
  assert.doesNotMatch(content.slice(startAudioStart, startAudioEnd), /fullscreen/i);
});

test("same-video media replacement does not reset the video session or audio capture", () => {
  const handlerStart = content.indexOf("function handleVideoElementChange");
  const handlerEnd = content.indexOf("function resyncVideoSessionAfterNavigation", handlerStart);
  const handler = content.slice(handlerStart, handlerEnd);
  assert.ok(handlerStart >= 0);
  assert.match(handler, /if \(videoId !== activeVideoId\) \{\s*beginVideoSession\(videoId\);/);
  assert.match(handler, /scheduleVideoSessionCaptionLoads\(videoId\)/);
  assert.doesNotMatch(
    handler,
    /if \(settings\.inputMode !== "audio"[\s\S]*?beginVideoSession\(videoId\)/
  );
});

test("SPA video changes preserve the tab stream and rebind only the STT session", () => {
  const sessionStart = content.indexOf("function beginVideoSession");
  const sessionEnd = content.indexOf("function currentVideoTimeMs", sessionStart);
  const session = content.slice(sessionStart, sessionEnd);
  assert.ok(sessionStart >= 0);
  assert.match(session, /if \(audioCaptureRequested\) \{[\s\S]*?reconfigureAudioFallback\(previousVideoId\)/);
  assert.match(session, /else \{\s*void stopAudioFallback\(false, previousVideoId\);/);
  assert.doesNotMatch(session, /startAudioFallbackIfNeeded/);
  assert.match(background, /reconfigureAudioCaptureInternal\(tabId, videoId, state\.activeVideoId\)/);
});

test("audio callbacks are isolated to the current video session", () => {
  assert.match(content, /message\.videoId === activeVideoId && shouldAcceptAudioSegment\(message\.segment\)/);
  assert.match(content, /if \(!message\.videoId \|\| message\.videoId !== activeVideoId\) \{/);
});

test("late translation callbacks cannot cross video sessions", () => {
  const readyStart = content.indexOf('if (message.type === "TRANSLATION_READY")');
  const errorStart = content.indexOf('if (message.type === "TRANSLATION_ERROR")', readyStart);
  const pretranslateStart = content.indexOf('if (message.type === "PRETRANSLATE_RESULT")', errorStart);
  const readyHandler = content.slice(readyStart, errorStart);
  const errorHandler = content.slice(errorStart, pretranslateStart);

  assert.match(readyHandler, /!message\.videoId \|\| message\.videoId === activeVideoId/);
  assert.match(errorHandler, /!message\.videoId \|\| message\.videoId === activeVideoId/);
});

test("short backward seeks reset the timed-text cursor", () => {
  assert.match(youtubeCaptions, /currentMs < segments\[startIndex\]\.startMs - TIMED_TEXT_DISPLAY_LEAD_MS/);
  assert.doesNotMatch(
    youtubeCaptions,
    /currentMs < segments\[startIndex\]\.startMs - TIMED_TEXT_DISPLAY_LEAD_MS \* 4/
  );
  assert.match(youtubeCaptions, /startIndex = 0;\s*timedTextCursorIndex = 0;/);
});

test("visible YouTube captions are used when timed text track metadata is unavailable", () => {
  const functionStart = content.indexOf("function readVisibleOfficialCaption()");
  const functionEnd = content.indexOf("function scheduleVisibleOfficialCaptionRead", functionStart);
  const reader = content.slice(functionStart, functionEnd);
  assert.ok(functionStart >= 0);
  assert.doesNotMatch(reader, /!getSelectedOfficialCaptionTrackKey\(/);
  assert.match(reader, /const segment = readVisibleCaptionSegment\(\);/);
  assert.match(content, /const visibleSegment = readVisibleCaptionSegment\(\);[\s\S]*?void processCaptionSegment\(visibleSegment\);/);
});

test("official timed text matching keeps short captions readable", () => {
  assert.match(youtubeCaptions, /const TIMED_TEXT_DISPLAY_TRAILING_GRACE_MS = 900/);
  assert.match(youtubeCaptions, /const currentMs = video\.currentTime \* 1000 \+ settings\.latencyOffsetMs;/);
  assert.doesNotMatch(
    youtubeCaptions,
    /currentTime \* 1000 \+ settings\.latencyOffsetMs \+ TIMED_TEXT_DISPLAY_LEAD_MS/
  );
  assert.match(youtubeCaptions, /currentMs < segment\.startMs - TIMED_TEXT_DISPLAY_LEAD_MS/);
  assert.match(youtubeCaptions, /currentMs > segment\.endMs \+ TIMED_TEXT_DISPLAY_TRAILING_GRACE_MS/);
  assert.match(youtubeCaptions, /return activeMatch \?\? leadMatch \?\? trailingMatch/);
});

test("late official caption translations are cached instead of being permanently dropped", () => {
  const sendStart = content.indexOf("async function sendSegment");
  const sendEnd = content.indexOf("async function processCaptionSegment", sendStart);
  const sendSegment = content.slice(sendStart, sendEnd);
  const processStart = sendEnd;
  const processEnd = content.indexOf("async function loadTimedText", processStart);
  const processSegment = content.slice(processStart, processEnd);

  assert.ok(sendStart >= 0);
  assert.ok(processStart >= 0);
  assert.match(
    sendSegment,
    /segment\.segment\.source === "youtubeTimedText"[\s\S]*?timedTextTranslations\.set\(segment\.segment\.id, response\.translatedText\)/
  );
  assert.match(processSegment, /captionRequestsInFlight\.has\(key\)/);
  assert.match(processSegment, /captionRequestRetryAfter\.get\(key\)/);
  assert.doesNotMatch(processSegment, /lastSentKey = key/);
  assert.match(content, /function captionRequestKey\(segment: CaptionSegment\)[\s\S]*?segment\.id/);
});

test("visible caption reader falls back to newer YouTube caption DOM shapes", () => {
  assert.match(youtubeCaptions, /querySelectorAll<HTMLElement>\("\.ytp-caption-segment"\)/);
  assert.match(youtubeCaptions, /querySelectorAll<HTMLElement>\("\.caption-visual-line"\)/);
  assert.match(youtubeCaptions, /captionContainer\.textContent \?\? ""/);
});

test("Korean lyrics prompt avoids dry declarative prose endings", () => {
  assert.match(providers, /한국어 가사 자막은 보고서처럼 매 줄을 ~다, ~한다, ~된다, ~였다로 닫지 않는다/);
  assert.match(providers, /초안이 ~다, ~한다, ~된다, ~였다로 끝나면 원문이 의도적 선언문이 아닌 한 다시 써서 가사다운 종결로 바꾼다/);
  assert.match(providers, /한국어 일반 자막도 기본값을 문어체 ~다로 두지 않는다/);
  assert.match(providers, /痛むごとに血が流れて落ちていく -> 아플 때마다 피가 흘러내려/);
  assert.match(translationVersion, /subtitle-fidelity-first-v28/);
});

test("manual audio start clears stale stop intent before starting tab capture", () => {
  const prepareIndex = popup.indexOf("async function prepareAudioCapture");
  const startIndex = popup.indexOf("function startPreparedAudioCapture", prepareIndex);
  assert.ok(prepareIndex >= 0);
  assert.ok(startIndex > prepareIndex);
  assert.match(popup, /videoId:\s*prepared\?\.ok\s*\?\s*prepared\.videoId\s*:\s*undefined/);
  assert.match(popup, /videoId:\s*prepared\.videoId/);
});

test("popup stop suppresses automatic restart and is bound to the prepared video session", () => {
  const prepareIndex = popup.indexOf('type: "PREPARE_AUDIO_STOP"');
  const stopIndex = popup.indexOf('type: "STOP_AUDIO_CAPTURE"', prepareIndex);
  assert.ok(prepareIndex >= 0);
  assert.ok(stopIndex > prepareIndex);
  assert.match(content, /settings\.inputMode === "captions" \|\|\s*audioCaptureRequested \|\|\s*audioCaptureSuppressed \|\|/);
  assert.match(
    content,
    /message\.type === "PREPARE_AUDIO_STOP"[\s\S]*?audioStopRequested = true;[\s\S]*?audioCaptureSuppressed = true;[\s\S]*?videoId: activeVideoId/
  );
});

test("offscreen lifecycle commands only accept explicitly routed background messages", () => {
  assert.match(offscreen, /if \(!\("target" in message\) \|\| message\.target !== "offscreen"\) \{\s*return false;/);
  assert.match(background, /if \("target" in message && message\.target === "offscreen"\) \{\s*return false;/);
  assert.match(background, /type: "START_AUDIO_CAPTURE",\s*target: "offscreen"/);
  assert.match(background, /type: "STOP_AUDIO_CAPTURE",\s*target: "offscreen"/);
  assert.match(background, /type: "GET_OFFSCREEN_AUDIO_STATE",\s*target: "offscreen"/);
});

test("streaming STT mixes stereo audio before downsampling", () => {
  assert.match(offscreen, /function mixToMono\(buffer: AudioBuffer\): Float32Array \{/);
  assert.match(offscreen, /buffer\.numberOfChannels/);
  assert.match(offscreen, /buffer\.getChannelData\(channel\)/);
  assert.match(offscreen, /const mixed = mixToMono\(event\.inputBuffer\)/);
  assert.match(offscreen, /const downsampled = downsampleTo16k\(mixed, audioContext\.sampleRate\)/);
  assert.doesNotMatch(offscreen, /event\.inputBuffer\.getChannelData\(0\)[\s\S]{0,80}downsampleTo16k/);
});

test("streaming STT downsampling averages source ranges for music input", () => {
  assert.match(offscreen, /const start = Math\.floor\(index \* ratio\)/);
  assert.match(offscreen, /const end = Math\.min\(input\.length, Math\.max\(start \+ 1, Math\.floor\(\(index \+ 1\) \* ratio\)\)\)/);
  assert.match(offscreen, /for \(let sourceIndex = start; sourceIndex < end; sourceIndex \+= 1\)/);
  assert.doesNotMatch(offscreen, /Math\.floor\(index \* ratio\)\)\] \?\? 0/);
});

test("playing events preserve the active STT buffer and tab capture", () => {
  const playingHandlerStart = content.indexOf('document.addEventListener(\n    "playing"');
  const playingHandlerEnd = content.indexOf('document.addEventListener("yt-navigate-finish"', playingHandlerStart);
  const playingHandler = content.slice(playingHandlerStart, playingHandlerEnd);
  assert.ok(playingHandlerStart >= 0);
  assert.doesNotMatch(playingHandler, /RESET_AUDIO_CAPTURE_BUFFER|STOP_AUDIO_CAPTURE/);
  assert.match(background, /type: "RESET_AUDIO_CAPTURE_BUFFER",\s*target: "offscreen"/);
  assert.match(offscreen, /message\.type === "RESET_AUDIO_CAPTURE_BUFFER"/);
  assert.match(offscreen, /sttSocket\.send\("reset"\)/);
  assert.doesNotMatch(offscreen, /RESET_AUDIO_CAPTURE_BUFFER[\s\S]{0,500}track\.stop\(\)/);
  assert.match(
    localStt,
    /if text_message == "reset":[\s\S]*?buffer_chunks\.clear\(\)[\s\S]*?buffered_samples = 0/
  );
});

test("same-video startup reuses the live STT socket without reconfiguration", () => {
  assert.match(background, /async function reuseAudioCapture\(/);
  assert.match(
    background,
    /if \(state\?\.activeVideoId === videoId\) \{\s*return reuseAudioCapture\(tabId, videoId, state\);/
  );
  assert.match(background, /statusText: "기존 음성 캡처와 STT 연결 유지"/);
  const reuseStart = background.indexOf("async function reuseAudioCapture");
  const reuseEnd = background.indexOf("async function startAudioCaptureInternal", reuseStart);
  const reuseCapture = background.slice(reuseStart, reuseEnd);
  assert.doesNotMatch(reuseCapture, /RECONFIGURE_AUDIO_CAPTURE|START_AUDIO_CAPTURE|STOP_AUDIO_CAPTURE/);
});

test("mini retry clears stale stop intent before restarting the actual offscreen session", () => {
  const retryStart = content.indexOf('case "retry":');
  const retryEnd = content.indexOf('case "options":', retryStart);
  const retryCase = content.slice(retryStart, retryEnd);
  const clearStopIntent = retryCase.indexOf("audioStopRequested = false");
  const reconfigure = retryCase.indexOf("reconfigureAudioFallback(undefined, true)");
  assert.ok(retryStart >= 0);
  assert.ok(clearStopIntent >= 0);
  assert.ok(clearStopIntent < reconfigure);
  assert.match(retryCase, /setAudioControlStatus\("음성 STT 재시작 중"\)/);
  assert.match(retryCase, /reconfigureAudioFallback\(undefined, true\)/);
  assert.doesNotMatch(retryCase, /if \(audioCaptureRequested\)/);
  assert.match(
    background,
    /async function reconfigureAudioCaptureInternal\([\s\S]*?startIfMissing = false[\s\S]*?if \(startIfMissing\) \{\s*return startAudioCaptureInternal\(undefined, tabId, videoId\);/
  );
  assert.match(background, /message\.startIfMissing/);
});

test("SPA capture stops and status updates are isolated by video session", () => {
  assert.match(content, /const previousVideoId = activeVideoId;[\s\S]*?stopAudioFallback\(false, previousVideoId\)/);
  assert.match(content, /sendMessage\(\{ type: "STOP_AUDIO_CAPTURE", videoId: captureVideoId \}\)/);
  assert.match(background, /stopAudioCapture\(message\.tabId \?\? sender\.tab\?\.id, message\.videoId\)/);
  assert.match(offscreen, /activeTabId !== message\.tabId \|\| activeVideoId !== message\.videoId/);
  assert.match(content, /if \(!message\.videoId \|\| message\.videoId !== activeVideoId\)/);
  assert.match(
    background,
    /!targetTabId \|\|\s*!message\.videoId \|\|\s*targetTabId !== activeAudioTabId \|\|\s*message\.videoId !== activeAudioVideoId/
  );
});

test("offscreen errors serialize cleanup and stale fatal errors cannot stop a new video", () => {
  assert.doesNotMatch(offscreen, /void\s+stopCapture\(\)/);
  assert.match(offscreen, /stopCaptureIfSession\(tabIdForRecorder,\s*videoIdForRecorder\)/);
  assert.match(offscreen, /if \(activeTabId !== tabId \|\| activeVideoId !== videoId\)/);
  assert.match(offscreen, /enqueueCaptureLifecycle\(stopCapture\)/);
  assert.match(background, /stopAudioCapture\(tabId,\s*videoId\)/);
  assert.match(background, /if \(!isActiveAudioSession\(tabId,\s*videoId\)\) \{\s*return;/);
});

test("HTTP STT queues and failure cooldowns are isolated by video session", () => {
  assert.match(background, /type AudioQueueState = \{ videoId: string;/);
  assert.match(background, /audioQueues\.get\(tabId\) !== ownedQueue/);
  assert.match(background, /getAudioFailureCooldown\(tabId,\s*message\.videoId\)/);
  assert.match(background, /setAudioFailureCooldown\(message\.tabId,\s*errorMessage,\s*message\.videoId\)/);
});

test("known subtitle thank-you hallucinations are blocked before translation", () => {
  assert.match(background, /thankyouverymuch/);
  assert.match(background, /字幕をご覧いただきましてありがとうございました/);
  assert.match(background, /key\.includes\("字幕"\).*key\.includes\("ご覧いただ"\).*key\.includes\("ありがとう"\)/s);
  assert.match(background, /key\.includes\("자막"\).*key\.includes\("감사"\)/s);
});

test("Japanese staying intent is polished into natural Korean", () => {
  assert.match(background, /ここに居ようとして\(\?:る\|いる\)/);
  assert.match(background, /"여기에 머물려는"/);
});

test("misrecognized Japanese lyric keeps BAD and restores hama meaning", () => {
  assert.match(providers, /BADなダンス 腫魔ったらいいじゃん -> BAD한 댄스에 빠져버리면 되잖아/);
  assert.match(background, /BADなダンス\(\?:腫魔\|ハマ\)ったらいいじゃん/);
  assert.match(background, /"BAD한 댄스에 빠져버리면 되잖아"/);
});

test("lyrics assist derives search queries from YouTube metadata without manual copying", () => {
  const queries = extractLyricsSearchQueries({
    videoId: "video",
    title: "Artist - Song Title [Official MV] - YouTube",
    author: "Artist",
    description: "00:00 Opening\n01:23 Artist - Second Song\nunrelated long description",
    durationSeconds: 240,
    isLive: false
  });
  assert.deepEqual(queries, ["Artist - Song Title", "Opening", "Artist - Second Song"]);
});

test("lyrics assist enters and leaves lyric mode conservatively during live speech", () => {
  const session = createLyricsAssistSession("video");
  setLyricsCandidates(session, [
    {
      id: 1,
      trackName: "Song",
      artistName: "Artist",
      lines: ["届いたテレパシー", "やっと会えた", "夜を越えて", "また歌おう"]
    }
  ]);
  const segment = (id, text) => ({ id, source: "audioStt", startMs: 0, endMs: 1000, text });

  const first = assistLyricsSegment(session, segment("1", "届いたテレパシ"), "live", true);
  assert.equal(first.detectedContentMode, undefined);
  const second = assistLyricsSegment(session, segment("2", "やっと会えた"), "live", true);
  assert.equal(second.text, "やっと会えた");
  assert.equal(second.detectedContentMode, "lyrics");

  const firstSpeech = assistLyricsSegment(session, segment("3", "今日は来てくれてありがとう"), "live", true);
  assert.equal(firstSpeech.detectedContentMode, undefined);
  const secondSpeech = assistLyricsSegment(session, segment("4", "それでは少し話しましょう"), "live", true);
  assert.equal(secondSpeech.detectedContentMode, undefined);

  assistLyricsSegment(session, segment("5", "夜を越えて"), "live", true);
  const resumed = assistLyricsSegment(session, segment("6", "また歌おう"), "live", true);
  assert.equal(resumed.text, "また歌おう");
  assert.equal(resumed.detectedContentMode, "lyrics");
});

test("lyrics assist rejects unrelated search text and keeps repeated hooks matchable", () => {
  assert.ok(lyricLineSimilarity("wow wow また会おう", "wow wow また会おう") > 0.95);
  assert.ok(lyricLineSimilarity("今日は雑談をします", "夜を越えて歌おう") < 0.3);
  assert.match(background, /segment\.detectedContentMode !== "lyrics"/);
});

test("official caption lyrics assist adds context without replacing the official subtitle", () => {
  const session = createLyricsAssistSession("video-caption");
  setLyricsCandidates(session, [
    {
      id: 7,
      trackName: "Song",
      artistName: "Artist",
      lines: ["夜の向こうへ", "届いたテレパシー やっと会えた", "青い風の中で"]
    }
  ]);
  const source = {
    id: "caption-1",
    source: "youtubeTimedText",
    startMs: 1000,
    endMs: 3000,
    text: "届いたテレパシー やっと会えた"
  };
  const assisted = assistOfficialCaptionSegment(session, source);
  assert.equal(assisted.text, source.text);
  assert.equal(assisted.startMs, source.startMs);
  assert.match(assisted.contextText ?? "", /High-confidence external lyrics reference/);
  assert.match(assisted.contextText ?? "", /夜の向こうへ/);
  assert.equal(assisted.detectedContentMode, "lyrics");
  assert.equal(session.activeLyrics, true);
  assert.equal(session.selectedCandidateId, 7);
  assert.equal(session.cursor, 2);

  const unrelated = assistOfficialCaptionSegment(session, {
    ...source,
    id: "caption-2",
    text: "今日は普通の雑談をしています"
  });
  assert.equal(unrelated.contextText, undefined);
});

test("caption lyrics matching caches normalized lines and yields between batches", () => {
  assert.match(lyricsAssistSource, /normalizedLines\?: string\[\]/);
  assert.match(lyricsAssistSource, /candidate\.lines\.map\(normalizeLyricText\)/);
  assert.match(background, /const LYRICS_ASSIST_MATCH_BATCH_SIZE = 24/);
  assert.match(
    background,
    /await new Promise<void>\(\(resolve\) => globalThis\.setTimeout\(resolve, 0\)\)/
  );
});

test("caption-only translation path prepares and applies non-destructive lyrics search assistance", () => {
  assert.match(content, /type: "PREPARE_CAPTION_LYRICS_ASSIST", videoId/);
  assert.match(background, /async function addCaptionLyricsAssist\(/);
  assert.match(
    background,
    /const lyricsAssistedSegments = await addCaptionLyricsAssist\(tabId, message\.videoId, settings, message\.segments, true\)/
  );
  assert.match(background, /const segments = addCaptionContext\(lyricsAssistedSegments, lyricsAssistedSegments, settings\)/);
  assert.match(
    background,
    /message\.type === "CAPTION_SEGMENT"[\s\S]*?await addCaptionLyricsAssist\(tabId, videoId, settings, \[message\.segment\]\)/
  );
  assert.match(options, /가사 검색으로 공식 자막 문맥 보조 \+ STT 보정/);
});

test("lyrics search parses synchronized LRCLIB records without trusting instrumental results", async () => {
  const responseData = [
    {
      id: 7,
      trackName: "Song",
      artistName: "Artist",
      instrumental: false,
      plainLyrics: null,
      syncedLyrics: "[00:01.00]一番目\n[00:03.00]二番目\n[00:05.00]三番目\n[00:07.00]四番目"
    },
    {
      id: 8,
      trackName: "Instrumental",
      artistName: "Artist",
      instrumental: true,
      plainLyrics: "one\ntwo\nthree\nfour"
    }
  ];
  const candidates = await searchLyricsCandidates(
    {
      videoId: "video",
      title: "Artist - Song",
      author: "Artist",
      description: "",
      durationSeconds: 180,
      isLive: false
    },
    async () => new Response(JSON.stringify(responseData), { status: 200 })
  );
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].lines, ["一番目", "二番目", "三番目", "四番目"]);
});

test("lyrics search preserves bracketed song names and rejects unrelated metadata", async () => {
  assert.deepEqual(
    extractLyricsSearchQueries({
      videoId: "video",
      title: "【Song Title】 Cover",
      author: "Cover Singer",
      description: "",
      durationSeconds: 240,
      isLive: false
    }),
    ["Song Title"]
  );

  const candidates = await searchLyricsCandidates(
    {
      videoId: "video",
      title: "【Song Title】 Cover",
      author: "Cover Singer",
      description: "",
      durationSeconds: 240,
      isLive: false
    },
    async () =>
      new Response(
        JSON.stringify([
          {
            id: 11,
            trackName: "Song Title",
            artistName: "Original Artist",
            duration: 238,
            instrumental: false,
            plainLyrics: "line one\nline two\nline three\nline four"
          },
          {
            id: 12,
            trackName: "Completely Different",
            artistName: "Other Artist",
            duration: 240,
            instrumental: false,
            plainLyrics: "wrong one\nwrong two\nwrong three\nwrong four"
          }
        ]),
        { status: 200 }
      )
  );

  assert.deepEqual(candidates.map((candidate) => candidate.id), [11]);
});

test("caption lyrics assist waits for search and separates assisted cache entries", () => {
  assert.match(
    background,
    /const lyricsAssistedSegments = await addCaptionLyricsAssist\(tabId, message\.videoId, settings, message\.segments, true\)/
  );
  assert.match(
    background,
    /if \(waitForReady\) \{\s*await state\.ready;\s*\}/
  );
  assert.match(
    background,
    /const contextText = \[segment\.contextText, surroundingContext\]\.filter\(Boolean\)\.join\("\\n"\)/
  );
  assert.match(captionCache, /function segmentFingerprint\(segment: CaptionSegment\): string/);
  assert.match(captionCache, /cacheKey\(context, segment\)/);
  assert.match(
    background,
    /putCachedCaptionTranslations\(context, safeTranslations, batch\)/
  );
});

test("lyrics assist reports search and application state to the current video", () => {
  assert.match(background, /type: "LYRICS_ASSIST_STATUS"/);
  assert.match(content, /message\.type === "LYRICS_ASSIST_STATUS"/);
  assert.match(content, /lyricsAssistStatus = message\.statusText/);
});

test("lyrics search assist is configurable and restricted to its API host", () => {
  assert.match(defaults, /lyricsAssistEnabled:\s*true/);
  assert.match(storage, /lyricsAssistEnabled:\s*settings\.lyricsAssistEnabled/);
  assert.match(options, /id="lyricsAssistEnabled"/);
  assert.match(manifest, /https:\/\/lrclib\.net\/\*/);
  assert.match(background, /void prepareLyricsAssist\(tabId, videoId, settings\)/);
  assert.match(background, /settings\.contentMode === "spoken"/);
  assert.match(background, /assistLyricsSegment\([\s\S]*?message\.isFinal/);
});
