import type { CaptionSegment } from "../shared/types";
import type {
  CorrectionMediaContext,
  CoverVariant,
  SongCorrection
} from "../shared/corrections";

const OFFICIAL_MATCH_THRESHOLD = 0.86;
const AUDIO_MATCH_THRESHOLD = 0.68;
const AUDIO_MATCHES_TO_ACTIVATE = 2;
const MISSES_TO_DEACTIVATE = 3;

type EffectiveCorrectionLine = {
  id: string;
  source: string;
  translation: string;
};

export type CorrectionMatchSession = {
  videoId: string;
  song: SongCorrection;
  variant?: CoverVariant;
  lines: EffectiveCorrectionLine[];
  cursor: number;
  active: boolean;
  consecutiveMatches: number;
  consecutiveMisses: number;
  pendingLineIndex?: number;
  matchReason: "videoId" | "metadata";
};

export type CorrectionMatchResult = {
  translatedText: string;
  provider: "사용자 교정";
  songTitle: string;
  lineId: string;
  score: number;
};

function normalizeText(value: string): string {
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

export function correctionTextSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }
  if (normalizedLeft === normalizedRight) {
    return 1;
  }
  if (normalizedLeft.length < 3 || normalizedRight.length < 3) {
    return 0;
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

function durationSimilarity(expected?: number, actual?: number): number {
  if (!expected || !actual) {
    return 0;
  }
  return Math.max(0, 1 - Math.abs(expected - actual) / 90);
}

function metadataTextSimilarity(value: string, text: string): number {
  const normalizedValue = normalizeText(value);
  const normalizedText = normalizeText(text);
  if (!normalizedValue || !normalizedText) {
    return 0;
  }
  if (normalizedText.includes(normalizedValue)) {
    return normalizedText === normalizedValue ? 1 : 0.94;
  }
  return correctionTextSimilarity(value, text);
}

function variantForMedia(song: SongCorrection, media: CorrectionMediaContext): CoverVariant | undefined {
  const exact = song.variants.find((variant) => variant.videoIds.includes(media.videoId));
  if (exact) {
    return exact;
  }
  return song.variants
    .map((variant) => ({
      variant,
      score:
        metadataTextSimilarity(variant.name, media.title) * 0.65 +
        metadataTextSimilarity(variant.performer ?? "", `${media.title} ${media.author}`) * 0.25 +
        durationSimilarity(variant.durationSeconds, media.durationSeconds) * 0.1
    }))
    .filter((entry) => entry.score >= 0.72)
    .sort((left, right) => right.score - left.score)[0]?.variant;
}

function effectiveLines(song: SongCorrection, variant?: CoverVariant): EffectiveCorrectionLine[] {
  const overridesByBaseId = new Map(
    (variant?.lineOverrides ?? [])
      .filter((override) => override.baseLineId)
      .map((override) => [override.baseLineId as string, override])
  );
  const lines = song.lines.map((line): EffectiveCorrectionLine => {
    const override = overridesByBaseId.get(line.id);
    return override
      ? { id: override.id, source: override.source, translation: override.translation }
      : { id: line.id, source: line.source, translation: line.translation };
  });
  for (const override of variant?.lineOverrides ?? []) {
    if (!override.baseLineId || !song.lines.some((line) => line.id === override.baseLineId)) {
      lines.push({ id: override.id, source: override.source, translation: override.translation });
    }
  }
  return lines;
}

function songMetadataScore(song: SongCorrection, media: CorrectionMediaContext): number {
  const titleScore = Math.max(
    metadataTextSimilarity(song.title, media.title),
    ...song.aliases.map((alias) => metadataTextSimilarity(alias, media.title))
  );
  const artistText = `${media.title} ${media.author}`;
  const artistScore = Math.max(
    metadataTextSimilarity(song.artist, artistText),
    metadataTextSimilarity(song.composer ?? "", artistText)
  );
  return titleScore * 0.72 + artistScore * 0.18 + durationSimilarity(song.durationSeconds, media.durationSeconds) * 0.1;
}

export function createCorrectionMatchSession(
  media: CorrectionMediaContext,
  songs: SongCorrection[],
  targetLanguage?: string
): CorrectionMatchSession | undefined {
  const enabledSongs = songs.filter(
    (song) => song.enabled && song.lines.length > 0 && (!targetLanguage || song.targetLanguage === targetLanguage)
  );
  const exactSong = enabledSongs.find(
    (song) => song.videoIds.includes(media.videoId) || song.variants.some((variant) => variant.videoIds.includes(media.videoId))
  );
  const ranked = exactSong
    ? { song: exactSong, score: 1, reason: "videoId" as const }
    : enabledSongs
        .map((song) => ({ song, score: songMetadataScore(song, media), reason: "metadata" as const }))
        .filter((entry) => entry.score >= 0.58)
        .sort((left, right) => right.score - left.score)[0];
  if (!ranked) {
    return undefined;
  }
  const variant = variantForMedia(ranked.song, media);
  return {
    videoId: media.videoId,
    song: ranked.song,
    variant,
    lines: effectiveLines(ranked.song, variant),
    cursor: 0,
    active: false,
    consecutiveMatches: 0,
    consecutiveMisses: 0,
    matchReason: ranked.reason
  };
}

export function cloneCorrectionMatchSession(session: CorrectionMatchSession): CorrectionMatchSession {
  return {
    ...session,
    lines: session.lines
  };
}

function bestLineMatch(
  session: CorrectionMatchSession,
  sourceText: string
): { line: EffectiveCorrectionLine; index: number; score: number } | undefined {
  const start = session.active ? Math.max(0, session.cursor - 3) : 0;
  const end = session.active ? Math.min(session.lines.length, session.cursor + 14) : session.lines.length;
  let best: { line: EffectiveCorrectionLine; index: number; score: number } | undefined;
  for (let index = start; index < end; index += 1) {
    const line = session.lines[index];
    const score = correctionTextSimilarity(sourceText, line.source);
    if (!best || score > best.score) {
      best = { line, index, score };
    }
  }
  return best;
}

function registerMiss(session: CorrectionMatchSession, commit: boolean): void {
  if (!commit) {
    return;
  }
  session.consecutiveMatches = 0;
  session.pendingLineIndex = undefined;
  session.consecutiveMisses += 1;
  if (session.consecutiveMisses >= MISSES_TO_DEACTIVATE) {
    session.active = false;
    session.cursor = 0;
    session.consecutiveMisses = 0;
  }
}

export function matchCorrectionSegment(
  session: CorrectionMatchSession | undefined,
  segment: CaptionSegment,
  commit: boolean
): CorrectionMatchResult | undefined {
  if (!session || !segment.text.trim()) {
    return undefined;
  }
  const match = bestLineMatch(session, segment.text);
  const isAudio = segment.source === "audioStt";
  const threshold = isAudio ? AUDIO_MATCH_THRESHOLD : OFFICIAL_MATCH_THRESHOLD;
  if (!match || match.score < threshold) {
    registerMiss(session, commit);
    return undefined;
  }

  if (!isAudio) {
    if (commit) {
      session.active = true;
      session.cursor = match.index + 1;
      session.consecutiveMatches = 1;
      session.consecutiveMisses = 0;
      session.pendingLineIndex = match.index + 1;
    }
  } else if (commit) {
    const followsPrevious =
      session.pendingLineIndex !== undefined &&
      match.index >= session.pendingLineIndex - 1 &&
      match.index <= session.pendingLineIndex + 8;
    session.consecutiveMatches = followsPrevious ? session.consecutiveMatches + 1 : 1;
    session.pendingLineIndex = match.index + 1;
    session.consecutiveMisses = 0;
    if (session.active || session.consecutiveMatches >= AUDIO_MATCHES_TO_ACTIVATE) {
      session.active = true;
      session.cursor = match.index + 1;
    }
  }

  if (isAudio && !session.active) {
    return undefined;
  }
  return {
    translatedText: match.line.translation,
    provider: "사용자 교정",
    songTitle: session.song.title,
    lineId: match.line.id,
    score: match.score
  };
}
