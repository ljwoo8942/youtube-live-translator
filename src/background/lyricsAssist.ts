import type { CaptionSegment, ContentMode } from "../shared/types";

const LRCLIB_SEARCH_URL = "https://lrclib.net/api/search";
const MAX_SEARCH_QUERIES = 6;
const MAX_CANDIDATES = 18;
const MIN_MATCH_CHARACTERS = 4;
const LIVE_MATCH_THRESHOLD = 0.64;
const LYRICS_MATCH_THRESHOLD = 0.68;
const OFFICIAL_CAPTION_MATCH_THRESHOLD = 0.86;
const OFFICIAL_CAPTION_MIN_CHARACTERS = 6;
const MISSES_TO_LEAVE_LYRICS = 2;
const MATCHES_TO_ENTER_LYRICS = 2;

export type LyricsMediaContext = {
  videoId: string;
  title: string;
  author: string;
  description: string;
  durationSeconds?: number;
  isLive: boolean;
};

export type LyricsCandidate = {
  id: number;
  trackName: string;
  artistName: string;
  lines: string[];
};

export type LyricsAssistSession = {
  videoId: string;
  candidates: LyricsCandidate[];
  activeLyrics: boolean;
  selectedCandidateId?: number;
  cursor: number;
  consecutiveMatches: number;
  consecutiveMisses: number;
  pendingCandidateId?: number;
  pendingLineIndex?: number;
};

type LyricsRecord = {
  id?: unknown;
  trackName?: unknown;
  artistName?: unknown;
  instrumental?: unknown;
  plainLyrics?: unknown;
  syncedLyrics?: unknown;
};

type LyricsMatch = {
  candidate: LyricsCandidate;
  lineIndex: number;
  lineCount: number;
  text: string;
  score: number;
};

export function createLyricsAssistSession(videoId: string): LyricsAssistSession {
  return {
    videoId,
    candidates: [],
    activeLyrics: false,
    cursor: 0,
    consecutiveMatches: 0,
    consecutiveMisses: 0
  };
}

export function setLyricsCandidates(session: LyricsAssistSession, candidates: LyricsCandidate[]): void {
  session.candidates = candidates;
  session.activeLyrics = false;
  session.selectedCandidateId = undefined;
  session.cursor = 0;
  session.consecutiveMatches = 0;
  session.consecutiveMisses = 0;
  session.pendingCandidateId = undefined;
  session.pendingLineIndex = undefined;
}

export function extractLyricsSearchQueries(media: LyricsMediaContext): string[] {
  const descriptionLines = media.description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length >= 3 &&
        line.length <= 120 &&
        (/^(?:\d{1,2}:)?\d{1,2}:\d{2}\b/.test(line) || /\s[-–—｜|／/]\s/.test(line))
    )
    .map((line) => line.replace(/^(?:\d{1,2}:)?\d{1,2}:\d{2}\s*/, ""));
  const queries = [media.title, ...descriptionLines]
    .map(cleanSearchText)
    .filter((query) => query.length >= 3);
  return [...new Set(queries)].slice(0, MAX_SEARCH_QUERIES);
}

export async function searchLyricsCandidates(
  media: LyricsMediaContext,
  fetcher: typeof fetch = fetch
): Promise<LyricsCandidate[]> {
  const queries = extractLyricsSearchQueries(media);
  if (queries.length === 0) {
    return [];
  }

  const resultGroups = await Promise.all(
    queries.map(async (query) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetcher(`${LRCLIB_SEARCH_URL}?q=${encodeURIComponent(query)}`, {
          signal: controller.signal
        });
        if (!response.ok) {
          return [];
        }
        const value = (await response.json()) as unknown;
        if (!Array.isArray(value)) {
          return [];
        }
        return value
          .map(normalizeLyricsRecord)
          .filter((candidate): candidate is LyricsCandidate => Boolean(candidate))
          .sort((left, right) => candidateMetadataScore(right, query, media) - candidateMetadataScore(left, query, media))
          .slice(0, 3);
      } catch {
        return [];
      } finally {
        clearTimeout(timeout);
      }
    })
  );

  const unique = new Map<number, LyricsCandidate>();
  for (const candidate of resultGroups.flat()) {
    if (!unique.has(candidate.id)) {
      unique.set(candidate.id, candidate);
    }
  }
  return [...unique.values()].slice(0, MAX_CANDIDATES);
}

