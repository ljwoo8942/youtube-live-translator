import { DEFAULT_SETTINGS, SETTINGS_KEY } from "./defaults";
import type { ContentSettings, SettingsSnapshot, TranslatorSettings } from "./types";

type PlainObject = Record<string, unknown>;
const OFFICIAL_CAPTION_POLICY_VERSION = 1;
const SETTINGS_REVISION_KEY = "translatorSettingsRevision";
const TRANSLATION_CONFIG_REVISION_KEY = "translatorTranslationConfigRevision";

type StoredSettings = Partial<TranslatorSettings> & {
  officialCaptionPolicyVersion?: number;
};

let settingsWriteQueue: Promise<void> = Promise.resolve();

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep<T extends PlainObject>(base: T, override: unknown): T {
  if (!isPlainObject(override)) {
    return { ...base };
  }

  const result: PlainObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = result[key];
    if (isPlainObject(baseValue) && isPlainObject(value)) {
      result[key] = mergeDeep(baseValue, value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }

  return result as T;
}

export async function loadSettings(): Promise<TranslatorSettings> {
  return (await loadSettingsSnapshot()).settings;
}

export async function loadSettingsSnapshot(): Promise<SettingsSnapshot> {
  const stored = (await chrome.storage.local.get([SETTINGS_KEY, SETTINGS_REVISION_KEY, TRANSLATION_CONFIG_REVISION_KEY])) as {
    [SETTINGS_KEY]?: StoredSettings;
    [SETTINGS_REVISION_KEY]?: unknown;
    [TRANSLATION_CONFIG_REVISION_KEY]?: unknown;
  };
  const settings = mergeDeep(DEFAULT_SETTINGS as unknown as PlainObject, stored[SETTINGS_KEY]) as TranslatorSettings;
  let revision = typeof stored[SETTINGS_REVISION_KEY] === "number" ? stored[SETTINGS_REVISION_KEY] : 0;
  const translationConfigRevision =
    typeof stored[TRANSLATION_CONFIG_REVISION_KEY] === "number" ? stored[TRANSLATION_CONFIG_REVISION_KEY] : 0;
  const rawProvider = (settings as unknown as { translationProvider?: string }).translationProvider;
  if (rawProvider === "google") {
    settings.translationProvider = "openai";
  }
  const storedVersion =
    typeof (stored[SETTINGS_KEY] as PlainObject | undefined)?.officialCaptionPolicyVersion === "number"
      ? ((stored[SETTINGS_KEY] as PlainObject).officialCaptionPolicyVersion as number)
      : 0;
  if (storedVersion < OFFICIAL_CAPTION_POLICY_VERSION) {
    settings.inputMode = "captionsThenAudio";
    settings.pretranslateEnabled = true;
    (settings as unknown as PlainObject).officialCaptionPolicyVersion = OFFICIAL_CAPTION_POLICY_VERSION;
    revision += 1;
    await saveSettings(settings, revision, translationConfigRevision);
  }
  return { settings, revision, translationConfigRevision };
}

async function saveSettings(settings: TranslatorSettings, revision: number, translationConfigRevision: number): Promise<void> {
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...settings,
      officialCaptionPolicyVersion: OFFICIAL_CAPTION_POLICY_VERSION
    },
    [SETTINGS_REVISION_KEY]: revision,
    [TRANSLATION_CONFIG_REVISION_KEY]: translationConfigRevision
  });
}

export function toContentSettings(settings: TranslatorSettings, translationConfigRevision: number): ContentSettings {
  return {
    enabled: settings.enabled,
    inputMode: settings.inputMode,
    contentMode: settings.contentMode,
    pretranslateEnabled: settings.pretranslateEnabled,
    miniControlsEnabled: settings.miniControlsEnabled,
    streamingSttEnabled: settings.streamingSttEnabled,
    streamingSttEndpoint: settings.streamingSttEndpoint,
    speakerTurnDetection: settings.speakerTurnDetection,
    sourceLanguage: settings.sourceLanguage,
    targetLanguage: settings.targetLanguage,
    translationProvider: settings.translationProvider,
    sttProvider: settings.sttProvider,
    latencyOffsetMs: settings.latencyOffsetMs,
    audioChunkMs: settings.audioChunkMs,
    overlayStyle: { ...settings.overlayStyle },
    streamingSttModel: settings.whisper.model,
    translationConfigRevision
  };
}

function translationConfigSignature(settings: TranslatorSettings): string {
  return JSON.stringify({
    provider: settings.translationProvider,
    openai: settings.openai,
    apiSttApiKey: settings.apiStt.apiKey,
    ollama: settings.ollama,
    lmStudio: settings.lmStudio
  });
}

function diffDeep(previous: PlainObject, next: PlainObject): PlainObject {
  const patch: PlainObject = {};
  for (const [key, nextValue] of Object.entries(next)) {
    const previousValue = previous[key];
    if (isPlainObject(previousValue) && isPlainObject(nextValue)) {
      const nestedPatch = diffDeep(previousValue, nextValue);
      if (Object.keys(nestedPatch).length > 0) {
        patch[key] = nestedPatch;
      }
    } else if (!Object.is(previousValue, nextValue)) {
      patch[key] = nextValue;
    }
  }
  return patch;
}

export function diffSettings(previous: TranslatorSettings, next: TranslatorSettings): Partial<TranslatorSettings> {
  return diffDeep(previous as unknown as PlainObject, next as unknown as PlainObject) as Partial<TranslatorSettings>;
}

export function patchSettings(patch: Partial<TranslatorSettings>): Promise<SettingsSnapshot> {
  const write = settingsWriteQueue.then(async () => {
    const current = await loadSettingsSnapshot();
    if (Object.keys(patch).length === 0) {
      return current;
    }
    const settings = mergeDeep(current.settings as unknown as PlainObject, patch) as TranslatorSettings;
    const revision = current.revision + 1;
    const translationConfigRevision =
      translationConfigSignature(current.settings) === translationConfigSignature(settings)
        ? current.translationConfigRevision
        : current.translationConfigRevision + 1;
    await saveSettings(settings, revision, translationConfigRevision);
    return { settings, revision, translationConfigRevision };
  });
  settingsWriteQueue = write.then(
    () => undefined,
    () => undefined
  );
  return write;
}
