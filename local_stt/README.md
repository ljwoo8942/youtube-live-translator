# Local faster-whisper STT server

OpenAI-compatible speech-to-text server for the YouTube Live Translator extension.

## Setup

```powershell
npm run stt:setup
```

## Run

```powershell
npm run stt:start
```

Keep that terminal open while using the extension. The server listens on `http://127.0.0.1:8765`.

The extension uses the WebSocket endpoint first for smoother audio subtitles:

```text
ws://127.0.0.1:8765/v1/audio/stream
```

It sends 16 kHz mono PCM16 frames and receives JSON messages with `type`, `text`, `start_ms`, `end_ms`, and `seq`. If this stream cannot be opened, the extension falls back to `/v1/audio/transcriptions`.

If you want the older detached background launcher, run:

```powershell
npm run stt:daemon
```

The first `/health` request loads the faster-whisper model. The default model is `small`. Transcription requests can also pass a `model` form field, so choosing another model in the extension loads it when it is cached locally. Run once with internet access so faster-whisper can download the model you want, or set `YT_TRANSLATOR_STT_MODEL` to a local model directory.

Default GPU settings are tuned for an RTX 5070 12 GB:

- model: `small`
- device: `cuda`
- compute type: `int8_float16`
- beam size: `1`
- VAD: enabled
- stream window: `7s`
- stream decode interval: `1.5s`

When the extension sends `content_mode=lyrics`, the server switches to a song-friendly profile:

- VAD: disabled, because accompaniment often makes vocal VAD unreliable
- beam size: `3` by default
- stream window: `14s`
- stream decode interval: `2s`
- minimum audio before decode: `4s`
- overlap after finalized text: `1.2s`
- multilingual vocal prompt and a more permissive no-speech threshold

When the extension sends `content_mode=live`, the server switches to a live/noisy speech profile:

- VAD: enabled, with no-VAD retry when streaming returns empty text
- beam size: `2` by default
- stream window: `9s`
- stream decode interval: `1.6s`
- minimum audio before decode: `2.6s`
- overlap after finalized text: `1s`

Override with environment variables such as `YT_TRANSLATOR_STT_MODEL`, `YT_TRANSLATOR_STT_DEVICE`, `YT_TRANSLATOR_STT_COMPUTE_TYPE`, `YT_TRANSLATOR_STT_STREAM_WINDOW_SECONDS`, or `YT_TRANSLATOR_STT_STREAM_DECODE_INTERVAL_SECONDS`.
