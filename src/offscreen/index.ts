import type { MessageResponse, RuntimeMessage } from "../shared/messages";

let activeStream: MediaStream | undefined;
let mediaRecorder: MediaRecorder | undefined;
let audioContext: AudioContext | undefined;
let processorNode: ScriptProcessorNode | undefined;
let silentGain: GainNode | undefined;
let sttSocket: WebSocket | undefined;
let activeTabId: number | undefined;
let chunkTimer: number | undefined;
let activeAudioChunkMs = 8000;
let activeMode: "stream" | "chunk" | undefined;
let cyclingRecorder = false;
let stoppingCapture = false;
let streamSequence = 0;
let streamFrameCount = 0;
let lastClientStreamStatusAt = 0;
const discardedRecorders = new WeakSet<MediaRecorder>();

type StreamingConfig = {
  endpoint: string;
  model: string;
  sourceLanguage: string;
  contentMode: string;
  speakerTurnDetection: boolean;
};

function chooseMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", ""];
  return candidates.find((candidate) => !candidate || MediaRecorder.isTypeSupported(candidate)) ?? "";
}

async function relayStatus(state: string, error?: string, tabId = activeTabId, statusText?: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "AUDIO_CAPTURE_STATUS", state, error, tabId, statusText });
  } catch (sendError) {
    console.debug("Audio capture status relay failed", sendError);
  }
}

function clearChunkTimer(): void {
  if (chunkTimer !== undefined) {
    window.clearTimeout(chunkTimer);
    chunkTimer = undefined;
  }
}

function stopRecorderForChunk(): void {
  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    return;
  }
  cyclingRecorder = true;
  mediaRecorder.stop();
}

function scheduleChunkStop(): void {
  clearChunkTimer();
  chunkTimer = window.setTimeout(stopRecorderForChunk, activeAudioChunkMs);
}

async function sendAudioBlob(blob: Blob, mimeType: string, tabId: number): Promise<void> {
  if (!blob.size) {
    return;
  }

  const audioBase64 = await blobToBase64(blob);
  if (!audioBase64) {
    return;
  }

  await chrome.runtime.sendMessage<MessageResponse>({
    type: "AUDIO_CHUNK",
    tabId,
    audioBase64,
    mimeType: blob.type || mimeType || "audio/webm"
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("오디오 청크를 base64로 변환하지 못했습니다."));
    });
    reader.readAsDataURL(blob);
  });
}

function startRecorderCycle(): void {
  if (!activeStream || !activeTabId) {
    return;
  }

  activeMode = "chunk";
  const tabIdForRecorder = activeTabId;
  const mimeType = chooseMimeType();
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(activeStream, mimeType ? { mimeType } : undefined);
  mediaRecorder = recorder;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) {
      chunks.push(event.data);
    }
  });

  recorder.addEventListener("stop", () => {
    const shouldRestart = cyclingRecorder && Boolean(activeStream && activeTabId === tabIdForRecorder);
    const shouldDiscard = discardedRecorders.has(recorder);
    cyclingRecorder = false;
    discardedRecorders.delete(recorder);

    if (!shouldDiscard) {
      void sendAudioBlob(new Blob(chunks, { type: mimeType || chunks[0]?.type || "audio/webm" }), mimeType, tabIdForRecorder).catch(
        (error) => {
          console.debug("Audio chunk relay failed", error);
        }
      );
    }

    if (shouldRestart) {
      startRecorderCycle();
    }
  });

  recorder.addEventListener("error", (event) => {
    const message = event.error?.message ?? "MediaRecorder 오류가 발생했습니다.";
    void stopCapture()
      .then((stoppedTabId) => relayStatus("error", message, stoppedTabId))
      .catch((error) => {
        void relayStatus("error", error instanceof Error ? error.message : String(error));
      });
  });

  recorder.start();
  scheduleChunkStop();
}

