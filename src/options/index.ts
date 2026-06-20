import { DEFAULT_SETTINGS } from "../shared/defaults";
import { diffSettings, loadSettings } from "../shared/storage";
import type {
  ApiAuthHeaderMode,
  AiEndpointMode,
  ContentMode,
  InputMode,
  SttProvider,
  TranslationProvider,
  TranslatorSettings
} from "../shared/types";
import type { MessageResponse } from "../shared/messages";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
const MINDLOGIC_GATEWAY_BASE_URL = "https://factchat-cloud.mindlogic.ai/v1/gateway";
const MINDLOGIC_GATEWAY_DEFAULT_MODEL = "claude-sonnet-4-6";
const LOCAL_STT_BASE_URL = "http://127.0.0.1:8765/v1";
const LOCAL_STT_MODEL = "small";
const LOCAL_STT_START_HINT = "별도 터미널에서 npm run stt:start를 실행하고 그 창을 닫지 않은 채 다시 테스트하세요.";
const PREFERRED_LM_STUDIO_MODEL_PATTERNS = [/^google\/gemma-4-e2b$/i, /gemma[-_/]?4[-_/]?e2b/i, /e2b/i, /gemma/i];
const PREFERRED_GATEWAY_MODEL_PATTERNS = [/mini/i, /flash/i, /sonnet/i, /gpt/i, /gemini/i, /claude/i, /llama/i, /grok/i, /sonar/i];
const AI_GATEWAY_PRESETS = {
  mindlogic: {
    baseUrl: MINDLOGIC_GATEWAY_BASE_URL,
    model: MINDLOGIC_GATEWAY_DEFAULT_MODEL,
    endpointMode: "chat" as AiEndpointMode,
    authHeaderMode: "bearer" as ApiAuthHeaderMode,
    label: "Mindlogic Gateway"
  },
  openai: {
    baseUrl: DEFAULT_SETTINGS.openai.baseUrl,
    model: DEFAULT_SETTINGS.openai.model,
    endpointMode: DEFAULT_SETTINGS.openai.endpointMode,
    authHeaderMode: DEFAULT_SETTINGS.openai.authHeaderMode,
    label: "OpenAI"
  }
};
let settings: TranslatorSettings;
type JsonObject = Record<string, unknown>;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimTrailingSlash(baseUrl)}${normalizedPath}`;
}

function normalizeOpenAiBaseUrl(baseUrl: string): string {
  const trimmed = trimTrailingSlash(baseUrl);
  try {
    const url = new URL(trimmed);
    url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses|models|audio\/transcriptions)$/i, "");
    if (isLocalUrl(url) && /\/api\/v\d+(?:\/chat)?$/i.test(url.pathname)) {
      url.pathname = "/v1";
    }
    if (!/(^|\/)v\d+(\/|$)/.test(url.pathname)) {
      url.pathname = `${trimTrailingSlash(url.pathname)}/v1`;
    }
    url.search = "";
    url.hash = "";
    return trimTrailingSlash(url.toString());
  } catch {
    return trimmed;
  }
}

function joinOpenAiUrl(baseUrl: string, path: string): string {
  return joinUrl(normalizeOpenAiBaseUrl(baseUrl), path);
}

function isLocalUrl(url: URL): boolean {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return ["127.0.0.1", "localhost", "::1"].includes(hostname);
}

function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    return isLocalUrl(new URL(normalizeOpenAiBaseUrl(baseUrl)));
  } catch {
    return false;
  }
}

function lmStudioNativeBaseUrl(baseUrl: string): string {
  const normalized = normalizeOpenAiBaseUrl(baseUrl);
  try {
    const url = new URL(normalized);
    url.pathname = "/api/v1";
    url.search = "";
    url.hash = "";
    return trimTrailingSlash(url.toString());
  } catch {
    return normalized.replace(/\/v\d+$/i, "/api/v1");
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function extractModelIds(json: JsonObject, loadedOnly = false): string[] {
  const ids: string[] = [];
  if (!loadedOnly && Array.isArray(json.data)) {
    for (const model of json.data as JsonObject[]) {
      if (typeof model.id === "string") {
        ids.push(model.id);
      }
    }
  }

  if (Array.isArray(json.models)) {
    for (const model of json.models as JsonObject[]) {
      const loadedInstances = model.loaded_instances;
      if (Array.isArray(loadedInstances)) {
        for (const instance of loadedInstances as JsonObject[]) {
          if (typeof instance.id === "string") {
            ids.push(instance.id);
          }
        }
      }
      if (!loadedOnly && typeof model.key === "string") {
        ids.push(model.key);
      }
    }
  }

  return uniqueStrings(ids);
}

function isEmbeddingModel(model: string): boolean {
  return /(^|[-_])embed|embedding/i.test(model);
}

function preferTranslationModel(models: string[], fallback: string): string {
  const fallbackTrimmed = fallback.trim();
  const candidates = uniqueStrings(models).filter((model) => !isEmbeddingModel(model));
  if (
    fallbackTrimmed &&
    !/^(local-model|model|your-model|local-llm)$/i.test(fallbackTrimmed) &&
    !isEmbeddingModel(fallbackTrimmed) &&
    (candidates.length === 0 || candidates.some((model) => model.toLowerCase() === fallbackTrimmed.toLowerCase()))
  ) {
    return fallbackTrimmed;
  }

  for (const pattern of PREFERRED_LM_STUDIO_MODEL_PATTERNS) {
    const preferred = candidates.find((model) => pattern.test(model));
    if (preferred) {
      return preferred;
    }
  }

  return candidates.find((model) => /:\d+$/.test(model)) ?? candidates[0] ?? fallbackTrimmed;
}

function preferGatewayModel(models: string[], fallback: string): string {
  const fallbackTrimmed = fallback.trim();
  const candidates = uniqueStrings(models).filter((model) => !isEmbeddingModel(model));
  if (fallbackTrimmed && candidates.some((model) => model.toLowerCase() === fallbackTrimmed.toLowerCase())) {
    return fallbackTrimmed;
  }

  for (const pattern of PREFERRED_GATEWAY_MODEL_PATTERNS) {
    const preferred = candidates.find((model) => pattern.test(model));
    if (preferred) {
      return preferred;
    }
  }

  return candidates[0] ?? fallbackTrimmed;
}

function modelFamilyLabel(model: string): string {
  if (/gpt|^o\d/i.test(model)) {
    return "GPT";
  }
  if (/claude|sonnet|opus|haiku/i.test(model)) {
    return "Claude";
  }
  if (/gemini|gemma/i.test(model)) {
    return "Google";
  }
  if (/grok|xai/i.test(model)) {
    return "xAI";
  }
  if (/perplexity|sonar/i.test(model)) {
    return "Perplexity";
  }
  if (/llama|mistral|qwen|deepseek/i.test(model)) {
    return "Open Model";
  }
  return "Model";
}

function optionTextForModel(model: string): string {
  return `${modelFamilyLabel(model)} · ${model}`;
}

function currentAiGatewayPreset(baseUrl: string): "mindlogic" | "openai" | "custom" {
  const normalized = normalizeOpenAiBaseUrl(baseUrl);
  if (normalized === normalizeOpenAiBaseUrl(AI_GATEWAY_PRESETS.mindlogic.baseUrl)) {
    return "mindlogic";
  }
  if (normalized === normalizeOpenAiBaseUrl(AI_GATEWAY_PRESETS.openai.baseUrl)) {
    return "openai";
  }
  return "custom";
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localFetchErrorMessage(error: unknown, target: string, hint: string): string {
  const message = getErrorMessage(error);
  if (/failed to fetch|fetch failed|networkerror|load failed/i.test(message)) {
    return `${target}에 연결하지 못했습니다. 서버가 켜져 있고 Base URL이 맞는지 확인하세요. ${hint}`;
  }
  return `${target} 요청 실패: ${message}`;
}

function formatLocalSttHealthStatus(health: JsonObject): string {
  const error = typeof health.error === "string" ? health.error : "상태를 확인하세요.";
  const hint = typeof health.hint === "string" ? health.hint : "";
  const model = typeof health.model === "string" ? health.model : "";
  const cachedModels = Array.isArray(health.cached_models)
    ? (health.cached_models as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const prefix = model ? `모델 ${model}: ` : "";
  const suffix = hint || (cachedModels.length > 0 ? `캐시된 모델: ${cachedModels.join(", ")}.` : "");
  return `${prefix}${error}${suffix ? ` ${suffix}` : ""}`;
}

function authHeaders(apiKey: string, mode: ApiAuthHeaderMode): HeadersInit {
  if (!apiKey || mode === "none") {
    return {};
  }
  if (mode === "xApiKey") {
    return { "x-api-key": apiKey };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function apiSttModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed || /^(tiny|base|small|medium|large|large-v\d+(?:-turbo)?|distil-.+)$/i.test(trimmed)) {
    return "whisper-1";
  }
  return trimmed;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function apiHttpErrorMessage(response: Response, text: string): string {
  const statusHint =
    response.status === 401 || response.status === 403
      ? "API 키 또는 권한을 확인하세요"
      : response.status === 429
        ? "요청 한도 또는 quota를 확인하세요"
        : `HTTP ${response.status}`;
  try {
    const json = text ? (JSON.parse(text) as JsonObject) : {};
    const error = json.error;
    if (typeof error === "object" && error && "message" in error) {
      return `${statusHint}: ${String((error as { message: unknown }).message)}`;
    }
    if (typeof error === "string") {
      return `${statusHint}: ${error}`;
    }
    if (typeof json.detail === "string") {
      return `${statusHint}: ${json.detail}`;
    }
  } catch {
    // Fall through to the raw response snippet below.
  }
  return `${statusHint}: ${text.slice(0, 180)}`;
}

async function fetchText(
  url: string,
  init: RequestInit | undefined,
  target: string,
  hint: string
): Promise<{ response: Response; text: string }> {
  try {
    const response = await fetch(url, init);
    return { response, text: await response.text() };
  } catch (error) {
    throw new Error(localFetchErrorMessage(error, target, hint));
  }
}

async function readModelIds(
  url: string,
  loadedOnly = false,
  init?: RequestInit,
  target = "LM Studio 로컬 서버"
): Promise<string[]> {
  const { response, text } = await fetchText(
    url,
    init,
    target,
    "LM Studio의 Developer > Local Server가 Running인지 확인하세요."
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${text.slice(0, 160)}`);
  }
  const json = text ? (JSON.parse(text) as JsonObject) : {};
  if (json.error) {
    throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error));
  }
  return extractModelIds(json, loadedOnly);
}