export function assistLyricsSegment(
  session: LyricsAssistSession | undefined,
  segment: CaptionSegment,
  contentMode: ContentMode,
  commit: boolean
): CaptionSegment {
  if (!session || contentMode === "spoken" || session.candidates.length === 0) {
    return segment;
  }

  const match = findBestMatch(session, segment.text);
  const threshold = contentMode === "lyrics" ? LYRICS_MATCH_THRESHOLD : LIVE_MATCH_THRESHOLD;
  if (!match || match.score < threshold) {
    if (commit) {
      session.consecutiveMatches = 0;
      session.pendingCandidateId = undefined;
      session.pendingLineIndex = undefined;
      session.consecutiveMisses += 1;
      if (session.consecutiveMisses >= MISSES_TO_LEAVE_LYRICS) {
        session.activeLyrics = false;
      }
    }
    return segment;
  }

  if (commit) {
    const followsPendingLine =
      session.pendingCandidateId === match.candidate.id &&
      session.pendingLineIndex !== undefined &&
      match.lineIndex >= session.pendingLineIndex - 1 &&
      match.lineIndex <= session.pendingLineIndex + 8;
    session.consecutiveMatches = followsPendingLine ? session.consecutiveMatches + 1 : 1;
    session.pendingCandidateId = match.candidate.id;
    session.pendingLineIndex = match.lineIndex + match.lineCount;
    session.consecutiveMisses = 0;

    if (session.activeLyrics || session.consecutiveMatches >= MATCHES_TO_ENTER_LYRICS) {
      session.activeLyrics = true;
      session.selectedCandidateId = match.candidate.id;
      session.cursor = match.lineIndex + match.lineCount;
    }
  }

  if (!session.activeLyrics) {
    return segment;
  }

  const contextStart = Math.max(0, match.lineIndex - 1);
  const contextEnd = Math.min(match.candidate.lines.length, match.lineIndex + match.lineCount + 1);
  const lyricContext = match.candidate.lines.slice(contextStart, contextEnd).join("\n");
  return {
    ...segment,
    text: match.text,
    contextText: [segment.contextText, lyricContext].filter(Boolean).join("\n"),
    detectedContentMode: "lyrics"
  };
}

export function assistOfficialCaptionSegment(
  session: LyricsAssistSession | undefined,
  segment: CaptionSegment
): CaptionSegment {
  if (
    !session ||
    segment.source === "audioStt" ||
    session.candidates.length === 0 ||
    normalizeLyricText(segment.text).length < OFFICIAL_CAPTION_MIN_CHARACTERS
  ) {
    return segment;
  }

  const match = findBestMatch(session, segment.text);
  if (!match || match.score < OFFICIAL_CAPTION_MATCH_THRESHOLD) {
    return segment;
  }

  const contextStart = Math.max(0, match.lineIndex - 1);
  const contextEnd = Math.min(match.candidate.lines.length, match.lineIndex + match.lineCount + 1);
  const lyricContext = match.candidate.lines.slice(contextStart, contextEnd).join("\n");
  const externalContext = [
    "High-confidence external lyrics reference for meaning only.",
    "Keep the official CURRENT subtitle as the source of truth; never replace or extend it from this reference.",
    lyricContext
  ].join("\n");

  return {
    ...segment,
    contextText: [segment.contextText, externalContext].filter(Boolean).join("\n"),
    detectedContentMode: "lyrics"
  };
}

