import type { CaptionSegment, PageCaptionSnapshot, PageCaptionTrack, TranslatorSettings } from "../shared/types";
import { findVideoElement } from "./overlay";

type CaptionTrack = PageCaptionTrack & {
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
};

type TimedTextSegment = CaptionSegment & {
  translated?: boolean;
};

export type TimedTextFetchResult = {
  videoId: string;
  trackLanguage: string;
  trackKey: string;
  segments: TimedTextSegment[];
};

type YouTubeWindow = Window &
  typeof globalThis & {
    ytInitialPlayerResponse?: Record<string, unknown>;
  };

type YouTubePlayerElement = HTMLElement & {
  getOption?: (module: string, option: string) => unknown;
  getPlayerResponse?: () => unknown;
};

const SHORT_SEGMENT_MAX_DURATION_MS = 1400;
const SHORT_SEGMENT_MAX_TEXT_LENGTH = 14;
const MERGE_MAX_GAP_MS = 650;
const MERGE_MAX_DURATION_MS = 4600;
const MERGE_MAX_LYRICS_DURATION_MS = 3200;
const MERGE_MAX_TEXT_LENGTH = 130;
const MERGE_MAX_LYRICS_TEXT_LENGTH = 90;
// Official caption timings arrive ahead of the rendered YouTube caption frame.
// A small lead keeps the translated line aligned without waiting for the DOM.
const TIMED_TEXT_DISPLAY_LEAD_MS = 1100;

function getVideoId(): string | undefined {
  const url = new URL(location.href);
  const watchId = url.searchParams.get("v");
  if (watchId) {
    return watchId;
  }

  const shortsMatch = location.pathname.match(/\/shorts\/([^/?]+)/);
  return shortsMatch?.[1];
}

export function getCurrentVideoId(): string | undefined {
  return getVideoId();
}

function findBalancedJson(source: string, marker: string): string | undefined {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }

  const start = source.indexOf("{", markerIndex + marker.length);
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function playerResponseMatchesVideo(playerResponse: Record<string, unknown>, videoId: string): boolean {
  const videoDetails = playerResponse.videoDetails as Record<string, unknown> | undefined;
  return typeof videoDetails?.videoId !== "string" || videoDetails.videoId === videoId;
}

