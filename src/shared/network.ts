// Include the response body in the deadline; providers return complete JSON, not streams.
export async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 60_000): Promise<Response> {
  const controller = new AbortController();
  const cancel = () => controller.abort(init?.signal?.reason);
  if (init?.signal?.aborted) cancel();
  init?.signal?.addEventListener("abort", cancel, { once: true });
  const timer = globalThis.setTimeout(() => {
    controller.abort(new DOMException("서버 응답 제한시간을 초과했습니다.", "TimeoutError"));
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.arrayBuffer();
    controller.signal.throwIfAborted();
    return new Response(body.byteLength ? body : null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  } catch (error) {
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
    init?.signal?.removeEventListener("abort", cancel);
  }
}
