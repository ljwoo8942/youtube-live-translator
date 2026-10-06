import type { MessageResponse } from "../shared/messages";
import {
  createEmptySongCorrection,
  normalizeCorrectionLibrary,
  type CorrectionLine,
  type CorrectionMediaContext,
  type CoverLineOverride,
  type CoverVariant,
  type SongCorrection
} from "../shared/corrections";
import {
  deleteSongCorrection,
  exportCorrectionLibrary,
  getCorrectionPreferences,
  listSongCorrections,
  putSongCorrection,
  replaceSongCorrections,
  setCorrectionPreferences
} from "../shared/correctionStore";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");
let songs: SongCorrection[] = [];
let selected = createEmptySongCorrection();
let selectedIsNew = true;
let currentMedia: CorrectionMediaContext | undefined;
let searchText = "";

function splitList(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean))];
}

function setStatus(text: string, tone: "normal" | "success" | "error" = "normal"): void {
  const status = document.querySelector<HTMLDivElement>("#status");
  if (status) {
    status.textContent = text;
    status.dataset.tone = tone;
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runAction(action: () => Promise<void>): void {
  void action().catch((error) => setStatus(getErrorMessage(error), "error"));
}

function cloneSong(song: SongCorrection): SongCorrection {
  return structuredClone(song);
}

function staticShell(): string {
  return `
    <header class="topbar">
      <div>
        <p class="eyebrow">YT Translator</p>
        <h1>곡 교정 사전</h1>
      </div>
      <div class="top-actions">
        <label class="toggle">
          <input id="correctionEnabled" type="checkbox" />
          교정 적용
        </label>
        <button id="importCurrent">현재 영상 가져오기</button>
        <button id="importFile">가져오기</button>
        <button id="exportFile">내보내기</button>
        <input id="fileInput" type="file" accept=".json,.lrc,.srt,.txt,application/json,text/plain" hidden />
      </div>
    </header>
    <main class="workspace">
      <aside class="library">
        <div class="library-tools">
          <input id="search" type="search" placeholder="곡 또는 가수 검색" />
          <button id="newSong" class="primary">새 곡</button>
        </div>
        <div id="songList" class="song-list"></div>
      </aside>
      <section class="editor">
        <div class="editor-head">
          <div>
            <p id="editorMode" class="eyebrow"></p>
            <h2 id="editorTitle">새 교정</h2>
          </div>
          <div class="editor-actions">
            <button id="deleteSong" class="danger">삭제</button>
            <button id="saveSong" class="primary">저장</button>
          </div>
        </div>

        <section class="form-band">
          <h3>곡 정보</h3>
          <div class="metadata-grid">
            <label>곡 이름<input id="title" /></label>
            <label>가수/아티스트<input id="artist" /></label>
            <label>작곡가<input id="composer" /></label>
            <label>별칭<input id="aliases" placeholder="쉼표로 구분" /></label>
            <label>원문 언어<input id="sourceLanguage" value="ja" /></label>
            <label>목표 언어<input id="targetLanguage" value="ko" /></label>
            <label>영상 길이(초)<input id="durationSeconds" type="number" min="0" step="0.1" /></label>
            <label class="wide">YouTube 영상 ID<textarea id="videoIds" rows="2"></textarea></label>
          </div>
        </section>

        <section class="form-band">
          <div class="section-head">
            <h3>원문과 교정 번역</h3>
            <button id="addLine">줄 추가</button>
          </div>
          <details class="bulk-editor">
            <summary>가사 일괄 편집</summary>
            <div class="bulk-grid">
              <label>원문<textarea id="bulkSource" rows="8"></textarea></label>
              <label>교정 번역<textarea id="bulkTranslation" rows="8"></textarea></label>
            </div>
            <div class="bulk-actions">
              <button id="loadBulk">현재 줄 불러오기</button>
              <button id="applyBulk">일괄 반영</button>
            </div>
          </details>
          <div class="line-header">
            <span>순서</span><span>원문</span><span>교정 번역</span><span></span>
          </div>
          <div id="lineEditor" class="line-editor"></div>
        </section>

        <section class="form-band">
          <div class="section-head">
            <h3>커버 프로필</h3>
            <div>
              <button id="addCurrentCover">현재 영상을 커버로 추가</button>
              <button id="addVariant">커버 추가</button>
            </div>
          </div>
          <div id="variantEditor" class="variant-editor"></div>
        </section>
      </section>
    </main>
    <footer>
      <div id="status" class="status">준비됨</div>
    </footer>
  `;
}

function inputValue(id: string): string {
  return document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)?.value ?? "";
}

function syncMetadataFromForm(): void {
  selected.title = inputValue("title").trim();
  selected.artist = inputValue("artist").trim();
  selected.composer = inputValue("composer").trim() || undefined;
  selected.aliases = splitList(inputValue("aliases"));
  selected.sourceLanguage = inputValue("sourceLanguage").trim() || "ja";
  selected.targetLanguage = inputValue("targetLanguage").trim() || "ko";
  selected.durationSeconds = Number(inputValue("durationSeconds")) || undefined;
  selected.videoIds = splitList(inputValue("videoIds"));
}

function renderSongList(): void {
  const container = document.querySelector<HTMLDivElement>("#songList");
  if (!container) {
    return;
  }
  container.replaceChildren();
  const query = searchText.trim().toLocaleLowerCase();
  const visible = songs.filter((song) =>
    [song.title, song.artist, song.composer ?? "", ...song.aliases].some((value) =>
      value.toLocaleLowerCase().includes(query)
    )
  );
  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = query ? "검색 결과 없음" : "저장된 곡 없음";
    container.append(empty);
    return;
  }
  for (const song of visible) {
    const button = document.createElement("button");
    button.className = `song-item${!selectedIsNew && selected.id === song.id ? " active" : ""}`;
    const title = document.createElement("strong");
    title.textContent = song.title;
    const artist = document.createElement("span");
    artist.textContent = song.artist;
    const count = document.createElement("small");
    count.textContent = `${song.lines.length}줄 · 커버 ${song.variants.length}`;
    button.append(title, artist, count);
    button.addEventListener("click", () => {
      selected = cloneSong(song);
      selectedIsNew = false;
      renderEditor();
      renderSongList();
    });
    container.append(button);
  }
}