function getPlayerResponse(videoId: string): Record<string, unknown> | undefined {
  // On YouTube SPA navigation this updates before window.ytInitialPlayerResponse
  // and before the inline scripts are replaced.
  try {
    const playerResponse = moviePlayer()?.getPlayerResponse?.();
    if (isRecord(playerResponse) && playerResponseMatchesVideo(playerResponse, videoId)) {
      return playerResponse;
    }
  } catch {
    // Fall back to the page-level player response sources below.
  }

  const livePlayerResponse = (window as YouTubeWindow).ytInitialPlayerResponse;
  if (livePlayerResponse && typeof livePlayerResponse === "object" && playerResponseMatchesVideo(livePlayerResponse, videoId)) {
    return livePlayerResponse;
  }

  for (const script of document.querySelectorAll("script")) {
    const text = script.textContent ?? "";
    if (!text.includes("ytInitialPlayerResponse")) {
      continue;
    }

    const jsonText = findBalancedJson(text, "ytInitialPlayerResponse");
    if (!jsonText) {
      continue;
    }

    try {
      const playerResponse = JSON.parse(jsonText) as Record<string, unknown>;
      if (playerResponseMatchesVideo(playerResponse, videoId)) {
        return playerResponse;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function captionTracksFromPlayerResponse(playerResponse: Record<string, unknown> | undefined): CaptionTrack[] {
  const captions = playerResponse?.captions as Record<string, unknown> | undefined;
  const trackList = captions?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
  const tracks = trackList?.captionTracks;
  return Array.isArray(tracks) ? (tracks as CaptionTrack[]) : [];
}

function getCaptionTracks(videoId: string): CaptionTrack[] {
  const responseTracks = captionTracksFromPlayerResponse(getPlayerResponse(videoId));
  if (responseTracks.length > 0) {
    return responseTracks;
  }

  // The player option becomes available during some transitions before the
  // full response object is exposed. It contains the same source track list.
  const liveTrackList = captionOption("tracklist");
  return Array.isArray(liveTrackList) ? (liveTrackList as CaptionTrack[]) : [];
}

async function fetchWatchPageCaptionTracks(videoId: string): Promise<CaptionTrack[]> {
  const url = new URL("/watch", location.origin);
  url.searchParams.set("v", videoId);
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!response.ok) {
      return [];
    }
    const html = await response.text();
    const jsonText = findBalancedJson(html, "ytInitialPlayerResponse");
    if (!jsonText) {
      return [];
    }
    const playerResponse = JSON.parse(jsonText) as Record<string, unknown>;
    return playerResponseMatchesVideo(playerResponse, videoId) ? captionTracksFromPlayerResponse(playerResponse) : [];
  } catch {
    return [];
  }
}

function moviePlayer(): YouTubePlayerElement | undefined {
  return (
    document.querySelector<YouTubePlayerElement>("#movie_player") ??
    document.querySelector<YouTubePlayerElement>(".html5-video-player") ??
    undefined
  );
}

function captionOption(option: string): unknown {
  const player = moviePlayer();
  if (typeof player?.getOption !== "function") {
    return undefined;
  }
  try {
    return player.getOption("captions", option);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function hasActiveAutoTranslation(): boolean {
  const translationLanguage = captionOption("translationLanguage");
  if (!translationLanguage) {
    return false;
  }
  if (typeof translationLanguage === "string") {
    return translationLanguage.trim().length > 0;
  }
  if (isRecord(translationLanguage)) {
    return Boolean(stringField(translationLanguage, "languageCode") || stringField(translationLanguage, "languageName"));
  }
  return false;
}

function isAutoTranslatedTimedTextUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    const url = new URL(baseUrl, location.origin);
    return url.searchParams.has("tlang") || url.searchParams.get("translate") === "1";
  } catch {
    return /[?&](?:tlang|translate)=/i.test(baseUrl);
  }
}

function captionTrackMatchesVideo(track: Partial<CaptionTrack>, videoId: string): boolean {
  if (!track.baseUrl) {
    return false;
  }
  try {
    const trackVideoId = new URL(track.baseUrl, location.origin).searchParams.get("v");
    return !trackVideoId || trackVideoId === videoId;
  } catch {
    const match = track.baseUrl.match(/[?&]v=([^&]+)/);
    return !match || decodeURIComponent(match[1]) === videoId;
  }
}

export function isYouTubeAutoTranslationActive(): boolean {
  return hasActiveAutoTranslation() || isAutoTranslatedTimedTextUrl(selectedCaptionTrack()?.baseUrl);
}

function selectedCaptionTrack(): Partial<CaptionTrack> | undefined {
  const track = captionOption("track");
  if (!isRecord(track)) {
    return undefined;
  }
  return {
    baseUrl: stringField(track, "baseUrl") ?? "",
    languageCode: stringField(track, "languageCode"),
    kind: stringField(track, "kind"),
    vssId: stringField(track, "vssId")
  };
}

function captionTrackKey(track: Pick<CaptionTrack, "baseUrl" | "languageCode" | "vssId">): string {
  return [track.languageCode ?? "", track.vssId ?? "", track.baseUrl].join("|");
}

function isOfficialCaptionTrack(track: Partial<CaptionTrack>): boolean {
  const kind = (track.kind ?? "").toLowerCase();
  const vssId = (track.vssId ?? "").toLowerCase();
  return kind !== "asr" && !kind.includes("asr") && !vssId.startsWith("a.") && !isAutoTranslatedTimedTextUrl(track.baseUrl);
}

type CaptionSelection = Pick<PageCaptionSnapshot, "selectedTrack" | "autoTranslationActive">;

function currentCaptionSelection(): CaptionSelection {
  return {
    selectedTrack: selectedCaptionTrack(),
    autoTranslationActive: isYouTubeAutoTranslationActive()
  };
}

function selectedOfficialCaptionTrack(selection: CaptionSelection): CaptionTrack | undefined {
  if (selection.autoTranslationActive) {
    return undefined;
  }

  const selected = selection.selectedTrack;
  if (!selected?.baseUrl || !isOfficialCaptionTrack(selected)) {
    return undefined;
  }

  return {
    baseUrl: selected.baseUrl,
    languageCode: selected.languageCode,
    kind: selected.kind,
    vssId: selected.vssId
  };
}

function configuredOfficialCaptionTrack(tracks: CaptionTrack[], settings: TranslatorSettings): CaptionTrack | undefined {
  const configuredLanguage = settings.sourceLanguage.trim().toLowerCase().replace(/_/g, "-");
  if (!configuredLanguage || configuredLanguage === "auto") {
    return undefined;
  }

  const configuredBaseLanguage = configuredLanguage.split("-")[0];
  return tracks.find((track) => {
    if (!isOfficialCaptionTrack(track) || !track.languageCode) {
      return false;
    }
    const trackLanguage = track.languageCode.toLowerCase().replace(/_/g, "-");
    return trackLanguage === configuredLanguage || trackLanguage.split("-")[0] === configuredBaseLanguage;
  });
}

function matchingOfficialCaptionTrack(
  officialTracks: CaptionTrack[],
  selected: Partial<CaptionTrack> | undefined
): CaptionTrack | undefined {
  if (!selected) {
    return undefined;
  }
  return (
    officialTracks.find((track) => selected.vssId && track.vssId === selected.vssId) ??
    officialTracks.find((track) => selected.languageCode && track.languageCode === selected.languageCode) ??
    officialTracks.find((track) => selected.baseUrl && track.baseUrl === selected.baseUrl)
  );
}

function chooseTrack(tracks: CaptionTrack[], settings: TranslatorSettings, selection = currentCaptionSelection()): CaptionTrack | undefined {
  const officialTracks = tracks.filter(isOfficialCaptionTrack);
  if (selection.autoTranslationActive) {
    // Never consume the caption currently rendered by YouTube's translation
    // layer. Match the user-selected source language to its original human
    // track, even when the selected URL itself contains YouTube's tlang.
    return (
      matchingOfficialCaptionTrack(officialTracks, selection.selectedTrack) ??
      configuredOfficialCaptionTrack(officialTracks, settings) ??
      officialTracks[0]
    );
  }

  const selected = selectedOfficialCaptionTrack(selection);
  if (!selected) {
    // A selected official track can disappear from the player option when CC is
    // hidden. Prefer the explicit source language, then the first human-made
    // track so navigating to another video still uses official captions first.
    return configuredOfficialCaptionTrack(officialTracks, settings) ?? officialTracks[0];
  }

  if (officialTracks.length === 0) {
    // On SPA navigation YouTube can expose the active caption URL before it
    // refreshes ytInitialPlayerResponse. The selected track is enough to fetch
    // official timed text immediately, so do not wait for that refresh.
    return selected;
  }
  return (
    matchingOfficialCaptionTrack(officialTracks, selected) ??
    configuredOfficialCaptionTrack(officialTracks, settings) ??
    selected
  );
}

export function getSelectedOfficialCaptionTrackKey(settings: TranslatorSettings): string | undefined {
  const videoId = getVideoId();
  if (!videoId) {
    return undefined;
  }
  const track = chooseTrack(getCaptionTracks(videoId), settings);
  return track ? captionTrackKey(track) : undefined;
}

function parseXmlTimedText(xmlText: string, videoId: string): TimedTextSegment[] {
  const xml = new DOMParser().parseFromString(xmlText, "text/xml");
  const textNodes = [...xml.querySelectorAll("text")];
  return textNodes
    .map((node, index): TimedTextSegment | undefined => {
      const start = Number(node.getAttribute("start"));
      const dur = Number(node.getAttribute("dur") ?? "3.2");
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!Number.isFinite(start) || !text) {
        return undefined;
      }
      return {
        id: `${videoId}-${index}-${Math.round(start * 1000)}`,
        source: "youtubeTimedText",
        startMs: Math.round(start * 1000),
        endMs: Math.round((start + Math.max(dur, 1.5)) * 1000),
        text
      };
    })
    .filter((segment): segment is TimedTextSegment => Boolean(segment));
}

function parseJsonTimedText(jsonText: string, videoId: string): TimedTextSegment[] {
  const json = JSON.parse(jsonText) as { events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }> };
  const events = Array.isArray(json.events) ? json.events : [];
  return events
    .map((event, index): TimedTextSegment | undefined => {
      const startMs = Number(event.tStartMs);
      const durationMs = Number(event.dDurationMs ?? 3200);
      const text = (event.segs ?? [])
        .map((segment) => segment.utf8 ?? "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (!Number.isFinite(startMs) || !text) {
        return undefined;
      }
      return {
        id: `${videoId}-json-${index}-${Math.round(startMs)}`,
        source: "youtubeTimedText",
        startMs: Math.round(startMs),
        endMs: Math.round(startMs + Math.max(durationMs, 1500)),
        text
      };
    })
    .filter((segment): segment is TimedTextSegment => Boolean(segment));
}

