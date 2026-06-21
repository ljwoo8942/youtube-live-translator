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
  private playerResizeObserver: ResizeObserver | undefined;
  private playerClassObserver: MutationObserver | undefined;
  private hasTranslation = false;
  private controlsBound = false;
  private readonly syncHostPlacement = () => {
    const { host, player } = this;
    if (!host || !player || !host.isConnected) {
      return;
    }

    const mountInPlayer = this.isPlayerFullscreen(player);
    const parent = mountInPlayer ? player : document.body || document.documentElement;
    if (host.parentElement !== parent) {
      parent.append(host);
    }

    host.dataset.portal = String(!mountInPlayer);
    if (mountInPlayer) {
      // A fullscreen document only paints descendants of the fullscreen player.
      this.setHostBox({ position: "absolute", left: "0px", right: "0px", width: "auto", bottom: this.playerBottom() });
      return;
    }

    const playerRect = player.getBoundingClientRect();
    if (playerRect.width <= 0 || playerRect.height <= 0) {
      return;
    }
    this.setHostBox({
      position: "fixed",
      left: `${playerRect.left}px`,
      right: "auto",
      width: `${playerRect.width}px`,
      bottom: `calc(100vh - ${playerRect.bottom}px + ${this.playerBottom()})`
    });
  };
  private readonly repairFullscreenGesture = (event: MouseEvent) => {
    if (!event.isTrusted || document.fullscreenElement) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".ytp-fullscreen-button")) {
      return;
    }

    const player = findPlayerElement();
    if (!player) {
      return;
    }

    // Let YouTube process its normal click first. If it remains in the theater
    // layout, this still runs inside the same trusted user gesture.
    queueMicrotask(() => {
      if (document.fullscreenElement || player.classList.contains("ytp-fullscreen") || !player.isConnected) {
        return;
      }
      void player.requestFullscreen().catch((error) => {
        console.debug("YouTube fullscreen fallback was rejected", error);
      });
    });
  };

  ensure(settings: ContentSettings): void {
    const player = findPlayerElement();
    if (!player) {
      return;
    }

    if (this.host?.isConnected && this.player === player) {
      this.syncHostPlacement();
      this.applySettings(settings);
      return;
    }

    this.destroy();
    this.removeStaleOverlayHosts();

    this.host = document.createElement("div");
    this.host.id = "yt-live-translator-overlay";
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: absolute;
          left: 0;
          right: 0;
          bottom: calc(var(--ytlt-bottom, 86px) + var(--ytlt-caption-clearance, 0px));
          /* Keep YouTube's own controls above this extension layer. */
          z-index: 20;
          display: flex;
          justify-content: center;
          pointer-events: none;
          font-family: Roboto, Arial, "Noto Sans KR", sans-serif;
        }

        .stack {
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
          backdrop-filter: blur(5px);
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
          display: flex;
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
          backdrop-filter: blur(5px);
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
          font: 700 12px/1 Roboto, Arial, "Noto Sans KR", sans-serif;
        }

        .controls button:hover {
          background: rgba(255, 255, 255, 0.2);
        }

        .controls button[data-active="true"] {
          color: #101418;
          background: #fff;
        }

        .control-status {
          max-width: 170px;
          overflow: hidden;
          color: rgba(255, 255, 255, 0.72);
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      </style>
      <div class="stack">
        <div class="controls" aria-label="YouTube translator controls">
          <button data-action="toggle" title="번역 켜기/끄기" type="button">ON</button>
          <button data-action="source" title="원문 표시" type="button">원</button>
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
    this.installPlacementObservers();
    (document.body || document.documentElement).append(this.host);
    this.syncHostPlacement();
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
    this.updateControlButtons(settings);
  }

  bindMiniControls(onAction: (action: string) => void): void {
    if (!this.controlsLine || this.controlsBound) {
      return;
    }
    this.controlsBound = true;
    this.controlsLine.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
      if (!button) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onAction(button.dataset.action ?? "");
    });
  }

  setControlStatus(text: string, settings: ContentSettings): void {
    this.ensure(settings);
    if (this.controlStatusLine) {
      this.controlStatusLine.textContent = text;
    }
  }

  showTranslation(segment: CaptionSegment, translatedText: string, provider: string, settings: ContentSettings): void {
    this.ensure(settings);
    if (!this.host || !this.translationLine || !this.sourceLine || !this.statusLine) {
      return;
    }
    this.setCaptionClearance(segment);
    this.host.dataset.empty = "false";
    this.hasTranslation = true;
    this.translationLine.textContent = translatedText;
    this.sourceLine.textContent = segment.text;
    this.statusLine.textContent = provider === "cache" ? "" : provider;
  }

  showStatus(text: string, settings: ContentSettings): void {
    this.ensure(settings);
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
    this.ensure(settings);
    if (!this.host || !this.translationLine || !this.statusLine) {
      return;
    }
    this.host.dataset.empty = "false";
    this.host.style.setProperty("--ytlt-caption-clearance", "0px");
    this.hasTranslation = false;
    this.translationLine.textContent = text;
    this.statusLine.textContent = "";
  }

  showSegmentError(segment: CaptionSegment, error: string, settings: ContentSettings): void {
    this.ensure(settings);
    if (!this.host || !this.translationLine || !this.sourceLine || !this.statusLine) {
      return;
    }
    this.setCaptionClearance(segment);
    this.host.dataset.empty = "false";
    this.hasTranslation = false;
    this.translationLine.textContent = `번역 실패: ${error}`;
    this.sourceLine.textContent = segment.text;
    this.statusLine.textContent = `인식: ${segment.text}`;
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
    this.playerResizeObserver?.disconnect();
    this.playerResizeObserver = undefined;
    this.playerClassObserver?.disconnect();
    this.playerClassObserver = undefined;
    document.removeEventListener("fullscreenchange", this.syncHostPlacement);
    document.removeEventListener("click", this.repairFullscreenGesture, true);
    window.removeEventListener("resize", this.syncHostPlacement);
    window.removeEventListener("scroll", this.syncHostPlacement, true);
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
  }

  private installPlacementObservers(): void {
    if (!this.player) {
      return;
    }
    this.playerResizeObserver = new ResizeObserver(this.syncHostPlacement);
    this.playerResizeObserver.observe(this.player);
    this.playerClassObserver = new MutationObserver(this.syncHostPlacement);
    this.playerClassObserver.observe(this.player, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("fullscreenchange", this.syncHostPlacement);
    document.addEventListener("click", this.repairFullscreenGesture, true);
    window.addEventListener("resize", this.syncHostPlacement);
    window.addEventListener("scroll", this.syncHostPlacement, true);
  }

  private removeStaleOverlayHosts(): void {
    for (const staleHost of document.querySelectorAll<HTMLElement>("#yt-live-translator-overlay")) {
      if (staleHost !== this.host) {
        staleHost.remove();
      }
    }
  }

  private isPlayerFullscreen(player: HTMLElement): boolean {
    const fullscreenElement = document.fullscreenElement;
    return Boolean(
      player.classList.contains("ytp-fullscreen") ||
        player.matches(":fullscreen") ||
        (fullscreenElement && (fullscreenElement === player || fullscreenElement.contains(player) || player.contains(fullscreenElement)))
    );
  }

  private playerBottom(): string {
    return "calc(var(--ytlt-bottom, 86px) + var(--ytlt-caption-clearance, 0px))";
  }

  private setHostBox(box: { position: "absolute" | "fixed"; left: string; right: string; width: string; bottom: string }): void {
    if (!this.host) {
      return;
    }
    this.host.style.setProperty("position", box.position, "important");
    this.host.style.setProperty("left", box.left, "important");
    this.host.style.setProperty("right", box.right, "important");
    this.host.style.setProperty("width", box.width, "important");
    this.host.style.setProperty("bottom", box.bottom, "important");
    this.host.style.setProperty("top", "auto", "important");
    this.host.style.setProperty("height", "auto", "important");
    this.host.style.setProperty("margin", "0", "important");
    this.host.style.setProperty("padding", "0", "important");
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
    const source = button("source");
    if (source) {
      source.dataset.active = String(settings.overlayStyle.showSourceText);
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
  const activeVideo = findVideoElement();
  const activeVideoPlayer = activeVideo?.closest<HTMLElement>(".html5-video-player, #movie_player, #player");
  if (activeVideoPlayer) {
    return activeVideoPlayer;
  }

  return (
    document.querySelector<HTMLElement>(".html5-video-player") ??
    document.querySelector<HTMLElement>("#movie_player") ??
    document.querySelector<HTMLElement>("ytd-player") ??
    document.querySelector<HTMLElement>("#player")
  );
}

export function findVideoElement(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>("video.html5-main-video") ?? document.querySelector<HTMLVideoElement>("video");
}
