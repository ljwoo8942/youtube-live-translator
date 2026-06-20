import { DEFAULT_SETTINGS, SETTINGS_KEY } from "./defaults";
import type { TranslatorSettings } from "./types";

type PlainObject = Record<string, unknown>;
const OFFICIAL_CAPTION_POLICY_VERSION = 1;

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
  const stored = (await chrome.storage.local.get(SETTINGS_KEY)) as {
    [SETTINGS_KEY]?: Partial<TranslatorSettings>;
  };
  const settings = mergeDeep(DEFAULT_SETTINGS as unknown as PlainObject, stored[SETTINGS_KEY]) as TranslatorSettings;
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
    await saveSettings(settings);
  }
  return settings;
}

export async function saveSettings(settings: TranslatorSettings): Promise<void> {
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...settings,
      officialCaptionPolicyVersion: OFFICIAL_CAPTION_POLICY_VERSION
    }
  });
}

export async function patchSettings(patch: Partial<TranslatorSettings>): Promise<TranslatorSettings> {
  const current = await loadSettings();
  const merged = mergeDeep(current as unknown as PlainObject, patch) as TranslatorSettings;
  await saveSettings(merged);
  return merged;
}
