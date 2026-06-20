import type { TranslatorSettings } from "./types";

export const SETTINGS_KEY = "translatorSettings";

export const DEFAULT_SETTINGS: TranslatorSettings = {
  enabled: true,
  inputMode: "captionsThenAudio",
  contentMode: "auto",
  pretranslateEnabled: true,
  miniControlsEnabled: true,
  streamingSttEnabled: true,
  streamingSttEndpoint: "ws://127.0.0.1:8765/v1/audio/stream",
  speakerTurnDetection: true,
  sourceLanguage: "auto",
  targetLanguage: "ko",
  translationProvider: "openai",
  sttProvider: "whisper",
  latencyOffsetMs: 0,
  audioChunkMs: 8000,
  overlayStyle: {
    fontSize: 24,
    bottomOffset: 86,
    maxWidth: 76,
    backgroundOpacity: 0.72,
    showSourceText: false
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    endpointMode: "chat",
    authHeaderMode: "bearer"
  },
  apiStt: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini-transcribe",
    endpoint: "/audio/transcriptions",
    authHeaderMode: "bearer"
  },
  ollama: {
    baseUrl: "http://localhost:11434",
    model: "llama3.1"
  },
  lmStudio: {
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "",
    model: "google/gemma-4-e2b",
    endpointMode: "chat",
    authHeaderMode: "none",
    tryStt: false,
    sttModel: "whisper-1",
    sttEndpoint: "/audio/transcriptions"
  },
  whisper: {
    baseUrl: "http://127.0.0.1:8765/v1",
    apiKey: "",
    model: "small",
    endpoint: "/audio/transcriptions"
  }
};