export function lyricLineSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeLyricText(left);
  const normalizedRight = normalizeLyricText(right);
  if (normalizedLeft.length < MIN_MATCH_CHARACTERS || normalizedRight.length < MIN_MATCH_CHARACTERS) {
    return 0;
  }
  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  const leftPairs = characterPairs(normalizedLeft);
  const rightPairs = characterPairs(normalizedRight);
  const counts = new Map<string, number>();
  for (const pair of leftPairs) {
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  let intersection = 0;
  for (const pair of rightPairs) {
    const count = counts.get(pair) ?? 0;
    if (count > 0) {
      intersection += 1;
      counts.set(pair, count - 1);
    }
  }
  const dice = (2 * intersection) / Math.max(1, leftPairs.length + rightPairs.length);
  const containment =
    normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)
      ? Math.min(normalizedLeft.length, normalizedRight.length) / Math.max(normalizedLeft.length, normalizedRight.length)
      : 0;
  return Math.max(dice, containment);
}

function findBestMatch(session: LyricsAssistSession, transcript: string): LyricsMatch | undefined {
  let best: LyricsMatch | undefined;
  const selectedCandidate = session.candidates.find((candidate) => candidate.id === session.selectedCandidateId);
  const candidates = session.activeLyrics && selectedCandidate ? [selectedCandidate] : session.candidates;

  for (const candidate of candidates) {
    const start = session.activeLyrics && candidate.id === session.selectedCandidateId ? Math.max(0, session.cursor - 3) : 0;
    const end =
      session.activeLyrics && candidate.id === session.selectedCandidateId
        ? Math.min(candidate.lines.length, session.cursor + 14)
        : candidate.lines.length;
    for (let index = start; index < end; index += 1) {
      for (const lineCount of [1, 2]) {
        if (index + lineCount > candidate.lines.length) {
          continue;
        }
        const text = candidate.lines.slice(index, index + lineCount).join("\n");
        const score = lyricLineSimilarity(transcript, text);
        if (!best || score > best.score) {
          best = { candidate, lineIndex: index, lineCount, text, score };
        }
      }
    }
  }
  return best;
}

function normalizeLyricsRecord(value: unknown): LyricsCandidate | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as LyricsRecord;
  if (
    typeof record.id !== "number" ||
    typeof record.trackName !== "string" ||
    typeof record.artistName !== "string" ||
    record.instrumental === true
  ) {
    return undefined;
  }
  const lines = parseLyricsLines(
    typeof record.syncedLyrics === "string"
      ? record.syncedLyrics
      : typeof record.plainLyrics === "string"
        ? record.plainLyrics
        : ""
  );
  if (lines.length < 4) {
    return undefined;
  }
  return {
    id: record.id,
    trackName: record.trackName.trim(),
    artistName: record.artistName.trim(),
    lines
  };
}

function parseLyricsLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^(?:\[\d{1,3}:\d{2}(?:\.\d{1,3})?\])+\s*/, "")
        .replace(/^\[(?:ar|al|ti|by|offset|length):[^\]]*\]\s*/i, "")
        .trim()
    )
    .filter((line) => line.length >= 1 && line.length <= 200 && !/^\[[^\]]+\]$/.test(line));
}

function candidateMetadataScore(candidate: LyricsCandidate, query: string, media: LyricsMediaContext): number {
  const titleScore = Math.max(
    lyricLineSimilarity(candidate.trackName, query),
    lyricLineSimilarity(candidate.trackName, media.title)
  );
  const artistScore = lyricLineSimilarity(candidate.artistName, media.author);
  return titleScore * 0.8 + artistScore * 0.2;
}

function cleanSearchText(value: string): string {
  return value
    .replace(/\s*-\s*YouTube\s*$/i, "")
    .replace(/【[^】]{0,100}】|\[[^\]]{0,100}\]/g, " ")
    .replace(/#\S+/g, " ")
    .replace(/\b(?:official\s*(?:music\s*)?video|official\s*mv|music\s*video|lyrics?|cover(?:ed)?|歌ってみた|初配信)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLyricText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function characterPairs(value: string): string[] {
  if (value.length <= 1) {
    return [value];
  }
  const pairs: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    pairs.push(value.slice(index, index + 2));
  }
  return pairs;
}
