import type { CaptionTranslationEntry } from "../shared/messages";
import type { CaptionSegment, TranslatorSettings } from "../shared/types";
import { TRANSLATION_PROMPT_VERSION } from "../shared/translationVersion";

const DB_NAME = "yt-live-translator";
const DB_VERSION = 2;
const STORE_NAME = "captionTranslations";
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 10_000;

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

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? request.transaction!.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: "key" });
      if (!store.indexNames.contains("updatedAt")) store.createIndex("updatedAt", "updatedAt");
    });
    request.addEventListener("success", () => {
      request.result.addEventListener("versionchange", () => { request.result.close(); dbPromise = undefined; });
      resolve(request.result);
    });
    request.addEventListener("error", () => {
      dbPromise = undefined;
      reject(request.error ?? new Error("IndexedDB를 열지 못했습니다."));
    });
  }).catch((error) => {
    dbPromise = undefined;
    throw error;
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

function segmentFingerprint(segment: CaptionSegment): string {
  const value = [segment.text, segment.contextText ?? "", segment.detectedContentMode ?? ""].join("\u241e");
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function cacheKey(context: CaptionCacheContext, segment: CaptionSegment): string {
  return `${cachePrefix(context)}|${segment.id}|${segmentFingerprint(segment)}`;
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
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const complete = txComplete(transaction).catch(() => undefined);
    const entries = await Promise.all(
      segments.map(async (segment) => {
        const record = await requestResult<CaptionTranslationRecord | undefined>(store.get(cacheKey(context, segment)));
        return record?.translatedText && record.updatedAt >= Date.now() - CACHE_MAX_AGE_MS
          ? ([segment.id, record.translatedText] as const) : undefined;
      })
    );
    await complete;
    return new Map(entries.filter((entry): entry is readonly [string, string] => Boolean(entry)));
  } catch (error) {
    console.warn("번역 캐시를 읽지 못해 새로 번역합니다.", error);
    return new Map();
  }
}

function pruneCaptionCache(store: IDBObjectStore): Promise<void> {
  return new Promise((resolve, reject) => {
    const count = store.count();
    count.onerror = () => reject(count.error);
    count.onsuccess = () => {
      let excess = count.result - CACHE_MAX_ENTRIES;
      const cursor = store.index("updatedAt").openCursor();
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry || (excess <= 0 && Number(entry.key) >= Date.now() - CACHE_MAX_AGE_MS)) {
          resolve();
          return;
        }
        entry.delete();
        excess -= 1;
        entry.continue();
      };
    };
  });
}

export async function putCachedCaptionTranslations(
  context: CaptionCacheContext,
  translations: CaptionTranslationEntry[],
  segments: CaptionSegment[]
): Promise<void> {
  if (translations.length === 0) {
    return;
  }

  try {
    const db = await openDb();
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const complete = txComplete(transaction);
    void complete.catch(() => undefined);
    const updatedAt = Date.now();
    const segmentsById = new Map(segments.map((segment) => [segment.id, segment]));
    for (const translation of translations) {
      const segment = segmentsById.get(translation.id);
      if (!segment) {
        continue;
      }
      const record: CaptionTranslationRecord = {
        ...context,
        key: cacheKey(context, segment),
        segmentId: translation.id,
        translatedText: translation.translatedText,
        updatedAt
      };
      store.put(record);
    }
    await pruneCaptionCache(store);
    await complete;
  } catch (error) {
    console.warn("번역 캐시를 저장하지 못했지만 번역은 계속합니다.", error);
  }
}