function field<T extends HTMLInputElement | HTMLTextAreaElement>(id: string): T | null {
  return document.querySelector<T>(`#${id}`);
}

function renderEditor(): void {
  const mode = document.querySelector("#editorMode");
  const heading = document.querySelector("#editorTitle");
  if (mode) mode.textContent = selectedIsNew ? "새 항목" : "저장된 항목";
  if (heading) heading.textContent = selected.title || "새 교정";
  const values: Record<string, string> = {
    title: selected.title,
    artist: selected.artist,
    composer: selected.composer ?? "",
    aliases: selected.aliases.join(", "),
    sourceLanguage: selected.sourceLanguage,
    targetLanguage: selected.targetLanguage,
    durationSeconds: selected.durationSeconds?.toString() ?? "",
    videoIds: selected.videoIds.join("\n")
  };
  for (const [id, value] of Object.entries(values)) {
    const node = field<HTMLInputElement | HTMLTextAreaElement>(id);
    if (node) node.value = value;
  }
  const deleteButton = document.querySelector<HTMLButtonElement>("#deleteSong");
  if (deleteButton) deleteButton.disabled = selectedIsNew;
  renderLines();
  renderVariants();
}

function createTextArea(value: string, label: string, onInput: (value: string) => void): HTMLTextAreaElement {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.rows = 2;
  textarea.setAttribute("aria-label", label);
  textarea.addEventListener("input", () => onInput(textarea.value));
  return textarea;
}

function removeButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "icon-button danger";
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = "×";
  button.addEventListener("click", onClick);
  return button;
}

function renderLines(): void {
  const container = document.querySelector<HTMLDivElement>("#lineEditor");
  if (!container) {
    return;
  }
  container.replaceChildren();
  if (selected.lines.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "교정 줄 없음";
    container.append(empty);
    return;
  }
  selected.lines.forEach((line, index) => {
    const row = document.createElement("div");
    row.className = "line-row";
    const order = document.createElement("span");
    order.className = "line-number";
    order.textContent = String(index + 1);
    const source = createTextArea(line.source, `${index + 1}번째 원문`, (value) => {
      line.source = value;
    });
    const translation = createTextArea(line.translation, `${index + 1}번째 교정 번역`, (value) => {
      line.translation = value;
    });
    row.append(
      order,
      source,
      translation,
      removeButton(`${index + 1}번째 줄 삭제`, () => {
        selected.lines.splice(index, 1);
        renderLines();
      })
    );
    container.append(row);
  });
}

function newLine(): CorrectionLine {
  return {
    id: crypto.randomUUID(),
    source: "",
    translation: ""
  };
}

