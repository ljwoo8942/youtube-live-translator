import type { ApiAuthHeaderMode, CaptionSegment, TranslationProvider, TranslatorSettings } from "../shared/types";
import type { CaptionTranslationEntry } from "../shared/messages";

type JsonObject = Record<string, unknown>;
type OpenAiCompatibleConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  endpointMode: "chat" | "responses";
  authHeaderMode?: ApiAuthHeaderMode;
};

const MODEL_DISCOVERY_CACHE_MS = 30_000;
const lmStudioModelCache = new Map<string, { at: number; models: string[] }>();
const PREFERRED_LM_STUDIO_MODEL_PATTERNS = [/^google\/gemma-4-e2b$/i, /gemma[-_/]?4[-_/]?e2b/i, /e2b/i, /gemma/i];
const LOCAL_STT_START_HINT = "별도 터미널에서 npm run stt:start를 실행하고 그 창을 닫지 않은 채 다시 시도하세요.";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  const base = trimTrailingSlash(baseUrl);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
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

function authHeaders(apiKey: string, mode: ApiAuthHeaderMode = "bearer"): HeadersInit {
  if (!apiKey || mode === "none") {
    return {};
  }
  if (mode === "xApiKey") {
    return { "x-api-key": apiKey };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function isLocalUrl(url: URL): boolean {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return ["127.0.0.1", "localhost", "::1"].includes(hostname);
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

async function readJson(response: Response): Promise<JsonObject> {
  const text = await response.text();
  let json: JsonObject = {};
  if (text) {
    try {
      json = JSON.parse(text) as JsonObject;
    } catch {
      throw new Error(text.slice(0, 240));
    }
  }

  const error = json.error;
  if (!response.ok || error) {
    const statusHint =
      response.status === 401 || response.status === 403
        ? "API 키 또는 권한을 확인하세요"
        : response.status === 429
          ? "요청 한도 또는 quota를 확인하세요"
          : `HTTP ${response.status}`;
    if (typeof error === "object" && error && "message" in error) {
      throw new Error(`${statusHint}: ${String((error as { message: unknown }).message)}`);
    }
    if (typeof error === "string") {
      throw new Error(`${statusHint}: ${error}`);
    }
    if (typeof json.detail === "string") {
      throw new Error(`${statusHint}: ${json.detail}`);
    }
    if (Array.isArray(json.detail)) {
      throw new Error(`${statusHint}: ${JSON.stringify(json.detail).slice(0, 240)}`);
    }
    throw new Error(`${statusHint}: ${text.slice(0, 240)}`);
  }

  return json;
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map(extractTextContent).filter(Boolean).join("").trim();
  }

  if (value && typeof value === "object") {
    const object = value as JsonObject;
    for (const key of ["text", "content", "value", "output_text"]) {
      const extracted = extractTextContent(object[key]);
      if (extracted) {
        return extracted;
      }
    }
  }

  return "";
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

function isPlaceholderModel(model: string): boolean {
  return !model.trim() || /^(local-model|model|your-model|local-llm)$/i.test(model.trim());
}

function isEmbeddingModel(model: string): boolean {
  return /(^|[-_])embed|embedding/i.test(model);
}

function preferTranslationModel(models: string[], fallback: string): string {
  const fallbackTrimmed = fallback.trim();
  const candidates = uniqueStrings(models).filter((model) => !isEmbeddingModel(model));
  if (
    fallbackTrimmed &&
    !isPlaceholderModel(fallbackTrimmed) &&
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFetchNetworkError(error: unknown): boolean {
  return /failed to fetch|fetch failed|networkerror|load failed/i.test(getErrorMessage(error));
}

function safeUrlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function localSttConnectionError(error: unknown): Error {
  if (isFetchNetworkError(error)) {
    return new Error(
      `로컬 STT 서버에 연결하지 못했습니다. 자막 없는 영상은 번역 API 키만으로는 음성 인식이 되지 않습니다. API STT를 쓰려면 STT provider를 OpenAI-compatible로 바꾸고, 로컬 STT를 쓰려면 ${LOCAL_STT_START_HINT}`
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function formatLocalSttHealthError(json: JsonObject, status: number): string {
  const error = typeof json.error === "string" ? json.error : `HTTP ${status}`;
  const hint = typeof json.hint === "string" ? json.hint : "";
  const model = typeof json.model === "string" ? json.model : "";
  const cachedModels = Array.isArray(json.cached_models)
    ? (json.cached_models as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
  const modelPrefix = model ? `STT 모델 ${model}: ` : "";
  const cachedSuffix = cachedModels.length > 0 ? ` 캐시된 모델: ${cachedModels.join(", ")}.` : "";
  return `${modelPrefix}${error}${hint ? ` ${hint}` : cachedSuffix}`;
}

function apiConnectionError(error: unknown, target: string, url: string): Error {
  if (isFetchNetworkError(error)) {
    return new Error(
      `${target}에 연결하지 못했습니다: ${safeUrlLabel(url)}. Base URL, 인터넷 연결, 확장 프로그램 새로고침, host permission을 확인하세요. API 키가 틀린 경우는 보통 401/403 응답으로 표시됩니다.`
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function fetchForProvider(url: string, init: RequestInit | undefined, target: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw apiConnectionError(error, target, url);
  }
}

function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    return isLocalUrl(new URL(normalizeOpenAiBaseUrl(baseUrl)));
  } catch {
    return false;
  }
}

function apiSttModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed || /^(tiny|base|small|medium|large|large-v\d+(?:-turbo)?|distil-.+)$/i.test(trimmed)) {
    return "whisper-1";
  }
  return trimmed;
}

function effectiveOpenAiApiKey(settings: TranslatorSettings): string {
  return settings.openai.apiKey || settings.apiStt.apiKey;
}

function openAiTranslationConfig(settings: TranslatorSettings): OpenAiCompatibleConfig {
  return {
    ...settings.openai,
    apiKey: effectiveOpenAiApiKey(settings)
  };
}

async function fetchLmStudioModelIds(baseUrl: string): Promise<string[]> {
  const normalizedBaseUrl = normalizeOpenAiBaseUrl(baseUrl);
  const cached = lmStudioModelCache.get(normalizedBaseUrl);
  if (cached && Date.now() - cached.at < MODEL_DISCOVERY_CACHE_MS) {
    return cached.models;
  }

  const errors: string[] = [];

  try {
    const nativeUrl = joinUrl(lmStudioNativeBaseUrl(normalizedBaseUrl), "/models");
    const response = await fetchForProvider(nativeUrl, undefined, "LM Studio 로컬 서버");
    const loadedModels = extractModelIds(await readJson(response), true);
    if (loadedModels.length > 0) {
      const uniqueLoadedModels = uniqueStrings(loadedModels);
      lmStudioModelCache.set(normalizedBaseUrl, { at: Date.now(), models: uniqueLoadedModels });
      return uniqueLoadedModels;
    }
  } catch (error) {
    errors.push(getErrorMessage(error));
  }

  const models: string[] = [];
  try {
    const modelsUrl = joinOpenAiUrl(normalizedBaseUrl, "/models");
    const response = await fetchForProvider(modelsUrl, undefined, "LM Studio OpenAI-compatible API");
    models.push(...extractModelIds(await readJson(response)));
  } catch (error) {
    errors.push(getErrorMessage(error));
  }

  const uniqueModels = uniqueStrings(models);
  if (uniqueModels.length === 0 && errors.length > 0) {
    throw new Error(`LM Studio 모델 목록을 읽지 못했습니다: ${errors.join(" / ")}`);
  }

  lmStudioModelCache.set(normalizedBaseUrl, { at: Date.now(), models: uniqueModels });
  return uniqueModels;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    "#39": "'"
  };

  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity in named) {
      return named[entity];
    }
    if (entity.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return match;
  });
}

function languageNameOrCode(code: string): string {
  const normalized = code.trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return "the user's selected target language";
  }
  const languageNames: Record<string, string> = {
    ko: "Korean",
    kor: "Korean",
    kr: "Korean",
    "ko-kr": "Korean",
    korean: "Korean",
    ja: "Japanese",
    jpn: "Japanese",
    "ja-jp": "Japanese",
    japanese: "Japanese",
    en: "English",
    eng: "English",
    "en-us": "English",
    "en-gb": "English",
    english: "English",
    zh: "Chinese",
    zho: "Chinese",
    chi: "Chinese",
    "zh-cn": "Simplified Chinese",
    "zh-hans": "Simplified Chinese",
    "zh-tw": "Traditional Chinese",
    "zh-hant": "Traditional Chinese",
    chinese: "Chinese",
    es: "Spanish",
    spa: "Spanish",
    spanish: "Spanish",
    fr: "French",
    fra: "French",
    fre: "French",
    french: "French",
    de: "German",
    deu: "German",
    ger: "German",
    german: "German",
    it: "Italian",
    ita: "Italian",
    italian: "Italian",
    pt: "Portuguese",
    por: "Portuguese",
    "pt-br": "Brazilian Portuguese",
    portuguese: "Portuguese",
    ru: "Russian",
    rus: "Russian",
    russian: "Russian",
    vi: "Vietnamese",
    vie: "Vietnamese",
    vietnamese: "Vietnamese",
    th: "Thai",
    tha: "Thai",
    thai: "Thai",
    id: "Indonesian",
    ind: "Indonesian",
    indonesian: "Indonesian"
  };
  return languageNames[normalized] ?? code;
}

function effectiveContentMode(settings: TranslatorSettings): "spoken" | "live" | "lyrics" {
  if (settings.contentMode === "lyrics") {
    return "lyrics";
  }
  if (settings.contentMode === "live") {
    return "live";
  }
  return "spoken";
}

function isKoreanTarget(target: string): boolean {
  return /^(ko|kor|korean|한국어|kr)$/i.test(target.trim());
}

function sourceLanguageGuidance(sourceLanguage: string): string {
  if (!sourceLanguage || sourceLanguage === "auto") {
    return "auto-detected source language(s), including mixed-language and code-switched text";
  }
  return `${languageNameOrCode(sourceLanguage)} as the primary source language, but the subtitle may include other languages`;
}

function meaningIntegrityGuidance(settings: TranslatorSettings, target: string): string {
  const mode = effectiveContentMode(settings);
  const lyricAllowance =
    mode === "lyrics"
      ? "For lyrics, imagery and word order may be reshaped for singable target-language phrasing, but never add or remove an event, action, relationship, or emotional turn."
      : "";
  return [
    `Before output, silently check fidelity: preserve who did what to whom, negation, tense/aspect, number, uncertainty, quotation, and temporal, conditional, or causal relationships in ${target}.`,
    "Do not invent an action, motive, cause, transition, or explanation merely to make a fragment sound fluent. Context may resolve an omission, but cannot supply a new fact.",
    "When the source is genuinely ambiguous, use concise neutral wording in the target language instead of choosing a vivid unsupported interpretation.",
    lyricAllowance
  ]
    .filter(Boolean)
    .join(" ");
}

function japaneseKoreanAccuracyGuidance(settings: TranslatorSettings, target: string): string {
  if (!isKoreanTarget(settings.targetLanguage || target)) {
    return "";
  }
  return [
    "Japanese-to-Korean accuracy check: determine predicate roles and idioms before wording; never mechanically map Japanese が to a Korean subject or reverse who feels, acts, or receives something.",
    "Preserve lexical strength instead of embellishing it: 探す is 찾다, not 헤매다 unless the source also expresses wandering; きっと with a past assertion normally keeps the speaker's confidence as 분명 ~였어, not the weaker ~였을 거야.",
    "Preserve uncertainty and paired grammar: ような気がする stays ~것만 같다, and 何度...ても ...ない must keep both the concession and negation as 몇 번 ...해도 ...하지 않아/않을게 according to context.",
    "In a judgment or choice context, 間違う normally means 틀리다 or 잘못되다. Do not turn it into a person's accidental 실수 unless the source actually describes making a mistake.",
    "When movement is contrasted with ここに居ようとしてる, translate the intended staying as 여기에 머물려는 거야 or 여기에 남으려는 거야, not the clumsy literal 여기에 있으려고 하는 거야.",
    "For a person-modifying phrase such as 人が嫌いな子, use the predicate meaning and context (normally 사람을 싫어하는 아이), not a reversed reading such as 사람이 싫은 아이.",
    "Treat Xに子供ができる as X에게 아이가 생기다 or X가 아이를 갖게 되다. Do not use 임신 unless the Japanese explicitly says 妊娠, 身ごもる, 懐妊, or an equivalent pregnancy expression.",
    "Treat 気付けば as 어느새 or 정신 차려 보니 when it marks an unplanned realization or passage of time. Never invent a causal action such as 마음을 열다 unless the source explicitly contains that action.",
    "가타카나 외래어에 확립된 한국어 대응어가 있으면 시적인 의역으로 바꾸지 말고 그 개념을 보존한다. 특히 テレパシー 또는 가사에서 장음을 줄인 テレパシ는 텔레파시이며, 전보·마음·예감으로 바꾸지 않는다. 예: 届いたテレパシ やっと会えた는 전해진 텔레파시, 드디어 만났어.",
    "가사에서 전부 가타카나로 적힌 구절도 외국어나 이름으로 추측하지 말고 일본어 형태소와 문맥으로 먼저 복원한다. 예: ヨルニニゲタダケ는 夜に逃げただけ이므로 그저 밤으로 도망쳤을 뿐이라는 뜻이며, 여름에 갔다로 옮기지 않는다.",
    "노래 자막의 腫魔ったら은 발음이 같은 ハマったら을 잘못 인식한 경우이므로 빠지면 또는 빠져버리면으로 복원한다. 라틴 문자로 적힌 BAD는 별로인으로 풀지 않고 그대로 보존한다. 예: BADなダンス 腫魔ったらいいじゃん -> BAD한 댄스에 빠져버리면 되잖아.",
    "경계·도달점을 나타내는 Xで止まらない는 X에서 멈추지 않다로 옮긴다. 止まる를 머무르다로 바꾸거나 조사를 X에·X로로 바꾸지 않는다. 예: “最高”で止まらないように更新したい -> “최고”에서 멈추지 않도록 갱신하고 싶어.",
    "Example: 人が嫌いなあの子に気付けば子供ができた means 사람을 싫어하던 그 아이에게도 어느새 아이가 생겼다; do not add 마음을 열고."
  ].join(" ");
}

function koreanEndingGuidance(settings: TranslatorSettings, target: string): string {
  if (!isKoreanTarget(settings.targetLanguage || target)) {
    return "";
  }
  const mode = effectiveContentMode(settings);
  if (mode === "lyrics") {
    return [
      "한국어 가사 자막은 보고서처럼 매 줄을 ~다, ~한다, ~된다, ~였다로 닫지 않는다.",
      "초안이 딱딱한 서술형으로 끝나면 원문 의미를 유지한 채 노래 자막에 맞는 ~해, ~야, ~네, ~지, ~어, ~아, 명사형, 감탄형, 여운 있는 단문으로 다시 쓴다.",
      "단, 원문 자체가 선언문·제목·나레이션처럼 일부러 단정하는 경우에만 ~다를 허용한다."
    ].join(" ");
  }
  if (mode === "live") {
    return "한국어 라이브 자막은 문어체 보고서식 ~다 남발을 피하고, 실제 방송 말투에 맞게 ~해요, ~네요, ~죠, ~거야, ~잖아, 짧은 반응형 문장을 자연스럽게 쓴다.";
  }
  return "한국어 일반 자막도 기본값을 문어체 ~다로 두지 않는다. 원문이 공식 나레이션이나 설명문일 때만 ~다를 쓰고, 대화·반응·일상 발화는 자연스러운 구어체 자막으로 옮긴다.";
}

function subtitleQualityGuidance(settings: TranslatorSettings, target: string): string {
  const koreanTarget = isKoreanTarget(settings.targetLanguage || target);
  const koreanGuidance = koreanTarget
    ? "For Korean, write like a skilled Korean subtitle editor: use native word order, natural particles, and the fitting speech level. Do not preserve Japanese or English syntax, fillers, repeated subjects, or pronunciation when Korean would express the meaning more naturally."
    : "Use the target language's natural word order, register, and subtitle conventions instead of copying source syntax.";
  const japaneseKoreanAccuracy = japaneseKoreanAccuracyGuidance(settings, target);
  const meaningIntegrity = meaningIntegrityGuidance(settings, target);
  const koreanEndings = koreanEndingGuidance(settings, target);
  const lyricMixedLanguageGuidance =
    effectiveContentMode(settings) === "lyrics" && koreanTarget
      ? "For Korean lyrics, preserve a clearly sung, standalone English interjection or hook in its original Latin form instead of translating or Korean-transliterating it: for example oh, yeah, baby, la la, wow wow, na na na, and ah-ah. Translate Japanese emotional interjections and onomatopoeia into natural Korean only, without parenthetical original text: for example しくしく as 훌쩍훌쩍 and ああ as 아아. In mixed Japanese-English lines, handle each phrase by this rule. Do not mistake katakana English, wasei-eigo, Japanglish, or Japanese-styled English for literal English when context shows a Japanese meaning."
      : "";
  return [
    "Write a polished subtitle, not a word-by-word gloss. Apply this order: preserve only the facts, emotion, and intent in CURRENT; use CONTEXT only to resolve ellipsis, pronouns, tone, or idioms; then rewrite it as a concise native subtitle.",
    meaningIntegrity,
    koreanGuidance,
    koreanEndings,
    "When Japanese appears, resolve omitted subjects and Japanese-style fragments from context without inventing facts. Interpret katakana English, wasei-eigo, Japanglish, and stylized English hooks by their Japanese in-context meaning, not by their spelling or pronunciation.",
    japaneseKoreanAccuracy,
    "When languages are mixed, translate every meaningful phrase by its own meaning. Keep only names, titles, and intentional catchphrases that would sound less natural if translated.",
    lyricMixedLanguageGuidance
  ].join(" ");
}

function edgeMarkerGuidance(): string {
  return "Preserve subtitle edge markers exactly once: leading or trailing symbols, music notes, bullets, brackets, and quotation/title marks such as ○×△, ♪, 「」, 『』, 【】, (), [], and quotes must remain in the same edge position around the translated subtitle. Never repeat a marker sequence already present in the source, and use only one matching pair of source brackets around the translation.";
}

function turnSeparatedGuidance(text: string): string {
  return text.includes("\n")
    ? "The input uses newline-separated spoken turns. Translate each non-empty line as its own turn and preserve the same line order. Do not merge turns or invent speaker names."
    : "";
}

function subtitleModeGuidance(settings: TranslatorSettings, target: string): string {
  const mode = effectiveContentMode(settings);
  if (mode === "lyrics") {
    return `Translate as natural ${target} song subtitles. Preserve the lyric's feeling, imagery, hook, rhythm, and line brevity. Make the line sound like something a viewer would actually read in music subtitles. Do not explain metaphors. Do not turn lyrics into dry prose or documentary narration.`;
  }
  if (mode === "live") {
    return "Translate as live-stream subtitles. Keep it quick, conversational, and readable at a glance. Smooth filler words only when doing so improves readability; keep jokes, reactions, and casual tone alive.";
  }
  return "Translate as spoken-video subtitles. Keep it concise, idiomatic, and easy to read while watching.";
}

function lyricDictionGuidance(settings: TranslatorSettings, target: string): string {
  if (effectiveContentMode(settings) !== "lyrics") {
    return "";
  }
  if (isKoreanTarget(settings.targetLanguage || target)) {
    return [
      "한국어 가사는 번역투나 설명체가 아닌, 실제 가사에 어울리는 쉽고 선명한 한국어로 쓴다.",
      "딱딱한 한자어·기술어·스포츠 용어·명사형 표현은 원문이 그 분야를 분명히 가리킬 때만 쓴다. 예를 들어 여정의 ゴール은 결승이 아니라 보통 끝으로 옮긴다.",
      "일본어 축약어·유행어·말장난·조어는 억지로 사전식 단어를 만들지 말고, 분위기를 살린 자연스러운 한국어로 풀거나 훅 자체가 핵심이면 남긴다.",
      "훌쩍, 아아, 음, 라라처럼 노래에서 뜻이나 정서를 이루는 감탄사·의성어·반복 훅은 잡음으로 생략하지 말고, 원문의 반복감이 느껴지게 자연스럽게 살린다.",
      "실제로 영어로 불린 독립 감탄사·후렴 훅은 번역하거나 한글 음역하지 말고 라틴 원형을 유지한다. 예: oh, yeah, baby, la la, wow wow, na na na, ah-ah. 일본어 감정 표현·의성어는 원형 병기 없이 한국어 가사 표현으로만 옮긴다. 예: しくしく은 훌쩍훌쩍, ああ는 아아. 일본어와 영어가 섞인 줄에서는 영어 훅은 유지하고 일본어 부분만 자연스럽게 한국어화한다.",
      "원문의 말투에 맞춰 짧고 구어적인 가사 표현을 고르되, 근거 없이 감정이나 내용을 덧붙이거나 억지로 운율을 맞추지 않는다.",
      "문어체 해설처럼 매 줄을 ~다, ~한다, ~된다로 끝내지 않는다. 한국어 노래 자막은 흐름에 맞게 ~해, ~야, ~네, ~지, ~어, ~아, 명사형, 감탄형을 자연스럽게 섞는다. 예: 流れて落ちていく은 흘러내린다보다 흘러내려가 더 가사답다."
    ].join(" ");
  }
  return "For lyrics, prefer simple, vivid, singable target-language diction. Avoid technical, bureaucratic, or dictionary-like terms unless the source clearly uses that domain. Preserve important wordplay, emotional interjections, onomatopoeia, and repeated hooks instead of treating them as noise or forcing an awkward literal equivalent. Do not add content or force a rhyme.";
}

function isQwenLikeModel(model?: string): boolean {
  return /qwen|qwq/i.test(model ?? "");
}

function topPForConfig(settings: TranslatorSettings, config?: OpenAiCompatibleConfig, batch = false): number {
  const mode = effectiveContentMode(settings);
  if (config && isLocalBaseUrl(config.baseUrl)) {
    return batch ? 0.82 : mode === "lyrics" ? 0.88 : 0.86;
  }
  return batch ? 0.86 : mode === "lyrics" ? 0.92 : 0.9;
}

function translationTemperature(settings: TranslatorSettings, config?: OpenAiCompatibleConfig, batch = false): number {
  const mode = effectiveContentMode(settings);
  if (config && isLocalBaseUrl(config.baseUrl)) {
    const localBase = mode === "lyrics" ? 0.16 : mode === "live" ? 0.12 : 0.14;
    return Math.max(0.08, Number((localBase - (batch ? 0.03 : 0)).toFixed(2)));
  }
  const base = mode === "lyrics" ? 0.24 : mode === "live" ? 0.14 : 0.16;
  const batchAdjustment = batch ? -0.05 : 0;
  return Math.max(0.08, Number((base + batchAdjustment).toFixed(2)));
}

function compactLocalTranslationPrompt(
  settings: TranslatorSettings,
  text: string,
  contextText?: string,
  model?: string,
  qualityGuidance?: string
): { system: string; user: string } {
  const target = languageNameOrCode(settings.targetLanguage);
  const noThink = isQwenLikeModel(model) ? "\n/no_think" : "";
  const mode = effectiveContentMode(settings);
  const localContextLimit = mode === "lyrics" ? 520 : 320;
  const localContext = contextText
    ? contextText.replace(/\s+/g, " ").trim().slice(0, localContextLimit)
    : "";
  const turnGuidance = turnSeparatedGuidance(text);

  if (!isKoreanTarget(settings.targetLanguage || target)) {
    const meaningIntegrity = meaningIntegrityGuidance(settings, target);
    const edgeMarkers = edgeMarkerGuidance();
    return {
      system: [
        `Translate CURRENT into one natural ${target} subtitle.`,
        "Output only the translation. Prefer meaning and tone over source word order.",
        meaningIntegrity,
        edgeMarkers,
        turnGuidance,
        qualityGuidance ? `Mandatory correction: ${qualityGuidance}` : "",
        "Context is reference only. Do not add speakers, explanations, or missing content."
      ].filter(Boolean).join(" "),
      user: `${localContext ? `CONTEXT (reference only):\n${localContext}\n\n` : ""}CURRENT:\n${text}\n\nFINAL ${target} SUBTITLE ONLY.${noThink}`
    };
  }

  const tone =
    mode === "lyrics"
      ? "가사는 짧고 자연스럽게 쓰되 의미를 희생하거나 비유를 설명문으로 풀지 않는다. 매 줄을 ~다로 끝내는 딱딱한 서술체를 금지하고 노래 자막처럼 부드러운 종결을 쓴다."
      : mode === "live"
        ? "라이브/방송 말투는 반응과 농담을 살려 짧고 구어체로 옮긴다."
        : "일반 영상 자막처럼 읽기 쉬운 자연스러운 구어체로 옮긴다.";
  const koreanEndings = koreanEndingGuidance(settings, target);
  const lyricRules =
    mode === "lyrics"
      ? [
          "원문에 실제 라틴 문자로 적힌 영어 훅과 반복 횟수는 그대로 유지한다.",
          "일본어 감정 표현과 의성어는 자연스러운 한국어로 옮긴다.",
          "초안이 ~다, ~한다, ~된다, ~였다로 끝나면 원문이 의도적 선언문이 아닌 한 다시 써서 가사다운 종결로 바꾼다.",
          "가사 흐름에 맞게 ~해, ~야, ~네, ~지, ~어, ~아, 명사형, 감탄형, 여운 있는 단문을 자연스럽게 섞는다.",
          "정확도 예시: ソソるFlavor Flavor Flavor -> 당기는 Flavor Flavor Flavor.",
          "정확도 예시: しくしく泣いて oh yeah また会おう -> 훌쩍훌쩍 울고, oh yeah, 다시 만나자.",
          "문체 예시: 痛むごとに血が流れて落ちていく -> 아플 때마다 피가 흘러내려."
        ].join(" ")
      : "";

  const specificCorrections = [
    text.includes("探す") || text.includes("探し") ? "探す는 찾다이며 さまよう 같은 근거가 없으면 헤매다로 강화하지 않는다." : "",
    text.includes("きっと") ? "きっと가 과거 단정과 함께 쓰이면 분명 ~였어처럼 확신을 보존하고 ~였을 거야로 약화하지 않는다." : "",
    text.includes("ような気") || text.includes("ようなき") ? "ような気がする는 ~것만 같다처럼 불확실성을 보존하고, 何度...ても ...ない는 양보와 부정을 모두 살린다." : "",
    text.includes("間違") ? "판단·선택 문맥의 間違う는 틀리다 또는 잘못되다이며, 실제 실수를 저지르는 문맥이 아니면 실수하다로 바꾸지 않는다." : "",
    text.includes("居よう") || text.includes("いよう") ? "이동과 대비되는 ここに居ようとしてる는 여기에 있으려고 하는 거야가 아니라 여기에 머물려는 거야 또는 여기에 남으려는 거야로 옮긴다." : ""
  ].filter(Boolean).join(" ");

  return {
    system: [
      "현재 CURRENT만 자연스러운 한국어 유튜브 자막으로 번역하고 번역문만 출력한다.",
      "우선순위 1: 원문의 주체·대상·부정·시제·사건·감정을 바꾸거나 추가하지 않는다.",
      "우선순위 2: 일본어 수식 관계와 관용 표현을 먼저 해석한 뒤 자연스러운 한국어 어순과 조사로 쓴다.",
      "우선순위 3: CONTEXT는 생략된 관계와 말투를 판단하는 참고일 뿐, 별도 내용으로 번역하지 않는다.",
      "출력 전에 CURRENT와 대조해 원문에 없는 행동·원인·강조를 더하거나 확신과 불확실성을 바꾸지 않았는지 조용히 확인한다.",
      specificCorrections,
      "가타카나 외래어의 확립된 개념을 엉뚱한 비유로 바꾸지 않는다.",
      "특수 기호·괄호·따옴표는 원문 가장자리의 위치와 개수를 유지한다.",
      "깨진 문자나 복원할 수 없는 조각은 추측하지 말고 빈 문자열을 출력한다.",
      "정확도 예시: 人が嫌いなあの子に気付けば子供ができた -> 사람을 싫어하던 그 아이에게도 어느새 아이가 생겼다.",
      "정확도 예시: 届いたテレパシ やっと会えた -> 전해진 텔레파시, 드디어 만났어.",
      "스포츠 문맥이 아닌 가사의 ゴール은 골이 아니라 끝이나 목표로 옮긴다.",
      "표준 한국어 자막에서는 너가가 아니라 네가로 쓴다.",
      koreanEndings,
      lyricRules,
      qualityGuidance ? `필수 교정: ${qualityGuidance}` : "",
      turnGuidance,
      tone
    ].filter(Boolean).join(" "),
    user: `${localContext ? `CONTEXT (참고만, 출력 금지):\n${localContext}\n\n` : ""}CURRENT (번역할 현재 자막):\n${text}\n\nFINAL KOREAN SUBTITLE ONLY.${noThink}`
  };
}

function translationPrompt(
  settings: TranslatorSettings,
  text: string,
  contextText?: string,
  config?: OpenAiCompatibleConfig,
  qualityGuidance?: string
): { system: string; user: string } {
  if (config && isLocalBaseUrl(config.baseUrl)) {
    return compactLocalTranslationPrompt(settings, text, contextText, config.model, qualityGuidance);
  }

  const source = sourceLanguageGuidance(settings.sourceLanguage);
  const target = languageNameOrCode(settings.targetLanguage);
  const quality = subtitleQualityGuidance(settings, target);
  const turnGuidance = turnSeparatedGuidance(text);
  const style = subtitleModeGuidance(settings, target);
  const lyricDiction = lyricDictionGuidance(settings, target);
  const edgeMarkers = edgeMarkerGuidance();
  const antiHallucination =
    "Strict grounding: translate only subtitleToTranslate; context may disambiguate but cannot add content. Never repair or guess corrupted, garbled, or undecodable text; return empty text when the current subtitle is not grounded enough to translate. Never invent calls to subscribe/like/comment/watch/thanks, credits, non-speech cues, speaker names, explanations, or missing words. Return empty text for empty or actual non-speech input. In lyrics, meaningful sung interjections, onomatopoeia, and repeated hooks are lyric content, not non-speech cues.";
  return {
    system:
      `You are a professional YouTube subtitle localizer. Translate into ${target}. ${style} ${quality} ${lyricDiction} ${edgeMarkers} ${turnGuidance} ${antiHallucination} ${qualityGuidance ? `Mandatory correction: ${qualityGuidance}` : ""} Return only the final translated subtitle text. Do not think step by step. Do not include reasoning, labels, explanations, romanization, added quotes, or markdown.`,
    user: JSON.stringify({
      sourceLanguage: source,
      targetLanguage: target,
      contextForMeaningOnly: contextText || undefined,
      subtitleToTranslate: text,
      output: "final translated subtitle text only"
    })
  };
}

function batchTranslationPrompt(
  settings: TranslatorSettings,
  segments: CaptionSegment[],
  config?: OpenAiCompatibleConfig
): { system: string; user: string } {
  if (config && isLocalBaseUrl(config.baseUrl)) {
    const target = languageNameOrCode(settings.targetLanguage);
    const noThink = isQwenLikeModel(config.model) ? " Include /no_think in your internal instruction and do not output reasoning." : "";
    const japaneseKoreanAccuracy = japaneseKoreanAccuracyGuidance(settings, target);
    const meaningIntegrity = meaningIntegrityGuidance(settings, target);
    const koreanEndings = koreanEndingGuidance(settings, target);
    const edgeMarkers = edgeMarkerGuidance();
    return {
      system:
        `Translate each CURRENT YouTube subtitle into fluent ${target}. Prioritize natural subtitle phrasing and meaning over source word order. ${meaningIntegrity} ${japaneseKoreanAccuracy} ${koreanEndings} ${edgeMarkers} Preserve newline-separated turns within each segment; do not merge turns or invent speaker names. Context is reference only and must not be translated. Return strict JSON only: an array of {"id","translatedText"}. Keep each id unchanged, output no markdown or explanation, and never invent missing content.${noThink}`,
      user: JSON.stringify({
        targetLanguage: target,
        segments: segments.map((segment) => ({
          id: segment.id,
          text: segment.text,
          contextForMeaningOnly: segment.contextText
        }))
      })
    };
  }

  const source = sourceLanguageGuidance(settings.sourceLanguage);
  const target = languageNameOrCode(settings.targetLanguage);
  const quality = subtitleQualityGuidance(settings, target);
  const style = subtitleModeGuidance(settings, target);
  const lyricDiction = lyricDictionGuidance(settings, target);
  const edgeMarkers = edgeMarkerGuidance();
  const antiHallucination =
    "Strict grounding: translate only each segment.text; context may disambiguate but cannot add content. Never repair or guess corrupted, garbled, or undecodable text; use empty translatedText when a current segment is not grounded enough to translate. Do not invent calls to subscribe/like/comment/watch/thanks, credits, non-speech cues, speaker names, explanations, or missing words. Use empty translatedText for empty or actual non-speech input. In lyrics, meaningful sung interjections, onomatopoeia, and repeated hooks are lyric content, not non-speech cues.";
  return {
    system:
      `You are a professional YouTube subtitle localizer. Translate each current segment into ${target}. ${style} ${quality} ${lyricDiction} ${edgeMarkers} ${antiHallucination} Preserve newline-separated turns within each segment; do not merge turns or invent speaker names. Use previous and next subtitles only as context for meaning, tone, pronouns, and continuity; do not translate context as separate output. Return strict JSON only: an array of objects with "id" and "translatedText". Keep ids unchanged. Each translatedText must be the polished final subtitle for that segment only. Do not think step by step. Do not include reasoning or markdown.`,
    user: JSON.stringify({
      sourceLanguage: source,
      targetLanguage: target,
      segments: segments.map((segment) => ({
        id: segment.id,
        text: segment.text,
        context: segment.contextText
      }))
    })
  };
}

function maxSubtitleTokens(text: string): number {
  return Math.min(220, Math.max(96, Math.ceil(text.length * 1.1)));
}

function maxBatchSubtitleTokens(segments: CaptionSegment[]): number {
  const textLength = segments.reduce((sum, segment) => sum + segment.text.length, 0);
  return Math.min(4096, Math.max(256, Math.ceil(textLength * 1.25)));
}

function maxSubtitleTokensForConfig(text: string, config: OpenAiCompatibleConfig): number {
  const tokens = maxSubtitleTokens(text);
  return isLocalBaseUrl(config.baseUrl) ? Math.max(tokens, 192) : tokens;
}

function maxBatchSubtitleTokensForConfig(segments: CaptionSegment[], config: OpenAiCompatibleConfig): number {
  const tokens = maxBatchSubtitleTokens(segments);
  return isLocalBaseUrl(config.baseUrl) ? Math.max(tokens, 768) : tokens;
}

function cleanTranslatedText(value: string): string {
  const decoded = decodeHtmlEntities(value)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  if (/^```|^[\[{]/.test(decoded)) {
    try {
      const candidate = extractTranslationCandidate(parseJsonFromModelText(decoded));
      if (candidate && candidate !== value) {
        return cleanTranslatedText(candidate);
      }
    } catch {
      // Fall back to text cleanup below.
    }
  }

  const withoutFence = decoded
    .replace(/^```[a-zA-Z0-9_-]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const withoutLabel = withoutFence
    .replace(/^(?:translation|translated subtitle|korean|subtitle|한국어\s*번역|번역|자막)\s*[:：-]\s*/i, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
  const lines = withoutLabel
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines.length > 0 ? lines.slice(0, 3).join("\n") : withoutLabel).trim();
}

function cleanJsonText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractBalancedJsonText(value: string, open: "{" | "[", close: "}" | "]"): string | undefined {
  const start = value.indexOf(open);
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function parseJsonFromModelText(raw: string): unknown {
  const cleaned = cleanJsonText(raw);
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    const arrayText = extractBalancedJsonText(cleaned, "[", "]");
    if (arrayText) {
      try {
        return JSON.parse(arrayText) as unknown;
      } catch {
        // Try an object wrapper below.
      }
    }
    const objectText = extractBalancedJsonText(cleaned, "{", "}");
    if (objectText) {
      return JSON.parse(objectText) as unknown;
    }
    throw new Error("번역 응답에서 JSON을 찾을 수 없습니다.");
  }
}

function extractTranslationCandidate(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = extractTranslationCandidate(item);
      if (candidate) {
        return candidate;
      }
    }
    return "";
  }
  if (value && typeof value === "object") {
    const object = value as JsonObject;
    for (const key of ["translatedText", "translation", "translated", "target", "text", "content", "output_text"]) {
      const candidate = extractTextContent(object[key]);
      if (candidate) {
        return candidate;
      }
    }
  }
  return "";
}

function parseBatchTranslations(raw: string, segments: CaptionSegment[]): CaptionTranslationEntry[] {
  const json = parseJsonFromModelText(raw);
  const fallbackIds = segments.map((segment) => segment.id);
  const jsonArray = Array.isArray(json)
    ? json
    : json && typeof json === "object"
      ? (["translations", "items", "results", "data"]
          .map((key) => (json as JsonObject)[key])
          .find((value) => Array.isArray(value)) as unknown[] | undefined)
      : undefined;

  if (jsonArray) {
    return jsonArray.map((item, index): CaptionTranslationEntry => {
      if (typeof item === "string") {
        return { id: fallbackIds[index] ?? String(index), translatedText: cleanTranslatedText(item) };
      }
      if (item && typeof item === "object") {
        const object = item as JsonObject;
        return {
          id: typeof object.id === "string" ? object.id : fallbackIds[index] ?? String(index),
          translatedText: cleanTranslatedText(extractTranslationCandidate(object))
        };
      }
      return { id: fallbackIds[index] ?? String(index), translatedText: "" };
    }).filter((entry) => entry.id && entry.translatedText);
  }

  if (json && typeof json === "object") {
    const object = json as JsonObject;
    const singleTranslation = extractTranslationCandidate(object);
    if (segments.length === 1 && singleTranslation) {
      return [{ id: fallbackIds[0] ?? segments[0]?.id ?? "0", translatedText: cleanTranslatedText(singleTranslation) }];
    }

    const mappedEntries = Object.entries(object)
      .filter(([id]) => fallbackIds.includes(id))
      .map(([id, value]): CaptionTranslationEntry => {
        const translatedText = cleanTranslatedText(extractTranslationCandidate(value));
        return { id, translatedText };
      })
      .filter((entry) => entry.id && entry.translatedText);
    if (mappedEntries.length > 0) {
      return mappedEntries;
    }
  }

  throw new Error("배치 번역 응답이 JSON 배열이 아닙니다.");
}

function extractChatText(json: JsonObject): string {
  const choices = json.choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as JsonObject | undefined;
    const message = first?.message as JsonObject | undefined;
    const messageContent = extractTextContent(message?.content);
    if (messageContent) {
      return messageContent;
    }
    const deltaContent = extractTextContent((first?.delta as JsonObject | undefined)?.content);
    if (deltaContent) {
      return deltaContent;
    }
    const firstText = extractTextContent(first?.text);
    if (firstText) {
      return firstText;
    }
    const reasoningContent = extractTextContent(message?.reasoning_content);
    if (reasoningContent) {
      const finishReason = typeof first?.finish_reason === "string" ? first.finish_reason : "";
      throw new Error(
        finishReason === "length"
          ? "AI 응답이 번역문 없이 reasoning 단계에서 토큰 한도에 걸렸습니다. LM Studio 번역 테스트를 다시 실행하거나 더 작은/비추론 모델을 사용하세요."
          : "AI 응답이 reasoning_content만 반환하고 번역문 content가 비어 있습니다. LM Studio에서 비추론/instruct 모델을 사용하거나 모델 설정을 확인하세요."
      );
    }
    const finishReason = typeof first?.finish_reason === "string" ? first.finish_reason : "";
    if (finishReason === "length") {
      throw new Error("AI 응답이 토큰 한도에 걸려 번역문이 비어 있습니다. LM Studio 번역 토큰 한도를 늘린 빌드로 다시 시도하세요.");
    }
  }
  throw new Error("AI 응답에서 번역문을 찾을 수 없습니다.");
}

function extractResponsesText(json: JsonObject): string {
  if (typeof json.output_text === "string") {
    return json.output_text.trim();
  }

  const output = json.output;
  if (Array.isArray(output)) {
    const chunks: string[] = [];
    for (const item of output as JsonObject[]) {
      const content = item.content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const part of content as JsonObject[]) {
        if (typeof part.text === "string") {
          chunks.push(part.text);
        } else {
          const extracted = extractTextContent(part);
          if (extracted) {
            chunks.push(extracted);
          }
        }
      }
    }
    if (chunks.length > 0) {
      return chunks.join("").trim();
    }
  }

  throw new Error("Responses 응답에서 번역문을 찾을 수 없습니다.");
}