async function readAiGatewayModelIds(): Promise<string[]> {
  const baseUrl = normalizeOpenAiBaseUrl(inputValue("openaiBaseUrl", DEFAULT_SETTINGS.openai.baseUrl));
  const authHeaderMode = selectValue<ApiAuthHeaderMode>("openaiAuthHeaderMode");
  const apiKey = inputValue("openaiApiKey") || inputValue("apiSttApiKey");
  setInput("openaiBaseUrl", baseUrl);

  if (!apiKey && authHeaderMode !== "none") {
    throw new Error("AI API 키가 없어 모델 목록을 불러올 수 없습니다. 멀티모델 게이트웨이 키를 먼저 입력하세요.");
  }

  const { response, text } = await fetchText(
    joinOpenAiUrl(baseUrl, "/models"),
    {
      method: "GET",
      headers: authHeaders(apiKey, authHeaderMode)
    },
    "AI API 모델 목록",
    "Base URL, 인증 방식, API 키 권한을 확인하세요."
  );

  if (!response.ok) {
    throw new Error(`AI API 모델 목록 실패: ${apiHttpErrorMessage(response, text)}`);
  }

  const json = text ? (JSON.parse(text) as JsonObject) : {};
  if (json.error) {
    throw new Error(`AI API 모델 목록 실패: ${typeof json.error === "string" ? json.error : JSON.stringify(json.error).slice(0, 180)}`);
  }

  return uniqueStrings(extractModelIds(json).filter((model) => !isEmbeddingModel(model)));
}

async function readLmStudioModelIds(): Promise<string[]> {
  const baseUrl = normalizeOpenAiBaseUrl(inputValue("lmStudioBaseUrl", DEFAULT_SETTINGS.lmStudio.baseUrl));
  const apiKey = inputValue("lmStudioApiKey");
  const authHeaderMode = selectValue<ApiAuthHeaderMode>("lmStudioAuthHeaderMode");
  const init = {
    method: "GET",
    headers: authHeaders(apiKey, authHeaderMode)
  };
  setInput("lmStudioBaseUrl", baseUrl);

  const nativeResult = await Promise.allSettled([
    readModelIds(joinUrl(lmStudioNativeBaseUrl(baseUrl), "/models"), true, init, "LM Studio 네이티브 모델 목록")
  ]);
  const nativeModels = uniqueStrings(nativeResult.flatMap((result) => (result.status === "fulfilled" ? result.value : [])));
  const openAiResults =
    nativeModels.length > 0
      ? []
      : await Promise.allSettled([readModelIds(joinOpenAiUrl(baseUrl, "/models"), false, init, "LM Studio OpenAI-compatible 모델 목록")]);
  const models = nativeModels.length > 0 ? nativeModels : uniqueStrings(openAiResults.flatMap((result) => (result.status === "fulfilled" ? result.value : [])));

  if (models.length === 0) {
    const errors = [...nativeResult, ...openAiResults]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
    throw new Error(errors.length ? `LM Studio 모델 목록 실패: ${errors.join(" / ")}` : "LM Studio는 응답했지만 로드된 LLM 모델을 찾지 못했습니다.");
  }

  return uniqueStrings(models.filter((model) => !isEmbeddingModel(model)));
}

function populateOpenAiModelPicker(models: string[], selectedModel: string): void {
  const picker = byId<HTMLSelectElement>("openaiModelPicker");
  picker.replaceChildren();

  if (models.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "모델 목록이 비어 있습니다";
    picker.append(option);
    return;
  }

  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = optionTextForModel(model);
    picker.append(option);
  }
  picker.value = selectedModel && models.includes(selectedModel) ? selectedModel : models[0];
}

function populateLmStudioModelPicker(models: string[], selectedModel: string): void {
  const picker = byId<HTMLSelectElement>("lmStudioModelPicker");
  picker.replaceChildren();

  if (models.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "모델 목록이 비어 있습니다";
    picker.append(option);
    return;
  }

  for (const model of models) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = optionTextForModel(model);
    picker.append(option);
  }
  picker.value = selectedModel && models.includes(selectedModel) ? selectedModel : models[0];
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

function inputValue(id: string, fallback = ""): string {
  return byId<HTMLInputElement | HTMLSelectElement>(id).value.trim() || fallback;
}

function rawInputValue(id: string): string {
  return byId<HTMLInputElement>(id).value.trim();
}

function selectValue<T extends string>(id: string): T {
  return byId<HTMLSelectElement>(id).value as T;
}

function checkboxValue(id: string): boolean {
  return byId<HTMLInputElement>(id).checked;
}

function numberValue(id: string, fallback: number): number {
  const value = Number(byId<HTMLInputElement>(id).value);
  return Number.isFinite(value) ? value : fallback;
}

function setStatus(text: string): void {
  byId<HTMLDivElement>("status").textContent = text;
}