function parseTimedText(text: string, videoId: string): TimedTextSegment[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  if (trimmed.startsWith("{")) {
    return parseJsonTimedText(trimmed, videoId);
  }
  return parseXmlTimedText(trimmed, videoId);
}

function isShortSegment(segment: CaptionSegment): boolean {
  return segment.endMs - segment.startMs <= SHORT_SEGMENT_MAX_DURATION_MS || segment.text.length <= SHORT_SEGMENT_MAX_TEXT_LENGTH;
}

function hasSentenceBoundary(text: string): boolean {
  return /[.!?。？！…]$/.test(text.trim());
}

function canMergeTimedTextSegment(
  current: TimedTextSegment,
  next: TimedTextSegment,
  settings: TranslatorSettings
): boolean {
  const gapMs = next.startMs - current.endMs;
  if (gapMs < -250 || gapMs > MERGE_MAX_GAP_MS) {
    return false;
  }

  const lyricsMode = settings.contentMode === "lyrics";
  const maxDuration = lyricsMode ? MERGE_MAX_LYRICS_DURATION_MS : MERGE_MAX_DURATION_MS;
  const maxLength = lyricsMode ? MERGE_MAX_LYRICS_TEXT_LENGTH : MERGE_MAX_TEXT_LENGTH;
  const mergedDuration = next.endMs - current.startMs;
  const mergedTextLength = `${current.text} ${next.text}`.length;
  if (mergedDuration > maxDuration || mergedTextLength > maxLength) {
    return false;
  }

  if (hasSentenceBoundary(current.text) && !isShortSegment(next)) {
    return false;
  }

  return isShortSegment(current) || isShortSegment(next);
}