function newOverride(): CoverLineOverride {
  return {
    id: crypto.randomUUID(),
    source: "",
    translation: ""
  };
}

function newVariant(name = ""): CoverVariant {
  return {
    id: crypto.randomUUID(),
    name,
    videoIds: [],
    lineOverrides: []
  };
}

function renderOverrideRows(container: HTMLElement, variant: CoverVariant): void {
  container.replaceChildren();
  if (variant.lineOverrides.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty compact";
    empty.textContent = "커버 전용 교정 없음";
    container.append(empty);
    return;
  }
  variant.lineOverrides.forEach((override, index) => {
    const row = document.createElement("div");
    row.className = "override-row";
    const baseSelect = document.createElement("select");
    baseSelect.setAttribute("aria-label", "원곡 줄 연결");
    baseSelect.append(new Option("추가 가사", ""));
    selected.lines.forEach((line, lineIndex) => baseSelect.append(new Option(`${lineIndex + 1}. ${line.source}`, line.id)));
    baseSelect.value = override.baseLineId ?? "";
    baseSelect.addEventListener("change", () => {
      override.baseLineId = baseSelect.value || undefined;
      const base = selected.lines.find((line) => line.id === baseSelect.value);
      if (base && !override.source.trim() && !override.translation.trim()) {
        override.source = base.source;
        override.translation = base.translation;
        renderVariants();
      }
    });
    row.append(
      baseSelect,
      createTextArea(override.source, `${index + 1}번째 커버 원문`, (value) => {
        override.source = value;
      }),
      createTextArea(override.translation, `${index + 1}번째 커버 번역`, (value) => {
        override.translation = value;
      }),
      removeButton("커버 교정 줄 삭제", () => {
        variant.lineOverrides.splice(index, 1);
        renderVariants();
      })
    );
    container.append(row);
  });
}

function renderVariants(): void {
  const container = document.querySelector<HTMLDivElement>("#variantEditor");
  if (!container) {
    return;
  }
  container.replaceChildren();
  if (selected.variants.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "등록된 커버 없음";
    container.append(empty);
    return;
  }
  selected.variants.forEach((variant, index) => {
    const section = document.createElement("section");
    section.className = "variant";
    const head = document.createElement("div");
    head.className = "variant-head";
    const title = document.createElement("strong");
    title.textContent = variant.name || `커버 ${index + 1}`;
    head.append(
      title,
      removeButton("커버 프로필 삭제", () => {
        selected.variants.splice(index, 1);
        renderVariants();
      })
    );
    const fields = document.createElement("div");
    fields.className = "variant-fields";
    const nameInput = document.createElement("input");
    nameInput.placeholder = "커버 이름";
    nameInput.value = variant.name;
    nameInput.addEventListener("input", () => {
      variant.name = nameInput.value;
      title.textContent = nameInput.value || `커버 ${index + 1}`;
    });
    const performerInput = document.createElement("input");
    performerInput.placeholder = "커버 가수";
    performerInput.value = variant.performer ?? "";
    performerInput.addEventListener("input", () => {
      variant.performer = performerInput.value.trim() || undefined;
    });
    const durationInput = document.createElement("input");
    durationInput.type = "number";
    durationInput.min = "0";
    durationInput.step = "0.1";
    durationInput.placeholder = "영상 길이(초)";
    durationInput.value = variant.durationSeconds?.toString() ?? "";
    durationInput.addEventListener("input", () => {
      variant.durationSeconds = Number(durationInput.value) || undefined;
    });
    const videoIds = document.createElement("textarea");
    videoIds.rows = 2;
    videoIds.placeholder = "YouTube 영상 ID";
    videoIds.value = variant.videoIds.join("\n");
    videoIds.addEventListener("input", () => {
      variant.videoIds = splitList(videoIds.value);
    });
    fields.append(nameInput, performerInput, durationInput, videoIds);

    const overrideHead = document.createElement("div");
    overrideHead.className = "section-head compact";
    const label = document.createElement("span");
    label.textContent = "커버 전용 교정";
    const add = document.createElement("button");
    add.textContent = "교정 줄 추가";
    add.addEventListener("click", () => {
      variant.lineOverrides.push(newOverride());
      renderVariants();
    });
    overrideHead.append(label, add);
    const overrides = document.createElement("div");
    overrides.className = "override-editor";
    renderOverrideRows(overrides, variant);
    section.append(head, fields, overrideHead, overrides);
    container.append(section);
  });
}