function runAction(action: () => Promise<void>): void {
  void action().catch((error) => {
    setStatus(getErrorMessage(error));
  });
}

function setInput(id: string, value: string | number | boolean): void {
  const element = byId<HTMLInputElement | HTMLSelectElement>(id);
  if (element instanceof HTMLInputElement && element.type === "checkbox") {
    element.checked = Boolean(value);
  } else {
    element.value = String(value);
  }
}

function setSelectWithCustomOption(id: string, value: string): void {
  const select = byId<HTMLSelectElement>(id);
  if (value && !Array.from(select.options).some((option) => option.value === value)) {
    select.add(new Option(`직접 저장된 언어 코드 - ${value}`, value));
  }
  select.value = value;
}

function ensureAiApiTranslationDefaults(): void {
  if (!rawInputValue("openaiBaseUrl")) {
    setInput("openaiBaseUrl", DEFAULT_SETTINGS.openai.baseUrl);
  }
  if (!rawInputValue("openaiModel")) {
    setInput("openaiModel", DEFAULT_SETTINGS.openai.model);
    populateOpenAiModelPicker([DEFAULT_SETTINGS.openai.model], DEFAULT_SETTINGS.openai.model);
  }
}

function render(): void {
  if (!app) {
    return;
  }

  app.innerHTML = `
    <section class="shell">
      <header class="global-nav">
        <div class="brand">YouTube Live Translator</div>
        <label class="check nav-toggle">
          <input id="enabled" type="checkbox" />
          <span>확장프로그램 켜기</span>
        </label>
      </header>

      <section class="hero-tile">
        <p class="eyebrow">Recommended Flow</p>
        <h1>로컬 STT + 번역 API</h1>
        <p class="muted">faster-whisper로 음성을 인식하고 AI API로 번역합니다.</p>
        <div class="hero-actions">
          <button id="heroLocalPreset" class="primary" type="button">로컬 STT 프리셋</button>
          <button id="heroLivePreset" type="button">라이브 STT 프리셋</button>
          <button id="heroLyricsPreset" type="button">노래 STT 프리셋</button>
          <button id="heroPipelineTest" type="button">전체 테스트</button>
        </div>
      </section>

      <section class="workflow-strip" aria-label="현재 권장 흐름">
        <div class="flow-step">
          <span class="flow-index">1</span>
          <strong>탭 오디오</strong>
          <span>YouTube</span>
        </div>
        <div class="flow-step">
          <span class="flow-index">2</span>
          <strong>로컬 STT</strong>
          <span>faster-whisper small</span>
        </div>
        <div class="flow-step">
          <span class="flow-index">3</span>
          <strong>번역 API</strong>
          <span>AI API</span>
        </div>
        <div class="flow-step">
          <span class="flow-index">4</span>
          <strong>오버레이</strong>
          <span>실시간 자막</span>
        </div>
      </section>

      <section class="grid">
        <section class="section">
          <h2>기본 동작</h2>
          <div class="fields">
            <label>
              입력 방식
              <select id="inputMode">
                <option value="captions">선택한 공식 자막만 사용 - STT/자동 자막 무시</option>
                <option value="captionsThenAudio">선택한 공식 자막 우선 + 없으면 음성</option>
                <option value="audio">음성만 - YouTube 자막/자동 번역 무시</option>
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
            <label class="check">
              <input id="pretranslateEnabled" type="checkbox" />
              <span>선택한 공식 자막 선번역 + 캐시</span>
            </label>
            <label class="check">
              <input id="miniControlsEnabled" type="checkbox" />
              <span>YouTube 화면 미니 컨트롤 표시</span>
            </label>
            <label class="check">
              <input id="streamingSttEnabled" type="checkbox" />
              <span>로컬 STT WebSocket 스트리밍 사용</span>
            </label>
            <label class="check">
              <input id="speakerTurnDetection" type="checkbox" />
              <span>다화자 발화 분리 - 화자 이름은 추정하지 않고 발화 경계를 줄별로 유지</span>
            </label>
            <label>
              스트리밍 STT WebSocket
              <input id="streamingSttEndpoint" placeholder="ws://127.0.0.1:8765/v1/audio/stream" />
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
              <span class="hint">단일 언어 방송은 해당 언어를 고르면 STT가 더 안정적이고, 일본어+영어처럼 섞인 노래는 자동 감지를 권장합니다.</span>
            </label>
            <label>
              목표 언어
              <input id="targetLanguage" placeholder="ko" />
            </label>
            <label>
              STT provider
              <select id="sttProvider">
                <option value="lmStudio">LM Studio STT 먼저 시도</option>
                <option value="whisper">Whisper-compatible</option>
                <option value="openai">OpenAI-compatible</option>
              </select>
              <span class="hint">자막 없는 영상은 STT도 필요합니다. API 키로 음성 인식까지 쓰려면 OpenAI-compatible을 선택하세요.</span>
            </label>
            <label>
              자막 지연 보정(ms)
              <input id="latencyOffsetMs" type="number" step="100" />
            </label>
            <label>
              음성 청크(ms)
              <input id="audioChunkMs" type="number" min="1000" max="15000" step="500" />
            </label>
          </div>
        </section>

        <section class="section">
          <h2>오버레이</h2>
          <div class="fields">
            <label>
              글자 크기 <span id="fontSizeOut" class="hint"></span>
              <input id="fontSize" type="range" min="14" max="42" step="1" />
            </label>
            <label>
              하단 위치 <span id="bottomOffsetOut" class="hint"></span>
              <input id="bottomOffset" type="range" min="32" max="180" step="2" />
            </label>
            <label>
              최대 너비 <span id="maxWidthOut" class="hint"></span>
              <input id="maxWidth" type="range" min="42" max="96" step="1" />
            </label>
            <label>
              배경 투명도 <span id="backgroundOpacityOut" class="hint"></span>
              <input id="backgroundOpacity" type="range" min="0" max="1" step="0.05" />
            </label>
            <label class="check">
              <input id="showSourceText" type="checkbox" />
              <span>원문도 표시</span>
            </label>
          </div>
        </section>

        <section class="section provider-section">
          <div class="section-head">
            <h2>AI API</h2>
            <span class="hint">하나의 게이트웨이 키로 GPT, Claude, Gemini 등 사용 가능한 모델을 선택합니다.</span>
          </div>
          <div class="gateway-summary">
            <div>
              <span>권장</span>
              <strong>멀티모델 Gateway</strong>
            </div>
            <div>
              <span>모델 선택</span>
              <strong>/models 자동 조회</strong>
            </div>
          </div>
          <div class="fields">
            <label>
              API 프리셋
              <select id="openaiGatewayPreset">
                <option value="mindlogic">Mindlogic Gateway</option>
                <option value="openai">OpenAI 공식</option>
                <option value="custom">직접 입력</option>
              </select>
            </label>
            <label>
              Base URL
              <input id="openaiBaseUrl" placeholder="https://api.openai.com/v1" />
            </label>
            <label>
              API 키
              <input id="openaiApiKey" type="password" autocomplete="off" />
            </label>
            <label>
              모델
              <input id="openaiModel" placeholder="gpt-4o-mini" />
            </label>
            <label>
              불러온 모델
              <select id="openaiModelPicker">
                <option value="">모델 목록을 불러오세요</option>
              </select>
            </label>
            <label>
              인증 방식
              <select id="openaiAuthHeaderMode">
                <option value="bearer">Authorization: Bearer</option>
                <option value="xApiKey">x-api-key</option>
                <option value="none">인증 헤더 없음</option>
              </select>
            </label>
            <label>
              엔드포인트
              <select id="openaiEndpointMode">
                <option value="chat">/chat/completions</option>
                <option value="responses">/responses</option>
              </select>
            </label>
          </div>
          <div class="actions">
            <button id="applyAiGatewayPreset" type="button">프리셋 적용</button>
            <button id="loadOpenAiModels" type="button">모델 목록 불러오기</button>
            <button id="mindlogicPreset" type="button">Mindlogic Gateway 프리셋</button>
          </div>
          <span class="hint">Mindlogic Gateway Base URL은 ${MINDLOGIC_GATEWAY_BASE_URL} 이며, Bearer와 x-api-key 인증을 모두 지원합니다. GPT 모델도 목록에 있으면 그대로 선택할 수 있습니다.</span>
        </section>

        <section class="section">
          <h2>API STT</h2>
          <div class="fields">
            <label>
              Base URL
              <input id="apiSttBaseUrl" placeholder="https://api.openai.com/v1" />
            </label>
            <label>
              API 키
              <input id="apiSttApiKey" type="password" autocomplete="off" />
              <span class="hint">비워두면 AI API 키를 음성 인식에도 사용합니다.</span>
            </label>
            <label>
              모델
              <input id="apiSttModel" placeholder="gpt-4o-mini-transcribe" />
            </label>
            <label>
              인증 방식
              <select id="apiSttAuthHeaderMode">
                <option value="bearer">Authorization: Bearer</option>
                <option value="xApiKey">x-api-key</option>
                <option value="none">인증 헤더 없음</option>
              </select>
            </label>
            <label>
              엔드포인트
              <input id="apiSttEndpoint" placeholder="/audio/transcriptions" />
            </label>
          </div>
          <div class="actions">
            <button id="apiKeyAudioPreset" type="button">API 키로 음성 자막 프리셋</button>
            <button id="apiSttTest" type="button">API STT 연결 테스트</button>
            <button id="apiPipelineTest" type="button">API STT + 번역 테스트</button>
          </div>
          <span class="hint">YouTube 자체 자막이 없을 때 탭 음성을 API STT로 인식하고, AI API 번역 자막으로 표시합니다.</span>
        </section>

        <section class="section">
          <h2>Ollama</h2>
          <div class="fields">
            <label>
              Base URL
              <input id="ollamaBaseUrl" placeholder="http://localhost:11434" />
            </label>
            <label>
              모델
              <input id="ollamaModel" placeholder="llama3.1" />
            </label>
          </div>
        </section>

        <section class="section provider-section">
          <div class="section-head">
            <h2>LM Studio</h2>
            <span class="hint">로컬 서버도 AI API와 같은 OpenAI-compatible 방식으로 모델을 선택하고 호출합니다.</span>
          </div>
          <div class="gateway-summary">
            <div>
              <span>기본 주소</span>
              <strong>http://127.0.0.1:1234/v1</strong>
            </div>
            <div>
              <span>모델 선택</span>
              <strong>로드된 모델 조회</strong>
            </div>
          </div>
          <div class="fields">
            <label>
              Base URL
              <input id="lmStudioBaseUrl" placeholder="http://127.0.0.1:1234/v1" />
            </label>
            <label>
              API 토큰
              <input id="lmStudioApiKey" type="password" autocomplete="off" />
            </label>
            <label>
              번역 모델
              <input id="lmStudioModel" placeholder="local-model" />
            </label>
            <label>
              불러온 모델
              <select id="lmStudioModelPicker">
                <option value="">모델 목록을 불러오세요</option>
              </select>
            </label>
            <label>
              엔드포인트
              <select id="lmStudioEndpointMode">
                <option value="chat">/chat/completions</option>
                <option value="responses">/responses</option>
              </select>
            </label>
            <label>
              인증 방식
              <select id="lmStudioAuthHeaderMode">
                <option value="bearer">Authorization: Bearer</option>
                <option value="xApiKey">x-api-key</option>
                <option value="none">인증 헤더 없음</option>
              </select>
            </label>
            <label class="check">
              <input id="lmStudioTryStt" type="checkbox" />
              <span>LM Studio STT 먼저 시도</span>
            </label>
            <label>
              STT 모델
              <input id="lmStudioSttModel" placeholder="whisper-1" />
            </label>
            <label>
              STT 엔드포인트
              <input id="lmStudioSttEndpoint" placeholder="/audio/transcriptions" />
            </label>
          </div>
          <div class="actions">
            <button id="loadLmStudioModels" type="button">모델 목록 불러오기</button>
            <button id="lmStudioProbe" type="button">LM Studio 번역 테스트</button>
          </div>
          <span class="hint">모델 목록을 불러와도 입력한 번역 모델은 자동으로 바꾸지 않습니다. 드롭다운에서 직접 선택하면 그 모델로 저장됩니다.</span>
        </section>

        <section class="section full recommended-section">
          <h2>로컬 GPU STT + 번역 API</h2>
          <div class="summary-grid">
            <div>
              <span>STT</span>
              <strong>faster-whisper 선택 모델</strong>
            </div>
            <div>
              <span>번역</span>
              <strong>AI API</strong>
            </div>
            <div>
              <span>청크</span>
              <strong>8000ms</strong>
            </div>
          </div>
          <div class="actions">
            <button id="localGpuPreset" type="button">로컬 STT + 번역 API 프리셋</button>
            <button id="liveSttPreset" type="button">라이브 STT 프리셋</button>
            <button id="fasterWhisperProbe" type="button">faster-whisper 연결 확인</button>
            <button id="localPipelineTest" type="button">STT + 번역 API 전체 테스트</button>
          </div>
          <span class="hint">RTX 5070 12GB 기준 기본 STT는 small입니다. 끊김이 없고 인식률이 부족하면 medium으로 올려서 확인하세요. STT는 로컬 GPU로 처리하고 번역만 AI API 키를 사용합니다. 테스트 전 ${LOCAL_STT_START_HINT}</span>
        </section>

        <section class="section full">
          <h2>Whisper-compatible STT</h2>
          <div class="fields">
            <label>
              Base URL
              <input id="whisperBaseUrl" placeholder="http://127.0.0.1:8765/v1" />
            </label>
            <label>
              API 키
              <input id="whisperApiKey" type="password" autocomplete="off" />
            </label>
            <label>
              모델
              <select id="whisperModel">
                <option value="tiny">tiny - 가장 가벼움</option>
                <option value="base">base - 가벼움</option>
                <option value="small">small - 기본/안정성 우선</option>
                <option value="medium">medium - 정확도 우선</option>
                <option value="large-v3-turbo">large-v3-turbo - 무거움</option>
                <option value="large-v3">large-v3 - 매우 무거움</option>
              </select>
            </label>
            <label>
              엔드포인트
              <input id="whisperEndpoint" placeholder="/audio/transcriptions" />
            </label>
          </div>
        </section>
      </section>

      <div class="actions">
        <button id="save" class="primary">설정 저장</button>
        <button id="test">번역 테스트</button>
        <button id="restore" class="danger">기본값 복원</button>
        <div id="status" class="status"></div>
      </div>
    </section>
  `;

  fillValues();
  bindRangeOutputs();
  bindActions();
}

