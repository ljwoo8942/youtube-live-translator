import type { MessageResponse, RuntimeMessage } from "../shared/messages";

let activeStream: MediaStream | undefined;
let mediaRecorder: MediaRecorder | undefined;
let audioContext: AudioContext | undefined;
let audioSource: MediaStreamAudioSourceNode | undefined;
let processorNode: AudioWorkletNode | undefined;
let pcmWorkletLoaded = false;
let streamAudioRevision = 0;
let sttSocket: WebSocket | undefined;
let activeTabId: number | undefined;
let activeVideoId: string | undefined;
let chunkTimer: number | undefined;
let recorderRevision = 0;
let activeAudioChunkMs = 8000;
let activeMode: "stream" | "chunk" | undefined;
let cyclingRecorder = false;
let stoppingCapture = false;
let streamSequence = 0;
let streamFrameCount = 0;
let lastClientStreamStatusAt = 0;
let captureLifecycleQueue: Promise<void> = Promise.resolve();
const discardedRecorders = new WeakSet<MediaRecorder>();
const MAX_STREAM_BUFFER_BYTES = 32_000;

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

async function relayStatus(
  state: string,
  error?: string,
  tabId = activeTabId,
  statusText?: string,
  videoId = activeVideoId
): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "AUDIO_CAPTURE_STATUS", state, error, tabId, videoId, statusText });
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

function discardActiveRecorder(): void {
  recorderRevision += 1;
  clearChunkTimer();
  cyclingRecorder = false;
  const recorder = mediaRecorder;
  mediaRecorder = undefined;
  if (recorder && recorder.state !== "inactive") {
    discardedRecorders.add(recorder);
    recorder.stop();
  }
}

function scheduleChunkStop(): void {
  clearChunkTimer();
  chunkTimer = window.setTimeout(stopRecorderForChunk, activeAudioChunkMs);
}

