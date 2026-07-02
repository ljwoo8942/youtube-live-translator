import type {
  CaptionSegment,
  ContentSettings,
  MiniControlSettingsPatch,
  PageCaptionSnapshot,
  TranslatorSettings
} from "./types";

export const BLOCKED_HALLUCINATION_ERROR = "환각 의심 번역 결과를 차단했습니다.";

export type CaptionTranslationEntry = {
  id: string;
  translatedText: string;
};

export type RuntimeMessage =
  | { type: "CAPTION_SEGMENT"; segment: CaptionSegment }
  | { type: "TRANSLATION_READY"; segment: CaptionSegment; translatedText: string; provider: string; videoId?: string }
  | { type: "TRANSLATION_ERROR"; segment?: CaptionSegment; error: string; videoId?: string }
  | {
      type: "PRETRANSLATE_CAPTIONS";
      videoId: string;
      captionHash: string;
      trackLanguage: string;
      currentTimeMs: number;
      translationConfigRevision: number;
      segments: CaptionSegment[];
    }
  | {
      type: "PRETRANSLATE_PROGRESS";
      videoId: string;
      captionHash: string;
      translated: number;
      total: number;
      translationConfigRevision: number;
      statusText?: string;
    }
  | {
      type: "PRETRANSLATE_RESULT";
      videoId: string;
      captionHash: string;
      translations: CaptionTranslationEntry[];
      provider: string;
      translationConfigRevision: number;
    }
  | {
      type: "START_AUDIO_CAPTURE";
      tabId?: number;
      videoId?: string;
      streamId?: string;
      audioChunkMs?: number;
      useStreaming?: boolean;
      streamingSttEndpoint?: string;
      streamingSttModel?: string;
      sourceLanguage?: string;
      contentMode?: string;
      speakerTurnDetection?: boolean;
      ensureTabCapturePermission?: boolean;
      target?: "offscreen";
    }
  | { type: "PREPARE_AUDIO_CAPTURE" }
  | { type: "PREPARE_AUDIO_STOP" }
  | {
      type: "RECONFIGURE_AUDIO_CAPTURE";
      tabId?: number;
      videoId: string;
      expectedVideoId?: string;
      audioChunkMs?: number;
      useStreaming?: boolean;
      streamingSttEndpoint?: string;
      streamingSttModel?: string;
      sourceLanguage?: string;
      contentMode?: string;
      speakerTurnDetection?: boolean;
      startIfMissing?: boolean;
      target?: "offscreen";
    }
  | { type: "RESET_AUDIO_CAPTURE_BUFFER"; tabId?: number; videoId: string; target?: "offscreen" }
  | { type: "STOP_AUDIO_CAPTURE"; tabId?: number; videoId?: string; target?: "offscreen" }
  | { type: "GET_OFFSCREEN_AUDIO_STATE"; target?: "offscreen" }
  | { type: "AUDIO_CHUNK"; tabId: number; videoId: string; audioBase64: string; mimeType: string }
  | { type: "AUDIO_TRANSCRIPT"; tabId: number; videoId: string; segment: CaptionSegment }
  | { type: "STREAM_STT_TRANSCRIPT"; tabId: number; videoId: string; segment: CaptionSegment; isFinal: boolean }
  | { type: "AUDIO_CAPTURE_STATUS"; state: string; error?: string; tabId?: number; videoId?: string; statusText?: string }
  | { type: "SETTINGS_UPDATED"; settings: ContentSettings; revision: number }
  | { type: "SAVE_SETTINGS"; patch: Partial<TranslatorSettings> }
  | { type: "MINI_CONTROL_UPDATE"; patch: MiniControlSettingsPatch }
  | { type: "CANCEL_PRETRANSLATION"; keepVideoId?: string }
  | { type: "RESET_AUDIO_CAPTURE_COOLDOWN"; tabId?: number }
  | { type: "OPEN_OPTIONS_PAGE" }
  | { type: "GET_SETTINGS" }
  | { type: "GET_PAGE_CAPTION_SNAPSHOT"; videoId: string }
  | { type: "PREPARE_CAPTION_LYRICS_ASSIST"; videoId: string }
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