function fillValues(): void {
  setInput("enabled", settings.enabled);
  setInput("inputMode", settings.inputMode);
  setInput("contentMode", settings.contentMode);
  setInput("pretranslateEnabled", settings.pretranslateEnabled);
  setInput("miniControlsEnabled", settings.miniControlsEnabled);
  setInput("streamingSttEnabled", settings.streamingSttEnabled);
  setInput("streamingSttEndpoint", settings.streamingSttEndpoint);
  setInput("speakerTurnDetection", settings.speakerTurnDetection);
  setInput("translationProvider", settings.translationProvider);
  setSelectWithCustomOption("sourceLanguage", settings.sourceLanguage);
  setInput("targetLanguage", settings.targetLanguage);
  setInput("sttProvider", settings.sttProvider);
  setInput("latencyOffsetMs", settings.latencyOffsetMs);
  setInput("audioChunkMs", settings.audioChunkMs);
  setInput("fontSize", settings.overlayStyle.fontSize);
  setInput("bottomOffset", settings.overlayStyle.bottomOffset);
  setInput("maxWidth", settings.overlayStyle.maxWidth);
  setInput("backgroundOpacity", settings.overlayStyle.backgroundOpacity);
  setInput("showSourceText", settings.overlayStyle.showSourceText);
  setInput("openaiGatewayPreset", currentAiGatewayPreset(settings.openai.baseUrl));
  setInput("openaiBaseUrl", settings.openai.baseUrl);
  setInput("openaiApiKey", settings.openai.apiKey);
  setInput("openaiModel", settings.openai.model);
  populateOpenAiModelPicker(settings.openai.model ? [settings.openai.model] : [], settings.openai.model);
  setInput("openaiEndpointMode", settings.openai.endpointMode);
  setInput("openaiAuthHeaderMode", settings.openai.authHeaderMode);
  setInput("apiSttBaseUrl", settings.apiStt.baseUrl);
  setInput("apiSttApiKey", settings.apiStt.apiKey);
  setInput("apiSttModel", settings.apiStt.model);
  setInput("apiSttEndpoint", settings.apiStt.endpoint);
  setInput("apiSttAuthHeaderMode", settings.apiStt.authHeaderMode);
  setInput("ollamaBaseUrl", settings.ollama.baseUrl);
  setInput("ollamaModel", settings.ollama.model);
  setInput("lmStudioBaseUrl", settings.lmStudio.baseUrl);
  setInput("lmStudioApiKey", settings.lmStudio.apiKey);
  setInput("lmStudioModel", settings.lmStudio.model);
  populateLmStudioModelPicker(settings.lmStudio.model ? [settings.lmStudio.model] : [], settings.lmStudio.model);
  setInput("lmStudioEndpointMode", settings.lmStudio.endpointMode);
  setInput("lmStudioAuthHeaderMode", settings.lmStudio.authHeaderMode);
  setInput("lmStudioTryStt", settings.lmStudio.tryStt);
  setInput("lmStudioSttModel", settings.lmStudio.sttModel);
  setInput("lmStudioSttEndpoint", settings.lmStudio.sttEndpoint);
  setInput("whisperBaseUrl", settings.whisper.baseUrl);
  setInput("whisperApiKey", settings.whisper.apiKey);
  setInput("whisperModel", settings.whisper.model);
  setInput("whisperEndpoint", settings.whisper.endpoint);
}