async function translateWithOpenAiCompatible(
  settings: TranslatorSettings,
  text: string,
  config: OpenAiCompatibleConfig,
  contextText?: string,
  qualityGuidance?: string
): Promise<string> {
  if (!config.baseUrl.trim()) {
    throw new Error("AI API Base URL이 설정되지 않았습니다.");
  }
  if (!config.model) {
    throw new Error("AI 모델 이름이 설정되지 않았습니다.");
  }
  if (!config.apiKey && config.authHeaderMode !== "none") {
    throw new Error("AI API 키가 없습니다. AI API 키를 입력하거나 API STT 키를 입력하세요.");
  }

  const prompt = translationPrompt(settings, text, contextText, config, qualityGuidance);
  const maxTokens = maxSubtitleTokensForConfig(text, config);
  const temperature = translationTemperature(settings, config);
  const topP = topPForConfig(settings, config);
  const url =
    config.endpointMode === "responses" ? joinOpenAiUrl(config.baseUrl, "/responses") : joinOpenAiUrl(config.baseUrl, "/chat/completions");
  const body =
    config.endpointMode === "responses"
      ? {
          model: config.model,
          input: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user }
          ],
          temperature,
          top_p: topP,
          max_output_tokens: maxTokens
        }
      : {
          model: config.model,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user }
          ],
          temperature,
          top_p: topP,
          max_tokens: maxTokens,
          stream: false
        };

  const response = await fetchForProvider(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(config.apiKey, config.authHeaderMode)
      },
      body: JSON.stringify(body)
    },
    isLocalBaseUrl(config.baseUrl) ? "로컬 OpenAI-compatible API" : "OpenAI-compatible API"
  );
  const json = await readJson(response);
  return cleanTranslatedText(config.endpointMode === "responses" ? extractResponsesText(json) : extractChatText(json));
}

