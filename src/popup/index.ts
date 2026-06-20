import { loadSettings } from "../shared/storage";
import type { MessageResponse } from "../shared/messages";
import type { ContentMode, InputMode, SttProvider, TranslationProvider, TranslatorSettings } from "../shared/types";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
let settings: TranslatorSettings;

function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  return chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]);
}

async function persist(patch: Partial<TranslatorSettings>): Promise<void> {
  const response = await chrome.runtime.sendMessage<MessageResponse<{ settings: TranslatorSettings; revision: number }>>({
    type: "SAVE_SETTINGS",
    patch
  });
  if (!response?.ok) {
    throw new Error(response?.error ?? "설정을 저장하지 못했습니다.");
  }
  settings = response.settings;
}

async function stopActiveTabAudio(): Promise<void> {
  const tab = await activeTab();
  await chrome.runtime.sendMessage({ type: "STOP_AUDIO_CAPTURE", tabId: tab?.id }).catch(() => undefined);
}

function setStatus(text: string): void {
  const node = document.querySelector<HTMLDivElement>("#status");
  if (node) {
    node.textContent = text;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runAction(action: () => Promise<void>): void {
  void action().catch((error) => {
    setStatus(getErrorMessage(error));
  });
}

function inputModeLabel(mode: InputMode): string {
  switch (mode) {
    case "audio":
      return "음성만";
    case "captions":
      return "선택한 공식 자막만";
    case "captionsThenAudio":
      return "공식 자막 + 음성";
    default:
      return mode;
  }
}

function contentModeLabel(mode: ContentMode): string {
  switch (mode) {
    case "lyrics":
      return "노래/가사";
    case "live":
      return "라이브/잡음";
    case "spoken":
      return "일반 영상";
    case "auto":
      return "자동";
    default:
      return mode;
  }
}

function translationProviderLabel(provider: TranslationProvider): string {
  switch (provider) {
    case "openai":
      return "AI API";
    case "ollama":
      return "Ollama";
    case "lmStudio":
      return "LM Studio";
    default:
      return provider;
  }
}

function sttProviderLabel(provider: SttProvider): string {
  switch (provider) {
    case "whisper":
      return "로컬 STT";
    case "openai":
      return "API STT";
    case "lmStudio":
      return "LM Studio STT";
    default:
      return provider;
  }
}

function translationModelLabel(settings: TranslatorSettings): string {
  switch (settings.translationProvider) {
    case "openai":
      return settings.openai.model || "AI 모델";
    case "lmStudio":
      return settings.lmStudio.model || "LM Studio 모델";
    case "ollama":
      return settings.ollama.model || "Ollama 모델";
    default:
      return "번역 모델";
  }
}

function setSelectWithCustomOption(select: HTMLSelectElement | null, value: string): void {
  if (!select) {
    return;
  }
  if (value && !Array.from(select.options).some((option) => option.value === value)) {
    select.add(new Option(`직접 저장된 언어 코드 - ${value}`, value));
  }
  select.value = value;
}

function render(): void {
  if (!app) {
    return;
  }

  const isRecommendedFlow = settings.translationProvider === "openai" && settings.sttProvider === "whisper";

  app.innerHTML = `
    <section class="shell">
      <div class="global-nav">
        <span class="brand">YT Translator</span>
        <label class="switch">
          <input id="enabled" type="checkbox" />
          켜기
        </label>
      </div>

      <section class="hero-tile">
        <p class="eyebrow">YouTube Live Translator</p>
        <h1>실시간 자막</h1>
        <p class="tagline">${isRecommendedFlow ? "로컬 STT + 번역 API" : "사용자 지정 흐름"}</p>
      </section>

      <section class="quick-status">
        <div class="status-row">
          <span class="status-dot ${isRecommendedFlow ? "ok" : ""}"></span>
          <strong>${isRecommendedFlow ? "권장 흐름" : "사용자 설정"}</strong>
        </div>
        <div class="status-metrics">
          <span>${inputModeLabel(settings.inputMode)}</span>
          <span>${contentModeLabel(settings.contentMode)}</span>
          <span>${sttProviderLabel(settings.sttProvider)}</span>
          <span>${translationProviderLabel(settings.translationProvider)}</span>
          <span>${translationModelLabel(settings)}</span>
        </div>
      </section>

      <section class="panel">
        <label>
          입력 방식
          <select id="inputMode">
            <option value="captions">선택한 공식 자막만 사용</option>
            <option value="captionsThenAudio">선택한 공식 자막 우선 + 없으면 음성</option>
            <option value="audio">음성만 - YouTube 자막 무시</option>
          </select>
        </label>
        <label>
          콘텐츠 모드
          <select id="contentMode">
            <option value="auto">자동</option>
            <option value="spoken">일반 영상</option>
            <option value="live">라이브/잡음</option>
            <option value="lyrics">노래/가사</option>
          </select>
        </label>
        <label>
          번역 provider
          <select id="translationProvider">
            <option value="openai">AI API</option>
            <option value="ollama">Ollama</option>
            <option value="lmStudio">LM Studio</option>
          </select>
        </label>
        <label>
          STT provider
          <select id="sttProvider">
            <option value="lmStudio">LM Studio STT 먼저 시도</option>
            <option value="whisper">Whisper-compatible</option>
            <option value="openai">OpenAI-compatible</option>
          </select>
        </label>
        <label>
          음성 언어
          <select id="sourceLanguage">
            <option value="auto">자동 감지 - 여러 언어/노래 권장</option>
            <option value="ja">일본어</option>
            <option value="en">영어</option>
            <option value="ko">한국어</option>
            <option value="zh">중국어</option>
            <option value="es">스페인어</option>
            <option value="fr">프랑스어</option>
            <option value="de">독일어</option>
            <option value="it">이탈리아어</option>
            <option value="pt">포르투갈어</option>
            <option value="ru">러시아어</option>
            <option value="th">태국어</option>
            <option value="vi">베트남어</option>
            <option value="id">인도네시아어</option>
          </select>
        </label>
        <label>
          목표 언어
          <input id="targetLanguage" placeholder="ko" />
        </label>
      </section>

      <div class="actions">
        <button id="options" class="primary">전체 설정</button>
        <button id="save">저장</button>
        <button id="startAudio">음성 시작</button>
        <button id="stopAudio">음성 중지</button>
      </div>
      <div id="status" class="status"></div>
    </section>
  `;

  const enabled = document.querySelector<HTMLInputElement>("#enabled");
  const inputMode = document.querySelector<HTMLSelectElement>("#inputMode");
  const contentMode = document.querySelector<HTMLSelectElement>("#contentMode");
  const translationProvider = document.querySelector<HTMLSelectElement>("#translationProvider");
  const sttProvider = document.querySelector<HTMLSelectElement>("#sttProvider");
  const sourceLanguage = document.querySelector<HTMLSelectElement>("#sourceLanguage");
  const targetLanguage = document.querySelector<HTMLInputElement>("#targetLanguage");

  if (enabled) enabled.checked = settings.enabled;
  if (inputMode) inputMode.value = settings.inputMode;
  if (contentMode) contentMode.value = settings.contentMode;
  if (translationProvider) translationProvider.value = settings.translationProvider;
  if (sttProvider) sttProvider.value = settings.sttProvider;
  setSelectWithCustomOption(sourceLanguage, settings.sourceLanguage);
  if (targetLanguage) targetLanguage.value = settings.targetLanguage;

  enabled?.addEventListener("change", () => {
    runAction(async () => {
      await persist({ enabled: enabled.checked });
      if (!settings.enabled) {
        await stopActiveTabAudio();
        setStatus("자막을 껐습니다.");
      } else {
        setStatus("자막을 켰습니다.");
      }
    });
  });

  document.querySelector("#save")?.addEventListener("click", () => {
    runAction(async () => {
      await persist({
        enabled: Boolean(enabled?.checked),
        inputMode: (inputMode?.value ?? settings.inputMode) as InputMode,
        contentMode: (contentMode?.value ?? settings.contentMode) as ContentMode,
        translationProvider: (translationProvider?.value ?? settings.translationProvider) as TranslationProvider,
        sttProvider: (sttProvider?.value ?? settings.sttProvider) as SttProvider,
        sourceLanguage: sourceLanguage?.value || "auto",
        targetLanguage: targetLanguage?.value.trim() || "ko"
      });
      if (!settings.enabled) {
        await stopActiveTabAudio();
      }
      setStatus("저장했습니다.");
    });
  });

  document.querySelector("#options")?.addEventListener("click", () => {
    runAction(async () => {
      await chrome.runtime.openOptionsPage();
    });
  });

  document.querySelector("#startAudio")?.addEventListener("click", () => {
    runAction(async () => {
      await persist({
        enabled: true,
        inputMode: "audio",
        contentMode: (contentMode?.value ?? settings.contentMode) as ContentMode,
        translationProvider: (translationProvider?.value ?? settings.translationProvider) as TranslationProvider,
        sttProvider: (sttProvider?.value ?? settings.sttProvider) as SttProvider,
        sourceLanguage: sourceLanguage?.value || "auto",
        targetLanguage: targetLanguage?.value.trim() || "ko"
      });
      if (enabled) enabled.checked = true;
      if (inputMode) inputMode.value = "audio";

      const tab = await activeTab();
      const response = await chrome.runtime.sendMessage<MessageResponse<{ tabId: number; mode?: string }>>({
        type: "START_AUDIO_CAPTURE",
        tabId: tab?.id
      });
      const mode = response?.ok && response.mode ? ` (${response.mode})` : "";
      setStatus(response?.ok ? `음성 자막을 켜고 시작했습니다${mode}.` : response?.error ?? "음성 인식 시작 응답을 받지 못했습니다.");
    });
  });

  document.querySelector("#stopAudio")?.addEventListener("click", () => {
    runAction(async () => {
      const tab = await activeTab();
      const response = await chrome.runtime.sendMessage<MessageResponse>({ type: "STOP_AUDIO_CAPTURE", tabId: tab?.id });
      setStatus(response?.ok ? "음성 인식을 중지했습니다." : response?.error ?? "음성 인식 중지 응답을 받지 못했습니다.");
    });
  });
}

async function main(): Promise<void> {
  settings = await loadSettings();
  render();
}

void main().catch((error) => {
  if (app) {
    app.textContent = getErrorMessage(error);
  }
});