function bindRangeOutputs(): void {
  const pairs = [
    ["fontSize", "fontSizeOut", "px"],
    ["bottomOffset", "bottomOffsetOut", "px"],
    ["maxWidth", "maxWidthOut", "%"],
    ["backgroundOpacity", "backgroundOpacityOut", ""]
  ] as const;

  for (const [inputId, outputId, suffix] of pairs) {
    const input = byId<HTMLInputElement>(inputId);
    const output = byId<HTMLSpanElement>(outputId);
    const update = () => {
      output.textContent = `${input.value}${suffix}`;
    };
    input.addEventListener("input", update);
    update();
  }
}

function collectSettings(): TranslatorSettings {
  return {
    enabled: checkboxValue("enabled"),
    inputMode: selectValue<InputMode>("inputMode"),
    contentMode: selectValue<ContentMode>("contentMode"),
    pretranslateEnabled: checkboxValue("pretranslateEnabled"),
    miniControlsEnabled: checkboxValue("miniControlsEnabled"),
    streamingSttEnabled: checkboxValue("streamingSttEnabled"),
    streamingSttEndpoint: inputValue("streamingSttEndpoint", DEFAULT_SETTINGS.streamingSttEndpoint),
    speakerTurnDetection: checkboxValue("speakerTurnDetection"),
    translationProvider: selectValue<TranslationProvider>("translationProvider"),
    sourceLanguage: selectValue<string>("sourceLanguage") || "auto",
    targetLanguage: inputValue("targetLanguage", "ko"),
    sttProvider: selectValue<SttProvider>("sttProvider"),
    latencyOffsetMs: numberValue("latencyOffsetMs", 0),
    audioChunkMs: numberValue("audioChunkMs", DEFAULT_SETTINGS.audioChunkMs),
    overlayStyle: {
      fontSize: numberValue("fontSize", DEFAULT_SETTINGS.overlayStyle.fontSize),
      bottomOffset: numberValue("bottomOffset", DEFAULT_SETTINGS.overlayStyle.bottomOffset),
      maxWidth: numberValue("maxWidth", DEFAULT_SETTINGS.overlayStyle.maxWidth),
      backgroundOpacity: numberValue("backgroundOpacity", DEFAULT_SETTINGS.overlayStyle.backgroundOpacity),
      showSourceText: checkboxValue("showSourceText")
    },
    openai: {
      baseUrl: inputValue("openaiBaseUrl", DEFAULT_SETTINGS.openai.baseUrl),
      apiKey: inputValue("openaiApiKey"),
      model: inputValue("openaiModel", DEFAULT_SETTINGS.openai.model),
      endpointMode: selectValue<AiEndpointMode>("openaiEndpointMode"),
      authHeaderMode: selectValue<ApiAuthHeaderMode>("openaiAuthHeaderMode")
    },
    apiStt: {
      baseUrl: inputValue("apiSttBaseUrl", DEFAULT_SETTINGS.apiStt.baseUrl),
      apiKey: inputValue("apiSttApiKey"),
      model: inputValue("apiSttModel", DEFAULT_SETTINGS.apiStt.model),
      endpoint: inputValue("apiSttEndpoint", DEFAULT_SETTINGS.apiStt.endpoint),
      authHeaderMode: selectValue<ApiAuthHeaderMode>("apiSttAuthHeaderMode")
    },
    ollama: {
      baseUrl: inputValue("ollamaBaseUrl", DEFAULT_SETTINGS.ollama.baseUrl),
      model: inputValue("ollamaModel", DEFAULT_SETTINGS.ollama.model)
    },
    lmStudio: {
      baseUrl: inputValue("lmStudioBaseUrl", DEFAULT_SETTINGS.lmStudio.baseUrl),
      apiKey: inputValue("lmStudioApiKey"),
      model: inputValue("lmStudioModel", DEFAULT_SETTINGS.lmStudio.model),
      endpointMode: selectValue<AiEndpointMode>("lmStudioEndpointMode"),
      authHeaderMode: selectValue<ApiAuthHeaderMode>("lmStudioAuthHeaderMode"),
      tryStt: checkboxValue("lmStudioTryStt"),
      sttModel: inputValue("lmStudioSttModel", DEFAULT_SETTINGS.lmStudio.sttModel),
      sttEndpoint: inputValue("lmStudioSttEndpoint", DEFAULT_SETTINGS.lmStudio.sttEndpoint)
    },
    whisper: {
      baseUrl: inputValue("whisperBaseUrl", DEFAULT_SETTINGS.whisper.baseUrl),
      apiKey: inputValue("whisperApiKey"),
      model: inputValue("whisperModel", DEFAULT_SETTINGS.whisper.model),
      endpoint: inputValue("whisperEndpoint", DEFAULT_SETTINGS.whisper.endpoint)
    }
  };
}

async function saveSettingsPatch(patch: Partial<TranslatorSettings>): Promise<TranslatorSettings> {
  const response = await chrome.runtime.sendMessage<MessageResponse<{ settings: TranslatorSettings; revision: number }>>({
    type: "SAVE_SETTINGS",
    patch
  });
  if (!response?.ok) {
    throw new Error(response?.error ?? "설정을 저장하지 못했습니다.");
  }
  return response.settings;
}

