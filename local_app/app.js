const editor = document.getElementById("editor");
const fileInput = document.getElementById("fileInput");
const fileLabel = document.getElementById("fileLabel");
const statusText = document.getElementById("statusText");
const statusHint = document.getElementById("statusHint");
const previewMode = document.getElementById("previewMode");
const logOutput = document.getElementById("logOutput");
const pdfFrame = document.getElementById("pdfFrame");
const engineSelect = document.getElementById("engineSelect");

const newBtn = document.getElementById("newBtn");
const openBtn = document.getElementById("openBtn");
const saveTexBtn = document.getElementById("saveTexBtn");
const editResumeBtn = document.getElementById("editResumeBtn");
const previewBtn = document.getElementById("previewBtn");
const savePdfBtn = document.getElementById("savePdfBtn");

const resumeModal = document.getElementById("resumeModal");
const resumeCloseBtn = document.getElementById("resumeCloseBtn");
const resumeCancelBtn = document.getElementById("resumeCancelBtn");
const resumeApplyBtn = document.getElementById("resumeApplyBtn");
const rbError = document.getElementById("rbError");
const rdHeaderBlock = document.getElementById("rdHeaderBlock");
const rdSections = document.getElementById("rdSections");
const rdAddSection = document.getElementById("rdAddSection");

const state = {
  fileName: "Untitled.tex",
  dirty: false,
  pdfUrl: "",
  resumeDocAtOpen: null,
  resumeSnapshotAtOpen: null,
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeNewlines(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function setStatus(text, tone = "ok") {
  statusText.textContent = text;
  statusText.classList.remove("status-ok", "status-warn", "status-error");
  if (tone === "warn") statusText.classList.add("status-warn");
  else if (tone === "error") statusText.classList.add("status-error");
  else statusText.classList.add("status-ok");
}

function setLog(text) {
  logOutput.textContent = text && text.trim() ? text : "Ready.";
  logOutput.scrollTop = 0;
}

function appendLog(text) {
  const current = logOutput.textContent || "";
  logOutput.textContent = current.trim() ? `${current}\n\n${text}` : text;
}

function updateFileLabel() {
  fileLabel.textContent = state.fileName + (state.dirty ? " *" : "");
}

function markDirty(value = true) {
  state.dirty = value;
  updateFileLabel();
}

function decodePdf(base64Text) {
  const raw = atob(base64Text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return new Blob([bytes], { type: "application/pdf" });
}

function setPreviewBlob(blob) {
  if (state.pdfUrl) {
    URL.revokeObjectURL(state.pdfUrl);
  }
  state.pdfUrl = URL.createObjectURL(blob);
  pdfFrame.src = state.pdfUrl;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function makePdfName() {
  const base = state.fileName.replace(/\.[^.]+$/, "") || "document";
  return `${base}.pdf`;
}

function makeTexName() {
  if (!state.fileName || state.fileName === "Untitled.tex") return "document.tex";
  return state.fileName.endsWith(".tex") ? state.fileName : `${state.fileName}.tex`;
}

function hasLikelyTex(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  return /\\[a-zA-Z]+/.test(value);
}

function updateResumeButtonState() {
  editResumeBtn.disabled = !hasLikelyTex(editor.value);
}

function waitForPywebviewApi(timeoutMs = 1800) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const ready =
        window.pywebview &&
        window.pywebview.api &&
        typeof window.pywebview.api.save_pdf_base64 === "function";
      if (ready) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 80);
  });
}