function streamUrl(config: StreamingConfig): string | undefined {
  try {
    const url = new URL(config.endpoint);
    if (config.model) {
      url.searchParams.set("model", config.model);
    }
    const mixedLanguageAudio = config.contentMode === "lyrics";
    if (config.sourceLanguage && config.sourceLanguage !== "auto" && !mixedLanguageAudio) {
      url.searchParams.set("language", config.sourceLanguage);
    }
    if (config.contentMode) {
      url.searchParams.set("content_mode", config.contentMode);
    }
    if (config.speakerTurnDetection && config.contentMode !== "lyrics") {
      url.searchParams.set("speaker_turns", "1");
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === 16000) {
    return input;
  }

  const ratio = inputRate / 16000;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    output[index] = input[Math.min(input.length - 1, Math.floor(index * ratio))] ?? 0;
  }
  return output;
}

function pcm16Buffer(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return buffer;
}

function teardownStreamingNodes(): void {
  processorNode?.disconnect();
  silentGain?.disconnect();
  processorNode = undefined;
  silentGain = undefined;
  if (sttSocket && sttSocket.readyState <= WebSocket.OPEN) {
    sttSocket.close();
  }
  sttSocket = undefined;
  streamFrameCount = 0;
  lastClientStreamStatusAt = 0;
}

function startStreamingProcessor(source: MediaStreamAudioSourceNode, socket: WebSocket): void {
  if (!audioContext || !activeTabId) {
    return;
  }

  activeMode = "stream";
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const gain = audioContext.createGain();
  gain.gain.value = 0;
  processorNode = processor;
  silentGain = gain;

  processor.addEventListener("audioprocess", (event) => {
    if (socket.readyState !== WebSocket.OPEN || !audioContext) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleTo16k(input, audioContext.sampleRate);
    try {
      socket.send(pcm16Buffer(downsampled));
    } catch {
      return;
    }
    streamFrameCount += 1;
    const now = Date.now();
    if (now - lastClientStreamStatusAt > 3000) {
      lastClientStreamStatusAt = now;
      void relayStatus("recording", undefined, activeTabId, `브라우저 오디오 전송 중 (${streamFrameCount} frames)`);
    }
  });

  source.connect(processor);
  processor.connect(gain);
  gain.connect(audioContext.destination);
}

function relayStreamTranscript(payload: unknown, tabId: number): void {
  if (!payload || typeof payload !== "object") {
    return;
  }
  const object = payload as Record<string, unknown>;
  if (object.type === "error") {
    const text = typeof object.text === "string" ? object.text : "스트리밍 STT 오류가 발생했습니다.";
    void relayStatus("recording", undefined, tabId, `${text} HTTP STT fallback`);
    if (activeStream && activeTabId === tabId && activeMode === "stream") {
      teardownStreamingNodes();
      startRecorderCycle();
    }
    return;
  }
  if (object.type === "status") {
    const text = typeof object.text === "string" ? object.text : "스트리밍 STT 상태 확인 중";
    void relayStatus("recording", undefined, tabId, text);
    return;
  }
  const text = typeof object.text === "string" ? object.text.trim() : "";
  if (!text) {
    return;
  }
  const now = Date.now();
  const startMs = typeof object.start_ms === "number" ? Math.round(object.start_ms) : now;
  const endMs = typeof object.end_ms === "number" ? Math.round(object.end_ms) : now + 2200;
  const seq = typeof object.seq === "number" ? object.seq : streamSequence++;
  const isFinal = object.type === "final";
  void chrome.runtime.sendMessage<MessageResponse>({
    type: "STREAM_STT_TRANSCRIPT",
    tabId,
    isFinal,
    segment: {
      id: `stream-${seq}-${isFinal ? "final" : "partial"}`,
      source: "audioStt",
      startMs,
      endMs,
      text
    }
  }).catch((error) => {
    console.debug("Streaming STT transcript relay failed", error);
  });
}