async function saveCurrentSettings(): Promise<void> {
  const nextSettings = collectSettings();
  settings = await saveSettingsPatch(diffSettings(settings, nextSettings));
  if (!settings.enabled) {
    await chrome.runtime.sendMessage({ type: "STOP_AUDIO_CAPTURE" }).catch(() => undefined);
  }
  setStatus("설정을 저장했습니다. YouTube 탭에 바로 반영됩니다.");
}

async function testTranslation(): Promise<void> {
  await saveCurrentSettings();
  const response = await chrome.runtime.sendMessage<MessageResponse<{ translatedText: string; provider: string }>>({
    type: "CAPTION_SEGMENT",
    segment: {
      id: "options-test",
      source: "youtubeDom",
      startMs: 0,
      endMs: 1000,
      text: "Hello, this is a translation test."
    }
  });
  setStatus(response?.ok ? `테스트 성공: ${response.translatedText}` : `테스트 실패: ${response?.error ?? "background 응답 없음"}`);
}

async function loadLmStudioModels(): Promise<void> {
  setInput("translationProvider", "lmStudio");
  setStatus("LM Studio 모델 목록을 불러오는 중입니다...");

  const models = await readLmStudioModelIds();
  const currentModel = rawInputValue("lmStudioModel");
  const selectedModel = currentModel && models.includes(currentModel) ? currentModel : preferTranslationModel(models, currentModel);
  populateLmStudioModelPicker(models, selectedModel);
  setStatus(
    currentModel
      ? `LM Studio 모델 ${models.length}개를 불러왔습니다. 현재 번역 모델은 ${currentModel} 그대로 유지됩니다.`
      : `LM Studio 모델 ${models.length}개를 불러왔습니다. 드롭다운에서 사용할 모델을 선택하세요.`
  );
}

async function testLmStudioTranslation(): Promise<void> {
  setInput("translationProvider", "lmStudio");
  await saveCurrentSettings();
  const response = await chrome.runtime.sendMessage<MessageResponse<{ translatedText: string; provider: string }>>({
    type: "CAPTION_SEGMENT",
    segment: {
      id: "lm-studio-options-test",
      source: "youtubeDom",
      startMs: 0,
      endMs: 1000,
      text: "Hello, this is a translation test."
    }
  });
  setStatus(response?.ok ? `LM Studio 번역 테스트 성공: ${response.translatedText}` : `LM Studio 번역 테스트 실패: ${response?.error ?? "background 응답 없음"}`);
}

async function probeFasterWhisper(): Promise<void> {
  const baseUrl = normalizeOpenAiBaseUrl(inputValue("whisperBaseUrl", DEFAULT_SETTINGS.whisper.baseUrl));
  setInput("whisperBaseUrl", baseUrl);
  const healthUrl = joinUrl(baseUrl.replace(/\/v1\/?$/, ""), "/health");
  setStatus("faster-whisper 서버를 확인하는 중입니다...");

  const [healthResult, modelsResult] = await Promise.all([
    fetchText(healthUrl, undefined, "faster-whisper STT 서버", LOCAL_STT_START_HINT),
    fetchText(joinUrl(baseUrl, "/models"), undefined, "faster-whisper STT 서버", LOCAL_STT_START_HINT)
  ]);
  const { response: healthResponse, text: healthText } = healthResult;
  const { response: modelsResponse, text: modelsText } = modelsResult;

  if (!healthResponse.ok) {
    throw new Error(`faster-whisper health 실패: HTTP ${healthResponse.status} ${healthText.slice(0, 180)}`);
  }
  if (!modelsResponse.ok) {
    throw new Error(`faster-whisper models 실패: HTTP ${modelsResponse.status} ${modelsText.slice(0, 180)}`);
  }

  const health = healthText ? JSON.parse(healthText) : {};
  const models = modelsText ? JSON.parse(modelsText) : {};
  if (health.ok === false) {
    throw new Error(`faster-whisper 준비 실패: ${formatLocalSttHealthStatus(health)}`);
  }

  const modelIds = Array.isArray(models.data)
    ? (models.data as JsonObject[]).map((model) => model.id).filter((id): id is string => typeof id === "string")
    : [];
  const selectedModel = rawInputValue("whisperModel") || LOCAL_STT_MODEL;
  const cachedModels = stringArray(health.cached_models);
  const loadedModel =
    typeof health.loaded_model === "string" && health.loaded_model
      ? health.loaded_model
      : typeof health.model === "string" && health.model
        ? health.model
        : "";
  const selectedIsUsable =
    cachedModels.includes(selectedModel) ||
    selectedModel === loadedModel ||
    selectedModel.includes("/") ||
    selectedModel.includes("\\");
  const modelId = selectedIsUsable ? selectedModel : loadedModel || cachedModels[0] || modelIds[0] || selectedModel;

  setInput("whisperModel", modelId);
  setInput("sttProvider", "whisper");
  setStatus(
    health.ok
      ? `faster-whisper 연결 성공: ${modelId}, ${health.device ?? "device?"}/${health.compute_type ?? "compute?"}`
      : `faster-whisper 응답 오류: ${health.error ?? "상태를 확인하세요."}`
  );
}

function createSilentWavBlob(seconds = 1): Blob {
  const sampleRate = 16000;
  const samples = sampleRate * seconds;
  const bytesPerSample = 2;
  const dataSize = samples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let offset = 0;

  const writeString = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset, value.charCodeAt(index));
      offset += 1;
    }
  };
  const writeUint32 = (value: number) => {
    view.setUint32(offset, value, true);
    offset += 4;
  };
  const writeUint16 = (value: number) => {
    view.setUint16(offset, value, true);
    offset += 2;
  };

  writeString("RIFF");
  writeUint32(36 + dataSize);
  writeString("WAVE");
  writeString("fmt ");
  writeUint32(16);
  writeUint16(1);
  writeUint16(1);
  writeUint32(sampleRate);
  writeUint32(sampleRate * bytesPerSample);
  writeUint16(bytesPerSample);
  writeUint16(16);
  writeString("data");
  writeUint32(dataSize);

  return new Blob([buffer], { type: "audio/wav" });
}

async function testLocalPipeline(): Promise<void> {
  applyLocalGpuPreset();
  await probeFasterWhisper();
  await saveCurrentSettings();
  setStatus("로컬 STT와 AI API 번역을 함께 테스트하는 중입니다...");

  const form = new FormData();
  form.append("file", createSilentWavBlob(), "silence.wav");
  form.append("model", inputValue("whisperModel", LOCAL_STT_MODEL));
  const { response: sttResponse, text: sttText } = await fetchText(
    joinOpenAiUrl(inputValue("whisperBaseUrl", LOCAL_STT_BASE_URL), inputValue("whisperEndpoint", "/audio/transcriptions")),
    {
      method: "POST",
      body: form
    },
    "faster-whisper STT 서버",
    LOCAL_STT_START_HINT
  );
  if (!sttResponse.ok) {
    throw new Error(`STT 테스트 실패: HTTP ${sttResponse.status} ${sttText.slice(0, 180)}`);
  }

  const translationResponse = await chrome.runtime.sendMessage<MessageResponse<{ translatedText: string; provider: string }>>({
    type: "CAPTION_SEGMENT",
    segment: {
      id: "local-pipeline-test",
      source: "audioStt",
      startMs: 0,
      endMs: 1000,
      text: "Local GPU speech recognition and AI translation API are connected."
    }
  });

  if (!translationResponse?.ok) {
    throw new Error(`AI API 번역 테스트 실패: ${translationResponse?.error ?? "background 응답 없음"}`);
  }

  setStatus(`로컬 STT + 번역 API 테스트 성공: ${translationResponse.translatedText}`);
}

