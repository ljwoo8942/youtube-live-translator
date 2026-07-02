import type { CaptionSegment, ContentSettings } from "../shared/types";

export class TranslatorOverlay {
  private host: HTMLDivElement | undefined;
  private shadow: ShadowRoot | undefined;
  private translationLine: HTMLDivElement | undefined;
  private sourceLine: HTMLDivElement | undefined;
  private statusLine: HTMLDivElement | undefined;
  private controlsLine: HTMLDivElement | undefined;
  private controlStatusLine: HTMLSpanElement | undefined;
  private player: HTMLElement | undefined;
  private hasTranslation = false;
  private controlsBound = false;
  private controlAction: ((action: string) => void) | undefined;
  private readonly handleControlPointerEvent = (event: Event): void => {
    if (this.controlButtonFromEvent(event)) {
      event.stopPropagation();
    }
  };
  private readonly handleControlClick = (event: Event): void => {
    const button = this.controlButtonFromEvent(event);
    if (!button) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.controlAction?.(button.dataset.action ?? "");
  };

  ensure(settings: ContentSettings): void {
    const player = findPlayerElement();
    if (!player) {
      return;
    }

    if (this.host) {
      this.player = player;
      this.placeHost(player);
      this.applySettings(settings);
      return;
    }

    this.removeStaleOverlayHosts();

    this.host = document.createElement("div");
    this.host.id = "yt-live-translator-overlay";
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          z-index: 2147483647;
          box-sizing: border-box;
          margin: 0;
          padding: 0;
          border: 0;
          display: block;
          flex: none;
          min-width: 0;
          min-height: 0;
          max-width: none;
          max-height: none;
          contain: style paint;
          pointer-events: none;
          background: transparent;
          font-family: Roboto, Arial, "Noto Sans KR", sans-serif;
        }

        .stack {
          position: absolute;
          left: 0;
          right: 0;
          bottom: calc(var(--ytlt-bottom, 86px) + var(--ytlt-caption-clearance, 0px));
          display: flex;
          width: 100%;
          flex-direction: column;
          align-items: center;
          gap: 6px;
        }

        .box {
          max-width: var(--ytlt-width, 76%);
          box-sizing: border-box;
          padding: 8px 14px;
          border-radius: 6px;
          color: #fff;
          background: rgba(8, 10, 14, var(--ytlt-opacity, 0.72));
          text-align: center;
          line-height: 1.35;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
          box-shadow: 0 6px 22px rgba(0, 0, 0, 0.24);
        }

        .translation {
          font-size: var(--ytlt-font-size, 24px);
          font-weight: 650;
          word-break: keep-all;
          overflow-wrap: anywhere;
          white-space: pre-line;
        }

        .source {
          display: none;
          margin-top: 4px;
          color: rgba(255, 255, 255, 0.78);
          font-size: max(12px, calc(var(--ytlt-font-size, 24px) * 0.58));
          white-space: pre-line;
        }

        .status {
          margin-top: 4px;
          color: rgba(255, 255, 255, 0.68);
          font-size: 12px;
        }

        :host([data-show-source="true"]) .source {
          display: block;
        }

        :host([data-empty="true"]) {
          display: none;
        }

        :host([data-controls-enabled="true"]) {
          display: block;
        }

        :host([data-controls-enabled="true"][data-empty="true"]) .box {
          display: none;
        }

        .controls {
          position: absolute;
          right: 12px;
          top: 12px;
          bottom: auto;
          display: none;
          align-items: center;
          gap: 4px;
          padding: 5px 6px;
          border-radius: 6px;
          color: #fff;
          background: rgba(8, 10, 14, 0.74);
          box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
          pointer-events: auto;
          font: 12px/1 Roboto, Arial, "Noto Sans KR", sans-serif;
        }

        :host([data-controls-enabled="true"]) .controls {
          display: flex;
        }

        .controls button {
          width: 28px;
          height: 26px;
          border: 0;
          border-radius: 5px;
          color: rgba(255, 255, 255, 0.88);
          background: rgba(255, 255, 255, 0.12);
          cursor: pointer;
          pointer-events: auto;
          font: 700 12px/1 Roboto, Arial, "Noto Sans KR", sans-serif;
        }