function mergeTimedTextPair(current: TimedTextSegment, next: TimedTextSegment): TimedTextSegment {
  return {
    id: `${current.id}~${next.id}`,
    source: "youtubeTimedText",
    startMs: current.startMs,
    endMs: Math.max(current.endMs, next.endMs),
    text: `${current.text} ${next.text}`.replace(/\s+/g, " ").trim()
  };
}

function mergeShortTimedTextSegments(segments: TimedTextSegment[], settings: TranslatorSettings): TimedTextSegment[] {
  if (segments.length < 2) {
    return segments;
  }

  const merged: TimedTextSegment[] = [];
  let current = segments[0];
  for (let index = 1; index < segments.length; index += 1) {
    const next = segments[index];
    if (canMergeTimedTextSegment(current, next, settings)) {
      current = mergeTimedTextPair(current, next);
      continue;
    }
    merged.push(current);
    current = next;
  }
  merged.push(current);
  return merged;
}

function timedTextUrlVariants(baseUrl: string): string[] {
  if (isAutoTranslatedTimedTextUrl(baseUrl)) {
    return [];
  }
  const variants: string[] = [];

  try {
    for (const format of ["json3", "srv3"]) {
      const url = new URL(baseUrl);
      url.searchParams.set("fmt", format);
      variants.push(url.toString());
    }
  } catch {
    // Keep the original URL when YouTube returns a non-standard URL string.
  }

  variants.push(baseUrl);
  return [...new Set(variants)];
}

async function fetchTimedTextUrl(url: string, videoId: string, signal?: AbortSignal): Promise<TimedTextSegment[]> {
  if (isAutoTranslatedTimedTextUrl(url)) {
    return [];
  }
  const response = await fetch(url, { credentials: "include", cache: "no-store", signal });
  if (!response.ok) {
    return [];
  }

  const timedText = await response.text();
  try {
    return parseTimedText(timedText, videoId);
  } catch (error) {
    console.debug("Timed text parse failed", error);
    return [];
  }
}

