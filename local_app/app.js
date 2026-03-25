// ─── CodeMirror 6 imports ───
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, highlightSpecialChars, gutter, GutterMarker, Decoration } from "@codemirror/view";
import { EditorState, StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, foldGutter, foldKeymap, syntaxHighlighting, HighlightStyle, StreamLanguage } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags } from "@lezer/highlight";

// ─── LaTeX StreamLanguage Definition ───
const latexLanguage = StreamLanguage.define({
  startState() {
    return { inMath: false, mathDelim: "" };
  },
  token(stream, state) {
    // Comments
    if (stream.match("%")) {
      stream.skipToEnd();
      return "comment";
    }
    // Math mode toggle: $$ or $
    if (stream.match("$$")) {
      state.inMath = !state.inMath;
      state.mathDelim = state.inMath ? "$$" : "";
      return "keyword";
    }
    if (stream.peek() === "$" && !state.inMath) {
      stream.next();
      state.inMath = true;
      state.mathDelim = "$";
      return "keyword";
    }
    if (stream.peek() === "$" && state.inMath && state.mathDelim === "$") {
      stream.next();
      state.inMath = false;
      state.mathDelim = "";
      return "keyword";
    }
    // Inside math mode
    if (state.inMath) {
      if (stream.match(/\\[a-zA-Z@]+/)) return "keyword";
      stream.next();
      return "string";
    }
    // Commands
    if (stream.match(/\\[a-zA-Z@]+/)) {
      return "keyword";
    }
    // Escaped char
    if (stream.match(/\\./)) {
      return "string";
    }
    // Braces
    if (stream.match(/[{}]/)) return "bracket";
    // Brackets
    if (stream.match(/[\[\]]/)) return "bracket";
    // Ampersand (table separator)
    if (stream.match("&")) return "operator";
    // Everything else
    stream.next();
    return null;
  },
});

// ─── Dark theme for CodeMirror ───
const darkHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "#c792ea" },
  { tag: tags.comment, color: "#5c6370", fontStyle: "italic" },
  { tag: tags.string, color: "#c3e88d" },
  { tag: tags.bracket, color: "#89ddff" },
  { tag: tags.operator, color: "#f78c6c" },
  { tag: tags.number, color: "#f78c6c" },
  { tag: tags.variableName, color: "#82aaff" },
]);

const darkTheme = EditorView.theme({
  "&": {
    color: "#d6deeb",
    backgroundColor: "#161822",
  },
  ".cm-content": {
    caretColor: "#6c5ce7",
    fontFamily: "'Cascadia Code', 'Cascadia Mono', 'Consolas', 'Lucida Console', monospace",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "#6c5ce7",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "rgba(108, 92, 231, 0.2)",
  },
  ".cm-gutters": {
    backgroundColor: "#0f1117",
    color: "#5c6178",
    border: "none",
    borderRight: "1px solid rgba(120, 130, 170, 0.15)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "rgba(108, 92, 231, 0.1)",
    color: "#6c5ce7",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(108, 92, 231, 0.06)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "rgba(0, 206, 201, 0.2)",
    outline: "1px solid rgba(0, 206, 201, 0.4)",
  },
  ".cm-foldGutter .cm-gutterElement": {
    color: "#5c6178",
    cursor: "pointer",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "rgba(108, 92, 231, 0.15)",
    border: "1px solid rgba(108, 92, 231, 0.3)",
    color: "#8b91a8",
  },
  ".cm-searchMatch": {
    backgroundColor: "rgba(253, 203, 110, 0.25)",
    outline: "1px solid rgba(253, 203, 110, 0.4)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "rgba(253, 203, 110, 0.45)",
  },
}, { dark: true });

const setCompileMarkersEffect = StateEffect.define();
const clearCompileMarkersEffect = StateEffect.define();

class CompileGutterMarker extends GutterMarker {
  constructor(severity = "error", message = "") {
    super();
    this.severity = severity;
    this.message = message;
  }

  toDOM() {
    const marker = document.createElement("span");
    marker.className = `cm-compile-marker cm-compile-marker-${this.severity}`;
    marker.textContent = "!";
    if (this.message) marker.title = this.message;
    return marker;
  }
}

const compileMarkerSpacer = new CompileGutterMarker("spacer");

