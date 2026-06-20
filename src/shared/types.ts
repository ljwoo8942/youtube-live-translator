export type InputMode = "captions" | "captionsThenAudio" | "audio";

export type PageCaptionTrack = {
  baseUrl: string;
  languageCode?: string;
  kind?: string;
  vssId?: string;
};

export type PageCaptionSnapshot = {
  videoId: string;
  tracks: PageCaptionTrack[];
  selectedTrack?: Partial<PageCaptionTrack>;
  autoTranslationActive: boolean;
};
export type TranslationProvider = "openai" | "ollama" | "lmStudio";
export type AiEndpointMode = "chat" | "responses";
export type ApiAuthHeaderMode = "bearer" | "xApiKey" | "none";
export type SttProvider = "openai" | "lmStudio" | "whisper";
export type ContentMode = "auto" | "spoken" | "live" | "lyrics";

export type CaptionSource = "youtubeTimedText" | "youtubeDom" | "audioStt";

export type CaptionSegment = {
  id: string;
  source: CaptionSource;
  startMs: number;
  endMs: number;
  text: string;
  contextText?: string;
};

export type OverlayStyle = {
  fontSize: number;
  bottomOffset: number;
  maxWidth: number;
  backgroundOpacity: number;
  showSourceText: boolean;
};

export type OpenAiProviderSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
  endpointMode: AiEndpointMode;
  authHeaderMode: ApiAuthHeaderMode;
};

export type ApiSttProviderSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
  endpoint: string;
  authHeaderMode: ApiAuthHeaderMode;
};

export type OllamaProviderSettings = {
  baseUrl: string;
  model: string;
};

export type LmStudioProviderSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
  endpointMode: AiEndpointMode;
  authHeaderMode: ApiAuthHeaderMode;
  tryStt: boolean;
  sttModel: string;
  sttEndpoint: string;
};

export type WhisperProviderSettings = {
  baseUrl: string;
  apiKey: string;
  model: string;
  endpoint: string;
};

export type TranslatorSettings = {
  enabled: boolean;
  inputMode: InputMode;
  contentMode: ContentMode;
  pretranslateEnabled: boolean;
  miniControlsEnabled: boolean;
  streamingSttEnabled: boolean;
  streamingSttEndpoint: string;
  speakerTurnDetection: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  translationProvider: TranslationProvider;
  sttProvider: SttProvider;
  latencyOffsetMs: number;
  audioChunkMs: number;
  overlayStyle: OverlayStyle;
  openai: OpenAiProviderSettings;
  apiStt: ApiSttProviderSettings;
  ollama: OllamaProviderSettings;
  lmStudio: LmStudioProviderSettings;
  whisper: WhisperProviderSettings;
};

// Content scripts only need behavior and presentation settings. Keep provider
// endpoints and credentials inside trusted extension contexts.
export type ContentSettings = Omit<
  TranslatorSettings,
  "openai" | "apiStt" | "ollama" | "lmStudio" | "whisper"
> & {
  streamingSttModel: string;
};

export type MiniControlSettingsPatch = Partial<Pick<TranslatorSettings, "enabled" | "contentMode" | "overlayStyle">>;

export type SettingsSnapshot = {
  settings: TranslatorSettings;
  revision: number;
};

export type TranslationRequest = {
  segment: CaptionSegment;
};

export type TranslationResult = {
  ok: true;
  segment: CaptionSegment;
  translatedText: string;
  provider: TranslationProvider;
};

export type FailureResult = {
  ok: false;
  error: string;
};

export type AudioCaptureState = "idle" | "starting" | "recording" | "error";