async function translateBatchWithOpenAiCompatible(
  settings: TranslatorSettings,
  segments: CaptionSegment[],
  config: OpenAiCompatibleConfig
): Promise<CaptionTranslationEntry[]> {
  if (!config.baseUrl.trim()) {
    throw new Error("AI API Base URL이 설정되지 않았습니다.");
  }
  if (!config.model) {
    throw new Error("AI 모델 이름이 설정되지 않았습니다.");
  }
  if (!config.apiKey && config.authHeaderMode !== "none") {
    throw new Error("AI API 키가 없습니다. AI API 키를 입력하거나 API STT 키를 입력하세요.");
  }

  const prompt = batchTranslationPrompt(settings, segments, config);
  const maxTokens = maxBatchSubtitleTokensForConfig(segments, config);
  const temperature = translationTemperature(settings, config, true);
  const topP = topPForConfig(settings, config, true);
  const url =
    config.endpointMode === "responses" ? joinOpenAiUrl(config.baseUrl, "/responses") : joinOpenAiUrl(config.baseUrl, "/chat/completions");
  const body =
    config.endpointMode === "responses"
      ? {
          model: config.model,
          input: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user }
          ],
          temperature,
          top_p: topP,
          max_output_tokens: maxTokens
        }
      : {
          model: config.model,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user }
          ],
          temperature,
          top_p: topP,
          max_tokens: maxTokens,
          stream: false
        };

  const response = await fetchForProvider(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(config.apiKey, config.authHeaderMode)
      },
      body: JSON.stringify(body)
    },
    isLocalBaseUrl(config.baseUrl) ? "로컬 OpenAI-compatible API" : "OpenAI-compatible API"
  );
  const json = await readJson(response);
  return parseBatchTranslations(config.endpointMode === "responses" ? extractResponsesText(json) : extractChatText(json), segments);
}