async function tryNativeSaveAs(pdfBase64, fileName) {
  const ready = await waitForPywebviewApi();
  if (!ready) return null;
  try {
    const result = await window.pywebview.api.save_pdf_base64(pdfBase64, fileName);
    return result || { ok: false, error: "Unknown save dialog error." };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function saveTex() {
  const blob = new Blob([editor.value], { type: "text/plain;charset=utf-8" });
  downloadBlob(blob, makeTexName());
  markDirty(false);
  setStatus("Saved .tex file.", "ok");
}

function loadNewDocument() {
  if (state.dirty) {
    const ok = window.confirm("Discard unsaved changes?");
    if (!ok) return;
  }
  editor.value = "";
  state.fileName = "Untitled.tex";
  state.resumeDocAtOpen = null;
  state.resumeSnapshotAtOpen = null;
  markDirty(false);
  setLog("Ready.");
  previewMode.textContent = "Not generated";
  setStatus("New document loaded.", "ok");
  updateResumeButtonState();
}

async function requestPdf({ download }) {
  const source = editor.value || "";
  if (!source.trim()) {
    setStatus("Editor is empty. Add TeX content first.", "warn");
    return;
  }

  previewBtn.disabled = true;
  savePdfBtn.disabled = true;
  setStatus("Generating PDF...", "ok");

  try {
    const response = await fetch("/api/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source,
        engine: engineSelect.value,
        allow_text_fallback: true,
      }),
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      setStatus(data.error || "PDF generation failed.", "error");
      setLog(data.log || "No log output.");
      return;
    }

    const blob = decodePdf(data.pdf_base64);
    setPreviewBlob(blob);

    const modeTag = data.mode === "latex" ? `LaTeX (${data.engine})` : "Text fallback PDF";
    previewMode.textContent = modeTag;
    setLog(data.log || "No build logs.");

    if (download) {
      const targetName = makePdfName();
      const nativeSave = await tryNativeSaveAs(data.pdf_base64, targetName);
      if (nativeSave && nativeSave.ok) {
        setStatus(`Saved to ${nativeSave.path}`, data.mode === "latex" ? "ok" : "warn");
      } else if (nativeSave && nativeSave.cancelled) {
        setStatus("Save As cancelled.", "warn");
      } else {
        downloadBlob(blob, targetName);
        setStatus(`Saved ${modeTag} (download folder).`, data.mode === "latex" ? "ok" : "warn");
      }
    } else {
      setStatus(`Preview ready: ${modeTag}.`, data.mode === "latex" ? "ok" : "warn");
    }
  } catch (error) {
    setStatus(`Unexpected error: ${error.message}`, "error");
    setLog(String(error));
  } finally {
    previewBtn.disabled = false;
    savePdfBtn.disabled = false;
  }
}

async function loadEngineInfo() {
  try {
    const response = await fetch("/api/engines");
    if (!response.ok) return;
    const data = await response.json();
    if (!data.ok || !Array.isArray(data.engines)) return;

    const available = data.engines.filter((item) => item.available);
    if (available.length === 0) {
      statusHint.textContent = "No TeX engine detected. PDF fallback mode will be used.";
      appendLog("No TeX engine detected. Add bundled tectonic or install TeX Live/MiKTeX.");
      return;
    }

    const details = available.map((item) => `${item.name} [${item.source}]`).join(", ");
    statusHint.textContent = `Available engines: ${details}`;
    appendLog(`Detected engines: ${details}`);
  } catch (error) {
    // keep app usable if this endpoint fails
  }
}

function handleOpenFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    editor.value = String(reader.result || "");
    state.fileName = file.name || "Untitled.tex";
    markDirty(false);
    previewMode.textContent = "Not generated";
    setStatus(`Loaded ${state.fileName}.`, "ok");
    setLog("Ready.");
    updateResumeButtonState();
  };
  reader.onerror = () => {
    setStatus("Failed to read selected file.", "error");
  };
  reader.readAsText(file, "utf-8");
}

