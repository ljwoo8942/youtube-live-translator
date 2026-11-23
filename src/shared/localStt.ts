import { fetchWithTimeout, LOCAL_STT_HEADERS } from "./network";
import type { TranslatorSettings } from "./types";

export function usesNativeSttEndpoint(settings: TranslatorSettings): boolean {
  return settings.sttProvider === "whisper" &&
    /^http:\/\/(127\.0\.0\.1|localhost):8765(?:\/v1)?\/?$/i.test(settings.whisper.baseUrl.trim()) &&
    settings.whisper.endpoint === "/audio/transcriptions" &&
    (!settings.streamingSttEnabled ||
      /^ws:\/\/(127\.0\.0\.1|localhost):8765\/v1\/audio\/stream$/i.test(settings.streamingSttEndpoint.trim()));
}

export async function needsLocalSttStart(settings: TranslatorSettings): Promise<boolean> {
  if (!usesNativeSttEndpoint(settings)) return false;
  const url = new URL("/v1/models", settings.whisper.baseUrl.trim());
  try {
    // The model list checks the listener without loading model weights.
    await fetchWithTimeout(url.href, { headers: LOCAL_STT_HEADERS, cache: "no-store", redirect: "manual" }, 1_000);
    return false;
  } catch (error) {
    // A timeout may mean an existing server is still starting.
    return error instanceof TypeError;
  }
}