async function testApiStt(): Promise<void> {
  const baseUrl = normalizeOpenAiBaseUrl(inputValue("apiSttBaseUrl", DEFAULT_SETTINGS.apiStt.baseUrl));
  const endpoint = inputValue("apiSttEndpoint", DEFAULT_SETTINGS.apiStt.endpoint);
  const authHeaderMode = selectValue<ApiAuthHeaderMode>("apiSttAuthHeaderMode");
  const apiKey = inputValue("apiSttApiKey") || inputValue("openaiApiKey");
  const model = apiSttModel(inputValue("apiSttModel", DEFAULT_SETTINGS.apiStt.model));

  setInput("apiSttBaseUrl", baseUrl);
  setInput("apiSttModel", model);
  if (!apiKey && authHeaderMode !== "none") {
    throw new Error("API STT 키가 없습니다. AI API 키를 입력하거나 API STT 키를 입력하세요.");
  }

  setStatus("API STT 연결을 테스트하는 중입니다...");
  const form = new FormData();
  form.append("file", createSilentWavBlob(), "silence.wav");
  form.append("model", model);
  form.append("response_format", "json");
  const sourceLanguage = selectValue<string>("sourceLanguage") || "auto";
  const contentMode = selectValue<ContentMode>("contentMode");
  const mixedLanguageAudio = contentMode === "lyrics";
  if (sourceLanguage !== "auto" && !mixedLanguageAudio) {
    form.append("language", sourceLanguage);
  }
  if (isLocalBaseUrl(baseUrl)) {
    form.append("content_mode", contentMode);
  }

  const { response, text } = await fetchText(
    joinOpenAiUrl(baseUrl, endpoint),
    {
      method: "POST",
      headers: authHeaders(apiKey, authHeaderMode),
      body: form
    },
    "API STT",
    "Base URL, endpoint, API 키/권한, 모델명을 확인하세요."
  );

  if (!response.ok) {
    throw new Error(`API STT 테스트 실패: ${apiHttpErrorMessage(response, text)}`);
  }

  let json: JsonObject = {};
  try {
    json = text ? (JSON.parse(text) as JsonObject) : {};
  } catch {
    throw new Error(`API STT 응답이 JSON이 아닙니다: ${text.slice(0, 180)}`);
  }
  if (json.error) {
    throw new Error(`API STT 테스트 실패: ${typeof json.error === "string" ? json.error : JSON.stringify(json.error).slice(0, 180)}`);
  }

  const transcript = typeof json.text === "string" ? json.text.trim() : typeof json.transcript === "string" ? json.transcript.trim() : "";
  setInput("sttProvider", "openai");
  setStatus(transcript ? `API STT 연결 성공: ${transcript}` : "API STT 연결 성공: 무음 테스트 응답을 받았습니다.");
}

async function testApiAudioPipeline(): Promise<void> {
  setInput("enabled", true);
  setInput("inputMode", "captionsThenAudio");
  setInput("translationProvider", "openai");
  setInput("sttProvider", "openai");
  await testApiStt();
  await saveCurrentSettings();
  setStatus("API STT 결과를 AI API 번역으로 전달하는 중입니다...");

  const response = await chrome.runtime.sendMessage<MessageResponse<{ translatedText: string; provider: string }>>({
    type: "CAPTION_SEGMENT",
    segment: {
      id: "api-audio-pipeline-test",
      source: "audioStt",
      startMs: 0,
      endMs: 1000,
      text: "API speech recognition and AI translation are connected."
    }
  });

  if (!response?.ok) {
    throw new Error(`AI API 번역 테스트 실패: ${response?.error ?? "background 응답 없음"}`);
  }

  setStatus(`API 음성 자막 파이프라인 성공: ${response.translatedText}`);
}

function applyLocalGpuPreset(): void {
  const existingApiKey = inputValue("openaiApiKey");
  const currentModel = rawInputValue("whisperModel");
  const selectedSttModel =
    currentModel && !/^(tiny|base|small|medium|whisper-1)$/i.test(currentModel)
      ? currentModel
      : LOCAL_STT_MODEL;
  setInput("enabled", true);
  setInput("inputMode", "captionsThenAudio");
  setInput("contentMode", "auto");
  setInput("pretranslateEnabled", true);
  setInput("miniControlsEnabled", true);
  setInput("streamingSttEnabled", true);
  setInput("streamingSttEndpoint", DEFAULT_SETTINGS.streamingSttEndpoint);
  setInput("translationProvider", "openai");
  setInput("sttProvider", "whisper");
  setInput("audioChunkMs", 8000);
  ensureAiApiTranslationDefaults();
  if (existingApiKey) {
    setInput("openaiApiKey", existingApiKey);
  }
  setInput("whisperBaseUrl", LOCAL_STT_BASE_URL);
  setInput("whisperModel", selectedSttModel);
  setInput("whisperEndpoint", "/audio/transcriptions");
  setInput("lmStudioTryStt", false);
  setStatus(`로컬 STT 프리셋을 입력했습니다. STT 모델은 ${selectedSttModel}, 선택한 AI API Base URL과 번역 모델은 유지됩니다.`);
}

function applyLyricsSttPreset(): void {
  const existingApiKey = inputValue("openaiApiKey");
  const currentModel = rawInputValue("whisperModel");
  const lyricsModel =
    currentModel && !/^(tiny|base|small|medium|whisper-1)$/i.test(currentModel)
      ? currentModel
      : "medium";
  setInput("enabled", true);
  setInput("inputMode", "captionsThenAudio");
  setInput("contentMode", "lyrics");
  setInput("sourceLanguage", "auto");
  setInput("pretranslateEnabled", true);
  setInput("miniControlsEnabled", true);
  setInput("streamingSttEnabled", true);
  setInput("streamingSttEndpoint", DEFAULT_SETTINGS.streamingSttEndpoint);
  setInput("translationProvider", "openai");
  setInput("sttProvider", "whisper");
  setInput("audioChunkMs", 14000);
  ensureAiApiTranslationDefaults();
  if (existingApiKey) {
    setInput("openaiApiKey", existingApiKey);
  }
  setInput("whisperBaseUrl", LOCAL_STT_BASE_URL);
  setInput("whisperModel", lyricsModel);
  setInput("whisperEndpoint", "/audio/transcriptions");
  setInput("lmStudioTryStt", false);
  setStatus(
    `노래 STT 프리셋을 입력했습니다. ${lyricsModel} 모델, 긴 창, 노래/가사 모드를 사용합니다. 여러 언어가 섞인 곡은 음성 언어를 자동 감지로 두는 것을 권장합니다.`
  );
}

function applyLiveSttPreset(): void {
  const existingApiKey = inputValue("openaiApiKey");
  const currentModel = rawInputValue("whisperModel");
  const liveModel =
    currentModel && !/^(tiny|base|small|medium|whisper-1)$/i.test(currentModel)
      ? currentModel
      : "medium";
  setInput("enabled", true);
  setInput("inputMode", "captionsThenAudio");
  setInput("contentMode", "live");
  setInput("pretranslateEnabled", true);
  setInput("miniControlsEnabled", true);
  setInput("streamingSttEnabled", true);
  setInput("streamingSttEndpoint", DEFAULT_SETTINGS.streamingSttEndpoint);
  setInput("translationProvider", "openai");
  setInput("sttProvider", "whisper");
  setInput("audioChunkMs", 10000);
  ensureAiApiTranslationDefaults();
  if (existingApiKey) {
    setInput("openaiApiKey", existingApiKey);
  }
  setInput("whisperBaseUrl", LOCAL_STT_BASE_URL);
  setInput("whisperModel", liveModel);
  setInput("whisperEndpoint", "/audio/transcriptions");
  setInput("lmStudioTryStt", false);
  setStatus(
    `라이브 STT 프리셋을 입력했습니다. ${liveModel} 모델, 라이브/잡음 모드, 10초 HTTP fallback 창을 사용합니다. 말하는 언어를 알면 음성 언어를 지정하세요.`
  );
}