async function startStreamingStt(source: MediaStreamAudioSourceNode, config: StreamingConfig): Promise<boolean> {
  if (!activeTabId || !config.endpoint) {
    return false;
  }

  const tabIdForSocket = activeTabId;
  const url = streamUrl(config);
  if (!url) {
    void relayStatus("recording", undefined, tabIdForSocket, "스트리밍 STT URL 오류, HTTP STT fallback");
    return false;
  }

  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch {
    void relayStatus("recording", undefined, tabIdForSocket, "스트리밍 STT 연결 생성 실패, HTTP STT fallback");
    return false;
  }
  socket.binaryType = "arraybuffer";
  sttSocket = socket;

  return new Promise((resolve) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.close();
        resolve(false);
      }
    }, 3500);

    socket.addEventListener("open", () => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      startStreamingProcessor(source, socket);
      void relayStatus("recording", undefined, tabIdForSocket, "로컬 스트리밍 STT 연결됨");
      resolve(true);
    });

    socket.addEventListener("message", (event) => {
      try {
        relayStreamTranscript(JSON.parse(String(event.data)), tabIdForSocket);
      } catch (error) {
        console.debug("Streaming STT message parse failed", error);
      }
    });

    socket.addEventListener("close", () => {
      if (!settled) {
        settled = true;
        window.clearTimeout(timeout);
        resolve(false);
        return;
      }
      if (!stoppingCapture && activeStream && activeTabId === tabIdForSocket && activeMode === "stream") {
        teardownStreamingNodes();
        startRecorderCycle();
        void relayStatus("recording", undefined, tabIdForSocket, "스트리밍 STT 끊김, HTTP STT fallback");
      }
    });

    socket.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        window.clearTimeout(timeout);
        resolve(false);
      }
    });
  });
}

async function stopCapture(): Promise<number | undefined> {
  const stoppedTabId = activeTabId;
  stoppingCapture = true;
  try {
    clearChunkTimer();
    cyclingRecorder = false;
    teardownStreamingNodes();
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      discardedRecorders.add(mediaRecorder);
      mediaRecorder.stop();
    }

    for (const track of activeStream?.getTracks() ?? []) {
      track.stop();
    }

    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close();
    }
  } finally {
    mediaRecorder = undefined;
    activeStream = undefined;
    audioContext = undefined;
    activeTabId = undefined;
    activeMode = undefined;
    activeAudioChunkMs = 8000;
    streamSequence = 0;
    stoppingCapture = false;
  }
  return stoppedTabId;
}

async function startCapture(
  tabId: number,
  streamId: string,
  audioChunkMs: number,
  useStreaming: boolean,
  streamingConfig: StreamingConfig
): Promise<void> {
  await stopCapture();
  activeTabId = tabId;
  activeAudioChunkMs = Math.max(1000, audioChunkMs);

  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  } as unknown as MediaStreamConstraints;

  activeStream = await navigator.mediaDevices.getUserMedia(constraints);

  audioContext = new AudioContext();
  if (audioContext.state === "suspended") {
    await audioContext.resume().catch(() => undefined);
  }
  const source = audioContext.createMediaStreamSource(activeStream);
  source.connect(audioContext.destination);

  if (useStreaming && (await startStreamingStt(source, streamingConfig))) {
    return;
  }

  startRecorderCycle();
  await relayStatus("recording", undefined, tabId, useStreaming ? "WebSocket 실패, HTTP STT fallback" : "음성 인식 중...");
}

chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
  const message = rawMessage as RuntimeMessage;

  void (async () => {
    try {
      if (message.type === "START_AUDIO_CAPTURE" && message.streamId && message.tabId) {
        await startCapture(message.tabId, message.streamId, message.audioChunkMs ?? 8000, Boolean(message.useStreaming), {
          endpoint: message.streamingSttEndpoint ?? "",
          model: message.streamingSttModel ?? "",
          sourceLanguage: message.sourceLanguage ?? "auto",
          contentMode: message.contentMode ?? "auto",
          speakerTurnDetection: Boolean(message.speakerTurnDetection)
        });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "STOP_AUDIO_CAPTURE") {
        const stoppedTabId = await stopCapture();
        await relayStatus("idle", undefined, stoppedTabId);
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "GET_OFFSCREEN_AUDIO_STATE") {
        sendResponse({
          ok: true,
          activeTabId,
          recording: Boolean(activeStream && activeTabId),
          mode: activeMode
        });
        return;
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      const stoppedTabId = await stopCapture();
      await relayStatus("error", messageText, stoppedTabId);
      sendResponse({ ok: false, error: messageText });
    }
  })();

  return true;
});
