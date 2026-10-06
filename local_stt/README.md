# Local Whisper STT server (MLX and faster-whisper)

OpenAI-compatible speech-to-text server for the YouTube Live Translator extension on Windows and macOS (Apple Silicon and Intel).

## Setup

Install Node.js 22.18+ and [uv](https://docs.astral.sh/uv/getting-started/installation/). The same commands work in PowerShell and macOS Terminal; uv finds `.venv-stt`'s platform-specific interpreter automatically.

```bash
npm run stt:setup
```

## Run

```bash
npm run stt:start
```

Keep that terminal open while using the extension. The server listens on `http://127.0.0.1:8765`.

The extension uses the WebSocket endpoint first for smoother audio subtitles:

```text
ws://127.0.0.1:8765/v1/audio/stream
```

It sends 16 kHz mono PCM16 frames and receives JSON messages with `type`, `text`, `start_ms`, `end_ms`, and `seq`. If this stream cannot be opened, the extension falls back to `/v1/audio/transcriptions`.

If you want the older detached background launcher, run:

```bash
npm run stt:daemon
```

The first `/health` request loads and probes the selected engine's model. The default model is `small`. Transcription requests can also pass a `model` form field, so choosing another model in the extension loads it when it is cached locally. Set `YT_TRANSLATOR_STT_MODEL` before starting the server to prepare a new model or select a local model directory.

Device selection is automatic: native Apple Silicon macOS uses MLX Metal GPU, Intel macOS uses CPU, and Windows/Linux uses CUDA when an NVIDIA GPU is available and CPU otherwise. Environment overrides remain available.

- model: `small`
- device: `mlx` on Apple Silicon; `cpu` on Intel Mac; `cuda` when available on Windows/Linux
- compute type: `float16` on MLX/CUDA, `int8` on CPU
- beam size: `1`
- VAD: enabled
- stream window: `6s`
- stream decode interval: `1.1s`

Apple Silicon GPU acceleration uses [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper), installed only on Darwin/arm64. It requires macOS 14+ and native arm64 Python. After updating an existing checkout, rerun `npm run stt:setup` and restart the server. `npm run stt:health` must report `backend=mlx-whisper`, `device=mlx`, `compute_type=float16`, and `ok=true`; the health probe executes short GPU inference with VAD disabled rather than checking model loading alone.

MLX model aliases (`tiny`, `base`, `small`, `medium`, `large-v3`, `large-v3-turbo`) resolve to verified `mlx-community` repositories. MLX and faster-whisper weights are different; only models cached for the selected engine appear in the model list. A configured local directory must contain weights for that engine.

MLX Whisper 0.4.3 uses greedy decoding, so effective beam size is reported as 1. VAD uses the existing Silero detector and forwards original audio clip timestamps; confidence scores, hallucination filters, and the HTTP/WebSocket contracts remain shared. Automatic language detection runs once per rolling window.

To select MLX explicitly, use `YT_TRANSLATOR_STT_DEVICE=mlx npm run stt:start`. For CPU, use `YT_TRANSLATOR_STT_DEVICE=cpu YT_TRANSLATOR_STT_COMPUTE_TYPE=int8 npm run stt:start`. For a slower machine, try `YT_TRANSLATOR_STT_MODEL=base npm run stt:start`, then use the extension's connection check to adopt the server model. Recreate copied virtual environments with `npm run stt:setup` on the target OS.

When the extension sends `content_mode=lyrics`, the server switches to a song-friendly profile:

- VAD: disabled, because accompaniment often makes vocal VAD unreliable
- beam size: `5` by default
- stream window: `14s`
- stream decode interval: `1.2s`
- minimum audio before decode: `2.4s`
- overlap after finalized text: `3s`
- a fixed source language is preserved; `auto` enables per-segment language detection
- deterministic decoding and a more permissive no-speech threshold

The server accepts Chrome extension origins only. HTTP uploads are limited to 16 MiB and 60 seconds of decoded audio, WebSocket frames to 256 KiB, and CPU/GPU inference is serialized. Override these ceilings with `YT_TRANSLATOR_STT_MAX_UPLOAD_BYTES`, `YT_TRANSLATOR_STT_MAX_AUDIO_SECONDS`, and `YT_TRANSLATOR_STT_MAX_STREAM_CHUNK_BYTES` only when needed. The bundled health-check commands supply the required origin header.

When the extension sends `content_mode=live`, the server uses a speech-first hybrid profile for streams that alternate between talking and singing:

- VAD: enabled with a lower speech threshold and boundary padding; when the speech pass is empty, one song-aware, no-VAD lyrics pass checks for sung vocals
- the lyrics fallback preserves a fixed source language and uses automatic detection only when the request language is `auto`
- beam size: `3` by default
- stream window: `8s`
- stream decode interval: `1.3s`
- minimum audio before decode: `2.1s`
- overlap after finalized text: `1.5s`

When `base` or `small` is selected, the server uses a model-specific profile:

- beam size: `5` for live/lyrics and `3` for ordinary speech
- automatic language detection checks more audio segments
- `small` keeps longer stream context (`10s`/`15s` for live/lyrics) to improve recognition stability
- `base` uses a faster testing profile (`7.5s`/`10s` for live/lyrics) and a less aggressive compact-model confidence filter

The `medium` timings remain unchanged. Use `base` for responsiveness experiments, `small` for the default balance, and `medium` when accuracy matters more than GPU load.

Streaming results are finalized after a repeated decode or the profile's stabilization interval, so the first short partial does not immediately discard context.

Initial prompts are disabled by default because short instrumental sections can copy prompt text into the transcript. Mode-specific prompts remain available through `YT_TRANSLATOR_STT_LYRICS_INITIAL_PROMPT` and `YT_TRANSLATOR_STT_LIVE_INITIAL_PROMPT`.

Override with environment variables such as `YT_TRANSLATOR_STT_MODEL`, `YT_TRANSLATOR_STT_DEVICE`, `YT_TRANSLATOR_STT_COMPUTE_TYPE`, `YT_TRANSLATOR_STT_TEMPERATURE`, `YT_TRANSLATOR_STT_LIVE_VAD_THRESHOLD`, `YT_TRANSLATOR_STT_STREAM_WINDOW_SECONDS`, or `YT_TRANSLATOR_STT_STREAM_DECODE_INTERVAL_SECONDS`.
