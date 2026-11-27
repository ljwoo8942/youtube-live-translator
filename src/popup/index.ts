import { loadSettings } from "../shared/storage";
import { needsLocalSttStart, usesNativeSttEndpoint } from "../shared/localStt";
import type { AudioCaptureStartResponse, AudioCaptureStopResponse, LocalSttServerState, MessageResponse } from "../shared/messages";
import type { ContentMode, InputMode, SttProvider, TranslationProvider, TranslatorSettings } from "../shared/types";
import { getVideoPage } from "../shared/videoSites";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
let settings: TranslatorSettings;
let currentTabId: number | undefined;
let currentTabPage: ReturnType<typeof getVideoPage>;
let needsNativeSttPermission = false;
let correctionEnabled = true;
let correctionCount = 0;
let actionPending = false;
let popupClosing = false;

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

async function ensureTabCapturePermission(requestNativeStt: boolean): Promise<void> {
  const permissions = requestNativeStt ? ["tabCapture", "nativeMessaging"] : ["tabCapture"];
  const granted = await chrome.permissions.request({ permissions });
  if (!granted) {
    throw new Error(requestNativeStt
      ? "음성 자막과 로컬 STT를 시작하려면 Chrome의 탭 캡처 및 로컬 프로그램 연결 권한을 허용하세요."
      : "음성 자막을 사용하려면 영상 탭 캡처 권한을 허용해야 합니다.");
  }
}

type PreparedAudioCapture = {
  tabId: number;
  videoId: string;
};

async function prepareAudioCapture(sttProvider = settings.sttProvider): Promise<PreparedAudioCapture> {
  const tabId = currentTabId;
  const videoId = currentTabPage?.videoId;
  if (!tabId || !videoId) {
    throw new Error("YouTube 또는 치지직 영상 재생 페이지에서 음성 시작을 눌러 주세요.");
  }
  await ensureTabCapturePermission(needsNativeSttPermission && usesNativeSttEndpoint({ ...settings, sttProvider }));
  const tab = await activeTab();
  const page = getVideoPage(tab?.url);
  if (tab?.id !== tabId || page?.videoId !== videoId) {
    throw new Error("영상이 바뀌었습니다. 현재 재생 탭에서 다시 시작하세요.");
  }
  const prepared = await chrome.tabs
    .sendMessage<MessageResponse<{ videoId: string }>>(tabId, { type: "PREPARE_AUDIO_CAPTURE" })
    .catch(() => undefined);
  if (prepared && !prepared.ok) throw new Error(prepared.error);
  if (page.site === "chzzk" && !prepared?.ok) {
    throw new Error("치지직 영상 탭을 새로고침한 뒤 다시 시도하세요.");
  }
  if (prepared?.ok && prepared.videoId !== videoId) {
    throw new Error("영상이 바뀌었습니다. 현재 재생 탭에서 다시 시작하세요.");
  }
  return { tabId, videoId };
}

async function startPreparedAudioCapture(prepared: PreparedAudioCapture): Promise<AudioCaptureStartResponse | undefined> {
  if (usesNativeSttEndpoint(settings)) {
    setStatus("로컬 STT 연결과 음성 자막을 준비하는 중입니다.");
  }
  const response = await chrome.runtime.sendMessage<AudioCaptureStartResponse>({
    type: "START_AUDIO_CAPTURE",
    tabId: prepared.tabId,
    videoId: prepared.videoId,
    ensureTabCapturePermission: true
  });
  if (response?.needsNativeSttPermission) needsNativeSttPermission = true;
  return response;
}

function setStatus(text: string): void {
  const node = document.querySelector<HTMLDivElement>("#status");
  if (node) {
    node.textContent = text;
  }
}

function localSttStatusText(state: LocalSttServerState): string {
  if (state.state === "running") return `로컬 STT 실행 중 · ${state.model} · ${state.device} / ${state.computeType}`;
  if (state.state === "starting") return "로컬 STT 서버를 시작하는 중입니다.";
  return "이 확장에서 실행 중인 로컬 STT 서버가 없습니다.";
}

function closePopupAfterSuccess(): void {
  popupClosing = true;
  window.setTimeout(() => window.close(), 120);
}

async function openCorrectionsPage(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL("corrections.html") });
  closePopupAfterSuccess();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