function splitTexDocument(tex) {
  const source = normalizeNewlines(tex);
  const beginMatch = /\\begin\{document\}/i.exec(source);
  if (!beginMatch) {
    return {
      hasDocument: false,
      preamble: "",
      body: source,
      tail: "",
    };
  }

  const bodyStart = beginMatch.index + beginMatch[0].length;
  const endMatchRel = /\\end\{document\}/i.exec(source.slice(bodyStart));
  if (!endMatchRel) {
    return {
      hasDocument: true,
      preamble: source.slice(0, bodyStart),
      body: source.slice(bodyStart),
      tail: "\n\\end{document}\n",
    };
  }

  const endIndex = bodyStart + endMatchRel.index;
  return {
    hasDocument: true,
    preamble: source.slice(0, bodyStart),
    body: source.slice(bodyStart, endIndex),
    tail: source.slice(endIndex),
  };
}

function extractHeaderBlock(body) {
  const source = normalizeNewlines(body);
  const centerRe = /\\begin\{center\}[\s\S]*?\\end\{center\}/i;
  const match = centerRe.exec(source);
  if (!match) {
    return { headerBlock: "", rest: source };
  }
  const rest = (source.slice(0, match.index) + source.slice(match.index + match[0].length)).trim();
  return { headerBlock: match[0].trim(), rest };
}

function parseSectionBlocks(body) {
  const source = normalizeNewlines(body);
  const headingRe = /\\(section|subsection|subsubsection)(\*)?\{([^{}]*)\}/gi;
  const matches = Array.from(source.matchAll(headingRe));

  if (matches.length === 0) {
    return [
      {
        kind: "raw",
        cmd: "raw",
        starred: false,
        title: "",
        content: source.trim(),
      },
    ];
  }

  const blocks = [];
  const firstStart = matches[0].index;
  const intro = source.slice(0, firstStart).trim();
  if (intro) {
    blocks.push({
      kind: "raw",
      cmd: "raw",
      starred: false,
      title: "",
      content: intro,
    });
  }

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const startOfContent = match.index + match[0].length;
    const endOfContent = i + 1 < matches.length ? matches[i + 1].index : source.length;
    blocks.push({
      kind: "heading",
      cmd: String(match[1] || "section").toLowerCase(),
      starred: Boolean(match[2]),
      title: String(match[3] || "").trim(),
      content: source.slice(startOfContent, endOfContent).trim(),
    });
  }

  return blocks;
}

function parseResumeDocument(tex) {
  const doc = splitTexDocument(tex);
  const header = extractHeaderBlock(doc.body);
  const blocks = parseSectionBlocks(header.rest);
  return {
    ...doc,
    headerBlock: header.headerBlock,
    blocks,
  };
}

function blankSection() {
  return {
    kind: "heading",
    cmd: "section",
    starred: true,
    title: "New Section",
    content: "",
  };
}

function cardContentRows(value) {
  const lines = normalizeNewlines(value).split("\n").length;
  return Math.max(6, Math.min(20, lines + 2));
}

function updateSectionCardMode(card) {
  const cmd = card.querySelector(".rd-cmd").value;
  const titleWrap = card.querySelector(".rd-title-wrap");
  const starWrap = card.querySelector(".rd-star-wrap");
  const titleInput = card.querySelector(".rd-title");
  const contentInput = card.querySelector(".rd-content");

  const isRaw = cmd === "raw";
  titleWrap.hidden = isRaw;
  starWrap.hidden = isRaw;
  titleInput.disabled = isRaw;

  if (isRaw) {
    contentInput.placeholder = "Raw TeX block (kept as-is).";
  } else {
    contentInput.placeholder = "Section body (raw TeX).";
  }
}