async function fetchFirstTimedTextUrl(urls: string[], videoId: string): Promise<TimedTextSegment[]> {
  const controllers = urls.map(() => new AbortController());
  try {
    return await Promise.any(
      urls.map(async (url, index) => {
        const segments = await fetchTimedTextUrl(url, videoId, controllers[index].signal);
        if (segments.length === 0) {
          throw new Error("Timed text response was empty.");
        }
        return segments;
      })
    );
  } catch {
    return [];
  } finally {
    for (const controller of controllers) {
      controller.abort();
    }
  }
}

export function hashCaptionSegments(segments: CaptionSegment[]): string {
  let hash = 2166136261;
  const source = segments.map((segment) => `${segment.startMs}:${segment.endMs}:${segment.text}`).join("|");
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export async function fetchTimedTextSegmentsWithMetadata(
  settings: TranslatorSettings,
  pageSnapshot?: PageCaptionSnapshot
): Promise<TimedTextFetchResult | undefined> {
  const videoId = getVideoId();
  if (!videoId) {
    return undefined;
  }

  const snapshot = pageSnapshot?.videoId === videoId ? pageSnapshot : undefined;
  let tracks = (snapshot?.tracks ?? getCaptionTracks(videoId)).filter((track) => captionTrackMatchesVideo(track, videoId));
  if (tracks.length === 0) {
    tracks = (await fetchWatchPageCaptionTracks(videoId)).filter((track) => captionTrackMatchesVideo(track, videoId));
  }
  const track = chooseTrack(
    tracks,
    settings,
    snapshot
      ? { selectedTrack: snapshot.selectedTrack, autoTranslationActive: snapshot.autoTranslationActive }
      : currentCaptionSelection()
  );
  if (!track?.baseUrl || !captionTrackMatchesVideo(track, videoId)) {
    return undefined;
  }

  const segments = await fetchFirstTimedTextUrl(timedTextUrlVariants(track.baseUrl), videoId);
  if (segments.length > 0) {
    return {
      videoId,
      trackLanguage: track.languageCode ?? settings.sourceLanguage,
      trackKey: captionTrackKey(track),
      segments: mergeShortTimedTextSegments(segments, settings)
    };
  }

  return { videoId, trackLanguage: track.languageCode ?? settings.sourceLanguage, trackKey: captionTrackKey(track), segments: [] };
}

export async function fetchTimedTextSegments(settings: TranslatorSettings): Promise<TimedTextSegment[]> {
  return (await fetchTimedTextSegmentsWithMetadata(settings))?.segments ?? [];
}

export function getCurrentTimedTextSegment(segments: TimedTextSegment[], settings: TranslatorSettings): TimedTextSegment | undefined {
  const video = findVideoElement();
  if (!video) {
    return undefined;
  }

  const currentMs = video.currentTime * 1000 + settings.latencyOffsetMs + TIMED_TEXT_DISPLAY_LEAD_MS;
  let low = 0;
  let high = segments.length - 1;
  let match: TimedTextSegment | undefined;

  // Segments are ordered by start time. Continue left after a match so overlapping
  // cues preserve the same first-match behavior as Array.prototype.find().
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const segment = segments[middle];
    if (currentMs < segment.startMs) {
      high = middle - 1;
    } else if (currentMs > segment.endMs) {
      low = middle + 1;
    } else {
      match = segment;
      high = middle - 1;
    }
  }

  return match;
}

export function readVisibleCaptionSegment(): CaptionSegment | undefined {
  const video = findVideoElement();
  const captionContainer =
    document.querySelector<HTMLElement>(".ytp-caption-window-container") ??
    document.querySelector<HTMLElement>(".ytp-caption-window-bottom");

  if (!video || !captionContainer) {
    return undefined;
  }

  const text = [...captionContainer.querySelectorAll<HTMLElement>(".ytp-caption-segment")]
    .map((segment) => segment.innerText.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) {
    return undefined;
  }

  const startMs = Math.round(video.currentTime * 1000);
  return {
    id: `dom-${startMs}-${text.slice(0, 24)}`,
    source: "youtubeDom",
    startMs,
    endMs: startMs + 3600,
    text
  };
}

export function isYouTubeWatchPage(): boolean {
  return Boolean(getVideoId());
}
