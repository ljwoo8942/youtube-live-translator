import type {
  CaptionSegment,
  ContentSettings,
  MiniControlSettingsPatch,
  PageCaptionSnapshot,
  TranslatorSettings
} from "./types";

export type CaptionTranslationEntry = {
  id: string;
  translatedText: string;
};

export type RuntimeMessage =
  | { type: "CAPTION_SEGMENT"; segment: CaptionSegment }
  | { type: "TRANSLATION_READY"; segment: CaptionSegment; translatedText: string; provider: string }
  | { type: "TRANSLATION_ERROR"; segment?: CaptionSegment; error: string }
  | {
      type: "PRETRANSLATE_CAPTIONS";
      videoId: string;
      captionHash: string;
      trackLanguage: string;
      currentTimeMs: number;
      segments: CaptionSegment[];
    }
  | {
      type: "PRETRANSLATE_PROGRESS";
      videoId: string;
      captionHash: string;
      translated: number;
      total: number;
      statusText?: string;
    }
  | {
      type: "PRETRANSLATE_RESULT";
      videoId: string;
      captionHash: string;
      translations: CaptionTranslationEntry[];
      provider: string;
    }
  | {
      type: "START_AUDIO_CAPTURE";
      tabId?: number;
      streamId?: string;
      audioChunkMs?: number;
      useStreaming?: boolean;
      streamingSttEndpoint?: string;
      streamingSttModel?: string;
      sourceLanguage?: string;
      contentMode?: string;
      speakerTurnDetection?: boolean;
    }
  | { type: "STOP_AUDIO_CAPTURE"; tabId?: number }
  | { type: "GET_OFFSCREEN_AUDIO_STATE" }
  | { type: "AUDIO_CHUNK"; tabId: number; audioBase64: string; mimeType: string }
  | { type: "AUDIO_TRANSCRIPT"; tabId: number; segment: CaptionSegment }
  | { type: "STREAM_STT_TRANSCRIPT"; tabId: number; segment: CaptionSegment; isFinal: boolean }
  | { type: "AUDIO_CAPTURE_STATUS"; state: string; error?: string; tabId?: number; statusText?: string }
  | { type: "SETTINGS_UPDATED"; settings: ContentSettings }
  | { type: "SAVE_SETTINGS"; patch: Partial<TranslatorSettings> }
  | { type: "MINI_CONTROL_UPDATE"; patch: MiniControlSettingsPatch }
  | { type: "RESET_AUDIO_CAPTURE_COOLDOWN"; tabId?: number }
  | { type: "OPEN_OPTIONS_PAGE" }
  | { type: "GET_SETTINGS" }
  | { type: "GET_PAGE_CAPTION_SNAPSHOT"; videoId: string }
  | { type: "GET_TAB_STATUS" };

export type MessageResponse<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