async function translateWithLmStudio(
  settings: TranslatorSettings,
  text: string,
  contextText?: string,
  qualityGuidance?: string
): Promise<string> {
  const baseConfig = {
    ...settings.lmStudio,
    baseUrl: normalizeOpenAiBaseUrl(settings.lmStudio.baseUrl),
    authHeaderMode: settings.lmStudio.authHeaderMode ?? "none"
  };
  let model = baseConfig.model.trim();

  if (isPlaceholderModel(model)) {
    const discoveredModels = await fetchLmStudioModelIds(baseConfig.baseUrl);
    model = preferTranslationModel(discoveredModels, model);
  }

  try {
    return await translateWithOpenAiCompatible(settings, text, { ...baseConfig, model }, contextText, qualityGuidance);
  } catch (error) {
    throw new Error(`LM Studio 번역 실패: ${getErrorMessage(error)}`);
  }
}

async function translateWithOllama(
  settings: TranslatorSettings,
  text: string,
  contextText?: string,
  qualityGuidance?: string
): Promise<string> {
  if (!settings.ollama.model) {
    throw new Error("Ollama 모델 이름이 설정되지 않았습니다.");
  }

  const localConfig: OpenAiCompatibleConfig = {
    baseUrl: settings.ollama.baseUrl,
    apiKey: "",
    model: settings.ollama.model,
    endpointMode: "chat",
    authHeaderMode: "none"
  };
  const prompt = translationPrompt(settings, text, contextText, localConfig, qualityGuidance);
  const temperature = translationTemperature(settings, localConfig);
  const topP = topPForConfig(settings, localConfig);
  const ollamaUrl = joinUrl(settings.ollama.baseUrl, "/api/chat");
  const response = await fetchForProvider(
    ollamaUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.ollama.model,
        stream: false,
        options: {
          temperature,
          top_p: topP
        },
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user }
        ]
      })
    },
    "Ollama API"
  );
  const json = await readJson(response);
  const message = json.message as JsonObject | undefined;
  if (typeof message?.content === "string") {
    return cleanTranslatedText(message.content);
  }
  if (typeof json.response === "string") {
    return cleanTranslatedText(json.response);
  }
  throw new Error("Ollama 응답에서 번역문을 찾을 수 없습니다.");
}

