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
- compute type: `float16` (`int8` when the device is CPU)
- beam size: `1`
- VAD: enabled
- stream window: `6s`
- stream decode interval: `1.1s`

When the extension sends `content_mode=lyrics`, the server switches to a song-friendly profile:

- VAD: disabled, because accompaniment often makes vocal VAD unreliable
- beam size: `3` by default
- stream window: `12s`
- stream decode interval: `1.6s`
- minimum audio before decode: `3s`
- overlap after finalized text: `2s`
- a fixed source language is preserved; `auto` enables per-segment language detection
- deterministic decoding and a more permissive no-speech threshold

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