function runAction(action: () => Promise<void>): void {
  if (actionPending || popupClosing) return;
  actionPending = true;
  const focused = document.activeElement as HTMLElement | null;
  const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button"));
  const disabled = controls.map((control) => control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  app?.setAttribute("aria-busy", "true");
  setStatus("처리 중...");
  void action().catch((error) => {
    setStatus(getErrorMessage(error));
  }).finally(() => {
    actionPending = false;
    app?.setAttribute("aria-busy", "false");
    if (!popupClosing) {
      controls.forEach((control, index) => { control.disabled = disabled[index]; });
      if (focused?.isConnected && document.activeElement === document.body) focused.focus();
    }
    if (document.querySelector("#status")?.textContent === "처리 중...") setStatus("완료했습니다.");
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

function sttModelLabel(settings: TranslatorSettings): string {
  switch (settings.sttProvider) {
    case "whisper":
      return `STT ${settings.whisper.model || "모델"}`;
    case "openai":
      return `STT ${settings.apiStt.model || "API 모델"}`;
    case "lmStudio":
      return `STT ${settings.lmStudio.sttModel || "LM Studio 모델"}`;
    default:
      return "STT 모델";
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

  if (!currentTabPage) {
    app.innerHTML = `
      <section class="shell">
        <div class="global-nav">
          <span class="brand">YT Translator</span>
        </div>
        <section class="hero-tile">
          <h1>YouTube와 치지직 지원</h1>
          <p class="tagline">영상 재생 탭에서 확장 팝업을 열어 주세요.</p>
        </section>
        <div class="actions">
          <button id="options" class="primary">전체 설정</button>
          <button id="corrections">교정 사전</button>
        </div>
        <div id="status" class="status" role="status" aria-live="polite" aria-atomic="true"></div>
      </section>
    `;
    document.querySelector("#options")?.addEventListener("click", () => {
      runAction(async () => {
        await chrome.runtime.openOptionsPage();
      });
    });
    document.querySelector("#corrections")?.addEventListener("click", () => {
      runAction(openCorrectionsPage);
    });
    return;
  }

  const isChzzk = currentTabPage.site === "chzzk";
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
        <p class="eyebrow">${isChzzk ? "치지직" : "YouTube Live Translator"}</p>
        <h1>실시간 자막</h1>
        <p class="tagline">${isRecommendedFlow ? "로컬 STT + 번역 API" : "사용자 지정 흐름"}</p>
      </section>

      <section class="quick-toggles" aria-label="자막 표시 설정">
        <label class="panel-switch">
          <input id="miniControlsEnabled" type="checkbox" />
          <span>영상 미니 컨트롤</span>
        </label>
        <label class="panel-switch">
          <input id="correctionEnabled" type="checkbox" />
          <span>사용자 교정 사전</span>
        </label>
      </section>
      <div class="actions primary-actions">
        <button id="save" class="primary">저장</button>
        <button id="startAudio">음성 시작</button>
        <button id="stopAudio">음성 중지</button>
      </div>
      <div class="actions">
        <button id="options">전체 설정</button>
        <button id="corrections">교정 사전</button>
      </div>
      <div id="status" class="status" role="status" aria-live="polite" aria-atomic="true"></div>

      <section class="quick-status">
        <div class="status-row">
          <span class="status-dot ${isRecommendedFlow ? "ok" : ""}"></span>
          <strong>${isRecommendedFlow ? "권장 흐름" : "사용자 설정"}</strong>
        </div>
        <div class="status-metrics">
          <span>${isChzzk && settings.inputMode !== "captions" ? "탭 음성" : escapeHtml(inputModeLabel(settings.inputMode))}</span>
          <span>${escapeHtml(contentModeLabel(settings.contentMode))}</span>
          <span>${escapeHtml(sttProviderLabel(settings.sttProvider))}</span>
          <span>${escapeHtml(sttModelLabel(settings))}</span>
          <span>${escapeHtml(translationProviderLabel(settings.translationProvider))}</span>
          <span>${escapeHtml(translationModelLabel(settings))}</span>
          <span>교정 ${correctionCount}곡</span>
        </div>
      </section>

      <details class="quick-settings">
        <summary>입력·언어·모델 설정</summary>
        <section class="panel">
        <label>
          입력 방식
          <select id="inputMode">
            <option value="captions">선택한 공식 자막만 사용${isChzzk ? " (YouTube용)" : ""}</option>
            <option value="captionsThenAudio">${isChzzk ? "치지직 탭 음성 (YouTube는 자막 우선)" : "선택한 공식 자막 우선 + 없으면 음성"}</option>
            <option value="audio">음성만 - 탭 음성 인식</option>
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
            <option value="whisper">로컬 STT (Whisper / Qwen)</option>
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
      </details>
    </section>
  `;

  const enabled = document.querySelector<HTMLInputElement>("#enabled");
  const inputMode = document.querySelector<HTMLSelectElement>("#inputMode");
  const contentMode = document.querySelector<HTMLSelectElement>("#contentMode");
  const translationProvider = document.querySelector<HTMLSelectElement>("#translationProvider");
  const sttProvider = document.querySelector<HTMLSelectElement>("#sttProvider");
  const sourceLanguage = document.querySelector<HTMLSelectElement>("#sourceLanguage");
  const targetLanguage = document.querySelector<HTMLInputElement>("#targetLanguage");
  const miniControlsEnabled = document.querySelector<HTMLInputElement>("#miniControlsEnabled");
  const correctionToggle = document.querySelector<HTMLInputElement>("#correctionEnabled");

  if (enabled) enabled.checked = settings.enabled;
  if (inputMode) inputMode.value = settings.inputMode;
  if (contentMode) contentMode.value = settings.contentMode;
  if (translationProvider) translationProvider.value = settings.translationProvider;
  if (sttProvider) sttProvider.value = settings.sttProvider;
  setSelectWithCustomOption(sourceLanguage, settings.sourceLanguage);
  if (targetLanguage) targetLanguage.value = settings.targetLanguage;
  if (miniControlsEnabled) miniControlsEnabled.checked = settings.miniControlsEnabled;
  if (correctionToggle) correctionToggle.checked = correctionEnabled;

  enabled?.addEventListener("change", () => {
    runAction(async () => {
      if (!enabled.checked) {
        await persist({ enabled: false });
        setStatus("자막을 껐습니다.");
        closePopupAfterSuccess();
        return;
      }
      if (inputMode?.value === "audio" || (isChzzk && settings.inputMode === "captionsThenAudio" && currentTabPage?.videoId)) {
        const prepared = await prepareAudioCapture();
        await persist({ enabled: true });
        const response = await startPreparedAudioCapture(prepared);
        const mode = response?.ok && response.mode ? ` (${response.mode})` : "";
        setStatus(response?.ok ? `자막을 켜고 음성 인식을 준비했습니다${mode}.` : response?.error ?? "음성 인식을 준비하지 못했습니다.");
        if (response?.ok) {
          closePopupAfterSuccess();
        }
        return;
      }
      await persist({ enabled: true });
      setStatus("자막을 켰습니다.");
      closePopupAfterSuccess();
    });
  });

  miniControlsEnabled?.addEventListener("change", () => {
    runAction(async () => {
      await persist({ miniControlsEnabled: miniControlsEnabled.checked });
      setStatus(miniControlsEnabled.checked ? "영상 미니 컨트롤을 표시합니다." : "영상 미니 컨트롤을 숨겼습니다.");
      closePopupAfterSuccess();
    });
  });

  correctionToggle?.addEventListener("change", () => {
    runAction(async () => {
      const response = await chrome.runtime.sendMessage<MessageResponse<{ enabled: boolean }>>({
        type: "SET_CORRECTION_ENABLED",
        enabled: correctionToggle.checked
      });
      if (!response?.ok) {
        throw new Error(response?.error ?? "교정 설정을 저장하지 못했습니다.");
      }
      correctionEnabled = response.enabled;
      setStatus(correctionEnabled ? "사용자 교정을 적용합니다." : "사용자 교정을 사용하지 않습니다.");
      closePopupAfterSuccess();
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
        targetLanguage: targetLanguage?.value.trim() || "ko",
        miniControlsEnabled: Boolean(miniControlsEnabled?.checked)
      });
      setStatus("저장했습니다.");
      closePopupAfterSuccess();
    });
  });

  document.querySelector("#options")?.addEventListener("click", () => {
    runAction(async () => {
      await chrome.runtime.openOptionsPage();
    });
  });

  document.querySelector("#startAudio")?.addEventListener("click", () => {
    runAction(async () => {
      const selectedSttProvider = (sttProvider?.value ?? settings.sttProvider) as SttProvider;
      const prepared = await prepareAudioCapture(selectedSttProvider);
      const captureInputMode = isChzzk && settings.inputMode === "captionsThenAudio" ? "captionsThenAudio" : "audio";
      await persist({
        enabled: true,
        inputMode: captureInputMode,
        contentMode: (contentMode?.value ?? settings.contentMode) as ContentMode,
        translationProvider: (translationProvider?.value ?? settings.translationProvider) as TranslationProvider,
        sttProvider: selectedSttProvider,
        sourceLanguage: sourceLanguage?.value || "auto",
        targetLanguage: targetLanguage?.value.trim() || "ko"
      });
      if (enabled) enabled.checked = true;
      if (inputMode) inputMode.value = captureInputMode;

      const response = await startPreparedAudioCapture(prepared);
      const mode = response?.ok && response.mode ? ` (${response.mode})` : "";
      setStatus(response?.ok ? `음성 자막을 켜고 시작했습니다${mode}.` : response?.error ?? "음성 인식 시작 응답을 받지 못했습니다.");
      if (response?.ok) {
        closePopupAfterSuccess();
      }
    });
  });

  document.querySelector("#stopAudio")?.addEventListener("click", () => {
    runAction(async () => {
      const tab = await activeTab();
      const tabId = tab?.id;
      const page = getVideoPage(tab?.url);
      if (!tabId || tabId !== currentTabId || !page || page.site !== currentTabPage?.site || page.videoId !== currentTabPage?.videoId) {
        throw new Error("탭이나 영상이 바뀌었습니다. 현재 탭에서 팝업을 다시 열어 주세요.");
      }

      const videoId = page.videoId;
      const prepared = videoId
        ? await chrome.tabs
            .sendMessage<MessageResponse<{ videoId: string }>>(tabId, { type: "PREPARE_AUDIO_STOP" })
            .catch(() => undefined)
        : undefined;
      if (prepared?.ok && prepared.videoId !== videoId) {
        throw new Error("영상이 바뀌었습니다. 현재 탭에서 팝업을 다시 열어 주세요.");
      }

      const response = await chrome.runtime.sendMessage<AudioCaptureStopResponse>({
        type: "STOP_AUDIO_CAPTURE",
        tabId,
        videoId
      });
      if (!response?.ok) {
        throw new Error(response?.error ?? "음성 인식 중지 응답을 받지 못했습니다.");
      }
      setStatus(response.localSttStopped ? "음성 인식과 로컬 STT 서버를 중지했습니다." : "음성 인식을 중지했습니다.");
      closePopupAfterSuccess();
    });
  });

  document.querySelector("#corrections")?.addEventListener("click", () => {
    runAction(openCorrectionsPage);
  });
}

async function main(): Promise<void> {
  const [tab, loadedSettings, correctionStatus] = await Promise.all([
    activeTab(),
    loadSettings(),
    chrome.runtime.sendMessage<MessageResponse<{ enabled: boolean; count: number }>>({
      type: "GET_CORRECTION_STATUS"
    })
  ]);
  currentTabId = tab?.id;
  currentTabPage = getVideoPage(tab?.url);
  settings = loadedSettings;
  if (currentTabPage?.videoId && usesNativeSttEndpoint(settings) &&
      !(await chrome.permissions.contains({ permissions: ["nativeMessaging"] }))) {
    needsNativeSttPermission = await needsLocalSttStart(settings);
  }
  if (correctionStatus?.ok) {
    correctionEnabled = correctionStatus.enabled;
    correctionCount = correctionStatus.count;
  }
  render();
  if (currentTabPage) {
    void chrome.runtime.sendMessage<MessageResponse<LocalSttServerState>>({ type: "LOCAL_STT_SERVER", action: "status" })
      .then((response) => {
        if (!actionPending && !popupClosing && response?.ok && response.state !== "stopped" &&
            !document.querySelector("#status")?.textContent) {
          setStatus(localSttStatusText(response));
        }
      })
      .catch(() => undefined);
  }
}

void main().catch((error) => {
  if (app) {
    app.textContent = getErrorMessage(error);
  }
});