function applyApiKeyAudioPreset(): void {
  const sharedApiKey = inputValue("openaiApiKey") || inputValue("apiSttApiKey");
  setInput("enabled", true);
  setInput("inputMode", "captionsThenAudio");
  setInput("contentMode", "auto");
  setInput("pretranslateEnabled", true);
  setInput("miniControlsEnabled", true);
  setInput("streamingSttEnabled", false);
  setInput("translationProvider", "openai");
  setInput("sttProvider", "openai");
  setInput("audioChunkMs", 8000);
  ensureAiApiTranslationDefaults();
  if (sharedApiKey) {
    setInput("openaiApiKey", sharedApiKey);
    setInput("apiSttApiKey", sharedApiKey);
  }
  setInput("apiSttBaseUrl", DEFAULT_SETTINGS.apiStt.baseUrl);
  setInput("apiSttModel", DEFAULT_SETTINGS.apiStt.model);
  setInput("apiSttEndpoint", DEFAULT_SETTINGS.apiStt.endpoint);
  setInput("apiSttAuthHeaderMode", "bearer");
  setStatus("API STT 프리셋을 입력했습니다. 선택한 AI API Base URL과 번역 모델은 유지됩니다.");
}

function applyAiGatewayPreset(): void {
  const presetId = selectValue<"mindlogic" | "openai" | "custom">("openaiGatewayPreset");
  if (presetId === "custom") {
    setInput("translationProvider", "openai");
    setStatus("직접 입력 모드입니다. Base URL, 모델명, 인증 방식을 입력한 뒤 저장하세요.");
    return;
  }

  const preset = AI_GATEWAY_PRESETS[presetId];
  const existingApiKey = inputValue("openaiApiKey") || inputValue("apiSttApiKey");
  setInput("translationProvider", "openai");
  setInput("openaiBaseUrl", preset.baseUrl);
  if (existingApiKey) {
    setInput("openaiApiKey", existingApiKey);
  }
  setInput("openaiModel", preset.model);
  setInput("openaiEndpointMode", preset.endpointMode);
  setInput("openaiAuthHeaderMode", preset.authHeaderMode);
  populateOpenAiModelPicker([preset.model], preset.model);
  setStatus(`${preset.label} 프리셋을 입력했습니다. 모델 목록을 불러오면 현재 키로 사용 가능한 모델을 선택할 수 있습니다.`);
}

async function loadOpenAiModels(): Promise<void> {
  setInput("translationProvider", "openai");
  setStatus("AI API 모델 목록을 불러오는 중입니다...");

  const models = await readAiGatewayModelIds();
  if (models.length === 0) {
    populateOpenAiModelPicker([], "");
    throw new Error("AI API가 응답했지만 사용 가능한 LLM 모델을 찾지 못했습니다.");
  }

  const currentModel = rawInputValue("openaiModel");
  const selectedModel = currentModel && models.includes(currentModel) ? currentModel : preferGatewayModel(models, currentModel);
  populateOpenAiModelPicker(models, selectedModel);
  setStatus(
    currentModel
      ? `AI API 모델 ${models.length}개를 불러왔습니다. 현재 번역 모델은 ${currentModel} 그대로 유지됩니다.`
      : `AI API 모델 ${models.length}개를 불러왔습니다. 드롭다운에서 사용할 모델을 선택하세요.`
  );
}

function bindActions(): void {
  byId<HTMLButtonElement>("save").addEventListener("click", () => {
    runAction(saveCurrentSettings);
  });

  byId<HTMLButtonElement>("heroLocalPreset").addEventListener("click", () => {
    applyLocalGpuPreset();
  });

  byId<HTMLButtonElement>("heroLivePreset").addEventListener("click", () => {
    applyLiveSttPreset();
  });

  byId<HTMLButtonElement>("heroLyricsPreset").addEventListener("click", () => {
    applyLyricsSttPreset();
  });

  byId<HTMLButtonElement>("heroPipelineTest").addEventListener("click", () => {
    runAction(testLocalPipeline);
  });

  byId<HTMLButtonElement>("test").addEventListener("click", () => {
    runAction(testTranslation);
  });

  byId<HTMLSelectElement>("openaiGatewayPreset").addEventListener("change", () => {
    const presetId = selectValue<"mindlogic" | "openai" | "custom">("openaiGatewayPreset");
    const label = presetId === "custom" ? "직접 입력" : AI_GATEWAY_PRESETS[presetId].label;
    setStatus(`${label} 프리셋을 선택했습니다. 적용하려면 프리셋 적용 버튼을 누르세요.`);
  });

  byId<HTMLButtonElement>("applyAiGatewayPreset").addEventListener("click", () => {
    applyAiGatewayPreset();
  });

  byId<HTMLButtonElement>("loadOpenAiModels").addEventListener("click", () => {
    runAction(loadOpenAiModels);
  });

  byId<HTMLSelectElement>("openaiModelPicker").addEventListener("change", (event) => {
    const selectedModel = (event.currentTarget as HTMLSelectElement).value;
    if (selectedModel) {
      setInput("translationProvider", "openai");
      setInput("openaiModel", selectedModel);
      setStatus(`번역 모델을 ${selectedModel}(으)로 선택했습니다.`);
    }
  });

  byId<HTMLSelectElement>("lmStudioModelPicker").addEventListener("change", (event) => {
    const selectedModel = (event.currentTarget as HTMLSelectElement).value;
    if (selectedModel) {
      setInput("translationProvider", "lmStudio");
      setInput("lmStudioModel", selectedModel);
      setStatus(`LM Studio 번역 모델을 ${selectedModel}(으)로 선택했습니다.`);
    }
  });

  byId<HTMLButtonElement>("mindlogicPreset").addEventListener("click", () => {
    setInput("openaiGatewayPreset", "mindlogic");
    applyAiGatewayPreset();
  });

  byId<HTMLButtonElement>("apiKeyAudioPreset").addEventListener("click", () => {
    applyApiKeyAudioPreset();
  });

  byId<HTMLButtonElement>("apiSttTest").addEventListener("click", () => {
    runAction(testApiStt);
  });

  byId<HTMLButtonElement>("apiPipelineTest").addEventListener("click", () => {
    runAction(testApiAudioPipeline);
  });

  byId<HTMLButtonElement>("loadLmStudioModels").addEventListener("click", () => {
    runAction(loadLmStudioModels);
  });

  byId<HTMLButtonElement>("lmStudioProbe").addEventListener("click", () => {
    runAction(testLmStudioTranslation);
  });

  byId<HTMLButtonElement>("localGpuPreset").addEventListener("click", () => {
    applyLocalGpuPreset();
  });

  byId<HTMLButtonElement>("liveSttPreset").addEventListener("click", () => {
    applyLiveSttPreset();
  });

  byId<HTMLButtonElement>("fasterWhisperProbe").addEventListener("click", () => {
    runAction(probeFasterWhisper);
  });

  byId<HTMLButtonElement>("localPipelineTest").addEventListener("click", () => {
    runAction(testLocalPipeline);
  });

  byId<HTMLButtonElement>("restore").addEventListener("click", () => {
    runAction(async () => {
      const defaultSettings = structuredClone(DEFAULT_SETTINGS);
      settings = await saveSettingsPatch(diffSettings(settings, defaultSettings));
      render();
      setStatus("기본값으로 복원했습니다.");
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
