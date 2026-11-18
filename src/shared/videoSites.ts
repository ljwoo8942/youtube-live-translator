export const VIDEO_SITE_MATCHES = [
  "https://www.youtube.com/*",
  "https://m.youtube.com/*",
  "https://chzzk.naver.com/*"
];

interface VideoPage {
  site: "youtube" | "chzzk";
  videoId?: string;
}

export function getVideoPage(url?: string): VideoPage | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;

  switch (parsed.origin) {
    case "https://www.youtube.com":
    case "https://m.youtube.com": {
      const id = parsed.searchParams.get("v") || parsed.pathname.match(/^\/shorts\/([\w-]+)\/?$/)?.[1];
      return { site: "youtube", videoId: id && /^[\w-]+$/.test(id) ? id : undefined };
    }
    case "https://chzzk.naver.com": {
      const channel = parsed.pathname.match(/^\/live\/([a-f\d]{32})\/?$/)?.[1];
      if (channel) return { site: "chzzk", videoId: `chzzk:live:${channel}` };
      const video = parsed.pathname.match(/^\/video\/(\d+)\/?$/)?.[1];
      return { site: "chzzk", videoId: video ? `chzzk:video:${video}` : undefined };
    }
    default:
      return undefined;
  }
}

export function isChzzkVideoId(videoId: string): boolean {
  return videoId.startsWith("chzzk:");
}