        .controls button:hover {
          background: rgba(255, 255, 255, 0.2);
        }

        .controls button[data-active="true"] {
          color: #101418;
          background: #fff;
        }

        :host([data-controls-collapsed="true"]) .controls {
          gap: 3px;
          padding: 4px;
        }

        :host([data-controls-collapsed="true"]) .controls button:not([data-action="toggle"]):not([data-action="collapse"]) {
          display: none;
        }

        :host([data-controls-collapsed="true"]) .control-status {
          display: none;
        }

        .control-status {
          max-width: 170px;
          overflow: hidden;
          color: rgba(255, 255, 255, 0.72);
          text-overflow: ellipsis;
          white-space: nowrap;
          pointer-events: none;
        }
      </style>
      <div class="controls" aria-label="YouTube translator controls">
        <button data-action="toggle" title="번역 켜기/끄기" type="button">ON</button>
        <button data-action="collapse" title="미니 컨트롤 접기/펼치기" type="button">−</button>
        <button data-action="source" title="원문 표시" type="button">원</button>
        <button data-action="inputMode" title="입력 방식 변경" type="button">혼</button>
        <button data-action="live" title="라이브/잡음 모드" type="button">L</button>
        <button data-action="lyrics" title="노래/가사 모드" type="button">♪</button>
        <button data-action="fontDown" title="자막 글자 작게" type="button">A-</button>
        <button data-action="fontUp" title="자막 글자 크게" type="button">A+</button>
        <button data-action="moveUp" title="자막 위로" type="button">↑</button>
        <button data-action="moveDown" title="자막 아래로" type="button">↓</button>
        <button data-action="retry" title="음성 인식 재시도" type="button">↻</button>
        <button data-action="options" title="전체 설정 열기" type="button">⚙</button>
        <span class="control-status"></span>
      </div>
      <div class="stack">
        <div class="box">
          <div class="translation"></div>
          <div class="source"></div>
          <div class="status"></div>
        </div>
      </div>
    `;

    this.translationLine = this.shadow.querySelector(".translation") as HTMLDivElement;
    this.sourceLine = this.shadow.querySelector(".source") as HTMLDivElement;
    this.statusLine = this.shadow.querySelector(".status") as HTMLDivElement;
    this.controlsLine = this.shadow.querySelector(".controls") as HTMLDivElement;
    this.controlStatusLine = this.shadow.querySelector(".control-status") as HTMLSpanElement;
    this.host.dataset.empty = "true";
    this.player = player;
    this.placeHost(player);
    this.applySettings(settings);
  }

  applySettings(settings: ContentSettings): void {
    if (!this.host) {
      return;
    }
    const { overlayStyle } = settings;
    this.host.style.setProperty("--ytlt-font-size", `${overlayStyle.fontSize}px`);
    this.host.style.setProperty("--ytlt-bottom", `${overlayStyle.bottomOffset}px`);
    this.host.style.setProperty("--ytlt-width", `${overlayStyle.maxWidth}%`);
    this.host.style.setProperty("--ytlt-opacity", `${overlayStyle.backgroundOpacity}`);
    this.host.dataset.showSource = String(overlayStyle.showSourceText);
    this.host.dataset.controlsEnabled = String(settings.miniControlsEnabled);
    this.host.dataset.controlsCollapsed = String(settings.miniControlsCollapsed);
    this.updateControlButtons(settings);
  }

  reconcilePlacement(): void {
    if (!this.host || !this.player?.isConnected) {
      return;
    }
    if (this.host.parentElement !== this.player) {
      this.placeHost(this.player);
    }
  }

  bindMiniControls(onAction: (action: string) => void): void {
    if (!this.controlsLine || this.controlsBound) {
      return;
    }
    this.controlsBound = true;
    this.controlAction = onAction;
    const root = this.shadow ?? this.host;
    if (!root) {
      return;
    }
    root.addEventListener("pointerdown", this.handleControlPointerEvent, true);
    root.addEventListener("pointerup", this.handleControlPointerEvent, true);
    root.addEventListener("click", this.handleControlClick, true);
  }

  setControlStatus(text: string, _settings: ContentSettings): void {
    if (!this.host?.isConnected) {
      return;
    }
    if (this.controlStatusLine) {
      this.controlStatusLine.textContent = text;
    }
  }

  showTranslation(
    segment: CaptionSegment,
    translatedText: string,
    provider: string,
    settings: ContentSettings,
    ensureConnected = true
  ): boolean {
    if (!this.host?.isConnected && ensureConnected) {
      this.ensure(settings);
    }
    if (!this.host || !this.translationLine || !this.sourceLine || !this.statusLine) {
      return false;
    }
    if (!this.host.isConnected || !this.player?.isConnected) {
      return false;
    }
    this.setCaptionClearance(segment);
    this.host.dataset.empty = "false";
    this.hasTranslation = true;
    this.translationLine.textContent = translatedText;
    this.sourceLine.textContent = segment.text;
    this.statusLine.textContent = provider === "cache" ? "" : provider;
    return true;
  }

  showStatus(text: string, _settings: ContentSettings): void {
    if (!this.host?.isConnected) {
      return;
    }
    if (!this.host || !this.translationLine || !this.statusLine) {
      return;
    }
    this.host.dataset.empty = "false";
    // A delayed loading/progress update must not overwrite the small status
    // line after a real subtitle has already been rendered.
    if (this.hasTranslation) {
      return;
    }
    this.translationLine.textContent = text;
    this.statusLine.textContent = text;
  }

  showError(text: string, settings: ContentSettings): void {
    if (!this.host?.isConnected) {
      this.ensure(settings);
    }
    if (!this.host || !this.translationLine || !this.statusLine) {
      return;
    }
    this.host.dataset.empty = "false";
    this.host.style.setProperty("--ytlt-caption-clearance", "0px");
    this.hasTranslation = false;
    this.translationLine.textContent = text;
    this.statusLine.textContent = "";
  }

  showSegmentError(
    segment: CaptionSegment,
    error: string,
    settings: ContentSettings,
    ensureConnected = true
  ): boolean {
    if (!this.host?.isConnected && ensureConnected) {
      this.ensure(settings);
    }
    if (!this.host || !this.translationLine || !this.sourceLine || !this.statusLine) {
      return false;
    }
    if (!this.host.isConnected || !this.player?.isConnected) {
      return false;
    }
    this.setCaptionClearance(segment);
    this.host.dataset.empty = "false";
    this.hasTranslation = false;
    this.translationLine.textContent = `번역 실패: ${error}`;
    this.sourceLine.textContent = segment.text;
    this.statusLine.textContent = `인식: ${segment.text}`;
    return true;
  }

  clear(): void {
    if (!this.host || !this.translationLine || !this.sourceLine || !this.statusLine) {
      return;
    }
    this.host.dataset.empty = "true";
    this.host.style.setProperty("--ytlt-caption-clearance", "0px");
    this.hasTranslation = false;
    this.translationLine.textContent = "";
    this.sourceLine.textContent = "";
    this.statusLine.textContent = "";
  }

  destroy(): void {
    const root = this.shadow ?? this.host;
    root?.removeEventListener("pointerdown", this.handleControlPointerEvent, true);
    root?.removeEventListener("pointerup", this.handleControlPointerEvent, true);
    root?.removeEventListener("click", this.handleControlClick, true);
    this.host?.remove();
    this.host = undefined;
    this.shadow = undefined;
    this.translationLine = undefined;
    this.sourceLine = undefined;
    this.statusLine = undefined;
    this.controlsLine = undefined;
    this.controlStatusLine = undefined;
    this.player = undefined;
    this.hasTranslation = false;
    this.controlsBound = false;
    this.controlAction = undefined;
  }

  private removeStaleOverlayHosts(): void {
    for (const staleHost of document.querySelectorAll<HTMLElement>("#yt-live-translator-overlay")) {
      if (staleHost !== this.host) {
        staleHost.remove();
      }
    }
  }

  private placeHost(player: HTMLElement): void {
    if (!this.host) {
      return;
    }

    if (this.host.parentElement !== player) {
      player.append(this.host);
    }
    this.host.dataset.mount = "player";
  }

  private controlButtonFromEvent(event: Event): HTMLButtonElement | null {
    for (const target of event.composedPath()) {
      if (target === this.host) {
        break;
      }
      if (target instanceof HTMLButtonElement && target.matches("button[data-action]")) {
        return target;
      }
    }
    return null;
  }

  private updateControlButtons(settings: ContentSettings): void {
    if (!this.controlsLine) {
      return;
    }
    const button = (action: string) => this.controlsLine?.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
    const toggle = button("toggle");
    if (toggle) {
      toggle.textContent = settings.enabled ? "ON" : "OFF";
      toggle.dataset.active = String(settings.enabled);
    }
    const collapse = button("collapse");
    if (collapse) {
      collapse.textContent = settings.miniControlsCollapsed ? "+" : "−";
      collapse.title = settings.miniControlsCollapsed ? "미니 컨트롤 펼치기" : "미니 컨트롤 접기";
      collapse.dataset.active = String(settings.miniControlsCollapsed);
    }
    const source = button("source");
    if (source) {
      source.dataset.active = String(settings.overlayStyle.showSourceText);
    }
    const inputMode = button("inputMode");
    if (inputMode) {
      const mode =
        settings.inputMode === "captions"
          ? { label: "자", title: "입력: 선택한 공식 자막만" }
          : settings.inputMode === "audio"
            ? { label: "음", title: "입력: 음성만" }
            : { label: "혼", title: "입력: 공식 자막 우선 + 없으면 음성" };
      inputMode.textContent = mode.label;
      inputMode.title = `${mode.title} (클릭하여 변경)`;
    }
    const live = button("live");
    if (live) {
      live.dataset.active = String(settings.contentMode === "live");
    }
    const lyrics = button("lyrics");
    if (lyrics) {
      lyrics.dataset.active = String(settings.contentMode === "lyrics");
    }
  }

  private setCaptionClearance(segment: CaptionSegment): void {
    if (!this.host) {
      return;
    }
    const isOfficialCaption = segment.source === "youtubeTimedText" || segment.source === "youtubeDom";
    this.host.style.setProperty("--ytlt-caption-clearance", isOfficialCaption ? "30px" : "0px");
  }
}

export function findPlayerElement(): HTMLElement | null {
  const fullscreenPlayer = findPlayerInScope(document.fullscreenElement);
  if (fullscreenPlayer) {
    return fullscreenPlayer;
  }

  const moviePlayer =
    document.querySelector<HTMLElement>("#movie_player") ??
    document.querySelector<HTMLElement>(".html5-video-player");
  if (moviePlayer) {
    return moviePlayer;
  }

  const activeVideo = findVideoElement();
  const activeVideoPlayer = activeVideo?.closest<HTMLElement>(".html5-video-player, #movie_player");
  if (activeVideoPlayer) {
    return activeVideoPlayer;
  }

  return null;
}

export function findVideoElement(): HTMLVideoElement | null {
  return findVideoInScope(document.fullscreenElement) ?? findVideoInScope(document);
}

function findPlayerInScope(scope: Element | null): HTMLElement | null {
  if (!scope) {
    return null;
  }

  const scopedVideoPlayer = findVideoInScope(scope)?.closest<HTMLElement>(".html5-video-player, #movie_player");
  if (scopedVideoPlayer) {
    return scopedVideoPlayer;
  }

  if (scope.matches("#movie_player, .html5-video-player")) {
    return scope as HTMLElement;
  }

  return (
    scope.querySelector<HTMLElement>("#movie_player") ??
    scope.querySelector<HTMLElement>(".html5-video-player")
  );
}

function findVideoInScope(scope: ParentNode | Element | null): HTMLVideoElement | null {
  if (!scope) {
    return null;
  }

  const videos =
    scope instanceof HTMLVideoElement
      ? [scope]
      : scope.querySelectorAll<HTMLVideoElement>("video.html5-main-video, video");
  let bestVideo: HTMLVideoElement | null = null;
  let bestScore = -1;
  for (const video of videos) {
    if (!video.isConnected) {
      continue;
    }
    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    const score = (video.matches(".html5-main-video") ? 1_000_000_000 : 0) + rect.width * rect.height;
    if (score > bestScore) {
      bestVideo = video;
      bestScore = score;
    }
  }
  return bestVideo;
}