function parseLrc(text: string): CorrectionLine[] {
  const result: CorrectionLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.+)$/);
    if (match) {
      const fraction = Number(`0.${match[3] ?? "0"}`);
      result.push({
        id: crypto.randomUUID(),
        source: match[4].trim(),
        translation: "",
        startMs: Math.round((Number(match[1]) * 60 + Number(match[2]) + fraction) * 1000)
      });
    }
  }
  return result.filter((line) => Boolean(line.source));
}

function parseSrt(text: string): CorrectionLine[] {
  const result: CorrectionLine[] = [];
  for (const block of text.trim().split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) {
      continue;
    }
    const source = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (source) {
      result.push({ id: crypto.randomUUID(), source, translation: "" });
    }
  }
  return result;
}

async function notifyLibraryUpdated(): Promise<void> {
  await chrome.runtime.sendMessage<MessageResponse>({ type: "CORRECTION_LIBRARY_UPDATED" });
}

async function loadCurrentMedia(): Promise<CorrectionMediaContext> {
  const response = await chrome.runtime.sendMessage<MessageResponse<{ media: CorrectionMediaContext }>>({
    type: "GET_CURRENT_YOUTUBE_MEDIA"
  });
  if (!response?.ok) {
    throw new Error(response?.error ?? "현재 YouTube 영상 정보를 가져오지 못했습니다.");
  }
  currentMedia = response.media;
  return response.media;
}

async function saveSelected(): Promise<void> {
  syncMetadataFromForm();
  selected.lines = selected.lines.map((line) => ({
    ...line,
    source: line.source.trim(),
    translation: line.translation.trim()
  }));
  selected.variants = selected.variants.map((variant) => ({
    ...variant,
    name: variant.name.trim(),
    performer: variant.performer?.trim() || undefined,
    lineOverrides: variant.lineOverrides.map((line) => ({
      ...line,
      source: line.source.trim(),
      translation: line.translation.trim()
    }))
  }));
  const saved = await putSongCorrection(selected);
  songs = await listSongCorrections();
  selected = cloneSong(saved);
  selectedIsNew = false;
  await notifyLibraryUpdated();
  renderEditor();
  renderSongList();
  setStatus("교정 사전을 저장했습니다.", "success");
}

async function importFile(file: File): Promise<void> {
  const text = await file.text();
  if (file.name.toLocaleLowerCase().endsWith(".json")) {
    const library = normalizeCorrectionLibrary(JSON.parse(text) as unknown);
    if (!window.confirm(`현재 교정 사전을 ${library.songs.length}개 곡으로 교체할까요?`)) {
      return;
    }
    await replaceSongCorrections(library.songs);
    songs = await listSongCorrections();
    selected = songs[0] ? cloneSong(songs[0]) : createEmptySongCorrection();
    selectedIsNew = songs.length === 0;
    await notifyLibraryUpdated();
    renderEditor();
    renderSongList();
    setStatus(`${songs.length}개 곡을 가져왔습니다.`, "success");
    return;
  }
  const lines = file.name.toLocaleLowerCase().endsWith(".srt") ? parseSrt(text) : parseLrc(text);
  if (lines.length === 0) {
    throw new Error("가사 줄을 찾지 못했습니다.");
  }
  selected.lines = lines;
  renderLines();
  setStatus(`${lines.length}개 원문 줄을 가져왔습니다. 번역을 입력한 뒤 저장하세요.`, "success");
}