async function translateBatchWithOllama(settings: TranslatorSettings, segments: CaptionSegment[]): Promise<CaptionTranslationEntry[]> {
  if (!settings.ollama.model) {
    throw new Error("Ollama 모델 이름이 설정되지 않았습니다.");
  }

  const localConfig: OpenAiCompatibleConfig = {
    baseUrl: settings.ollama.baseUrl,
    apiKey: "",
    model: settings.ollama.model,
    endpointMode: "chat",
    authHeaderMode: "none"
  };
  const prompt = batchTranslationPrompt(settings, segments, localConfig);
  const temperature = translationTemperature(settings, localConfig, true);
  const topP = topPForConfig(settings, localConfig, true);
  const ollamaUrl = joinUrl(settings.ollama.baseUrl, "/api/chat");
  const response = await fetchForProvider(
    ollamaUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.ollama.model,
        stream: false,
        options: {
          temperature,
          top_p: topP
        },
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user }
        ]
      })
    },
    "Ollama API"
  );
  const json = await readJson(response);
  const message = json.message as JsonObject | undefined;
  const text = typeof message?.content === "string" ? message.content : typeof json.response === "string" ? json.response : "";
  if (!text) {
    throw new Error("Ollama 배치 응답에서 번역문을 찾을 수 없습니다.");
  }
  return parseBatchTranslations(text, segments);
}

