# Local STT server (Whisper and Qwen3-ASR)

OpenAI-compatible speech-to-text server for the YouTube Live Translator extension on Windows and Apple Silicon macOS. Intel Macs are not supported.

## Setup

Install Node.js 22.18+ and [uv](https://docs.astral.sh/uv/getting-started/installation/). The same commands work in PowerShell and macOS Terminal; uv finds `.venv-stt`'s platform-specific interpreter automatically.

```bash
npm run stt:setup
```

Stop the existing STT server before setup. On Windows with an NVIDIA GPU, setup installs the official `torch==2.15.0+cu132` wheel from [PyTorch's CUDA 13.2 index](https://download.pytorch.org/whl/cu132) before the base dependencies. The exact CUDA build replaces an existing CPU-only wheel instead of accepting it as already installed. A CUDA 13.2-compatible NVIDIA driver and a supported Turing (`sm_75`) or newer GPU are required; setup checks a real FP16 matrix operation and fails with a recovery hint if GPU initialization or kernels fail. Older NVIDIA hardware must use an explicit CPU setup rather than expecting the CUDA probe to pass.

All packages stay in `.venv-stt`. The installer uses `.cache/uv` for downloads unless `UV_CACHE_DIR` is already set. No-GPU Windows and an explicit `YT_TRANSLATOR_STT_DEVICE=cpu` keep the ordinary dependency path. Apple Silicon keeps MLX; Intel Macs remain excluded. Model weights are shared between CPU and CUDA and do not need to be deleted or downloaded again.

## Run

```bash
npm run stt:start
```

Keep that terminal open while using the extension. The server listens on `http://127.0.0.1:8765`.

When local STT and WebSocket streaming are enabled, the extension uses this endpoint first:

```text
ws://127.0.0.1:8765/v1/audio/stream
```

It sends 16 kHz mono PCM16 frames and receives JSON messages with `type`, `text`, `start_ms`, `end_ms`, and `seq`. If this stream cannot be opened, the extension falls back to `/v1/audio/transcriptions`.

If you want the older detached background launcher, run:

```bash
npm run stt:daemon
```

The first `/health` request loads and probes the selected engine's model. The default model is `small`. Transcription requests can also pass a `model` form field, so choosing another model in the extension loads it when it is cached locally. Set `YT_TRANSLATOR_STT_MODEL` before starting the server to prepare a new model or select a local model directory.

Device selection is automatic: native Apple Silicon macOS uses MLX Metal GPU, and Windows selects CUDA when available and CPU otherwise. CUDA inference also requires the selected engine's GPU runtime. Qwen falls back to CPU if its PyTorch build cannot use CUDA; check `device`, `backend`, and `compute_type` in `/health`.

Default `small` Whisper settings for ordinary speech:

- model: `small`
- device: `mlx` on Apple Silicon; `cuda` when available on Windows, otherwise `cpu`
- compute type: `float16` on MLX/CUDA, `int8` on CPU (Whisper only; Qwen formats are listed below)
- beam size: `3` with faster-whisper, `1` with MLX
- VAD: enabled
- stream window: `8s`
- stream decode interval: `1.1s`

Apple Silicon GPU acceleration uses [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper), installed only on Darwin/arm64. It requires macOS 14+ and native arm64 Python. After updating an existing checkout, rerun `npm run stt:setup` and restart the server. `npm run stt:health` must report `backend=mlx-whisper`, `device=mlx`, `compute_type=float16`, and `ok=true`; the health probe executes short GPU inference with VAD disabled rather than checking model loading alone.

MLX model aliases (`tiny`, `base`, `small`, `medium`, `large-v3`, `large-v3-turbo`) resolve to verified `mlx-community` repositories. MLX and faster-whisper weights are different; only models cached for the selected engine appear in the model list. A configured local directory must contain weights for that engine.

MLX Whisper 0.4.3 uses greedy decoding, so effective beam size is reported as 1. VAD uses the existing Silero detector and forwards original audio clip timestamps; confidence scores, hallucination filters, and the HTTP/WebSocket contracts remain shared. Automatic language detection runs once per rolling window.

In macOS Terminal, select MLX explicitly with `YT_TRANSLATOR_STT_DEVICE=mlx npm run stt:start`. For Whisper on CPU, use `YT_TRANSLATOR_STT_DEVICE=cpu YT_TRANSLATOR_STT_COMPUTE_TYPE=int8 npm run stt:start`. To start with another model, use `YT_TRANSLATOR_STT_MODEL=base npm run stt:start`, then select the same model in the extension and save. The connection check reports server status; it does not change or save the selected model. In PowerShell, set variables separately, for example `$env:YT_TRANSLATOR_STT_MODEL = 'base'`, then run `npm run stt:start`. Recreate copied virtual environments with `npm run stt:setup` on the target OS.

## Qwen3-ASR

Run `npm run stt:setup` and `npm run stt:qwen:download` to prepare both models for your platform. Select `qwen3-asr-0.6b` or `qwen3-asr-1.7b` in the extension and save. The server accepts configured or cached models only; HTTP/WS clients cannot request arbitrary downloads.

Apple Silicon uses the `mlx-community/Qwen3-ASR-0.6B-8bit` and `mlx-community/Qwen3-ASR-1.7B-8bit` repositories through mlx-audio. Windows uses the official `Qwen/Qwen3-ASR-0.6B-hf` and `Qwen/Qwen3-ASR-1.7B-hf` checkpoints through Transformers. CUDA-enabled PyTorch uses float16; a CPU-only PyTorch build warns and falls back to CPU/float32. Check `device` and `compute_type` in `/health`; install a matching CUDA build from the official PyTorch instructions for Windows GPU use.

Set `YT_TRANSLATOR_STT_MODEL=qwen3-asr-0.6b` (or `qwen3-asr-1.7b`) before starting to use Qwen as the initial model. Health checks preserve an already selected model instead of replacing it with the default Whisper model.

HTTP transcribes each uploaded audio chunk; WebSocket inference uses a bounded rolling window. Both paths apply the shared VAD/text filters. Qwen returns chunk/window-level text, not Whisper confidence scores or word-level alignment. Its effective beam size is 1. Qwen uses MLX `8bit`, PyTorch CUDA `float16`, or PyTorch CPU `float32`; Whisper's `int8` setting does not quantize Qwen. Native stateful Qwen streaming and a forced aligner are not included. The 1.7B model on CPU may be slow; measure it on the target machine before choosing it for live use.

## Content profiles

The following live/lyrics timings are the base profiles used by Qwen and Whisper aliases other than `base`/`small`. The compact Whisper adjustments are listed afterward. These are decode scheduling settings, not measured end-to-end subtitle latency.

When the extension sends `content_mode=lyrics`, the server switches to a song-friendly profile:

- VAD: disabled, because accompaniment often makes vocal VAD unreliable
- beam size: `5` with faster-whisper; `1` with MLX or Qwen
- stream window: `14s`
- stream decode interval: `1.2s`
- minimum audio before decode: `2.4s`
- overlap after finalized text: `3s`
- the server preserves an explicitly supplied language; an omitted language or `auto` enables automatic detection
- deterministic decoding and a more permissive no-speech threshold

The extension deliberately omits the fixed language in lyrics mode for mixed-language songs, even if a source language was selected. In other modes it forwards the selected language.

The server accepts Chrome extension origins only. HTTP uploads are limited to 16 MiB and 60 seconds of decoded audio, WebSocket frames to 256 KiB, and CPU/GPU inference is serialized. Override these ceilings with `YT_TRANSLATOR_STT_MAX_UPLOAD_BYTES`, `YT_TRANSLATOR_STT_MAX_AUDIO_SECONDS`, and `YT_TRANSLATOR_STT_MAX_STREAM_CHUNK_BYTES` only when needed. The bundled health-check commands supply the required origin header.

The HTTP request body is capped before multipart parsing, allowing 64 KiB of multipart metadata in addition to the file limit. Decoding stops at the audio duration limit and returns HTTP 413. Streaming audio reception continues during inference; only the latest bounded audio window is decoded, and reset/disconnect discards stale results.

When the extension sends `content_mode=live`, the server uses a speech-first hybrid profile for streams that alternate between talking and singing:

- VAD: enabled with a lower speech threshold and boundary padding; when the speech pass is empty, one song-aware, no-VAD lyrics pass checks for sung vocals
- the lyrics fallback preserves a fixed source language and uses automatic detection only when the request language is `auto`
- beam size: `3` with faster-whisper; `1` with MLX or Qwen
- stream window: `8s`
- stream decode interval: `1.3s`
- minimum audio before decode: `2.1s`
- overlap after finalized text: `1.5s`

When `base` or `small` is selected, the server uses a model-specific profile:

- faster-whisper beam size: `base` uses `5` in all modes; `small` uses `5` for live/lyrics and `3` for ordinary speech. MLX remains greedy (`1`).
- faster-whisper automatic language detection checks more audio segments; MLX detects once per window
- `small` uses `8s`/`10s`/`15s` windows for ordinary speech/live/lyrics
- `base` uses `7.5s`/`9s`/`12s` windows for ordinary speech/live/lyrics and a compact-model confidence filter

The `medium` alias uses the base profile timings above. Select a model using measurements on your own audio and hardware; these profiles do not establish comparative accuracy or speed.

Streaming results are finalized after a repeated decode or the profile's stabilization interval, so the first short partial does not immediately discard context. Startup uses shorter minimum-audio/finalization thresholds than steady-state operation.

The lyrics profile, including the live mode's lyrics fallback, uses a Japanese lyrics prompt by default. The ordinary/live speech pass has no initial prompt by default. Replace the mode-specific prompts with `YT_TRANSLATOR_STT_LYRICS_INITIAL_PROMPT` or `YT_TRANSLATOR_STT_LIVE_INITIAL_PROMPT` as needed; an empty lyrics override keeps the default lyrics prompt.

Override with environment variables such as `YT_TRANSLATOR_STT_MODEL`, `YT_TRANSLATOR_STT_DEVICE`, `YT_TRANSLATOR_STT_COMPUTE_TYPE`, `YT_TRANSLATOR_STT_TEMPERATURE`, `YT_TRANSLATOR_STT_LIVE_VAD_THRESHOLD`, `YT_TRANSLATOR_STT_STREAM_WINDOW_SECONDS`, or `YT_TRANSLATOR_STT_STREAM_DECODE_INTERVAL_SECONDS`.

## CUDA acceptance test

After setup and model preparation, run this in PowerShell for each model:

```powershell
$env:YT_TRANSLATOR_STT_DEVICE = 'cuda'
$env:YT_TRANSLATOR_STT_EXPECT_DEVICE = 'cuda'
foreach ($model in @('qwen3-asr-0.6b', 'qwen3-asr-1.7b')) {
    $env:YT_TRANSLATOR_STT_MODEL = $model
    uv run --no-project --python .venv-stt python -m unittest local_stt.test_qwen_runtime -v
    if ($LASTEXITCODE -ne 0) { throw "CUDA test failed: $model" }
}
```

The test rejects CPU fallback, checks CUDA model parameters and input/output tensors, and runs actual HTTP and WebSocket generation. Its tone fixture checks GPU execution, not speech accuracy or live subtitle latency. See the [RTX 5070 validation record](../docs/qwen-cuda-validation.md) for the additional generated-speech control. GitHub-hosted Windows runners have no NVIDIA GPU; their CPU tests do not replace this local CUDA check.