function bindEvents(): void {
  document.querySelector("#newSong")?.addEventListener("click", () => {
    selected = createEmptySongCorrection();
    selectedIsNew = true;
    renderEditor();
    renderSongList();
  });
  document.querySelector<HTMLInputElement>("#search")?.addEventListener("input", (event) => {
    searchText = (event.currentTarget as HTMLInputElement).value;
    renderSongList();
  });
  document.querySelector("#addLine")?.addEventListener("click", () => {
    selected.lines.push(newLine());
    renderLines();
  });
  document.querySelector("#loadBulk")?.addEventListener("click", () => {
    const source = field<HTMLTextAreaElement>("bulkSource");
    const translation = field<HTMLTextAreaElement>("bulkTranslation");
    if (source) source.value = selected.lines.map((line) => line.source).join("\n");
    if (translation) translation.value = selected.lines.map((line) => line.translation).join("\n");
  });
  document.querySelector("#applyBulk")?.addEventListener("click", () => {
    const sourceLines = inputValue("bulkSource").split(/\r?\n/);
    const translationLines = inputValue("bulkTranslation").split(/\r?\n/);
    while (sourceLines.at(-1)?.trim() === "") sourceLines.pop();
    while (translationLines.at(-1)?.trim() === "") translationLines.pop();
    selected.lines = sourceLines
      .map((source, index): CorrectionLine | undefined => {
        const sourceText = source.trim();
        if (!sourceText) return undefined;
        return {
          id: selected.lines[index]?.id ?? crypto.randomUUID(),
          source: sourceText,
          translation: translationLines[index]?.trim() ?? ""
        };
      })
      .filter((line): line is CorrectionLine => Boolean(line));
    renderLines();
    setStatus(
      sourceLines.length === translationLines.length
        ? `${selected.lines.length}개 줄을 반영했습니다.`
        : `원문 ${sourceLines.length}줄, 번역 ${translationLines.length}줄을 반영했습니다.`,
      sourceLines.length === translationLines.length ? "success" : "normal"
    );
  });
  document.querySelector("#addVariant")?.addEventListener("click", () => {
    selected.variants.push(newVariant());
    renderVariants();
  });
  document.querySelector("#saveSong")?.addEventListener("click", () => runAction(saveSelected));
  document.querySelector("#deleteSong")?.addEventListener("click", () => {
    runAction(async () => {
      if (selectedIsNew || !window.confirm(`"${selected.title}" 교정을 삭제할까요?`)) {
        return;
      }
      await deleteSongCorrection(selected.id);
      songs = await listSongCorrections();
      selected = songs[0] ? cloneSong(songs[0]) : createEmptySongCorrection();
      selectedIsNew = songs.length === 0;
      await notifyLibraryUpdated();
      renderEditor();
      renderSongList();
      setStatus("삭제했습니다.", "success");
    });
  });
  document.querySelector("#importCurrent")?.addEventListener("click", () => {
    runAction(async () => {
      const media = await loadCurrentMedia();
      selected.title ||= media.title;
      selected.artist ||= media.author;
      selected.durationSeconds ||= media.durationSeconds;
      if (!selected.videoIds.includes(media.videoId)) selected.videoIds.push(media.videoId);
      renderEditor();
      setStatus("현재 영상 정보를 채웠습니다.", "success");
    });
  });
  document.querySelector("#addCurrentCover")?.addEventListener("click", () => {
    runAction(async () => {
      syncMetadataFromForm();
      if (!selected.title.trim()) {
        throw new Error("원곡 정보를 먼저 입력하세요.");
      }
      const media = currentMedia ?? (await loadCurrentMedia());
      selected.variants.push({
        id: crypto.randomUUID(),
        name: `${media.author || "YouTube"} 커버`,
        performer: media.author || undefined,
        durationSeconds: media.durationSeconds,
        videoIds: [media.videoId],
        lineOverrides: []
      });
      renderVariants();
      setStatus("현재 영상을 커버 프로필에 추가했습니다.", "success");
    });
  });
  document.querySelector("#importFile")?.addEventListener("click", () => {
    document.querySelector<HTMLInputElement>("#fileInput")?.click();
  });
  document.querySelector<HTMLInputElement>("#fileInput")?.addEventListener("change", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) runAction(() => importFile(file));
    input.value = "";
  });
  document.querySelector("#exportFile")?.addEventListener("click", () => {
    runAction(async () => {
      const library = await exportCorrectionLibrary();
      const url = URL.createObjectURL(new Blob([JSON.stringify(library, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `yt-translator-corrections-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus("교정 사전을 내보냈습니다.", "success");
    });
  });
  document.querySelector<HTMLInputElement>("#correctionEnabled")?.addEventListener("change", (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    runAction(async () => {
      await setCorrectionPreferences({ enabled });
      await notifyLibraryUpdated();
      setStatus(enabled ? "사용자 교정을 적용합니다." : "사용자 교정을 사용하지 않습니다.", "success");
    });
  });
}

async function main(): Promise<void> {
  if (!app) {
    return;
  }
  app.innerHTML = staticShell();
  bindEvents();
  const [storedSongs, preferences] = await Promise.all([listSongCorrections(), getCorrectionPreferences()]);
  songs = storedSongs;
  if (songs[0]) {
    selected = cloneSong(songs[0]);
    selectedIsNew = false;
  }
  const toggle = document.querySelector<HTMLInputElement>("#correctionEnabled");
  if (toggle) toggle.checked = preferences.enabled;
  renderSongList();
  renderEditor();
}

void main().catch((error) => {
  if (app) app.textContent = getErrorMessage(error);
});