async function sendAudioBlob(blob: Blob, mimeType: string, tabId: number, videoId: string, revision: number): Promise<void> {
  if (!blob.size) {
    return;
  }

  const audioBase64 = await blobToBase64(blob);
  if (!audioBase64 || revision !== recorderRevision) {
    return;
  }

  await chrome.runtime.sendMessage<MessageResponse>({
    type: "AUDIO_CHUNK",
    tabId,
    videoId,
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
  if (!activeStream || !activeTabId || !activeVideoId) {
    return;
  }

  activeMode = "chunk";
  const tabIdForRecorder = activeTabId;
  const videoIdForRecorder = activeVideoId;
  const revisionForRecorder = recorderRevision;
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
    const ownsRecorder = mediaRecorder === recorder;
    const shouldRestart =
      ownsRecorder && cyclingRecorder && Boolean(activeStream && activeTabId === tabIdForRecorder && activeVideoId === videoIdForRecorder);
    const shouldDiscard = discardedRecorders.has(recorder) || revisionForRecorder !== recorderRevision;
    if (ownsRecorder) cyclingRecorder = false;
    discardedRecorders.delete(recorder);

    if (!shouldDiscard) {
      void sendAudioBlob(
        new Blob(chunks, { type: mimeType || chunks[0]?.type || "audio/webm" }),
        mimeType,
        tabIdForRecorder,
        videoIdForRecorder,
        revisionForRecorder
      ).catch((error) => {
        console.debug("Audio chunk relay failed", error);
      });
    }

    if (shouldRestart) {
      startRecorderCycle();
    }
  });

  recorder.addEventListener("error", (event) => {
    const message = event.error?.message ?? "MediaRecorder 오류가 발생했습니다.";
    void enqueueCaptureLifecycle(() => stopCaptureIfSession(tabIdForRecorder, videoIdForRecorder))
      .then((stopped) => relayStatus("error", message, stopped.tabId, undefined, stopped.videoId))
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
    if (config.sourceLanguage && config.sourceLanguage !== "auto") {
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

function teardownStreamingNodes(): void {
  if (processorNode) {
    audioSource?.disconnect(processorNode);
    processorNode.disconnect();
    processorNode.port.onmessage = null;
    processorNode.port.close();
    processorNode = undefined;
  }
  const socket = sttSocket;
  sttSocket = undefined;
  if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
  streamAudioRevision = 0;
  streamFrameCount = 0;
  lastClientStreamStatusAt = 0;
}

function startStreamingProcessor(source: MediaStreamAudioSourceNode, socket: WebSocket): void {
  if (!audioContext) throw new Error("활성 오디오 컨텍스트가 없습니다.");
  const processor = new AudioWorkletNode(audioContext, "stt-pcm", {
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
    outputChannelCount: [1]
  });
  source.connect(processor);
  processor.connect(audioContext.destination);
  processorNode = processor;
  activeMode = "stream";
  const fallBackToRecorder = (statusText: string): void => {
    if (sttSocket !== socket) return;
    teardownStreamingNodes();
    startRecorderCycle();
    void relayStatus("recording", undefined, activeTabId, statusText);
  };
  processor.addEventListener("processorerror", () => {
    fallBackToRecorder("스트리밍 오디오 처리 실패, HTTP STT fallback");
  });
  processor.port.onmessage = ({ data }: MessageEvent<{ buffer: ArrayBuffer; revision: number }>) => {
    if (sttSocket !== socket || socket.readyState !== WebSocket.OPEN || data.revision !== streamAudioRevision) return;
    if (socket.bufferedAmount + data.buffer.byteLength > MAX_STREAM_BUFFER_BYTES) {
      fallBackToRecorder("스트리밍 오디오 전송 지연, HTTP STT fallback");
      return;
    }
    try {
      socket.send(data.buffer);
    } catch {
      return;
    }
    streamFrameCount += 1;
    const now = Date.now();
    if (now - lastClientStreamStatusAt > 3000) {
      lastClientStreamStatusAt = now;
      void relayStatus("recording", undefined, activeTabId, `브라우저 오디오 전송 중 (${streamFrameCount} frames)`);
    }
  };
}

function relayStreamTranscript(payload: unknown, tabId: number, videoId: string): void {
  if (activeTabId !== tabId || activeVideoId !== videoId) {
    return;
  }
  if (!payload || typeof payload !== "object") {
    return;
  }
  const object = payload as Record<string, unknown>;
  if (object.type === "error") {
    const text = typeof object.text === "string" ? object.text : "스트리밍 STT 오류가 발생했습니다.";
    void relayStatus("recording", undefined, tabId, `${text} HTTP STT fallback`, videoId);
    if (activeStream && activeTabId === tabId && activeVideoId === videoId && activeMode === "stream") {
      teardownStreamingNodes();
      startRecorderCycle();
    }
    return;
  }
  if (object.type === "status") {
    const text = typeof object.text === "string" ? object.text : "스트리밍 STT 상태 확인 중";
    void relayStatus("recording", undefined, tabId, text, videoId);
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
    videoId,
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
  if (!audioContext || !activeTabId || !activeVideoId || !config.endpoint) {
    return false;
  }

  const tabIdForSocket = activeTabId;
  const videoIdForSocket = activeVideoId;
  const url = streamUrl(config);
  if (!url) {
    void relayStatus("recording", undefined, tabIdForSocket, "스트리밍 STT URL 오류, HTTP STT fallback", videoIdForSocket);
    return false;
  }

  let socket: WebSocket;
  try {
    if (!pcmWorkletLoaded) {
      await audioContext.audioWorklet.addModule(chrome.runtime.getURL("stt-pcm-worklet.js"));
      pcmWorkletLoaded = true;
    }
    socket = new WebSocket(url);
  } catch {
    void relayStatus("recording", undefined, tabIdForSocket, "스트리밍 오디오 초기화 실패, HTTP STT fallback", videoIdForSocket);
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
      try {
        startStreamingProcessor(source, socket);
      } catch (error) {
        console.debug("Could not start streaming audio processor", error);
        teardownStreamingNodes();
        resolve(false);
        return;
      }
      void relayStatus("recording", undefined, tabIdForSocket, "로컬 스트리밍 STT 연결됨", videoIdForSocket);
      resolve(true);
    });

    socket.addEventListener("message", (event) => {
      if (sttSocket !== socket) return;
      try {
        relayStreamTranscript(JSON.parse(String(event.data)), tabIdForSocket, videoIdForSocket);
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
      if (
        !stoppingCapture &&
        activeStream &&
        activeTabId === tabIdForSocket &&
        activeVideoId === videoIdForSocket &&
        activeMode === "stream" &&
        sttSocket === socket
      ) {
        teardownStreamingNodes();
        startRecorderCycle();
        void relayStatus("recording", undefined, tabIdForSocket, "스트리밍 STT 끊김, HTTP STT fallback", videoIdForSocket);
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

async function stopCapture(): Promise<{ tabId?: number; videoId?: string }> {
  const stoppedTabId = activeTabId;
  const stoppedVideoId = activeVideoId;
  stoppingCapture = true;
  try {
    clearChunkTimer();
    cyclingRecorder = false;
    teardownStreamingNodes();
    discardActiveRecorder();
    audioSource?.disconnect();

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
    pcmWorkletLoaded = false;
    audioSource = undefined;
    activeTabId = undefined;
    activeVideoId = undefined;
    activeMode = undefined;
    activeAudioChunkMs = 8000;
    streamSequence = 0;
    stoppingCapture = false;
  }
  return { tabId: stoppedTabId, videoId: stoppedVideoId };
}

function stopCaptureIfSession(tabId: number, videoId: string): Promise<{ tabId?: number; videoId?: string }> {
  if (activeTabId !== tabId || activeVideoId !== videoId) {
    return Promise.resolve({ tabId, videoId });
  }
  return stopCapture();
}

async function reconfigureCapture(
  tabId: number,
  videoId: string,
  expectedVideoId: string | undefined,
  audioChunkMs: number,
  useStreaming: boolean,
  streamingConfig: StreamingConfig
): Promise<void> {
  if (
    !activeStream ||
    !audioContext ||
    !audioSource ||
    activeTabId !== tabId ||
    (expectedVideoId && activeVideoId !== expectedVideoId)
  ) {
    throw new Error("재구성할 활성 오디오 캡처 세션이 없습니다.");
  }

  stoppingCapture = true;
  try {
    discardActiveRecorder();
    teardownStreamingNodes();
    audioSource.disconnect();
    audioSource.connect(audioContext.destination);
    activeVideoId = videoId;
    activeAudioChunkMs = Math.max(1000, audioChunkMs);
    streamSequence = 0;

    if (useStreaming && (await startStreamingStt(audioSource, streamingConfig))) {
      return;
    }

    startRecorderCycle();
    await relayStatus(
      "recording",
      undefined,
      tabId,
      useStreaming ? "WebSocket 실패, HTTP STT fallback" : "음성 인식 중...",
      videoId
    );
  } finally {
    stoppingCapture = false;
  }
}

function resetCaptureBuffer(tabId: number, videoId: string): void {
  if (!activeStream || activeTabId !== tabId || activeVideoId !== videoId) {
    return;
  }
  if (activeMode === "stream" && sttSocket?.readyState === WebSocket.OPEN) {
    streamAudioRevision += 1;
    processorNode?.port.postMessage(streamAudioRevision);
    sttSocket.send("reset");
    return;
  }
  if (activeMode === "chunk" && mediaRecorder) {
    discardActiveRecorder();
    startRecorderCycle();
  }
}

async function startCapture(
  tabId: number,
  videoId: string,
  streamId: string,
  audioChunkMs: number,
  useStreaming: boolean,
  streamingConfig: StreamingConfig
): Promise<void> {
  await stopCapture();
  activeTabId = tabId;
  activeVideoId = videoId;
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

  try {
    activeStream = await navigator.mediaDevices.getUserMedia(constraints);

    audioContext = new AudioContext();
    if (audioContext.state === "suspended") {
      await audioContext.resume().catch(() => undefined);
    }
    audioSource = audioContext.createMediaStreamSource(activeStream);
    audioSource.connect(audioContext.destination);

    if (useStreaming && (await startStreamingStt(audioSource, streamingConfig))) {
      return;
    }

    startRecorderCycle();
    await relayStatus("recording", undefined, tabId, useStreaming ? "WebSocket 실패, HTTP STT fallback" : "음성 인식 중...");
  } catch (error) {
    await stopCaptureIfSession(tabId, videoId);
    throw error;
  }
}

function enqueueCaptureLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = captureLifecycleQueue.then(operation, operation);
  captureLifecycleQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
  const message = rawMessage as RuntimeMessage;
  if (!("target" in message) || message.target !== "offscreen") {
    return false;
  }

  void (async () => {
    try {
      if (message.type === "START_AUDIO_CAPTURE" && message.streamId && message.tabId && message.videoId) {
        await enqueueCaptureLifecycle(() =>
          startCapture(message.tabId!, message.videoId!, message.streamId!, message.audioChunkMs ?? 8000, Boolean(message.useStreaming), {
            endpoint: message.streamingSttEndpoint ?? "",
            model: message.streamingSttModel ?? "",
            sourceLanguage: message.sourceLanguage ?? "auto",
            contentMode: message.contentMode ?? "auto",
            speakerTurnDetection: Boolean(message.speakerTurnDetection)
          })
        );
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "RECONFIGURE_AUDIO_CAPTURE" && message.tabId && message.videoId) {
        await enqueueCaptureLifecycle(() =>
          reconfigureCapture(
            message.tabId!,
            message.videoId,
            message.expectedVideoId,
            message.audioChunkMs ?? 8000,
            Boolean(message.useStreaming),
            {
              endpoint: message.streamingSttEndpoint ?? "",
              model: message.streamingSttModel ?? "",
              sourceLanguage: message.sourceLanguage ?? "auto",
              contentMode: message.contentMode ?? "auto",
              speakerTurnDetection: Boolean(message.speakerTurnDetection)
            }
          )
        );
        sendResponse({ ok: true, mode: activeMode });
        return;
      }

      if (message.type === "RESET_AUDIO_CAPTURE_BUFFER" && message.tabId && message.videoId) {
        resetCaptureBuffer(message.tabId, message.videoId);
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "STOP_AUDIO_CAPTURE") {
        const stopped = await enqueueCaptureLifecycle(async () => {
          if (
            message.tabId &&
            message.videoId &&
            (activeTabId !== message.tabId || activeVideoId !== message.videoId)
          ) {
            return undefined;
          }
          return stopCapture();
        });
        if (stopped) {
          await relayStatus("idle", undefined, stopped.tabId, undefined, stopped.videoId);
        }
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "GET_OFFSCREEN_AUDIO_STATE") {
        sendResponse({
          ok: true,
          activeTabId,
          activeVideoId,
          recording: Boolean(activeStream && activeTabId),
          mode: activeMode
        });
        return;
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      if (message.type === "START_AUDIO_CAPTURE" && message.tabId && message.videoId) {
        await relayStatus("error", messageText, message.tabId, undefined, message.videoId);
      } else if (message.type === "RECONFIGURE_AUDIO_CAPTURE" && message.tabId && message.videoId) {
        await relayStatus(
          "recording",
          undefined,
          message.tabId,
          `STT 설정 갱신 실패: ${messageText}`,
          message.videoId
        );
      } else {
        const stopped = await enqueueCaptureLifecycle(stopCapture);
        await relayStatus("error", messageText, stopped.tabId, undefined, stopped.videoId);
      }
      sendResponse({ ok: false, error: messageText });
    }
  })();

  return true;
});
