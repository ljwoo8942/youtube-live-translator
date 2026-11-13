export function providerOrigins(urls: string[], streamingUrl?: string): string[] {
  const origins = new Set<string>();
  for (const [value, streaming] of [...urls.map((url) => [url, false] as const), ...(streamingUrl ? [[streamingUrl, true] as const] : [])]) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("API 주소가 올바르지 않습니다.");
    }
    const allowed = streaming ? ["ws:", "wss:"] : ["http:", "https:"];
    if (!allowed.includes(url.protocol) || url.username || url.password || url.hostname.includes("*")) {
      throw new Error(streaming ? "스트리밍 주소에는 ws:// 또는 wss:// 주소를 입력하세요." : "API 주소에는 http:// 또는 https:// 주소를 입력하세요.");
    }
    if (url.protocol === "http:" || url.protocol === "ws:") {
      if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
        throw new Error("외부 서버는 HTTPS 또는 WSS를 사용해야 합니다. 로컬 서버는 localhost 또는 127.0.0.1을 사용하세요.");
      }
      continue;
    }
    if (streaming) url.protocol = "https:";
    origins.add(`${url.origin}/*`);
  }
  return [...origins];
}

export function requestProviderPermissions(urls: string[], streamingUrl?: string): Promise<void> {
  const origins = providerOrigins(urls, streamingUrl);
  // Call directly from the click handler, before any await loses the user gesture.
  return origins.length === 0 ? Promise.resolve() : chrome.permissions.request({ origins }).then((granted) => {
    if (!granted) throw new Error("API 서버 접근 권한이 거부되었습니다. 권한을 허용한 뒤 다시 시도하세요.");
  });
}
