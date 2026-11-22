# LM Studio settings for YouTube Live Translator

[한국어](lm-studio-settings.md) · **English** · [日本語](lm-studio-settings.ja.md)

These settings were tested with `Gemma4-E4B-Instruct-Pure-GGUF` on a Windows PC with an RTX 5070, 12 GB of VRAM, and 64 GB of system memory.

Gemma translates subtitle text in the extension. Local Whisper or Qwen3-ASR turns tab audio into text. See the project overview for installation and platform support. [README](../README.md)

## Tested configuration

| Item | Value |
| --- | --- |
| Translation model | `Gemma4-E4B-Instruct-Pure-GGUF` |
| Model ID in the test installation | `gemma4-e4b-instruct-pure` |
| Translation provider | `LM Studio` |
| Song speech recognition | Local Qwen3-ASR 1.7B on Windows, CUDA/FP16 |
| Translation endpoint | `/chat/completions` |

Load the model in LM Studio. In the extension's LM Studio settings, click **Load model list (`모델 목록 불러오기`)** and select the ID shown for your loaded model.

## Model loading

| Setting | Value in this setup | Purpose |
| --- | --- | --- |
| GPU offload | As many layers as fit on the GPU | Reduces translation latency |
| Context length | `4096` | Fits the current subtitle, its context, and the translation |
| Flash Attention | On when available | Reduces memory use and processing time for longer context |
| CPU threads | Auto | Lets LM Studio choose the thread count |
| Model residency | Keep the model loaded | Avoids reloading during playback |

Use a context length of `4096` as a starting point when both Gemma and Qwen share the GPU. Larger contexts use more VRAM.

## Translation requests

Use the default output limit and leave custom stop strings empty. The extension sets the output token budget for each subtitle. For a local Gemma 4 model served by LM Studio, the extension sends `reasoning_effort: "none"` on `/chat/completions` translation requests.

| Content mode | Temperature | Top P |
| --- | ---: | ---: |
| Auto or regular video | `0.14` | `0.86` |
| Live or noisy audio | `0.12` | `0.86` |
| Songs and lyrics | `0.16` | `0.88` |

The extension sets these values for local LM Studio requests and sends one subtitle at a time.

## System prompt

You can leave the LM Studio system prompt empty. The extension sends instructions for the selected content mode with each request. To add a short instruction in LM Studio, use the following.

```text
You are a subtitle translation engine.
Follow the system instructions provided by the application as the highest priority.
Output only the final translated subtitle.
Do not output reasoning, explanations, labels, source text, quotation marks, or Markdown.
```

## Start the local server and connect the extension

Start LM Studio's local server from **Developer > Local Server**. In the extension's **Full settings (`전체 설정`)**, set the translation provider to LM Studio and fill in the LM Studio section.

| Extension setting | Value |
| --- | --- |
| Translation provider (`번역 provider`) | `LM Studio` |
| Base URL | `http://127.0.0.1:1234/v1` |
| Translation model (`번역 모델`) | The loaded model ID shown in the model list |
| Endpoint (`엔드포인트`) | `/chat/completions` |
| Authentication (`인증 방식`) | **No authentication header (`인증 헤더 없음`)** when server authentication is off |
| Try LM Studio STT first (`LM Studio STT 먼저 시도`) | Off |

If the LM Studio server requires authentication, enter its token in **API token (`API 토큰`)** and select the matching authentication mode. Run **Test LM Studio translation (`LM Studio 번역 테스트`)**, check the translated text, and click **Save settings (`설정 저장`)**.

## Setup for fast Japanese songs

Install `uv` and run these commands from the project folder to prepare the local STT environment and Qwen models.

```bash
npm run stt:setup
npm run stt:qwen:download
```

The settings below were used to transcribe and translate 1:00–1:30 of the 「快晴」 cover. The first subtitle appeared about 13 seconds after playback started. [Test video](https://www.youtube.com/watch?v=YA7QcvdHk70&t=60s)

| Extension setting | Value |
| --- | --- |
| Input mode (`입력 방식`) | Audio only (`음성만`) |
| Content mode (`콘텐츠 모드`) | Songs and lyrics (`노래/가사`) |
| Audio language (`음성 언어`) | Japanese (`일본어`) |
| STT provider | Local STT (`로컬 STT (Whisper / Qwen)`) |
| Local STT model | `Qwen3-ASR 1.7B` |
| Local STT Base URL | `http://127.0.0.1:8765/v1` |
| Local STT endpoint | `/audio/transcriptions` |
| Use local STT WebSocket streaming (`로컬 STT WebSocket 스트리밍 사용`) | Off |
| Audio chunk in milliseconds (`음성 청크(ms)`) | `14000` |

This setup collects 14-second audio chunks for HTTP transcription. The audio language setting applies to both WebSocket and HTTP transcription. Choose **Automatic detection (`자동 감지`)** for songs with multiple languages.

To start the STT server from the popup, copy the installed extension's ID from `chrome://extensions` and run `npm run stt:native:install -- YOUR_EXTENSION_ID` once with your actual ID. Save the settings, open the popup on the video tab, and click **Start local STT (`로컬 STT 시작`)**. When the server is ready, click **Start audio (`음성 시작`)**.

## Troubleshooting

- For empty translations or reasoning-only output, reload the extension with the current build and check the Gemma model ID and `/chat/completions` endpoint.
- For connection failures, check that the local server is running and that the base URL ends in `/v1`.
- For slow translation, check model reloading and GPU offload.
- For overly literal translations, set **Content mode (`콘텐츠 모드`)** to the mode for the video, such as songs and lyrics or live audio.