function appendSectionCard(section = blankSection()) {
  const safe = {
    cmd: section.cmd || "section",
    title: section.title || "",
    content: section.content || "",
    starred: Boolean(section.starred),
  };

  rdSections.insertAdjacentHTML(
    "beforeend",
    `
      <article class="rb-card" data-card="section">
        <div class="rb-card-head">
          <span class="rb-card-title">Section Block</span>
          <button type="button" class="rb-remove" data-remove="section">Remove</button>
        </div>
        <div class="rd-grid">
          <label>Type
            <select class="rd-cmd">
              <option value="section"${safe.cmd === "section" ? " selected" : ""}>section</option>
              <option value="subsection"${safe.cmd === "subsection" ? " selected" : ""}>subsection</option>
              <option value="subsubsection"${safe.cmd === "subsubsection" ? " selected" : ""}>subsubsection</option>
              <option value="raw"${safe.cmd === "raw" ? " selected" : ""}>raw block (no heading)</option>
            </select>
          </label>
          <label class="rd-title-wrap">Title
            <input class="rd-title" type="text" maxlength="200" value="${htmlEscape(safe.title)}">
          </label>
          <label class="rd-star-wrap rd-check">
            <input class="rd-star" type="checkbox"${safe.starred ? " checked" : ""}>
            Starred
          </label>
        </div>
        <label>Content
          <textarea class="rd-content" rows="${cardContentRows(safe.content)}">${htmlEscape(safe.content)}</textarea>
        </label>
      </article>
    `
  );

  const card = rdSections.lastElementChild;
  updateSectionCardMode(card);
}

function populateDynamicResumeEditor(doc) {
  rdHeaderBlock.value = doc.headerBlock || "";
  rdSections.innerHTML = "";
  const blocks = Array.isArray(doc.blocks) && doc.blocks.length > 0 ? doc.blocks : [blankSection()];
  blocks.forEach((block) => appendSectionCard(block));
}

function collectDynamicSnapshot() {
  const cards = Array.from(rdSections.querySelectorAll('[data-card="section"]'));
  const blocks = cards
    .map((card) => {
      const cmd = card.querySelector(".rd-cmd").value;
      const title = card.querySelector(".rd-title").value.trim();
      const content = normalizeNewlines(card.querySelector(".rd-content").value).trim();
      const starred = card.querySelector(".rd-star").checked;
      return {
        kind: cmd === "raw" ? "raw" : "heading",
        cmd,
        starred,
        title,
        content,
      };
    })
    .filter((block) => block.content || (block.cmd !== "raw" && block.title));

  return {
    headerBlock: normalizeNewlines(rdHeaderBlock.value).trim(),
    blocks,
  };
}

function validateSnapshot(snapshot) {
  const errors = [];
  snapshot.blocks.forEach((block, index) => {
    if (block.cmd !== "raw" && !block.title.trim()) {
      errors.push(`Section ${index + 1}: title is required for ${block.cmd}.`);
    }
  });
  return errors;
}

function renderBodyFromSnapshot(snapshot) {
  const parts = [];
  if (snapshot.headerBlock.trim()) {
    parts.push(snapshot.headerBlock.trim());
  }
  snapshot.blocks.forEach((block) => {
    if (block.cmd === "raw") {
      if (block.content.trim()) parts.push(block.content.trim());
      return;
    }
    const title = block.title.trim() || "Untitled";
    const heading = `\\${block.cmd}${block.starred ? "*" : ""}{${title}}`;
    const content = block.content.trim();
    parts.push(content ? `${heading}\n${content}` : heading);
  });
  return parts.join("\n\n").trim();
}

function buildTexFromSnapshot(originalDoc, snapshot) {
  const body = renderBodyFromSnapshot(snapshot);

  if (!originalDoc.hasDocument) {
    return body;
  }

  const preamble = originalDoc.preamble.replace(/\s+$/, "");
  const tail = originalDoc.tail && originalDoc.tail.trim()
    ? originalDoc.tail.replace(/^\s+/, "")
    : "\\end{document}\n";

  if (!body) {
    return `${preamble}\n\n${tail}`;
  }
  return `${preamble}\n\n${body}\n\n${tail}`;
}

