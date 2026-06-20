# YouTube Live Translator

Manifest V3 Chrome extension that overlays translated subtitles on YouTube live and recorded videos.

It uses creator-provided YouTube captions first, then falls back to tab-audio STT when captions are unavailable. Translation can run through an OpenAI-compatible AI API, LM Studio, or Ollama; the bundled faster-whisper server supports local GPU STT.

> API keys are entered through the extension settings and stored only in `chrome.storage.local`. They are not part of this repository or the built extension source.

## Features

- YouTube overlay subtitles for live and recorded playback.
- Caption-first pipeline using YouTube timed text, full-caption pretranslation, and IndexedDB cache.
- Audio fallback with `chrome.tabCapture`, offscreen WebAudio, and local WebSocket STT when captions are unavailable.
- YouTube on-video mini controls for enable/disable, source text, lyric mode, size, position, retry, and settings.
- Translation providers:
  - OpenAI-compatible AI API
  - Mindlogic Gateway and other multi-model gateways through the OpenAI-compatible AI API settings
  - Ollama
  - LM Studio
- STT providers:
  - LM Studio first, then Whisper-compatible fallback
  - Whisper-compatible local/cloud endpoint
  - OpenAI-compatible audio transcription endpoint

## Build

```bash
npm install
npm run build
```

Load the generated `dist` folder from `chrome://extensions` with Developer mode enabled.

## Local AI Defaults

- Ollama: `http://localhost:11434`
- faster-whisper GPU STT: `http://127.0.0.1:8765/v1/audio/transcriptions`
- faster-whisper streaming STT: `ws://127.0.0.1:8765/v1/audio/stream`
- LM Studio: `http://127.0.0.1:1234/v1` when you choose local LLM translation

Open the extension options page to choose providers, set API keys, choose language codes, and tune the subtitle overlay.

The default recommended flow is local faster-whisper STT plus an AI translation API. Use `LM Studio 연결 확인` only when you intentionally choose LM Studio as the text translation provider.

## Caption Pretranslation

When YouTube timed text exists, the extension does not start audio capture. It fetches the full timed text track, translates the current playback area first, then continues translating the rest of the video in the background.

Cached translated captions are stored in IndexedDB by video, caption hash, target language, provider/model, and content mode. Reloading the same video can display cached translations immediately.

Use `콘텐츠 모드` or the YouTube mini control `♪` button for lyric-style translation on music videos.

## API Key Audio Subtitles

For YouTube videos without built-in captions, a translation key alone is not enough. The extension must also send tab audio to an STT endpoint.

In the options page:

- Click `API 키로 음성 자막 프리셋`
- Enter either `AI API` key or `API STT` key
- Click `API STT + 번역 테스트` to verify STT reachability and AI translation together
- Save, then use YouTube with `자막 우선 + 음성` or `음성만`

You can still use `API STT 연결 테스트` for only the transcription endpoint, and `테스트` for only text translation.

Defaults for API STT:

- Base URL: `https://api.openai.com/v1`
- Endpoint: `/audio/transcriptions`
- Model: `gpt-4o-mini-transcribe`
- Auth: `Authorization: Bearer`

If `API STT` key is blank, the extension uses the `AI API` key for both STT and translation. If `AI API` key is blank but `API STT` key is present, OpenAI-compatible translation can use that same key too.

## Multi-model AI API

If your API key can call models from multiple LLM companies, use the `AI API` section in the options page.

- Choose `Mindlogic Gateway` or `직접 입력` from `API 프리셋`
- Enter the shared API key
- Click `모델 목록 불러오기`
- Pick any returned GPT, Claude, Gemini, xAI, Perplexity, or open model ID from `불러온 모델`
- Save and run `번역 테스트`

The extension stores the selected model as `AI API > 모델` and sends translation through the existing OpenAI-compatible `/chat/completions` or `/responses` flow.

## Local GPU STT + Translation API

This project includes a local OpenAI-compatible and WebSocket faster-whisper STT server for audio fallback.

Setup a Python 3.11 virtual environment with `uv`:

```bash
npm run stt:setup
```

Start the STT server:

```bash
npm run stt:start
```

Keep this terminal open while using YouTube translation. `stt:start` runs the local server in the foreground so Chrome can keep connecting to `http://127.0.0.1:8765`.

Check health:

```bash
npm run stt:health
```

Default STT settings prioritize smooth YouTube playback on an RTX 5070 12 GB VRAM:

- model: `medium`
- device: `cuda`
- compute type: `int8_float16`
- streaming endpoint: `ws://127.0.0.1:8765/v1/audio/stream`
- HTTP fallback chunk: `8000ms`
- endpoint: `http://127.0.0.1:8765/v1/audio/transcriptions`

The options page exposes the local STT model as a selector. `medium` is the default for better recognition, especially songs. If playback becomes unstable, choose `small` or `base`, then save and run `STT + 번역 API 전체 테스트`.

The local STT server defaults to `medium`. It can also load the requested form model dynamically, so choosing `small` or `base` in the options page uses that faster-whisper model when it is available locally.

For songs, use `노래 STT 프리셋` or set `콘텐츠 모드` to `노래/가사`. The extension sends `content_mode=lyrics` to the local STT server, which disables VAD, uses a longer 12 second window, and raises beam size to improve sung-vocal recognition.

In the options page:

- Enter your `AI API` key
- Click `로컬 STT + 번역 API 프리셋`
- Click `faster-whisper 연결 확인`
- Use `STT + 번역 API 전체 테스트` to verify local STT and AI API translation together

The local preset enables `로컬 STT WebSocket 스트리밍 사용`. If the WebSocket stream fails, the extension automatically falls back to the older HTTP transcription chunk path, then to API STT if configured.

If you intentionally want the older background launcher, use `npm run stt:daemon`, but the foreground `npm run stt:start` is the recommended stable path.

If `/health` reports a CUDA error, install the NVIDIA CUDA/cuDNN runtime required by faster-whisper/CTranslate2, then restart `npm run stt:start`.

If `/health` says the model files cannot be found locally and cannot be downloaded from the Hub, run `npm run stt:start` once from a normal network-enabled terminal so the selected model can be cached, or set `YT_TRANSLATOR_STT_MODEL` to a local faster-whisper model directory.

## Mindlogic Gateway

In the options page, use the `Mindlogic Gateway 프리셋` button in the AI API section.

- Base URL: `https://factchat-cloud.mindlogic.ai/v1/gateway`
- Default model: `claude-sonnet-4-6`
- Supported auth headers:
  - `Authorization: Bearer YOUR_API_KEY`
  - `x-api-key: YOUR_API_KEY`

Choose the matching auth header mode before saving. The default preset uses the OpenAI-style Bearer header.

## Notes

- LM Studio text translation uses OpenAI-compatible `/chat/completions` or `/responses`.
- For local real-time audio translation, the default path is faster-whisper for STT and AI API for text translation. LM Studio translation remains available as an optional local LLM mode.