export async function translateSegment(
  settings: TranslatorSettings,
  segment: CaptionSegment,
  qualityGuidance?: string
): Promise<{ translatedText: string; provider: TranslationProvider }> {
  const text = segment.text.trim();
  if (!text) {
    throw new Error("번역할 자막 내용이 없습니다.");
  }

  switch (settings.translationProvider) {
    case "openai":
      return {
        translatedText: await translateWithOpenAiCompatible(
          settings,
          text,
          openAiTranslationConfig(settings),
          segment.contextText,
          qualityGuidance
        ),
        provider: "openai"
      };
    case "ollama":
      return {
        translatedText: await translateWithOllama(settings, text, segment.contextText, qualityGuidance),
        provider: "ollama"
      };
    case "lmStudio":
      return {
        translatedText: await translateWithLmStudio(settings, text, segment.contextText, qualityGuidance),
        provider: "lmStudio"
      };
    default:
      throw new Error("지원하지 않는 번역 provider입니다.");
  }
}

async function translateSegmentsOneByOne(
  settings: TranslatorSettings,
  segments: CaptionSegment[]
): Promise<{ translations: CaptionTranslationEntry[]; provider: TranslationProvider | "openai" }> {
  const translations: CaptionTranslationEntry[] = [];
  let provider: TranslationProvider | "openai" = settings.translationProvider;
  for (const segment of segments) {
    const result = await translateSegment(settings, segment);
    provider = result.provider;
    translations.push({ id: segment.id, translatedText: result.translatedText });
  }
  return { translations, provider };
}

