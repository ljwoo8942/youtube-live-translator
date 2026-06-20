import type { CaptionTranslationEntry } from "../shared/messages";
import type { CaptionSegment, TranslatorSettings } from "../shared/types";
import { TRANSLATION_PROMPT_VERSION } from "../shared/translationVersion";

const DB_NAME = "yt-live-translator";
const DB_VERSION = 1;
const STORE_NAME = "captionTranslations";

export type CaptionCacheContext = {
  videoId: string;
  captionHash: string;
  sourceLanguage: string;
  targetLanguage: string;
  providerKey: string;
  contentMode: string;
  promptVersion: string;
};

type CaptionTranslationRecord = CaptionCacheContext & {
  key: string;
  segmentId: string;
  translatedText: string;
  updatedAt: number;
};

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB를 열지 못했습니다.")));
  });

  return dbPromise;
}

function providerKey(settings: TranslatorSettings): string {
  switch (settings.translationProvider) {
    case "openai":
      return `openai:${settings.openai.baseUrl}:${settings.openai.model}:${settings.openai.endpointMode}`;
    case "lmStudio":
      return `lmStudio:${settings.lmStudio.baseUrl}:${settings.lmStudio.model}:${settings.lmStudio.endpointMode}`;
    case "ollama":
      return `ollama:${settings.ollama.baseUrl}:${settings.ollama.model}`;
    default:
      return settings.translationProvider;
  }
}

export function createCaptionCacheContext(
  settings: TranslatorSettings,
  videoId: string,
  captionHash: string,
  trackLanguage: string
): CaptionCacheContext {
  return {
    videoId,
    captionHash,
    sourceLanguage: settings.sourceLanguage === "auto" ? trackLanguage || "auto" : settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    providerKey: providerKey(settings),
    contentMode: settings.contentMode === "lyrics" ? "lyrics" : settings.contentMode === "live" ? "live" : "spoken",
    promptVersion: TRANSLATION_PROMPT_VERSION
  };
}

function cachePrefix(context: CaptionCacheContext): string {
  return [
    context.videoId,
    context.captionHash,
    context.sourceLanguage,
    context.targetLanguage,
    context.providerKey,
    context.contentMode,
    context.promptVersion
  ].join("|");
}

function cacheKey(context: CaptionCacheContext, segmentId: string): string {
  return `${cachePrefix(context)}|${segmentId}`;
}

function txComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction 실패")));
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction 중단")));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request 실패")));
  });
}

export async function getCachedCaptionTranslations(
  context: CaptionCacheContext,
  segments: CaptionSegment[]
): Promise<Map<string, string>> {
  const db = await openDb();
  const transaction = db.transaction(STORE_NAME, "readonly");
  const store = transaction.objectStore(STORE_NAME);
  const complete = txComplete(transaction);
  const entries = await Promise.all(
    segments.map(async (segment) => {
      const record = await requestResult<CaptionTranslationRecord | undefined>(store.get(cacheKey(context, segment.id)));
      return record?.translatedText ? ([segment.id, record.translatedText] as const) : undefined;
    })
  );
  await complete.catch(() => undefined);
  return new Map(entries.filter((entry): entry is readonly [string, string] => Boolean(entry)));
}

export async function putCachedCaptionTranslations(
  context: CaptionCacheContext,
  translations: CaptionTranslationEntry[]
): Promise<void> {
  if (translations.length === 0) {
    return;
  }

  const db = await openDb();
  const transaction = db.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const complete = txComplete(transaction);
  const updatedAt = Date.now();
  for (const translation of translations) {
    const record: CaptionTranslationRecord = {
      ...context,
      key: cacheKey(context, translation.id),
      segmentId: translation.id,
      translatedText: translation.translatedText,
      updatedAt
    };
    store.put(record);
  }
  await complete;
}