function sanitizeCompileMarkers(markers, doc) {
  if (!Array.isArray(markers)) return [];
  const safe = [];
  const seen = new Set();
  for (const marker of markers) {
    const line = Math.max(1, Math.min(doc.lines || 1, Number(marker.line) || 0));
    if (!line) continue;
    const severity = marker.severity === "warn" ? "warn" : "error";
    const key = `${line}:${severity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    safe.push({ line, severity, message: String(marker.message || "").trim() });
    if (safe.length >= 40) break;
  }
  return safe;
}

function buildCompileGutterSet(doc, markers) {
  const builder = new RangeSetBuilder();
  for (const marker of sanitizeCompileMarkers(markers, doc)) {
    const line = doc.line(marker.line);
    builder.add(line.from, line.from, new CompileGutterMarker(marker.severity, marker.message));
  }
  return builder.finish();
}

function buildCompileLineDecorations(doc, markers) {
  const builder = new RangeSetBuilder();
  for (const marker of sanitizeCompileMarkers(markers, doc)) {
    const line = doc.line(marker.line);
    const className = marker.severity === "warn" ? "cm-compile-line-warn" : "cm-compile-line-error";
    builder.add(line.from, line.from, Decoration.line({ class: className }));
  }
  return builder.finish();
}

const compileGutterField = StateField.define({
  create() {
    const builder = new RangeSetBuilder();
    return builder.finish();
  },
  update(value, tr) {
    let next = tr.docChanged ? value.map(tr.changes) : value;
    for (const effect of tr.effects) {
      if (effect.is(clearCompileMarkersEffect)) next = buildCompileGutterSet(tr.state.doc, []);
      if (effect.is(setCompileMarkersEffect)) next = buildCompileGutterSet(tr.state.doc, effect.value);
    }
    return next;
  },
});

const compileLineField = StateField.define({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    let next = tr.docChanged ? value.map(tr.changes) : value;
    for (const effect of tr.effects) {
      if (effect.is(clearCompileMarkersEffect)) next = Decoration.none;
      if (effect.is(setCompileMarkersEffect)) next = buildCompileLineDecorations(tr.state.doc, effect.value);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const compileMarkerGutter = gutter({
  class: "cm-compile-gutter",
  markers: (view) => view.state.field(compileGutterField),
  initialSpacer: () => compileMarkerSpacer,
});


// ─── DOM Elements ───
const $ = (id) => document.getElementById(id);

const fileInput = $("fileInput");
const fileLabel = $("fileLabel");
const statusText = $("statusText");
const statusHint = $("statusHint");
const previewMode = $("previewMode");
const logOutput = $("logOutput");
const pdfFrame = $("pdfFrame");
const engineSelect = $("engineSelect");
const wordCount = $("wordCount");
const statusWordCount = $("statusWordCount");
const compileOverlay = $("compileOverlay");

// Buttons
const newBtn = $("newBtn");
const openBtn = $("openBtn");
const saveTexBtn = $("saveTexBtn");
const templatesBtn = $("templatesBtn");
const previewBtn = $("previewBtn");
const savePdfBtn = $("savePdfBtn");

// Tab system
const editorTabs = $("editorTabs");
const tabIndicator = $("tabIndicator");
const sourceTab = $("sourceTab");
const builderTab = $("builderTab");

// Resume builder
const rbError = $("rbError");
const rdPreamble = $("rdPreamble");
const rdHeaderBlock = $("rdHeaderBlock");
const rdSections = $("rdSections");
const rdAddSection = $("rdAddSection");
const resumeApplyBtn = $("resumeApplyBtn");

// Preamble collapsible
const preambleSection = $("preambleSection");

// Log panel
const logPanel = $("logPanel");
const logToggle = $("logToggle");
const logBadge = $("logBadge");
const logSummary = $("logSummary");
const askAiBtn = $("askAiBtn");
const aiPanel = $("aiPanel");
const aiContent = $("aiContent");
const aiApplyBtn = $("aiApplyBtn");
const aiDismissBtn = $("aiDismissBtn");

// Template modal
const templateModal = $("templateModal");
const templateCloseBtn = $("templateCloseBtn");
const templateGrid = $("templateGrid");

// Resize handle
const resizeHandle = $("resizeHandle");
const workspace = $("workspace");

// ─── App State ───
const state = {
  fileName: "Untitled.tex",
  dirty: false,
  pdfUrl: "",
  activeTab: "source",
  resumeDoc: null,
  compileTimer: null,
  lastPdfBase64: "",
  newestCompileRequestId: 0,
  activeCompileRequestId: 0,
  newlineStyle: "\n",
  compileErrorContext: {
    source: "",
    log: "",
    error: "",
  },
  ai: {
    available: false,
    checked: false,
    busy: false,
    fixedSource: "",
  },
  builder: {
    builderDirty: false,
    lastParsedSourceHash: "",
    lastAppliedSnapshotHash: "",
    liveBuilderCompileTimer: null,
  },
};

const LIVE_COMPILE_DELAY = 1500;

// ─── CodeMirror Setup ───
let cmView = null;

function createEditor() {
  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      clearCompileMarkers();
      markDirty(true);
      scheduleLiveCompile();
      updateWordCount();
    }
  });

  const startState = EditorState.create({
    doc: "",
    extensions: [
      lineNumbers(),
      compileMarkerGutter,
      compileGutterField,
      compileLineField,
      highlightActiveLineGutter(),
      highlightActiveLine(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      highlightSelectionMatches(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      latexLanguage,
      syntaxHighlighting(darkHighlightStyle),
      darkTheme,
      updateListener,
      EditorView.lineWrapping,
    ],
  });

  cmView = new EditorView({
    state: startState,
    parent: $("cmEditor"),
  });
}

function getEditorContent() {
  return cmView ? cmView.state.doc.toString() : "";
}

function setEditorContent(text) {
  if (!cmView) return;
  cmView.dispatch({
    changes: { from: 0, to: cmView.state.doc.length, insert: text },
  });
}

function setCompileMarkers(markers) {
  if (!cmView) return;
  cmView.dispatch({ effects: setCompileMarkersEffect.of(markers || []) });
}

function clearCompileMarkers() {
  if (!cmView) return;
  cmView.dispatch({ effects: clearCompileMarkersEffect.of(true) });
}


// ─── Utility Functions ───

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

function detectNewlineStyle(value) {
  return /\r\n/.test(String(value || "")) ? "\r\n" : "\n";
}

function restoreNewlineStyle(value, newlineStyle = "\n") {
  const normalized = normalizeNewlines(value);
  return newlineStyle === "\r\n" ? normalized.replace(/\n/g, "\r\n") : normalized;
}

function hashText(value) {
  let hash = 5381;
  const text = String(value || "");
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
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

function setLogSummary(text) {
  if (!logSummary) return;
  const summary = String(text || "").trim();
  logSummary.hidden = !summary;
  logSummary.textContent = summary;
}

function clearCompileErrorUi() {
  setLogSummary("");
  showLogBadge(false);
  if (askAiBtn) askAiBtn.hidden = true;
  if (askAiBtn) askAiBtn.disabled = false;
  if (aiPanel) aiPanel.hidden = true;
  if (aiApplyBtn) aiApplyBtn.hidden = true;
  state.ai.fixedSource = "";
  state.compileErrorContext = { source: "", log: "", error: "" };
}

function appendLog(text) {
  const current = logOutput.textContent || "";
  logOutput.textContent = current.trim() ? `${current}\n\n${text}` : text;
}

function updateFileLabel() {
  fileLabel.textContent = state.fileName + (state.dirty ? " •" : "");
}

function markDirty(value = true) {
  state.dirty = value;
  updateFileLabel();
}

function updateWordCount() {
  const text = getEditorContent();
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  const label = `${words} words · ${chars} chars`;
  wordCount.textContent = label;
  if (statusWordCount) statusWordCount.textContent = label;
}

function resetBuilderTracking() {
  state.builder.builderDirty = false;
  state.builder.lastParsedSourceHash = "";
  state.builder.lastAppliedSnapshotHash = "";
  if (state.builder.liveBuilderCompileTimer) {
    clearTimeout(state.builder.liveBuilderCompileTimer);
    state.builder.liveBuilderCompileTimer = null;
  }
}

// ─── PDF Utilities ───
function decodePdf(base64Text) {
  const raw = atob(base64Text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: "application/pdf" });
}

function setPreviewBlob(blob) {
  if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
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
  return value ? /\\[a-zA-Z]+/.test(value) : false;
}

function looksLikeResume(text) {
  const src = normalizeNewlines(text).toLowerCase();
  if (!/\\begin\{document\}/i.test(src)) return false;
  const resumeKeywords = ["experience", "education", "skills", "projects", "summary", "objective", "employment", "qualifications", "certifications", "awards"];
  const sectionRe = /\\(?:section|subsection)\*?\{([^}]{0,60})\}/gi;
  let match;
  let hits = 0;
  while ((match = sectionRe.exec(src)) !== null) {
    const title = match[1].toLowerCase();
    if (resumeKeywords.some((kw) => title.includes(kw))) hits++;
  }
  // Also check for \ressection or similar custom commands with resume keywords
  const customSectionRe = /\\(?:ressection|cvsection|resumesection)\{([^}]{0,60})\}/gi;
  while ((match = customSectionRe.exec(src)) !== null) {
    const title = match[1].toLowerCase();
    if (resumeKeywords.some((kw) => title.includes(kw))) hits++;
  }
  return hits >= 2;
}

// ─── pywebview Save ───
function waitForPywebviewApi(timeoutMs = 1800) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const ready = window.pywebview && window.pywebview.api && typeof window.pywebview.api.save_pdf_base64 === "function";
      if (ready) { clearInterval(timer); resolve(true); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(timer); resolve(false); }
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

// ─── File Operations ───
function saveTex() {
  const blob = new Blob([getEditorContent()], { type: "text/plain;charset=utf-8" });
  downloadBlob(blob, makeTexName());
  markDirty(false);
  setStatus("Saved .tex file.", "ok");
}

function loadNewDocument() {
  if ((state.dirty || state.builder.builderDirty) && !window.confirm("Discard unsaved changes?")) return;

  // Cancel any in-flight compile
  state.activeCompileRequestId = ++state.newestCompileRequestId;
  if (state.compileTimer) { clearTimeout(state.compileTimer); state.compileTimer = null; }
  if (state.builder.liveBuilderCompileTimer) { clearTimeout(state.builder.liveBuilderCompileTimer); state.builder.liveBuilderCompileTimer = null; }

  setEditorContent("");
  state.fileName = "Untitled.tex";
  state.resumeDoc = null;
  state.newlineStyle = "\n";
  state.lastPdfBase64 = "";
  resetBuilderTracking();
  clearCompileMarkers();
  markDirty(false);
  setLog("Ready.");
  clearCompileErrorUi();
  collapseLog();
  previewMode.textContent = "Not generated";
  setStatus("New document created.", "ok");
  updateWordCount();

  // Clear the preview iframe
  if (state.pdfUrl) { URL.revokeObjectURL(state.pdfUrl); state.pdfUrl = ""; }
  pdfFrame.src = "about:blank";

  switchTab("source", { skipBuilderSync: true });
}

function handleOpenFile(file) {
  if (!file) return;
  if ((state.dirty || state.builder.builderDirty) && !window.confirm("Discard unsaved changes and open selected file?")) return;

  // Cancel any in-flight compile so it doesn't overwrite the new file's preview
  state.activeCompileRequestId = ++state.newestCompileRequestId;
  if (state.compileTimer) { clearTimeout(state.compileTimer); state.compileTimer = null; }
  if (state.builder.liveBuilderCompileTimer) { clearTimeout(state.builder.liveBuilderCompileTimer); state.builder.liveBuilderCompileTimer = null; }

  const reader = new FileReader();
  reader.onload = () => {
    const content = String(reader.result || "");
    state.newlineStyle = detectNewlineStyle(content);
    setEditorContent(content);
    resetBuilderTracking();
    clearCompileMarkers();
    state.fileName = file.name || "Untitled.tex";
    state.resumeDoc = null;
    state.lastPdfBase64 = "";
    markDirty(false);
    previewMode.textContent = "Compiling…";
    setStatus(`Loaded ${state.fileName}.`, "ok");
    setLog("Ready.");
    clearCompileErrorUi();
    collapseLog();
    updateWordCount();

    // Auto-detect resume and offer to open in Resume Builder
    if (looksLikeResume(content)) {
      switchTab("builder");
      setStatus(`Loaded ${state.fileName} — resume detected, opened in builder.`, "ok");
    } else {
      switchTab("source", { skipBuilderSync: true });
    }

    // Always compile the newly opened file so preview updates immediately
    // Cancel any pending live compile timer triggered by setEditorContent above
    if (state.compileTimer) { clearTimeout(state.compileTimer); state.compileTimer = null; }
    if (content.trim() && hasLikelyTex(content)) {
      requestPdf({ download: false, quiet: false, sourceText: content });
    }
  };
  reader.onerror = () => setStatus("Failed to read selected file.", "error");
  reader.readAsText(file, "utf-8");
}

// ─── Auto-Save (disabled) ───
function scheduleAutoSave() { /* disabled */ }
function doAutoSave() { /* disabled */ }
function restoreAutoSave() { return false; }
function clearAutoSave() { /* disabled */ }

// ─── Live Compile ───
function scheduleLiveCompile() {
  if (state.activeTab !== "source") return;
  if (state.compileTimer) clearTimeout(state.compileTimer);
  state.compileTimer = setTimeout(() => {
    if (state.activeTab !== "source") return;
    const source = getEditorContent().trim();
    if (source && hasLikelyTex(source)) {
      requestPdf({ download: false, quiet: true, sourceText: source });
    }
  }, LIVE_COMPILE_DELAY);
}

function scheduleBuilderLiveCompile() {
  if (state.activeTab !== "builder") return;
  if (state.builder.liveBuilderCompileTimer) clearTimeout(state.builder.liveBuilderCompileTimer);
  state.builder.liveBuilderCompileTimer = setTimeout(() => {
    if (state.activeTab !== "builder") return;
    const snapshot = collectSnapshot();
    const errors = validateSnapshot(snapshot);
    if (errors.length > 0) return;
    const source = buildTexFromSnapshot(snapshot);
    if (source.trim()) {
      requestPdf({ download: false, quiet: true, sourceText: source });
    }
  }, LIVE_COMPILE_DELAY);
}

function extractLineNumber(text) {
  const source = String(text || "");
  const patterns = [
    /l\.(\d+)/i,
    /\bline\s+(\d+)\b/i,
    /:(\d+)(?::\d+)?\b/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function cleanCompileMessage(message) {
  return String(message || "")
    .replace(/^!+\s*/, "")
    .replace(/^(?:LaTeX|Package [^:]+)\s+Error:\s*/i, "")
    .replace(/^\s*(?:error|warning):\s*/i, "")
    .trim();
}

function normalizeCompileSummary(message) {
  const cleaned = cleanCompileMessage(message);
  if (!cleaned) return "Compilation failed.";

  if (/missing\s*}\s*inserted|extra }, or forgotten \\endgroup|runaway argument/i.test(cleaned)) {
    return "Missing }";
  }
  if (/undefined control sequence/i.test(cleaned)) {
    return "Undefined control sequence";
  }
  if (/paragraph ended before .* was complete/i.test(cleaned)) {
    return "Command argument ended early (likely missing })";
  }
  const missingFile = /file [`']([^`']+)[`'] not found/i.exec(cleaned);
  if (missingFile) {
    return `Missing package/file: ${missingFile[1]}`;
  }
  if (/emergency stop/i.test(cleaned)) {
    return "Compilation stopped after an earlier LaTeX error";
  }
  return cleaned.replace(/\s+/g, " ").trim();
}

function parseCompileMarkers(logText) {
  const text = normalizeNewlines(logText);
  if (!text.trim()) return [];
  const rows = text.split("\n");
  const markers = [];
  const seen = new Set();
  const markerLimit = 40;

  const pushMarker = (line, message, severity = "error") => {
    const lineNo = Number(line);
    if (!Number.isFinite(lineNo) || lineNo <= 0) return;
    const cleanMessage = normalizeCompileSummary(message || "Compilation issue");
    const tone = severity === "warn" ? "warn" : "error";
    const key = `${lineNo}|${tone}|${cleanMessage}`;
    if (seen.has(key)) return;
    seen.add(key);
    markers.push({ line: lineNo, message: cleanMessage, severity: tone });
  };

  for (let i = 0; i < rows.length && markers.length < markerLimit; i++) {
    const raw = rows[i];
    const row = raw.trim();
    if (!row) continue;

    // Classic LaTeX errors:
    // ! LaTeX Error: ...
    // l.42 ...
    if (/^!/.test(row)) {
      const message = cleanCompileMessage(row);
      const line = extractLineNumber(rows[i + 1]) || extractLineNumber(rows[i + 2]) || extractLineNumber(row);
      pushMarker(line, message || rows[i + 1] || "Compilation issue", "error");
      continue;
    }

    // Tectonic/rust style errors and warnings:
    // error: main.tex:42:5: ...
    // warning: main.tex:42:5: ...
    const rustStyle = /^(error|warning):\s+[^:\n]+:(\d+)(?::\d+)?:\s*(.+)$/i.exec(row);
    if (rustStyle) {
      const severity = rustStyle[1].toLowerCase() === "warning" ? "warn" : "error";
      pushMarker(Number(rustStyle[2]), rustStyle[3], severity);
      continue;
    }

    const hasErrorWord = /\b(error|warning|undefined|missing|runaway|fatal)\b/i.test(row);
    if (!hasErrorWord) continue;
    const line = extractLineNumber(row);
    if (!line) continue;
    const severity = /\bwarn(?:ing)?\b/i.test(row) ? "warn" : "error";
    pushMarker(line, row, severity);
  }

  return markers.slice(0, markerLimit);
}

function updateCompileMarkersFromLog(logText) {
  const markers = parseCompileMarkers(logText);
  if (markers.length > 0) setCompileMarkers(markers);
  else clearCompileMarkers();
}

function extractPrimaryCompileIssue(logText, fallbackMessage = "Compilation failed.") {
  const markers = parseCompileMarkers(logText);
  const firstError = markers.find((item) => item.severity === "error") || markers[0];
  if (firstError) {
    return {
      line: Number(firstError.line) || 0,
      message: normalizeCompileSummary(firstError.message || fallbackMessage),
    };
  }

  const rows = normalizeNewlines(logText).split("\n");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i].trim();
    if (!row) continue;
    if (!/^!/.test(row) && !/\berror\b/i.test(row)) continue;
    const line = extractLineNumber(rows[i + 1]) || extractLineNumber(rows[i + 2]) || extractLineNumber(row);
    const message = normalizeCompileSummary(row);
    return { line, message };
  }

  return {
    line: 0,
    message: normalizeCompileSummary(fallbackMessage),
  };
}

function formatIssueForStatus(issue) {
  const message = normalizeCompileSummary(issue && issue.message ? issue.message : "Compilation failed.");
  const line = issue && issue.line ? Number(issue.line) : 0;
  return line > 0 ? `${message} on line ${line}` : message;
}

async function ensureAiAvailable() {
  if (state.ai.checked) return state.ai.available;
  try {
    const response = await fetch("/api/ai-status");
    if (response.ok) {
      const data = await response.json();
      state.ai.available = Boolean(data && data.ok && data.available);
    } else {
      state.ai.available = false;
    }
  } catch (error) {
    state.ai.available = false;
  }
  state.ai.checked = true;
  return state.ai.available;
}

function showAskAiButton(show) {
  if (!askAiBtn) return;
  askAiBtn.hidden = !(show && state.ai.available);
}

function renderAiLoading() {
  if (!aiPanel || !aiContent) return;
  aiPanel.hidden = false;
  aiContent.innerHTML = `
    <div class="ai-loading">
      <div class="spinner"></div>
      <span>Asking Gemini…</span>
    </div>
  `;
  if (aiApplyBtn) aiApplyBtn.hidden = true;
}

function renderAiError(message) {
  if (!aiPanel || !aiContent) return;
  aiPanel.hidden = false;
  aiContent.innerHTML = `<div class="ai-error">${htmlEscape(message || "AI request failed.")}</div>`;
  if (aiApplyBtn) aiApplyBtn.hidden = true;
  state.ai.fixedSource = "";
}

function renderAiResult(payload) {
  if (!aiPanel || !aiContent) return;
  const suggestion = String(payload.suggestion || payload.diagnosis || payload.raw || "No diagnosis returned.").trim();
  const fixedSource = String(payload.fixed_source || "").trim();
  state.ai.fixedSource = fixedSource;
  aiPanel.hidden = false;

  const fixedHtml = fixedSource
    ? `
      <p class="ai-section-title">Suggested TeX</p>
      <pre class="ai-code">${htmlEscape(fixedSource)}</pre>
    `
    : "";

  aiContent.innerHTML = `
    <p class="ai-section-title">Diagnosis</p>
    <div class="ai-diagnosis">${htmlEscape(suggestion || "No diagnosis returned.")}</div>
    ${fixedHtml}
  `;
  if (aiApplyBtn) aiApplyBtn.hidden = !fixedSource;
}

async function askAiForHelp() {
  if (state.ai.busy) return;
  const source = state.compileErrorContext.source || getEditorContent();
  const logText = state.compileErrorContext.log || logOutput.textContent || "";
  const errorSummary = state.compileErrorContext.error || "";

  if (!source.trim()) {
    setStatus("No TeX source available for AI diagnosis.", "warn");
    return;
  }

  const aiEnabled = await ensureAiAvailable();
  if (!aiEnabled) {
    setStatus("AI help is not configured. Start with --gemini-key or GEMINI_API_KEY.", "warn");
    return;
  }

  state.ai.busy = true;
  if (askAiBtn) askAiBtn.disabled = true;
  renderAiLoading();
  expandLog();

  try {
    const response = await fetch("/api/ai-help", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tecxter-Request": "1" },
      body: JSON.stringify({
        source,
        log: logText,
        error: errorSummary,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `AI request failed (${response.status}).`);
    }
    renderAiResult(data);
    setStatus("AI diagnosis ready.", "ok");
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    renderAiError(message);
    setStatus(`AI help failed: ${message}`, "error");
  } finally {
    state.ai.busy = false;
    if (askAiBtn) askAiBtn.disabled = false;
  }
}

function applyAiFix() {
  const fixedSource = String(state.ai.fixedSource || "").trim();
  if (!fixedSource) return;
  if (!window.confirm("Replace the current editor content with the AI fix?")) return;

  const normalized = restoreNewlineStyle(fixedSource, state.newlineStyle);
  if (state.activeTab === "builder") {
    switchTab("source", { skipBuilderSync: true });
  }
  setEditorContent(normalized);
  markDirty(true);
  updateWordCount();
  setStatus("Applied AI fix. Recompiling…", "ok");
  requestPdf({ download: false, quiet: false, sourceText: normalized });
}

function handleCompileFailure({ source, logText, fallbackMessage = "Compilation failed.", quiet = false }) {
  const logSafe = String(logText || "");
  const issue = extractPrimaryCompileIssue(logSafe, fallbackMessage);
  const summary = formatIssueForStatus(issue);

  setLog(logSafe || "No log output.");
  setLogSummary(summary);
  updateCompileMarkersFromLog(logSafe);
  showLogBadge(true);
  expandLog();

  state.compileErrorContext = {
    source: String(source || ""),
    log: logSafe,
    error: summary,
  };

  if (!quiet) setStatus(summary, "error");

  ensureAiAvailable().then((available) => {
    if (!available) return;
    showAskAiButton(true);
  }).catch(() => {});

  return issue;
}

// ─── PDF Request ───
async function requestPdf({ download = false, quiet = false, sourceText = null }) {
  const source = sourceText == null ? getEditorContent() : String(sourceText);
  if (!source.trim()) {
    if (!quiet) setStatus("Editor is empty. Add TeX content first.", "warn");
    return;
  }

  const requestId = ++state.newestCompileRequestId;
  state.activeCompileRequestId = requestId;
  const lockUi = download || !quiet;

  if (lockUi) {
    previewBtn.disabled = true;
    savePdfBtn.disabled = true;
    compileOverlay.hidden = false;
  }
  if (!quiet) setStatus("Compiling…", "ok");
  if (aiPanel && !state.ai.busy) aiPanel.hidden = true;
  if (aiApplyBtn && !state.ai.busy) aiApplyBtn.hidden = true;
  if (!state.ai.busy) state.ai.fixedSource = "";

  try {
    const response = await fetch("/api/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tecxter-Request": "1" },
      body: JSON.stringify({
        source,
        engine: engineSelect.value,
        allow_text_fallback: true,
      }),
    });

    const data = await response.json();
    if (requestId !== state.activeCompileRequestId) return;

    if (!response.ok || !data.ok) {
      handleCompileFailure({
        source,
        logText: data.log || "No log output.",
        fallbackMessage: data.error || "Compilation failed.",
        quiet,
      });
      return;
    }

    state.lastPdfBase64 = data.pdf_base64;
    const blob = decodePdf(data.pdf_base64);
    setPreviewBlob(blob);

    const logText = data.log || "No build logs.";
    let issue = null;
    const modeTag = data.mode === "latex" ? `LaTeX (${data.engine})` : "Text fallback";
    previewMode.textContent = modeTag;

    if (data.mode === "latex") {
      setLog(logText);
      clearCompileMarkers();
      clearCompileErrorUi();
      collapseLog();
    } else {
      issue = handleCompileFailure({
        source,
        logText,
        fallbackMessage: data.message || "LaTeX compile failed.",
        quiet,
      });
    }

    if (download) {
      const targetName = makePdfName();
      const nativeSave = await tryNativeSaveAs(data.pdf_base64, targetName);
      if (nativeSave && nativeSave.ok) {
        setStatus(`Saved to ${nativeSave.path}`, data.mode === "latex" ? "ok" : "warn");
      } else if (nativeSave && nativeSave.cancelled) {
        setStatus("Save cancelled.", "warn");
      } else {
        downloadBlob(blob, targetName);
        setStatus(`Exported ${modeTag}.`, data.mode === "latex" ? "ok" : "warn");
      }
    } else if (!quiet) {
      if (data.mode === "latex") {
        setStatus(`Preview ready: ${modeTag}.`, "ok");
      } else {
        setStatus(formatIssueForStatus(issue || { message: "LaTeX compile failed.", line: 0 }), "error");
      }
    }
  } catch (error) {
    if (requestId !== state.activeCompileRequestId) return;
    const message = error && error.message ? error.message : String(error);
    handleCompileFailure({
      source,
      logText: message,
      fallbackMessage: message,
      quiet,
    });
  } finally {
    // Only clean up UI for the active request — stale requests must not re-enable buttons mid-compile
    if (requestId === state.activeCompileRequestId) {
      previewBtn.disabled = false;
      savePdfBtn.disabled = false;
      compileOverlay.hidden = true;
    }
  }
}

// ─── Engine Info ───
async function loadEngineInfo() {
  try {
    const response = await fetch("/api/engines");
    if (!response.ok) return;
    const data = await response.json();
    if (!data.ok || !Array.isArray(data.engines)) return;

    const available = data.engines.filter((e) => e.available);
    if (available.length === 0) {
      statusHint.textContent = "No TeX engine found — fallback mode.";
      appendLog("No TeX engine detected. Add bundled tectonic or install TeX Live/MiKTeX.");
      return;
    }

    const details = available.map((e) => `${e.name} [${e.source}]`).join(", ");
    statusHint.textContent = `Engines: ${details}`;
    appendLog(`Detected: ${details}`);
  } catch (e) { /* keep usable */ }
}

// ─── Tab System ───
function applyTabUi(tabName) {
  editorTabs.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  sourceTab.classList.toggle("active", tabName === "source");
  builderTab.classList.toggle("active", tabName === "builder");
  updateTabIndicator();
}

function switchTab(tabName, { skipBuilderSync = false, quietSync = false } = {}) {
  const targetTab = tabName === "builder" ? "builder" : "source";
  if (targetTab === state.activeTab) {
    updateTabIndicator();
    return true;
  }

  if (state.activeTab === "builder" && targetTab === "source" && !skipBuilderSync && state.builder.builderDirty) {
    const synced = syncBuilderToSource({ compile: false, quiet: quietSync, moveToSource: false });
    if (!synced) return false;
  }

  state.activeTab = targetTab;
  applyTabUi(targetTab);

  if (targetTab === "builder") {
    if (state.compileTimer) clearTimeout(state.compileTimer);
    populateBuilderFromTex();
  } else if (state.builder.liveBuilderCompileTimer) {
    clearTimeout(state.builder.liveBuilderCompileTimer);
    state.builder.liveBuilderCompileTimer = null;
  }
  return true;
}

function updateTabIndicator() {
  const activeBtn = editorTabs.querySelector(".tab.active");
  if (!activeBtn || !tabIndicator) return;
  tabIndicator.style.left = activeBtn.offsetLeft + "px";
  tabIndicator.style.width = activeBtn.offsetWidth + "px";
}

function populateBuilderFromTex({ force = false } = {}) {
  const tex = getEditorContent();
  const sourceHash = hashText(tex);
  if (!force) {
    const isSameSource = sourceHash === state.builder.lastParsedSourceHash;
    if (state.builder.builderDirty && isSameSource) return;
    if (!state.builder.builderDirty && isSameSource && rdSections.childElementCount > 0) return;
  }

  if (!tex.trim()) {
    rdPreamble.value = "";
    rdHeaderBlock.value = "";
    rdSections.innerHTML = "";
    appendSectionCard(blankSection());
    rbError.textContent = "";
    state.resumeDoc = null;
    state.builder.builderDirty = false;
    state.builder.lastParsedSourceHash = sourceHash;
    return;
  }

  const parsed = parseResumeDocument(tex);
  state.resumeDoc = parsed;
  state.newlineStyle = parsed.newlineStyle || state.newlineStyle;

  // Preamble
  if (parsed.hasDocument && parsed.preambleRaw) {
    const preambleContent = parsed.preambleRaw;
    rdPreamble.value = preambleContent;
  } else {
    rdPreamble.value = "";
  }

  rdHeaderBlock.value = parsed.headerBlock || "";
  rdSections.innerHTML = "";

  const blocks = Array.isArray(parsed.blocks) && parsed.blocks.length > 0 ? parsed.blocks : [blankSection()];
  blocks.forEach((block) => appendSectionCard(block));
  rbError.textContent = "";
  state.builder.builderDirty = false;
  state.builder.lastParsedSourceHash = sourceHash;
}


// ─── TeX Parser ───
function splitTexDocument(tex) {
  const source = normalizeNewlines(tex);
  const newlineStyle = detectNewlineStyle(tex);
  const beginMatch = /\\begin\{document\}/i.exec(source);
  if (!beginMatch) {
    return { hasDocument: false, preambleRaw: "", body: source, tail: "", newlineStyle };
  }

  const bodyStart = beginMatch.index + beginMatch[0].length;
  const preambleWithBegin = source.slice(0, bodyStart);
  const preambleRaw = preambleWithBegin.replace(/\\begin\{document\}\s*$/i, "");
  const endMatchRel = /\\end\{document\}/i.exec(source.slice(bodyStart));
  if (!endMatchRel) {
    return {
      hasDocument: true,
      preambleRaw,
      body: source.slice(bodyStart),
      tail: "\n\\end{document}\n",
      newlineStyle,
    };
  }

  const endIndex = bodyStart + endMatchRel.index;
  return {
    hasDocument: true,
    preambleRaw,
    body: source.slice(bodyStart, endIndex),
    tail: source.slice(endIndex),
    newlineStyle,
  };
}

function extractHeaderBlock(body) {
  const source = normalizeNewlines(body);
  const centerRe = /\\begin\{center\}[\s\S]*?\\end\{center\}/i;
  const match = centerRe.exec(source);
  if (!match) return { headerBlock: "", rest: source };
  // Preserve whitespace around the header block for round-trip fidelity
  const before = source.slice(0, match.index);
  const after = source.slice(match.index + match[0].length);
  // Collapse the join point: use the larger whitespace gap from either side
  const trailingBefore = (before.match(/\n*$/) || [""])[0];
  const leadingAfter = (after.match(/^\n*/) || [""])[0];
  const separator = trailingBefore.length >= leadingAfter.length ? trailingBefore : leadingAfter;
  const rest = before.replace(/\n*$/, "") + separator + after.replace(/^\n*/, "");
  return { headerBlock: match[0].trim(), rest };
}

function splitEdgeWhitespace(text) {
  const source = normalizeNewlines(text);
  const leadingWhitespace = (source.match(/^\s*/) || [""])[0];
  const trailingWhitespace = (source.match(/\s*$/) || [""])[0];
  const coreEnd = source.length - trailingWhitespace.length;
  const core = source.slice(leadingWhitespace.length, Math.max(leadingWhitespace.length, coreEnd));
  return { leadingWhitespace, core, trailingWhitespace };
}

function splitLeadingCommentChunk(source) {
  const lines = normalizeNewlines(source).split("\n");
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("%")) {
      index += 1;
      continue;
    }
    break;
  }
  return {
    leadingComments: lines.slice(0, index).join("\n"),
    rest: lines.slice(index).join("\n"),
  };
}

function splitTrailingCommentChunk(source) {
  const lines = normalizeNewlines(source).split("\n");
  let index = lines.length - 1;
  while (index >= 0) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith("%")) {
      index -= 1;
      continue;
    }
    break;
  }
  return {
    rest: lines.slice(0, index + 1).join("\n"),
    trailingComments: lines.slice(index + 1).join("\n"),
  };
}

function detectCommonEnvironments(source) {
  const envRe = /\\begin\{(itemize|enumerate|tabular|description)\}/gi;
  const environments = [];
  let match;
  while ((match = envRe.exec(source)) !== null) {
    environments.push(match[1].toLowerCase());
  }
  return environments;
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "\\") {
      i += 1;
      continue;
    }
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Enhanced section parser: handles nested braces in section titles
function parseSectionBlocks(body) {
  const source = normalizeNewlines(body);

  // Match \section, \subsection, \subsubsection with nested brace support
  const headingRe = /\\(section|subsection|subsubsection)(\*)?/gi;
  const matches = [];
  let m;

  while ((m = headingRe.exec(source)) !== null) {
    let braceStart = m.index + m[0].length;
    while (braceStart < source.length && /\s/.test(source[braceStart])) braceStart += 1;
    if (source[braceStart] !== "{") continue;
    const braceEnd = findMatchingBrace(source, braceStart);
    if (braceEnd === -1) continue;

    const title = source.slice(braceStart + 1, braceEnd);
    matches.push({
      index: m.index,
      fullEnd: braceEnd + 1,
      cmd: m[1].toLowerCase(),
      starred: Boolean(m[2]),
      title,
      rawHeading: source.slice(m.index, braceEnd + 1),
    });
  }

  if (matches.length === 0) {
    if (!source.trim()) return [];
    const edge = splitEdgeWhitespace(source);
    const withLeading = splitLeadingCommentChunk(edge.core);
    const withTrailing = splitTrailingCommentChunk(withLeading.rest);
    return withTrailing.rest.trim() || withLeading.leadingComments.trim() || withTrailing.trailingComments.trim()
      ? [{
        kind: "raw",
        cmd: "raw",
        starred: false,
        title: "",
        content: withTrailing.rest.trim(),
        leadingComments: withLeading.leadingComments.trim(),
        trailingComments: withTrailing.trailingComments.trim(),
        rawHeading: "",
        leadingWhitespace: edge.leadingWhitespace,
        trailingWhitespace: edge.trailingWhitespace,
        environments: detectCommonEnvironments(withTrailing.rest),
      }]
      : [];
  }

  const blocks = [];
  const firstStart = matches[0].index;
  const intro = source.slice(0, firstStart);
  if (intro.trim()) {
    const edge = splitEdgeWhitespace(intro);
    const withLeading = splitLeadingCommentChunk(edge.core);
    const withTrailing = splitTrailingCommentChunk(withLeading.rest);
    blocks.push({
      kind: "raw",
      cmd: "raw",
      starred: false,
      title: "",
      content: withTrailing.rest.trim(),
      leadingComments: withLeading.leadingComments.trim(),
      trailingComments: withTrailing.trailingComments.trim(),
      rawHeading: "",
      leadingWhitespace: edge.leadingWhitespace,
      trailingWhitespace: edge.trailingWhitespace,
      environments: detectCommonEnvironments(withTrailing.rest),
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const contentStart = match.fullEnd;
    const contentEnd = i + 1 < matches.length ? matches[i + 1].index : source.length;
    const rawContent = source.slice(contentStart, contentEnd);
    const edge = splitEdgeWhitespace(rawContent);
    const withLeading = splitLeadingCommentChunk(edge.core);
    const withTrailing = splitTrailingCommentChunk(withLeading.rest);
    blocks.push({
      kind: "heading",
      cmd: match.cmd,
      starred: match.starred,
      title: match.title.trim(),
      content: withTrailing.rest.trim(),
      leadingComments: withLeading.leadingComments.trim(),
      trailingComments: withTrailing.trailingComments.trim(),
      rawHeading: match.rawHeading,
      leadingWhitespace: edge.leadingWhitespace,
      trailingWhitespace: edge.trailingWhitespace,
      environments: detectCommonEnvironments(withTrailing.rest),
      originalCmd: match.cmd,
      originalStarred: match.starred,
      originalTitle: match.title.trim(),
    });
  }

  return blocks;
}

function parseResumeDocument(tex) {
  const doc = splitTexDocument(tex);
  const header = extractHeaderBlock(doc.body);
  const blocks = parseSectionBlocks(header.rest);
  return {
    hasDocument: doc.hasDocument,
    preambleRaw: doc.preambleRaw,
    body: doc.body,
    tail: doc.tail,
    headerBlock: header.headerBlock,
    blocks,
    newlineStyle: doc.newlineStyle,
  };
}


// ─── Resume Builder → TeX Serialization ───
function blankSection() {
  return {
    kind: "heading",
    cmd: "section",
    starred: true,
    title: "New Section",
    content: "",
    leadingComments: "",
    trailingComments: "",
    rawHeading: "",
    leadingWhitespace: "\n",
    trailingWhitespace: "\n\n",
    environments: [],
    originalCmd: "section",
    originalStarred: true,
    originalTitle: "New Section",
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
  contentInput.placeholder = isRaw ? "Raw TeX block (kept as-is)." : "Section body (raw TeX).";
}

function markBuilderDirty({ scheduleCompile = true } = {}) {
  state.builder.builderDirty = true;
  state.builder.lastAppliedSnapshotHash = "";
  if (scheduleCompile) scheduleBuilderLiveCompile();
}

function appendSectionCard(section = blankSection()) {
  const safe = {
    cmd: section.cmd || "section",
    title: section.title || "",
    content: section.content || "",
    starred: Boolean(section.starred),
    leadingComments: normalizeNewlines(section.leadingComments || ""),
    trailingComments: normalizeNewlines(section.trailingComments || ""),
    rawHeading: section.rawHeading || "",
    leadingWhitespace: section.leadingWhitespace != null ? String(section.leadingWhitespace) : "\n",
    trailingWhitespace: section.trailingWhitespace != null ? String(section.trailingWhitespace) : "\n\n",
    environments: Array.isArray(section.environments) ? section.environments : [],
    originalCmd: section.originalCmd || section.cmd || "section",
    originalStarred: typeof section.originalStarred === "boolean" ? section.originalStarred : Boolean(section.starred),
    originalTitle: section.originalTitle || section.title || "",
  };
  const metaPayload = encodeURIComponent(JSON.stringify({
    leadingComments: safe.leadingComments,
    trailingComments: safe.trailingComments,
    rawHeading: safe.rawHeading,
    leadingWhitespace: safe.leadingWhitespace,
    trailingWhitespace: safe.trailingWhitespace,
    environments: safe.environments,
    originalCmd: safe.originalCmd,
    originalStarred: safe.originalStarred,
    originalTitle: safe.originalTitle,
  }));

  rdSections.insertAdjacentHTML("beforeend", `
    <article class="rb-card" data-card="section" data-meta="${metaPayload}" draggable="true">
      <div class="rb-card-head">
        <div class="rb-card-actions">
          <span class="rb-drag-handle" title="Drag to reorder">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </span>
          <span class="rb-card-title">Section Block</span>
        </div>
        <div class="rb-card-actions">
          <button type="button" class="rb-duplicate" data-duplicate="section" title="Duplicate this section">Duplicate</button>
          <button type="button" class="rb-remove" data-remove="section">Remove</button>
        </div>
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
        <textarea class="rd-content" rows="${cardContentRows(safe.content)}" spellcheck="false">${htmlEscape(safe.content)}</textarea>
      </label>
    </article>
  `);

  const card = rdSections.lastElementChild;
  updateSectionCardMode(card);
}

function collectSnapshot() {
  const cards = Array.from(rdSections.querySelectorAll('[data-card="section"]'));
  const blocks = cards
    .map((card) => {
      let meta = {};
      try {
        meta = JSON.parse(decodeURIComponent(card.dataset.meta || "%7B%7D"));
      } catch (e) {
        meta = {};
      }

      const cmd = card.querySelector(".rd-cmd").value;
      const title = card.querySelector(".rd-title").value.trim();
      const content = normalizeNewlines(card.querySelector(".rd-content").value);
      const starred = card.querySelector(".rd-star").checked;
      return {
        kind: cmd === "raw" ? "raw" : "heading",
        cmd,
        starred,
        title,
        content,
        leadingComments: normalizeNewlines(meta.leadingComments || ""),
        trailingComments: normalizeNewlines(meta.trailingComments || ""),
        rawHeading: meta.rawHeading || "",
        leadingWhitespace: meta.leadingWhitespace != null ? String(meta.leadingWhitespace) : "\n",
        trailingWhitespace: meta.trailingWhitespace != null ? String(meta.trailingWhitespace) : "\n\n",
        environments: detectCommonEnvironments(content),
        originalCmd: meta.originalCmd || cmd,
        originalStarred: typeof meta.originalStarred === "boolean" ? meta.originalStarred : starred,
        originalTitle: meta.originalTitle || title,
      };
    })
    .filter((block) => {
      const hasContent = block.content.trim() || block.leadingComments.trim() || block.trailingComments.trim();
      return hasContent || (block.cmd !== "raw" && block.title);
    });

  return {
    preamble: normalizeNewlines(rdPreamble.value),
    headerBlock: normalizeNewlines(rdHeaderBlock.value),
    blocks,
    hasDocument: Boolean(state.resumeDoc && state.resumeDoc.hasDocument),
    tail: state.resumeDoc && state.resumeDoc.tail ? state.resumeDoc.tail : "\\end{document}\n",
    newlineStyle: state.newlineStyle || "\n",
  };
}

function validateSnapshot(snapshot) {
  const errors = [];
  snapshot.blocks.forEach((block, i) => {
    if (block.cmd !== "raw" && !block.title.trim()) {
      errors.push(`Section ${i + 1}: title is required for ${block.cmd}.`);
    }
  });
  return errors;
}

function serializeSection(block) {
  const isRaw = block.cmd === "raw";
  const leadingComments = normalizeNewlines(block.leadingComments || "").trim();
  const trailingComments = normalizeNewlines(block.trailingComments || "").trim();
  const content = normalizeNewlines(block.content || "").trim();
  const innerParts = [];
  if (leadingComments) innerParts.push(leadingComments);
  if (content) innerParts.push(content);
  if (trailingComments) innerParts.push(trailingComments);
  const inner = innerParts.join("\n\n");

  if (isRaw) {
    return inner;
  }

  const title = block.title.trim() || "Untitled";
  const heading = block.rawHeading
    && block.cmd === block.originalCmd
    && block.starred === block.originalStarred
    && title === String(block.originalTitle || "").trim()
    ? block.rawHeading
    : `\\${block.cmd}${block.starred ? "*" : ""}{${title}}`;

  if (!inner) return heading;

  const leadingWhitespace = block.leadingWhitespace != null ? String(block.leadingWhitespace) : "\n";
  const trailingWhitespace = block.trailingWhitespace != null ? String(block.trailingWhitespace) : "";
  return `${heading}${leadingWhitespace}${inner}${trailingWhitespace}`;
}

function renderBodyFromSnapshot(snapshot) {
  const parts = [];
  if (snapshot.headerBlock.trim()) parts.push(snapshot.headerBlock.trim());

  snapshot.blocks.forEach((block) => {
    const serialized = serializeSection(block).trim();
    if (serialized) parts.push(serialized);
  });

  return parts.join("\n\n").trim();
}

function buildTexFromSnapshot(snapshot) {
  const body = normalizeNewlines(renderBodyFromSnapshot(snapshot));
  const preamble = normalizeNewlines(snapshot.preamble || "");
  const newlineStyle = snapshot.newlineStyle || state.newlineStyle || "\n";

  if (snapshot.hasDocument || preamble.trim()) {
    const preambleTrimmed = preamble.trimEnd();
    const hasPreambleBeginDoc = /\\begin\{document\}/i.test(preambleTrimmed);
    const preambleWithBegin = hasPreambleBeginDoc
      ? preambleTrimmed
      : `${preambleTrimmed}${preambleTrimmed ? "\n\n" : ""}\\begin{document}`;
    const tail = normalizeNewlines(snapshot.tail || "");
    const safeTail = /\\end\{document\}/i.test(tail) ? tail : "\\end{document}\n";
    const tex = body
      ? `${preambleWithBegin}\n\n${body}\n\n${safeTail.trimStart()}`
      : `${preambleWithBegin}\n\n${safeTail.trimStart()}`;
    return restoreNewlineStyle(tex, newlineStyle);
  }

  return restoreNewlineStyle(body, newlineStyle);
}

function syncBuilderToSource({ compile = false, quiet = false, moveToSource = false } = {}) {
  rbError.textContent = "";
  const snapshot = collectSnapshot();
  const errors = validateSnapshot(snapshot);
  if (errors.length > 0) {
    rbError.textContent = errors.join("\n");
    setStatus("Fix resume builder validation errors before switching tabs.", "warn");
    if (moveToSource) switchTab("builder", { skipBuilderSync: true });
    return false;
  }

  const newTex = buildTexFromSnapshot(snapshot);
  if (newTex !== getEditorContent()) {
    setEditorContent(newTex);
    markDirty(true);
    updateWordCount();
  }

  state.builder.builderDirty = false;
  state.builder.lastAppliedSnapshotHash = hashText(JSON.stringify(snapshot));
  state.builder.lastParsedSourceHash = hashText(newTex);
  state.resumeDoc = parseResumeDocument(newTex);
  state.newlineStyle = state.resumeDoc.newlineStyle || state.newlineStyle;
  rbError.textContent = "";

  if (!quiet) setStatus("Applied resume builder edits.", "ok");
  if (moveToSource) switchTab("source", { skipBuilderSync: true });
  if (compile) void requestPdf({ download: false, quiet });
  return true;
}

function applyBuilderToEditor() {
  syncBuilderToSource({ compile: true, quiet: false, moveToSource: true });
}


// ─── Drag & Drop Section Cards ───
let draggedCard = null;

function installDragDrop() {
  rdSections.addEventListener("dragstart", (e) => {
    const card = e.target.closest('[data-card="section"]');
    if (!card) return;
    draggedCard = card;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });

  rdSections.addEventListener("dragend", (e) => {
    const card = e.target.closest('[data-card="section"]');
    if (card) card.classList.remove("dragging");
    rdSections.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
    draggedCard = null;
  });

  rdSections.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const target = e.target.closest('[data-card="section"]');
    if (target && target !== draggedCard) {
      rdSections.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      target.classList.add("drag-over");
    }
  });

  rdSections.addEventListener("dragleave", (e) => {
    const target = e.target.closest('[data-card="section"]');
    if (target) target.classList.remove("drag-over");
  });

  rdSections.addEventListener("drop", (e) => {
    e.preventDefault();
    const target = e.target.closest('[data-card="section"]');
    if (!target || !draggedCard || target === draggedCard) return;

    const cards = Array.from(rdSections.querySelectorAll('[data-card="section"]'));
    const dragIdx = cards.indexOf(draggedCard);
    const dropIdx = cards.indexOf(target);

    if (dragIdx < dropIdx) {
      target.after(draggedCard);
    } else {
      target.before(draggedCard);
    }

    target.classList.remove("drag-over");
    markBuilderDirty();
  });
}

// ─── Log Panel ───
function expandLog() {
  logPanel.classList.add("expanded");
}

function collapseLog() {
  logPanel.classList.remove("expanded");
}

function toggleLog() {
  logPanel.classList.toggle("expanded");
}

function showLogBadge(show) {
  logBadge.hidden = !show;
}

// ─── Resize Handle ───
function installResizeHandle() {
  let isResizing = false;
  let startX = 0;
  let startLeftWidth = 0;

  resizeHandle.addEventListener("mousedown", (e) => {
    isResizing = true;
    startX = e.clientX;
    startLeftWidth = document.getElementById("editorPanel").offsetWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isResizing) return;
    const diff = e.clientX - startX;
    const totalWidth = workspace.offsetWidth;
    const newLeftFr = ((startLeftWidth + diff) / totalWidth) * 100;
    const clampedLeft = Math.max(25, Math.min(75, newLeftFr));
    const clampedRight = 100 - clampedLeft;
    workspace.style.gridTemplateColumns = `${clampedLeft}% 8px ${clampedRight}%`;
  });

  document.addEventListener("mouseup", () => {
    if (!isResizing) return;
    isResizing = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });
}

// ─── Templates ───
const TEMPLATES = {
  classic: {
    name: "Classic",
    desc: "Traditional single-column resume with clean formatting.",
    tex: `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage[margin=0.8in]{geometry}
\\usepackage{enumitem}
\\usepackage{titlesec}
\\usepackage{hyperref}

\\titleformat{\\section}{\\large\\bfseries\\uppercase}{}{0em}{}[\\titlerule]
\\titlespacing*{\\section}{0pt}{12pt}{6pt}
\\setlist[itemize]{nosep, leftmargin=1.5em}
\\pagestyle{empty}

\\begin{document}

\\begin{center}
{\\LARGE\\bfseries Your Name}\\\\[4pt]
your.email@example.com \\quad|\\quad (555) 123-4567 \\quad|\\quad City, State\\\\[2pt]
\\href{https://linkedin.com/in/yourname}{linkedin.com/in/yourname} \\quad|\\quad \\href{https://github.com/yourname}{github.com/yourname}
\\end{center}

\\section*{Professional Summary}
Results-driven professional with experience in software development and a passion for creating efficient, scalable solutions.

\\section*{Experience}
\\textbf{Software Engineer} \\hfill \\textit{Jan 2023 -- Present}\\\\
\\textit{Company Name} \\hfill City, State
\\begin{itemize}
  \\item Developed and maintained web applications serving 10,000+ users
  \\item Collaborated with cross-functional teams to deliver features on schedule
  \\item Improved application performance by 40\\% through code optimization
\\end{itemize}

\\section*{Education}
\\textbf{Bachelor of Science in Computer Science} \\hfill \\textit{2019 -- 2023}\\\\
\\textit{University Name} \\hfill City, State
\\begin{itemize}
  \\item GPA: 3.8/4.0
  \\item Relevant coursework: Data Structures, Algorithms, Software Engineering
\\end{itemize}

\\section*{Skills}
\\textbf{Languages:} Python, JavaScript, TypeScript, Java, SQL\\\\
\\textbf{Frameworks:} React, Node.js, Django, Flask\\\\
\\textbf{Tools:} Git, Docker, AWS, PostgreSQL

\\section*{Projects}
\\textbf{Project Name} \\hfill \\href{https://github.com/yourname/project}{github.com/yourname/project}
\\begin{itemize}
  \\item Built a full-stack web application with React and Node.js
  \\item Implemented RESTful API with authentication and authorization
\\end{itemize}

\\end{document}`,
  },
  modern: {
    name: "Modern",
    desc: "Contemporary layout with accent colors and a clean sidebar feel.",
    tex: `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage[margin=0.7in]{geometry}
\\usepackage{xcolor}
\\usepackage{enumitem}
\\usepackage{titlesec}
\\usepackage{hyperref}
\\usepackage{fontawesome5}

\\definecolor{accent}{HTML}{2D5BFF}
\\definecolor{darkgray}{HTML}{333333}
\\definecolor{lightgray}{HTML}{999999}

\\titleformat{\\section}{\\color{accent}\\large\\bfseries}{}{0em}{}[{\\color{accent}\\titlerule[1pt]}]
\\titlespacing*{\\section}{0pt}{14pt}{6pt}
\\setlist[itemize]{nosep, leftmargin=1.5em, label={\\color{accent}\\textbullet}}
\\pagestyle{empty}
\\hypersetup{colorlinks=true,urlcolor=accent}

\\begin{document}

\\begin{center}
{\\Huge\\bfseries\\color{darkgray} Your Name}\\\\[6pt]
{\\color{lightgray}\\faEnvelope\\ your.email@example.com \\quad
\\faPhone\\ (555) 123-4567 \\quad
\\faMapMarker*\\ City, State}\\\\[3pt]
{\\color{lightgray}\\faLinkedin\\ \\href{https://linkedin.com/in/yourname}{yourname} \\quad
\\faGithub\\ \\href{https://github.com/yourname}{yourname}}
\\end{center}

\\section*{About Me}
A motivated software developer with a strong foundation in full-stack development. Passionate about building elegant solutions to complex problems.

\\section*{Experience}
{\\bfseries Senior Developer} \\hfill {\\color{lightgray} 2022 -- Present}\\\\
{\\itshape Tech Company Inc.} \\hfill {\\color{lightgray} Sydney, Australia}
\\begin{itemize}
  \\item Led a team of 5 developers to ship a greenfield product in 6 months
  \\item Architected microservices handling 1M+ requests per day
  \\item Mentored junior developers and conducted code reviews
\\end{itemize}

\\vspace{4pt}
{\\bfseries Junior Developer} \\hfill {\\color{lightgray} 2020 -- 2022}\\\\
{\\itshape Startup Co.} \\hfill {\\color{lightgray} Melbourne, Australia}
\\begin{itemize}
  \\item Built responsive web interfaces using React and TypeScript
  \\item Integrated third-party APIs and payment processing systems
\\end{itemize}

\\section*{Education}
{\\bfseries Bachelor of Computer Science} \\hfill {\\color{lightgray} 2016 -- 2020}\\\\
{\\itshape University of Technology} \\hfill {\\color{lightgray} Sydney, Australia}

\\section*{Technical Skills}
\\begin{tabular}{@{} l l}
\\textbf{Languages} & Python, TypeScript, Go, Rust, SQL \\\\
\\textbf{Frontend} & React, Next.js, Tailwind CSS \\\\
\\textbf{Backend} & Node.js, FastAPI, PostgreSQL, Redis \\\\
\\textbf{DevOps} & Docker, Kubernetes, AWS, CI/CD \\\\
\\end{tabular}

\\section*{Projects}
{\\bfseries Open Source Contribution} \\hfill \\href{https://github.com}{View on GitHub}
\\begin{itemize}
  \\item Contributed to major open-source projects with 500+ stars
  \\item Implemented performance optimizations reducing load time by 60\\%
\\end{itemize}

\\end{document}`,
  },
  minimal: {
    name: "Minimal",
    desc: "Clean, elegant layout with no distractions. Content speaks for itself.",
    tex: `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage[margin=1in]{geometry}
\\usepackage{enumitem}
\\usepackage{hyperref}

\\setlist[itemize]{nosep, leftmargin=1.5em}
\\pagestyle{empty}
\\setlength{\\parindent}{0pt}
\\hypersetup{colorlinks=true,urlcolor=black}

\\newcommand{\\ressection}[1]{\\vspace{10pt}{\\large\\textbf{#1}}\\\\[-6pt]\\rule{\\textwidth}{0.4pt}\\vspace{4pt}}

\\begin{document}

\\begin{center}
{\\LARGE Your Name}\\\\[4pt]
email@example.com \\quad $\\cdot$ \\quad (555) 123-4567 \\quad $\\cdot$ \\quad City, State
\\end{center}

\\ressection{Experience}

\\textbf{Job Title} \\hfill 2023 -- Present\\\\
\\textit{Company Name}
\\begin{itemize}
  \\item Delivered key features that improved user retention by 25\\%
  \\item Designed and implemented scalable backend services
\\end{itemize}

\\ressection{Education}

\\textbf{Degree Title} \\hfill 2019 -- 2023\\\\
\\textit{University Name}

\\ressection{Skills}

Python, JavaScript, React, Node.js, PostgreSQL, Git, Docker, AWS

\\ressection{Projects}

\\textbf{Project Title}
\\begin{itemize}
  \\item Description of what you built and the impact it had
\\end{itemize}

\\end{document}`,
  },
};

function renderTemplateGrid() {
  templateGrid.innerHTML = "";
  for (const [key, tmpl] of Object.entries(TEMPLATES)) {
    templateGrid.insertAdjacentHTML("beforeend", `
      <div class="template-card" data-template="${htmlEscape(key)}">
        <div class="template-card-icon">
          <div class="template-preview">
            <div class="tp-line tp-title"></div>
            <div class="tp-line tp-subtitle"></div>
            <div class="tp-line tp-section"></div>
            <div class="tp-line tp-text"></div>
            <div class="tp-line tp-text"></div>
            <div class="tp-line tp-text-short"></div>
            <div class="tp-line tp-section"></div>
            <div class="tp-line tp-text"></div>
            <div class="tp-line tp-text-short"></div>
            <div class="tp-line tp-section"></div>
            <div class="tp-line tp-text"></div>
            <div class="tp-line tp-text"></div>
          </div>
        </div>
        <div class="template-card-name">${htmlEscape(tmpl.name)}</div>
        <div class="template-card-desc">${htmlEscape(tmpl.desc)}</div>
      </div>
    `);
  }
}

function openTemplateModal() {
  renderTemplateGrid();
  templateModal.classList.add("open");
  templateModal.setAttribute("aria-hidden", "false");
}

function closeTemplateModal() {
  templateModal.classList.remove("open");
  templateModal.setAttribute("aria-hidden", "true");
}

function applyTemplate(key) {
  const tmpl = TEMPLATES[key];
  if (!tmpl) return;

  if ((state.dirty || state.builder.builderDirty) && !window.confirm("This will replace your current content. Continue?")) return;

  state.newlineStyle = detectNewlineStyle(tmpl.tex);
  setEditorContent(tmpl.tex);
  resetBuilderTracking();
  clearCompileMarkers();
  state.fileName = "resume.tex";
  markDirty(true);
  setStatus(`Loaded "${tmpl.name}" template.`, "ok");
  closeTemplateModal();
  switchTab("builder");
  updateWordCount();
  void requestPdf({ download: false, sourceText: tmpl.tex });
}


// ─── Preamble Collapsible ───
function installPreambleToggle() {
  const header = preambleSection.querySelector("[data-toggle='preamble']");
  if (header) {
    header.addEventListener("click", () => {
      preambleSection.classList.toggle("open");
    });
  }
}


// ─── Event Installation ───
function installEvents() {
  // File operations
  newBtn.addEventListener("click", loadNewDocument);
  openBtn.addEventListener("click", () => fileInput.click());
  saveTexBtn.addEventListener("click", saveTex);
  previewBtn.addEventListener("click", () => {
    if (state.activeTab === "builder") {
      const snapshot = collectSnapshot();
      const errors = validateSnapshot(snapshot);
      if (errors.length > 0) {
        rbError.textContent = errors.join("\n");
        setStatus("Fix resume builder validation errors before compile.", "warn");
        return;
      }
      requestPdf({ download: false, sourceText: buildTexFromSnapshot(snapshot) });
      return;
    }
    requestPdf({ download: false });
  });
  savePdfBtn.addEventListener("click", () => {
    if (state.activeTab === "builder") {
      const synced = syncBuilderToSource({ compile: false, quiet: true, moveToSource: false });
      if (!synced) return;
    }
    requestPdf({ download: true });
  });

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    handleOpenFile(file);
    fileInput.value = "";
  });

  // Tabs
  editorTabs.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (tab && tab.dataset.tab) switchTab(tab.dataset.tab);
  });

  // Resume builder
  resumeApplyBtn.addEventListener("click", applyBuilderToEditor);
  rdAddSection.addEventListener("click", () => {
    appendSectionCard(blankSection());
    markBuilderDirty();
  });

  rdPreamble.addEventListener("input", () => markBuilderDirty());
  rdHeaderBlock.addEventListener("input", () => markBuilderDirty());

  rdSections.addEventListener("input", (e) => {
    if (e.target.closest('[data-card="section"]')) markBuilderDirty();
  });

  rdSections.addEventListener("change", (e) => {
    const card = e.target.closest('[data-card="section"]');
    if (!card) return;
    if (e.target.classList.contains("rd-cmd")) updateSectionCardMode(card);
    markBuilderDirty();
  });

  rdSections.addEventListener("click", (e) => {
    // Duplicate section
    const dupBtn = e.target.closest('button[data-duplicate="section"]');
    if (dupBtn) {
      const card = dupBtn.closest('[data-card="section"]');
      if (card) {
        const cmd = card.querySelector(".rd-cmd").value;
        const title = card.querySelector(".rd-title").value.trim();
        const content = normalizeNewlines(card.querySelector(".rd-content").value);
        const starred = card.querySelector(".rd-star").checked;
        let meta = {};
        try { meta = JSON.parse(decodeURIComponent(card.dataset.meta || "%7B%7D")); } catch (e) { meta = {}; }
        const dupSection = {
          kind: cmd === "raw" ? "raw" : "heading",
          cmd,
          starred,
          title: title ? `${title} (copy)` : "",
          content,
          leadingComments: meta.leadingComments || "",
          trailingComments: meta.trailingComments || "",
          rawHeading: "", // Force regeneration of heading for the copy
          leadingWhitespace: meta.leadingWhitespace || "\n",
          trailingWhitespace: meta.trailingWhitespace || "\n\n",
          environments: meta.environments || [],
          originalCmd: cmd,
          originalStarred: starred,
          originalTitle: title ? `${title} (copy)` : "",
        };
        // Insert the duplicate right after the original card
        const tempContainer = document.createElement("div");
        rdSections.appendChild(tempContainer);
        appendSectionCard(dupSection);
        const newCard = rdSections.lastElementChild;
        card.after(newCard);
        tempContainer.remove();
        markBuilderDirty();
      }
      return;
    }

    // Remove section
    const removeBtn = e.target.closest('button[data-remove="section"]');
    if (!removeBtn) return;
    const card = removeBtn.closest('[data-card="section"]');
    if (card) {
      card.remove();
      markBuilderDirty();
    }
  });

  // Templates
  templatesBtn.addEventListener("click", openTemplateModal);
  templateCloseBtn.addEventListener("click", closeTemplateModal);
  templateModal.addEventListener("click", (e) => {
    if (e.target === templateModal) closeTemplateModal();
  });
  templateGrid.addEventListener("click", (e) => {
    const card = e.target.closest(".template-card");
    if (card && card.dataset.template) applyTemplate(card.dataset.template);
  });

  // Log panel
  logToggle.addEventListener("click", toggleLog);
  if (askAiBtn) {
    askAiBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      askAiForHelp();
    });
  }
  if (aiDismissBtn) {
    aiDismissBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (aiPanel) aiPanel.hidden = true;
    });
  }
  if (aiApplyBtn) {
    aiApplyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      applyAiFix();
    });
  }
  if (aiPanel) {
    aiPanel.addEventListener("click", (e) => e.stopPropagation());
  }

  // Keyboard shortcuts
  window.addEventListener("keydown", (e) => {
    const hotkey = e.ctrlKey || e.metaKey;
    if (hotkey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (state.activeTab === "builder") {
        const synced = syncBuilderToSource({ compile: false, quiet: true, moveToSource: false });
        if (!synced) return;
      }
      saveTex();
      requestPdf({ download: false });
      return;
    }
    if (hotkey && e.key === "Enter") {
      e.preventDefault();
      if (state.activeTab === "builder") {
        const snapshot = collectSnapshot();
        const errors = validateSnapshot(snapshot);
        if (errors.length > 0) {
          rbError.textContent = errors.join("\n");
          setStatus("Fix resume builder validation errors before compile.", "warn");
          return;
        }
        requestPdf({ download: false, sourceText: buildTexFromSnapshot(snapshot) });
      } else {
        requestPdf({ download: false });
      }
      return;
    }
    if (e.key === "Escape") {
      if (templateModal.classList.contains("open")) closeTemplateModal();
    }
  });

  // Warn before closing with unsaved changes
  window.addEventListener("beforeunload", (e) => {
    if (state.dirty || state.builder.builderDirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}


// ─── Init ───
function init() {
  createEditor();
  collapseLog();
  clearCompileMarkers();
  clearCompileErrorUi();
  updateFileLabel();
  setStatus("Ready.", "ok");
  setLog("Ready.");
  updateWordCount();
  updateTabIndicator();

  installEvents();
  installDragDrop();
  installPreambleToggle();
  installResizeHandle();

  ensureAiAvailable().then(() => showAskAiButton(false)).catch(() => {});
  loadEngineInfo();

  // Re-calc tab indicator after layout settles
  requestAnimationFrame(() => updateTabIndicator());
  window.addEventListener("resize", () => updateTabIndicator());
}

init();
