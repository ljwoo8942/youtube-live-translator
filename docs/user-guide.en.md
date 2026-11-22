# YouTube Live Translator: Beginner’s Guide

[한국어](user-guide.ko.md) · [English](user-guide.en.md) · [日本語](user-guide.ja.md) · [Project README](../README.md)

> This is an independent, unofficial Chrome extension. It is not an official service of YouTube or NAVER CHZZK and is not affiliated with or endorsed by either platform.

Start with a YouTube video that has creator-provided captions. You only need a translation API for this first test. For CHZZK or YouTube videos without official captions, follow the audio setup below.

## 1. Install the extension from source

You’ll need [Git](https://git-scm.com/), [Node.js](https://nodejs.org/) 22.18 or later (includes npm), and desktop Google Chrome 116 or later. Use Windows or macOS 14 or later on an Apple Silicon (M-series) Mac. Intel Macs and mobile browsers are not supported.

1. Open PowerShell on Windows or Terminal on macOS. Run:

   ```bash
   git clone https://github.com/ljwoo8942/youtube-live-translator.git
   cd youtube-live-translator
   npm ci
   npm run build
   ```

2. Open `chrome://extensions` in Chrome and turn on **Developer mode (개발자 모드)**.
3. Select **Load unpacked (압축해제된 확장 프로그램을 로드합니다)** and choose the newly generated `dist` folder inside the project. Choose `dist`, not the project folder.
4. Open or refresh a YouTube video tab. Click the puzzle-piece icon in Chrome’s toolbar and open **YouTube Live Translator**. You can pin it for easy access.

## 2. Translate your first YouTube video

1. Choose a video with a caption track uploaded by its creator. In YouTube’s player, turn on **CC** and select the original language track rather than an **auto-generated** or **auto-translated** one.
2. In the extension popup, click **Full settings (전체 설정)**. Under **Basic behavior (기본 동작)**, set **Input mode (입력 방식)** to **Use only the selected official captions (선택한 공식 자막만 사용 - STT/자동 자막 무시)**, and set **Translation provider (번역 provider)** to **AI API**.
3. In the **AI API** section, choose the **API preset (API 프리셋)** that matches your key (for example, **Official OpenAI (OpenAI 공식)**), then click **Apply preset (프리셋 적용)**. For another OpenAI-compatible provider, choose **Enter manually (직접 입력)** and use that provider’s **Base URL**, **Authentication method (인증 방식)**, **Endpoint (엔드포인트)**, and translation **Model (모델)**. Enter your provider’s **API key (API 키)** in this section.
4. Set **Target language (목표 언어)** to the language you want to read; for example, `en` for English, `ko` for Korean, or `ja` for Japanese. Under **Overlay (오버레이)**, turn on **Also show original text (원문도 표시)** if you want both lines. You can also adjust **Font size (글자 크기)** and **Bottom position (하단 위치)**.
5. Click **Test current settings (현재 설정 연결 테스트)** and allow access only to the API server you entered. After it succeeds, click **Save settings (설정 저장)**. The test checks a sample translation, but does not save your settings.
6. Return to the video. Turn on **Enable (켜기)** in the extension popup, click **Save (저장)** if you changed it, then play the video. The translated lines appear over the player. You don’t need to click **Start audio (음성 시작)** in this mode.

## 3. Use audio on CHZZK or YouTube without official captions

CHZZK (치지직) live broadcasts and replays use audio from the playing tab. YouTube can use the same route if there’s no official caption track. Speech-to-text (STT) turns the audio into words first; the translation provider then translates those words.

### Easiest setup: API speech recognition

1. Open **Full settings (전체 설정)** and click **API key audio subtitle preset (API 키로 음성 자막 프리셋)**. It selects API speech recognition and AI API translation and switches the input mode to **Prefer selected official captions, otherwise audio (선택한 공식 자막 우선 + 없으면 음성)**. Choose **Audio only (음성만 - YouTube 자막/자동 번역 무시)** in full settings if you deliberately want to ignore YouTube captions.
2. Check the **AI API** and **API STT** sections before testing. The default STT server is `https://api.openai.com/v1`, using `/audio/transcriptions` and `gpt-4o-mini-transcribe`. Use the key meant for each server. If the two providers differ, enter both matching keys explicitly: the preset can copy the existing key into both fields, and a blank STT key can reuse the translation key.
3. Click **Test API STT + translation (API STT + 번역 연결 테스트)**. If it succeeds, click **Save settings (설정 저장)**. This test does not check Chrome tab capture.
4. Play the actual video or broadcast in its tab (for CHZZK, wait for the main program). In that tab’s extension popup, click **Start audio (음성 시작)** and allow Chrome to capture the tab if prompted. Use **Stop audio (음성 중지)** when finished. On YouTube, starting audio switches the saved input mode to audio only. To go back, select official captions only in full settings and save.

### Optional: local speech recognition

Install [uv](https://docs.astral.sh/uv/getting-started/installation/). From the project folder, run:

```bash
npm run stt:setup
npm run stt:start
```

Leave the terminal open. In full settings, use **Local STT + translation API preset (로컬 STT + 번역 API 프리셋)**, check the translation credentials and selected model, and use **Check local STT connection (로컬 STT 연결 확인)** or **Test local STT + translation (로컬 STT + 번역 연결 테스트)**. Save, then start audio from the video tab as above. The advanced guide covers Whisper and Qwen model preparation, Ollama, and popup server controls. [Advanced guide (Korean)](advanced-guide.ko.md)

For local translation as well as local speech recognition, connect Gemma 4 through LM Studio. The settings guide also gives the Qwen 1.7B and 14-second HTTP setup tested on a fast Japanese song. [LM Studio settings guide](lm-studio-settings.en.md)

## 4. Update and reload

Run these commands in the existing project folder:

```bash
git pull
npm ci
npm run build
```

In `chrome://extensions`, click the extension’s reload icon. Then refresh any open YouTube or CHZZK video tabs as well. If you use local STT, stop the old server, run `npm run stt:setup` again, then restart it with `npm run stt:start`. Back up your song dictionary before an update if you want a copy.

## 5. Back up or edit song corrections

Open **Correction dictionary (교정 사전)** in the popup, or **Song correction dictionary (곡 교정 사전)** in full settings. This is for your own corrections to song lyrics, not for changing YouTube’s captions.

- **Back up:** Click **Export (내보내기)** and keep the JSON file. The library is stored locally in the current Chrome profile. Save your draft first: JSON does not include unsaved edits, the global dictionary switch, or API settings.
- **Restore or move:** Click **Import (가져오기)** and choose a dictionary JSON file. **Confirming a JSON import replaces the entire existing library; it does not merge.** An empty JSON library removes all saved songs. Export the current library first.
- **Start from an SRT or LRC file:** Open **New song (새 곡)** if you want a separate entry, then import the file. It fills or replaces the source lines in the current editor draft, not the saved library. Review the lines, enter **Corrected translation (교정 번역)**, then click **Save (저장)**. If you used the bulk editor, click **Apply bulk edits (일괄 반영)** before saving.

## 6. Quick troubleshooting

| What you see | What to check |
| --- | --- |
| The test passes but captions are missing. | Check that the extension is enabled and the video is playing. In official caption mode, choose a creator-provided track with YouTube’s CC menu. For audio, check the input mode, click **Start audio (음성 시작)** in the playing tab, and allow capture if prompted. |
| The API test returns 401 or 403. | Check the key, server URL, authentication method, and whether your account has access to the chosen model or endpoint. Only send each key to the provider it belongs to. |
| Local STT cannot connect. | Leave the terminal running `npm run stt:start`. In a second terminal, run `npm run stt:health`. The first model download can take time. |
| The old UI remains after an update. | Build again, reload the extension in `chrome://extensions`, and refresh the video tab. |
| The popup’s video controls are disabled. | Open the popup in a supported YouTube or CHZZK video tab, not another website. |

## Privacy and costs

- API keys are entered into the extension’s settings and stored in Chrome’s local extension storage, not in the repository or build files. Do not post or share them.
- Cloud translation sends original captions or recognized text and translation context to the selected provider. Cloud STT also sends chunks of the selected tab’s audio to its provider. Lyrics assistance, if enabled, sends search terms taken from the video title or description to LRCLIB; you can turn it off in full settings.
- Providers can charge for requests, including tests and background caption pre-translation. Local STT keeps speech processing local, but translation still goes to the cloud if you leave AI API selected. Local models may require an initial download.

For advanced configuration and diagnostics, see the [Advanced guide (Korean)](advanced-guide.ko.md).

License: [MIT License](../LICENSE)
