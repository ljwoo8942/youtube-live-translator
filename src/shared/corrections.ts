export type CorrectionLine = {
  id: string;
  source: string;
  translation: string;
  startMs?: number;
  endMs?: number;
  note?: string;
};

export type CoverLineOverride = {
  id: string;
  baseLineId?: string;
  source: string;
  translation: string;
};

export type CoverVariant = {
  id: string;
  name: string;
  videoIds: string[];
  performer?: string;
  durationSeconds?: number;
  lineOverrides: CoverLineOverride[];
};

export type SongCorrection = {
  id: string;
  title: string;
  artist: string;
  composer?: string;
  aliases: string[];
  sourceLanguage: string;
  targetLanguage: string;
  durationSeconds?: number;
  videoIds: string[];
  lines: CorrectionLine[];
  variants: CoverVariant[];
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type CorrectionPreferences = {
  enabled: boolean;
};

export type CorrectionLibraryExport = {
  format: "youtube-live-translator-corrections";
  version: 1;
  exportedAt: string;
  songs: SongCorrection[];
};

export type CorrectionMediaContext = {
  videoId: string;
  title: string;
  author: string;
  durationSeconds?: number;
  isLive: boolean;
};

type PlainObject = Record<string, unknown>;

function isObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))];
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function requiredText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text) {
    throw new Error(`${label} 항목이 비어 있습니다.`);
  }
  return text;
}

function correctionLine(value: unknown, index: number): CorrectionLine {
  if (!isObject(value)) {
    throw new Error(`${index + 1}번째 교정 줄 형식이 올바르지 않습니다.`);
  }
  return {
    id: optionalText(value.id) ?? crypto.randomUUID(),
    source: requiredText(value.source, `${index + 1}번째 원문`),
    translation: requiredText(value.translation, `${index + 1}번째 교정 번역`),
    startMs: optionalNumber(value.startMs),
    endMs: optionalNumber(value.endMs),
    note: optionalText(value.note)
  };
}

function coverLineOverride(value: unknown, index: number): CoverLineOverride {
  if (!isObject(value)) {
    throw new Error(`${index + 1}번째 커버 교정 줄 형식이 올바르지 않습니다.`);
  }
  return {
    id: optionalText(value.id) ?? crypto.randomUUID(),
    baseLineId: optionalText(value.baseLineId),
    source: requiredText(value.source, `${index + 1}번째 커버 원문`),
    translation: requiredText(value.translation, `${index + 1}번째 커버 번역`)
  };
}

function coverVariant(value: unknown, index: number): CoverVariant {
  if (!isObject(value)) {
    throw new Error(`${index + 1}번째 커버 프로필 형식이 올바르지 않습니다.`);
  }
  return {
    id: optionalText(value.id) ?? crypto.randomUUID(),
    name: requiredText(value.name, `${index + 1}번째 커버 이름`),
    videoIds: textList(value.videoIds),
    performer: optionalText(value.performer),
    durationSeconds: optionalNumber(value.durationSeconds),
    lineOverrides: Array.isArray(value.lineOverrides)
      ? value.lineOverrides.map((entry, lineIndex) => coverLineOverride(entry, lineIndex))
      : []
  };
}

export function normalizeSongCorrection(value: unknown): SongCorrection {
  if (!isObject(value)) {
    throw new Error("곡 교정 데이터 형식이 올바르지 않습니다.");
  }
  const now = Date.now();
  const lines = Array.isArray(value.lines) ? value.lines.map(correctionLine) : [];
  if (lines.length === 0) {
    throw new Error("원문과 교정 번역을 한 줄 이상 입력하세요.");
  }
  return {
    id: optionalText(value.id) ?? crypto.randomUUID(),
    title: requiredText(value.title, "곡 이름"),
    artist: requiredText(value.artist, "가수/아티스트"),
    composer: optionalText(value.composer),
    aliases: textList(value.aliases),
    sourceLanguage: optionalText(value.sourceLanguage) ?? "ja",
    targetLanguage: optionalText(value.targetLanguage) ?? "ko",
    durationSeconds: optionalNumber(value.durationSeconds),
    videoIds: textList(value.videoIds),
    lines,
    variants: Array.isArray(value.variants) ? value.variants.map(coverVariant) : [],
    enabled: value.enabled !== false,
    version: typeof value.version === "number" && Number.isInteger(value.version) && value.version > 0 ? value.version : 1,
    createdAt: optionalNumber(value.createdAt) ?? now,
    updatedAt: optionalNumber(value.updatedAt) ?? now
  };
}

export function normalizeCorrectionLibrary(value: unknown): CorrectionLibraryExport {
  if (!isObject(value) || value.format !== "youtube-live-translator-corrections" || value.version !== 1) {
    throw new Error("지원하지 않는 교정 사전 파일입니다.");
  }
  if (!Array.isArray(value.songs)) {
    throw new Error("교정 사전에 곡 목록이 없습니다.");
  }
  return {
    format: "youtube-live-translator-corrections",
    version: 1,
    exportedAt: optionalText(value.exportedAt) ?? new Date().toISOString(),
    songs: value.songs.map(normalizeSongCorrection)
  };
}

export function createEmptySongCorrection(): SongCorrection {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "",
    artist: "",
    aliases: [],
    sourceLanguage: "ja",
    targetLanguage: "ko",
    videoIds: [],
    lines: [],
    variants: [],
    enabled: true,
    version: 1,
    createdAt: now,
    updatedAt: now
  };
}
