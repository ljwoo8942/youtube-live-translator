import type { LocalSttServerState } from "../shared/messages";
import { usesNativeSttEndpoint } from "../shared/localStt";
import type { TranslatorSettings } from "../shared/types";

const HOST_NAME = "com.yt_live_translator.stt";
const SUPPORTED_MODELS = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo", "qwen3-asr-0.6b", "qwen3-asr-1.7b"];
let port: chrome.runtime.Port | undefined;
let running: Extract<LocalSttServerState, { state: "running" }> | undefined;

export function getLocalSttServerState(): LocalSttServerState {
  return running ?? { state: port ? "starting" : "stopped" };
}

function disconnectedMessage(message?: string): string {
  if (message && /not found|not registered|access .*forbidden/i.test(message)) {
    return "로컬 STT 연결 프로그램을 등록하세요. 터미널에서 npm run stt:native:install -- <Chrome 확장 ID>를 실행하세요.";
  }
  return message ?? "로컬 STT 연결이 끊겼습니다.";
}

function request(connection: chrome.runtime.Port, command: object, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      connection.onMessage.removeListener(onMessage);
      connection.onDisconnect.removeListener(onDisconnect);
    };
    const onMessage = (message: unknown) => {
      cleanup();
      const reply = message as Record<string, unknown> | null;
      if (reply?.ok === true) resolve(reply);
      else reject(new Error(typeof reply?.error === "string" ? reply.error : "로컬 STT 연결 프로그램의 응답이 올바르지 않습니다."));
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error(disconnectedMessage(chrome.runtime.lastError?.message)));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("로컬 STT 서버 응답 시간이 초과됐습니다."));
    }, timeoutMs);
    connection.onMessage.addListener(onMessage);
    connection.onDisconnect.addListener(onDisconnect);
    try {
      connection.postMessage(command);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function disconnect(connection: chrome.runtime.Port): void {
  if (port === connection) {
    port = undefined;
    running = undefined;
    connection.disconnect();
  }
}

export async function startLocalSttServer(settings: TranslatorSettings): Promise<LocalSttServerState> {
  if (running) return running;
  const model = settings.whisper.model;
  if (!SUPPORTED_MODELS.includes(model)) {
    throw new Error("전체 설정에서 지원하는 Whisper 또는 Qwen 모델을 선택하고 저장하세요.");
  }
  if (!usesNativeSttEndpoint(settings)) {
    throw new Error("전체 설정에서 로컬 STT (Whisper / Qwen)와 기본 8765번 STT 주소를 선택하고 저장하세요.");
  }
  if (port) throw new Error("로컬 STT 서버를 시작하는 중입니다.");
  const connection = chrome.runtime.connectNative(HOST_NAME);
  port = connection;
  connection.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port === connection) {
      port = undefined;
      running = undefined;
    }
  });
  try {
    const reply = await request(connection, { action: "start", model }, 120_000);
    if (port !== connection || reply.state !== "running" || reply.model !== model ||
        typeof reply.device !== "string" || typeof reply.computeType !== "string") {
      throw new Error("로컬 STT 서버 시작 응답이 올바르지 않습니다.");
    }
    running = { state: "running", model, device: reply.device, computeType: reply.computeType };
    return running;
  } catch (error) {
    disconnect(connection);
    throw error;
  }
}

export async function stopLocalSttServer(): Promise<LocalSttServerState> {
  const connection = port;
  if (!connection) return { state: "stopped" };
  try {
    const reply = await request(connection, { action: "stop" }, 10_000);
    if (reply.state !== "stopped") throw new Error("로컬 STT 서버 중지 응답이 올바르지 않습니다.");
    return { state: "stopped" };
  } finally {
    disconnect(connection);
  }
}