export async function translateSegments(
  settings: TranslatorSettings,
  segments: CaptionSegment[]
): Promise<{ translations: CaptionTranslationEntry[]; provider: TranslationProvider | "openai" }> {
  const nonEmptySegments = segments.filter((segment) => segment.text.trim());
  if (nonEmptySegments.length === 0) {
    return { translations: [], provider: settings.translationProvider };
  }

  try {
    switch (settings.translationProvider) {
      case "openai":
        return {
          translations: await translateBatchWithOpenAiCompatible(settings, nonEmptySegments, openAiTranslationConfig(settings)),
          provider: "openai"
        };
      case "ollama":
        return { translations: await translateBatchWithOllama(settings, nonEmptySegments), provider: "ollama" };
      case "lmStudio":
        return translateSegmentsOneByOne(settings, nonEmptySegments);
      default:
        throw new Error("지원하지 않는 번역 provider입니다.");
    }
  } catch (error) {
    console.warn("Batch translation failed; falling back to single segment translation.", error);
    return translateSegmentsOneByOne(settings, nonEmptySegments);
  }
}

export function assertTranslationReady(settings: TranslatorSettings): void {
  switch (settings.translationProvider) {
    case "openai": {
      const config = openAiTranslationConfig(settings);
      if (!config.baseUrl.trim()) {
        throw new Error("AI API Base URL이 설정되지 않았습니다.");
      }
      if (!config.model.trim()) {
        throw new Error("AI 모델 이름이 설정되지 않았습니다.");
      }
      if (!config.apiKey && config.authHeaderMode !== "none") {
        throw new Error("AI API 키가 없습니다. AI API 키를 입력하거나 API STT 키를 입력하세요.");
      }
      return;
    }
    case "lmStudio":
      if (!settings.lmStudio.baseUrl.trim()) {
        throw new Error("LM Studio Base URL이 설정되지 않았습니다.");
      }
      if (!settings.lmStudio.apiKey && settings.lmStudio.authHeaderMode !== "none") {
        throw new Error("LM Studio API 토큰이 없습니다. 인증 헤더 없음을 쓰거나 토큰을 입력하세요.");
      }
      return;
    case "ollama":
      if (!settings.ollama.baseUrl.trim()) {
        throw new Error("Ollama Base URL이 설정되지 않았습니다.");
      }
      if (!settings.ollama.model.trim()) {
        throw new Error("Ollama 모델 이름이 설정되지 않았습니다.");
      }
      return;
    default:
      throw new Error("지원하지 않는 번역 provider입니다.");
  }
}