function openResumeModal() {
  rbError.textContent = "";
  if (!hasLikelyTex(editor.value)) {
    setStatus("Load or paste a TeX resume first, then use Edit Resume.", "warn");
    return;
  }

  const parsed = parseResumeDocument(editor.value);
  if (!parsed.headerBlock && (!parsed.blocks || parsed.blocks.length === 0)) {
    setStatus("Could not detect editable TeX sections in this file.", "error");
    return;
  }

  state.resumeDocAtOpen = parsed;
  state.resumeSnapshotAtOpen = {
    headerBlock: parsed.headerBlock || "",
    blocks: deepClone(parsed.blocks || []),
  };
  populateDynamicResumeEditor(parsed);
  setStatus(`Detected ${parsed.blocks.length} editable block(s).`, "ok");

  resumeModal.classList.add("open");
  resumeModal.setAttribute("aria-hidden", "false");
}

function closeResumeModal() {
  resumeModal.classList.remove("open");
  resumeModal.setAttribute("aria-hidden", "true");
  rbError.textContent = "";
  state.resumeDocAtOpen = null;
  state.resumeSnapshotAtOpen = null;
}

function applyResumeToEditor() {
  rbError.textContent = "";
  if (!state.resumeDocAtOpen || !state.resumeSnapshotAtOpen) {
    rbError.textContent = "Editor context expired. Reopen Edit Resume.";
    return;
  }

  const snapshot = collectDynamicSnapshot();
  const errors = validateSnapshot(snapshot);
  if (errors.length > 0) {
    rbError.textContent = errors.join("\n");
    return;
  }

  if (deepEqual(snapshot, state.resumeSnapshotAtOpen)) {
    setStatus("No resume changes detected. Original TeX left unchanged.", "ok");
    closeResumeModal();
    return;
  }

  editor.value = buildTexFromSnapshot(state.resumeDocAtOpen, snapshot);
  markDirty(true);
  setStatus("Applied dynamic section edits to TeX.", "ok");
  closeResumeModal();
  requestPdf({ download: false });
}

function installResumeEditorEvents() {
  editResumeBtn.addEventListener("click", openResumeModal);
  resumeCloseBtn.addEventListener("click", closeResumeModal);
  resumeCancelBtn.addEventListener("click", closeResumeModal);
  resumeApplyBtn.addEventListener("click", applyResumeToEditor);

  resumeModal.addEventListener("click", (event) => {
    if (event.target === resumeModal) closeResumeModal();
  });

  rdAddSection.addEventListener("click", () => appendSectionCard(blankSection()));

  rdSections.addEventListener("change", (event) => {
    const card = event.target.closest('[data-card="section"]');
    if (!card) return;
    if (event.target.classList.contains("rd-cmd")) {
      updateSectionCardMode(card);
    }
  });

  rdSections.addEventListener("click", (event) => {
    const removeBtn = event.target.closest('button[data-remove="section"]');
    if (!removeBtn) return;
    const card = removeBtn.closest('[data-card="section"]');
    if (card) card.remove();
  });
}

function installEvents() {
  editor.addEventListener("input", () => {
    markDirty(true);
    updateResumeButtonState();
  });

  newBtn.addEventListener("click", loadNewDocument);
  openBtn.addEventListener("click", () => fileInput.click());
  saveTexBtn.addEventListener("click", saveTex);
  previewBtn.addEventListener("click", () => requestPdf({ download: false }));
  savePdfBtn.addEventListener("click", () => requestPdf({ download: true }));

  fileInput.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    handleOpenFile(file);
    fileInput.value = "";
  });

  window.addEventListener("keydown", (event) => {
    const hotkey = event.ctrlKey || event.metaKey;
    if (hotkey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveTex();
      return;
    }
    if (hotkey && event.key === "Enter") {
      event.preventDefault();
      requestPdf({ download: false });
      return;
    }
    if (event.key === "Escape" && resumeModal.classList.contains("open")) {
      closeResumeModal();
    }
  });
}

function init() {
  editor.value = "";
  updateFileLabel();
  setStatus("Ready.", "ok");
  setLog("Ready.");
  installEvents();
  installResumeEditorEvents();
  updateResumeButtonState();
  loadEngineInfo();
}

init();
