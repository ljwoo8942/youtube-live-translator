import {
  normalizeSongCorrection,
  type CorrectionLibraryExport,
  type CorrectionPreferences,
  type SongCorrection
} from "./corrections";

const DB_NAME = "youtube-live-translator-corrections";
const DB_VERSION = 1;
const SONG_STORE = "songs";
const META_STORE = "meta";
const PREFERENCES_KEY = "preferences";

let databasePromise: Promise<IDBDatabase> | undefined;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("교정 사전 DB 요청에 실패했습니다."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("교정 사전 DB 저장에 실패했습니다."));
    transaction.onabort = () => reject(transaction.error ?? new Error("교정 사전 DB 작업이 중단됐습니다."));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) {
    return databasePromise;
  }
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SONG_STORE)) {
        database.createObjectStore(SONG_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error ?? new Error("교정 사전 DB를 열지 못했습니다."));
    };
  });
  return databasePromise;
}

export async function listSongCorrections(): Promise<SongCorrection[]> {
  const database = await openDatabase();
  const transaction = database.transaction(SONG_STORE, "readonly");
  const complete = transactionComplete(transaction);
  const values = await requestResult<unknown[]>(transaction.objectStore(SONG_STORE).getAll());
  await complete;
  return values
    .map((value) => normalizeSongCorrection(value))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function putSongCorrection(value: SongCorrection): Promise<SongCorrection> {
  const song = normalizeSongCorrection({ ...value, version: value.version + 1, updatedAt: Date.now() });
  const database = await openDatabase();
  const transaction = database.transaction(SONG_STORE, "readwrite");
  const complete = transactionComplete(transaction);
  transaction.objectStore(SONG_STORE).put(song);
  await complete;
  return song;
}

export async function deleteSongCorrection(id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(SONG_STORE, "readwrite");
  const complete = transactionComplete(transaction);
  transaction.objectStore(SONG_STORE).delete(id);
  await complete;
}

export async function replaceSongCorrections(values: SongCorrection[]): Promise<void> {
  const songs = values.map(normalizeSongCorrection);
  const database = await openDatabase();
  const transaction = database.transaction(SONG_STORE, "readwrite");
  const complete = transactionComplete(transaction);
  const store = transaction.objectStore(SONG_STORE);
  store.clear();
  for (const song of songs) {
    store.put(song);
  }
  await complete;
}

export async function getCorrectionPreferences(): Promise<CorrectionPreferences> {
  const database = await openDatabase();
  const transaction = database.transaction(META_STORE, "readonly");
  const complete = transactionComplete(transaction);
  const stored = await requestResult<unknown>(transaction.objectStore(META_STORE).get(PREFERENCES_KEY));
  await complete;
  return {
    enabled:
      !stored ||
      typeof stored !== "object" ||
      !("enabled" in stored) ||
      (stored as { enabled?: unknown }).enabled !== false
  };
}

export async function setCorrectionPreferences(preferences: CorrectionPreferences): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(META_STORE, "readwrite");
  const complete = transactionComplete(transaction);
  transaction.objectStore(META_STORE).put({ enabled: Boolean(preferences.enabled) }, PREFERENCES_KEY);
  await complete;
}

export async function exportCorrectionLibrary(): Promise<CorrectionLibraryExport> {
  return {
    format: "youtube-live-translator-corrections",
    version: 1,
    exportedAt: new Date().toISOString(),
    songs: await listSongCorrections()
  };
}