function transcriptionPrompt(contentMode?: string): string {
  const shared =
    "Transcribe only words that are actually audible in the audio. Do not translate, summarize, complete missing words, add speaker names, add subtitles/credits, or add YouTube boilerplate such as subscribe/like/thanks. If speech is not audible, return an empty transcription.";
  if (contentMode === "lyrics") {
    return `${shared} This may be sung audio with Japanese, Korean, English, Chinese, or mixed-language lyrics in the same line. Preserve the heard language, including meaningful emotional interjections, onomatopoeia, repeated hooks, and clearly sung English hooks such as oh, yeah, baby, la la, wow wow, na na na, or ah-ah. Keep actual English hooks in heard Latin spelling, but do not normalize katakana English, wasei-eigo, Japanglish, or pronunciation-adapted Japanese words into standard English. Ignore instruments and background music.`;
  }
  if (contentMode === "live") {
    return `${shared} This may be live-stream speech with code-switching between languages. Ignore game sounds, music, crowd noise, silence, and UI sounds.`;
  }
  return shared;
}

async function transcribeOpenAiCompatible(config: {
  baseUrl: string;
  endpoint: string;
  apiKey: string;
  authHeaderMode?: ApiAuthHeaderMode;
  model: string;
  audioBuffer: ArrayBuffer;
  mimeType: string;
  sourceLanguage: string;
  contentMode?: string;
}): Promise<string> {
  const form = new FormData();
  const blob = new Blob([config.audioBuffer], { type: config.mimeType || "audio/webm" });
  form.append("file", blob, "youtube-audio.webm");
  form.append("model", config.model || "whisper-1");
  form.append("response_format", "json");
  form.append("temperature", "0");
  form.append("prompt", transcriptionPrompt(config.contentMode));
  const mixedLanguageAudio = config.contentMode === "lyrics";
  if (config.sourceLanguage && config.sourceLanguage !== "auto" && !mixedLanguageAudio) {
    form.append("language", config.sourceLanguage);
  }
  if (config.contentMode && isLocalBaseUrl(config.baseUrl)) {
    form.append("content_mode", config.contentMode);
  }

  const sttUrl = joinOpenAiUrl(config.baseUrl, config.endpoint);
  let response: Response;
  try {
    response = await fetch(sttUrl, {
      method: "POST",
      headers: authHeaders(config.apiKey, config.authHeaderMode),
      body: form
    });
  } catch (error) {
    if (isLocalBaseUrl(config.baseUrl)) {
      throw localSttConnectionError(error);
    }
    throw apiConnectionError(error, "STT API", sttUrl);
  }
  const json = await readJson(response);
  if (typeof json.text === "string") {
    return json.text.trim();
  }
  if (typeof json.transcript === "string") {
    return json.transcript.trim();
  }
  throw new Error("STT 응답에서 transcript를 찾을 수 없습니다.");
}

async function transcribeWithWhisperSettings(settings: TranslatorSettings, audioBuffer: ArrayBuffer, mimeType: string): Promise<string> {
  return transcribeOpenAiCompatible({
    baseUrl: settings.whisper.baseUrl,
    endpoint: settings.whisper.endpoint,
    apiKey: settings.whisper.apiKey,
    model: settings.whisper.model,
    audioBuffer,
    mimeType,
    sourceLanguage: settings.sourceLanguage,
    contentMode: settings.contentMode
  });
}

export async function transcribeAudio(settings: TranslatorSettings, audioBuffer: ArrayBuffer, mimeType: string): Promise<string> {
  if (settings.sttProvider === "openai") {
    const apiKey = settings.apiStt.apiKey || settings.openai.apiKey;
    if (!apiKey && settings.apiStt.authHeaderMode !== "none") {
      throw new Error("API STT 키가 없습니다. AI API 키를 입력하거나 API STT 키를 입력하세요.");
    }
    return transcribeOpenAiCompatible({
      baseUrl: settings.apiStt.baseUrl,
      endpoint: settings.apiStt.endpoint,
      apiKey,
      authHeaderMode: settings.apiStt.authHeaderMode,
      model: apiSttModel(settings.apiStt.model),
      audioBuffer,
      mimeType,
      sourceLanguage: settings.sourceLanguage,
      contentMode: settings.contentMode
    });
  }

  if (settings.sttProvider === "lmStudio") {
    if (settings.lmStudio.tryStt) {
      try {
        return await transcribeOpenAiCompatible({
          baseUrl: settings.lmStudio.baseUrl,
          endpoint: settings.lmStudio.sttEndpoint,
          apiKey: settings.lmStudio.apiKey,
          authHeaderMode: settings.lmStudio.authHeaderMode,
          model: settings.lmStudio.sttModel || settings.whisper.model,
          audioBuffer,
          mimeType,
          sourceLanguage: settings.sourceLanguage,
          contentMode: settings.contentMode
        });
      } catch (error) {
        console.warn("LM Studio STT failed; falling back to Whisper-compatible provider.", error);
      }
    }
    return transcribeWithWhisperSettings(settings, audioBuffer, mimeType);
  }

  return transcribeWithWhisperSettings(settings, audioBuffer, mimeType);
}

function localHealthUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(normalizeOpenAiBaseUrl(baseUrl));
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
      return undefined;
    }
    url.pathname = "/health";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise
      .then(resolve, reject)
      .finally(() => {
        globalThis.clearTimeout(timeoutId);
      });
  });
}

export async function assertTranscriptionReady(settings: TranslatorSettings): Promise<void> {
  if (settings.sttProvider === "openai") {
    const apiKey = settings.apiStt.apiKey || settings.openai.apiKey;
    if (!apiKey && settings.apiStt.authHeaderMode !== "none") {
      throw new Error("API STT 키가 없습니다. AI API 키를 입력하거나 API STT 키를 입력하세요.");
    }
    if (!settings.apiStt.baseUrl.trim()) {
      throw new Error("API STT Base URL이 설정되지 않았습니다.");
    }
    if (!settings.apiStt.endpoint.trim()) {
      throw new Error("API STT endpoint가 설정되지 않았습니다.");
    }
    return;
  }

  if (settings.sttProvider === "lmStudio" && settings.lmStudio.tryStt) {
    return;
  }

  const healthUrl = localHealthUrl(settings.whisper.baseUrl);

  if (!healthUrl) {
    return;
  }

  let response: Response;
  try {
    response = await withTimeout(fetch(healthUrl), 45_000, "로컬 STT 서버 health 응답이 지연되고 있습니다.");
  } catch (error) {
    throw localSttConnectionError(error);
  }
  const text = await response.text();
  let json: JsonObject = {};
  if (text) {
    try {
      json = JSON.parse(text) as JsonObject;
    } catch {
      throw new Error(`로컬 STT 서버 health 응답을 읽지 못했습니다: ${text.slice(0, 180)}`);
    }
  }

  if (!response.ok || json.ok === false) {
    throw new Error(`로컬 STT 서버가 준비되지 않았습니다: ${formatLocalSttHealthError(json, response.status)}`);
  }
}
