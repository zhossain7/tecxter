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

const rbName = document.getElementById("rbName");
const rbHeadline = document.getElementById("rbHeadline");
const rbLocation = document.getElementById("rbLocation");
const rbEmail = document.getElementById("rbEmail");
const rbPhone = document.getElementById("rbPhone");
const rbWebsite = document.getElementById("rbWebsite");
const rbSummary = document.getElementById("rbSummary");

const rbExperienceList = document.getElementById("rbExperienceList");
const rbEducationList = document.getElementById("rbEducationList");
const rbProjectList = document.getElementById("rbProjectList");
const rbAddExperience = document.getElementById("rbAddExperience");
const rbAddEducation = document.getElementById("rbAddEducation");
const rbAddProject = document.getElementById("rbAddProject");

const rbSkillsLanguages = document.getElementById("rbSkillsLanguages");
const rbSkillsTools = document.getElementById("rbSkillsTools");
const rbSkillsOther = document.getElementById("rbSkillsOther");

const DEFAULT_TEX = String.raw`\documentclass[11pt]{article}
\usepackage[utf8]{inputenc}
\usepackage{amsmath,amssymb}
\usepackage[a4paper,margin=1in]{geometry}
\title{TeX Studio Local}
\author{Local Build}
\date{\today}
\begin{document}
\maketitle

Write your TeX content here.

\[
\int_{0}^{1} x^2\,dx = \frac{1}{3}
\]

\end{document}
`;

const state = {
  fileName: "Untitled.tex",
  dirty: false,
  pdfUrl: "",
  resumeData: createDefaultResumeData(),
};

function createDefaultResumeData() {
  return {
    profile: {
      name: "",
      headline: "",
      location: "",
      email: "",
      phone: "",
      website: "",
    },
    summary: "",
    experiences: [],
    education: [],
    projects: [],
    skills: {
      languages: "",
      tools: "",
      other: "",
    },
  };
}

function blankExperience() {
  return {
    role: "",
    company: "",
    start: "",
    end: "",
    bullets: [],
  };
}

function blankEducation() {
  return {
    degree: "",
    school: "",
    start: "",
    end: "",
    details: "",
  };
}

function blankProject() {
  return {
    name: "",
    link: "",
    year: "",
    bullets: [],
  };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function splitLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function unescapeLatex(value) {
  return String(value || "")
    .replace(/\\textbackslash\{\}/g, "\\")
    .replace(/\\textasciitilde\{\}/g, "~")
    .replace(/\\textasciicircum\{\}/g, "^")
    .replace(/\\([#$%&_{}])/g, "$1");
}

function stripTexComments(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^\\])%.*/, "$1"))
    .join("\n");
}

function cleanTeXInline(text) {
  let value = String(text || "");
  value = value.replace(/\\textbar\{\}/g, "|");
  value = value.replace(/\\\\/g, " ");
  value = value.replace(/\\hfill/g, " ");
  value = value.replace(/\\begin\{[^}]+\}|\\end\{[^}]+\}/g, " ");

  let prev = "";
  while (prev !== value) {
    prev = value;
    value = value.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, "$1");
  }

  value = value.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, " ");
  value = unescapeLatex(value);
  value = value.replace(/\s+/g, " ").trim();
  return value;
}

function parseDateRange(raw) {
  const text = cleanTeXInline(raw).replace(/\u2013|\u2014/g, "-").trim();
  if (!text) return { start: "", end: "" };

  if (text.includes("--")) {
    const [start, end] = text.split("--", 2).map((part) => part.trim());
    return { start, end };
  }
  if (text.includes(" to ")) {
    const [start, end] = text.split(" to ", 2).map((part) => part.trim());
    return { start, end };
  }
  if (text.includes(" - ")) {
    const [start, end] = text.split(" - ", 2).map((part) => part.trim());
    return { start, end };
  }
  return { start: text, end: "" };
}

function extractSections(tex) {
  const sections = [];
  const re = /\\section\*?\{([^}]*)\}/gi;
  const matches = Array.from(tex.matchAll(re));
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const title = cleanTeXInline(match[1] || "");
    const start = match.index + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : tex.length;
    sections.push({
      title,
      titleKey: title.toLowerCase().replace(/[^a-z]/g, ""),
      content: tex.slice(start, end).trim(),
    });
  }
  return sections;
}

function extractCenterProfile(tex, target) {
  const centerMatch = tex.match(/\\begin\{center\}([\s\S]*?)\\end\{center\}/i);
  if (!centerMatch) return 0;

  const block = centerMatch[1] || "";
  const lines = block
    .split(/\\\\/)
    .map((line) => cleanTeXInline(line))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  let score = 0;
  const nameMatch = block.match(/\\textbf\{([^}]*)\}/i);
  if (nameMatch) {
    target.profile.name = cleanTeXInline(nameMatch[1]);
    score += 1;
  } else if (lines.length > 0) {
    target.profile.name = lines[0];
    score += 1;
  }

  const remaining = lines.filter((line) => line !== target.profile.name);
  if (remaining.length > 0) {
    target.profile.headline = remaining[0];
    score += 1;
  }

  const contactLine = remaining.find((line) => line.includes("@") || line.includes("|")) || "";
  if (contactLine) {
    const parts = contactLine
      .split("|")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    const unused = [];
    parts.forEach((part) => {
      if (!target.profile.email && /@/.test(part)) {
        target.profile.email = part;
      } else if (!target.profile.website && /(https?:\/\/|www\.|linkedin|github)/i.test(part)) {
        target.profile.website = part;
      } else if (!target.profile.phone && /\d{6,}/.test(part.replace(/\D/g, ""))) {
        target.profile.phone = part;
      } else {
        unused.push(part);
      }
    });

    if (!target.profile.location && unused.length > 0) {
      target.profile.location = unused.join(", ");
    }
    score += 1;
  }

  return score;
}

function splitEntriesByBoldHeaders(content) {
  const matches = Array.from(content.matchAll(/\\textbf\{[^}]+\}[^\n]*/g));
  if (matches.length === 0) return [];

  const entries = [];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length;
    const chunk = content.slice(start, end).trim();
    if (chunk) entries.push(chunk);
  }
  return entries;
}

function parseItemizeBullets(chunk) {
  const bullets = [];
  const itemizeBlocks = Array.from(
    chunk.matchAll(/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/gi)
  );
  itemizeBlocks.forEach((block) => {
    const body = block[1] || "";
    const items = Array.from(body.matchAll(/\\item\s+([\s\S]*?)(?=(\\item|$))/g));
    items.forEach((item) => {
      const text = cleanTeXInline(item[1]);
      if (text) bullets.push(text);
    });
  });
  return bullets;
}

function parseHeaderLine(chunk) {
  const firstLine = chunk.split(/\r?\n/)[0] || "";
  const boldMatch = firstLine.match(/\\textbf\{([^}]*)\}/);
  const roleOrTitle = boldMatch ? cleanTeXInline(boldMatch[1]) : "";

  const hfillParts = firstLine.split(/\\hfill/i);
  const leftPart = hfillParts[0] || "";
  const rightPart = hfillParts[1] || "";

  const leftWithoutBold = leftPart.replace(/\\textbf\{[^}]*\}/, "");
  let orgPart = cleanTeXInline(leftWithoutBold)
    .replace(/^(---|--|-|:|at\s+)/i, "")
    .trim();
  const dates = parseDateRange(rightPart);

  if (!orgPart) {
    const fallback = cleanTeXInline(firstLine)
      .replace(roleOrTitle, "")
      .replace(/^(---|--|-|:|at\s+)/i, "")
      .trim();
    orgPart = fallback;
  }

  return { roleOrTitle, orgPart, dates };
}

function parseExperienceSection(content) {
  const entries = splitEntriesByBoldHeaders(content);
  return entries
    .map((chunk) => {
      const header = parseHeaderLine(chunk);
      return {
        role: header.roleOrTitle,
        company: header.orgPart,
        start: header.dates.start,
        end: header.dates.end,
        bullets: parseItemizeBullets(chunk),
      };
    })
    .filter((item) => item.role || item.company || item.start || item.end || item.bullets.length);
}

function parseEducationSection(content) {
  const entries = splitEntriesByBoldHeaders(content);
  return entries
    .map((chunk) => {
      const header = parseHeaderLine(chunk);
      const details = cleanTeXInline(
        chunk
          .split(/\r?\n/)
          .slice(1)
          .join(" ")
      );
      return {
        degree: header.roleOrTitle,
        school: header.orgPart,
        start: header.dates.start,
        end: header.dates.end,
        details,
      };
    })
    .filter((item) => item.degree || item.school || item.start || item.end || item.details);
}

function parseProjectSection(content) {
  const entries = splitEntriesByBoldHeaders(content);
  return entries
    .map((chunk) => {
      const header = parseHeaderLine(chunk);
      const lines = chunk.split(/\r?\n/).map((line) => cleanTeXInline(line)).filter(Boolean);
      const link = lines.find((line) => /(https?:\/\/|www\.|github|gitlab|linkedin)/i.test(line)) || "";
      return {
        name: header.roleOrTitle,
        link,
        year: header.dates.start || header.dates.end,
        bullets: parseItemizeBullets(chunk),
      };
    })
    .filter((item) => item.name || item.link || item.year || item.bullets.length);
}

function parseSkillsSection(content) {
  const lines = content
    .split(/\\\\|\r?\n/)
    .map((line) => cleanTeXInline(line))
    .filter((line) => line.length > 0);
  const result = { languages: "", tools: "", other: "" };
  const other = [];

  lines.forEach((line) => {
    const languages = line.match(/^Languages?\s*:\s*(.+)$/i);
    const tools = line.match(/^Tools?\s*:\s*(.+)$/i);
    const otherSkill = line.match(/^Other\s*:\s*(.+)$/i);
    if (languages) result.languages = languages[1].trim();
    else if (tools) result.tools = tools[1].trim();
    else if (otherSkill) result.other = otherSkill[1].trim();
    else other.push(line);
  });

  if (!result.other && other.length > 0) result.other = other.join(", ");
  return result;
}

function parseResumeFromTex(tex) {
  const source = stripTexComments(tex || "");
  const parsed = createDefaultResumeData();
  let confidence = 0;
  const sectionsFound = [];

  confidence += extractCenterProfile(source, parsed);

  const sections = extractSections(source);
  sections.forEach((section) => {
    sectionsFound.push(section.title || section.titleKey);
    const key = section.titleKey;
    if (/summary|profile|objective/.test(key)) {
      parsed.summary = cleanTeXInline(section.content);
      if (parsed.summary) confidence += 1;
    } else if (/experience|employment|work/.test(key)) {
      parsed.experiences = parseExperienceSection(section.content);
      if (parsed.experiences.length > 0) confidence += 2;
    } else if (/education|academic/.test(key)) {
      parsed.education = parseEducationSection(section.content);
      if (parsed.education.length > 0) confidence += 2;
    } else if (/project|portfolio/.test(key)) {
      parsed.projects = parseProjectSection(section.content);
      if (parsed.projects.length > 0) confidence += 1;
    } else if (/skill|technicalskill|techskill/.test(key)) {
      parsed.skills = parseSkillsSection(section.content);
      if (parsed.skills.languages || parsed.skills.tools || parsed.skills.other) confidence += 1;
    }
  });

  const hasStructuralData =
    parsed.profile.name ||
    parsed.profile.headline ||
    parsed.summary ||
    parsed.experiences.length > 0 ||
    parsed.education.length > 0 ||
    parsed.projects.length > 0 ||
    parsed.skills.languages ||
    parsed.skills.tools ||
    parsed.skills.other;

  return {
    ok: hasStructuralData && confidence >= 2,
    confidence,
    sectionsFound,
    data: parsed,
  };
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
  state.resumeData = createDefaultResumeData();
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
        setStatus(
          `Saved ${modeTag} (download folder).`,
          data.mode === "latex" ? "ok" : "warn"
        );
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
    // Keep app usable if engine info endpoint fails.
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

function appendExperienceCard(data = blankExperience()) {
  const bullets = (data.bullets || []).join("\n");
  rbExperienceList.insertAdjacentHTML(
    "beforeend",
    `
      <article class="rb-card" data-card="experience">
        <div class="rb-card-head">
          <span class="rb-card-title">Experience</span>
          <button type="button" class="rb-remove" data-remove="experience">Remove</button>
        </div>
        <div class="rb-grid-two">
          <label>Role* <input class="rb-exp-role" type="text" maxlength="120" value="${htmlEscape(data.role)}"></label>
          <label>Company* <input class="rb-exp-company" type="text" maxlength="120" value="${htmlEscape(data.company)}"></label>
          <label>Start <input class="rb-exp-start" type="text" maxlength="40" value="${htmlEscape(data.start)}" placeholder="2022"></label>
          <label>End <input class="rb-exp-end" type="text" maxlength="40" value="${htmlEscape(data.end)}" placeholder="Present"></label>
        </div>
        <label>Bullet Points (one per line)
          <textarea class="rb-exp-bullets" rows="4">${htmlEscape(bullets)}</textarea>
        </label>
      </article>
    `
  );
}

function appendEducationCard(data = blankEducation()) {
  rbEducationList.insertAdjacentHTML(
    "beforeend",
    `
      <article class="rb-card" data-card="education">
        <div class="rb-card-head">
          <span class="rb-card-title">Education</span>
          <button type="button" class="rb-remove" data-remove="education">Remove</button>
        </div>
        <div class="rb-grid-two">
          <label>Degree* <input class="rb-edu-degree" type="text" maxlength="120" value="${htmlEscape(data.degree)}"></label>
          <label>School* <input class="rb-edu-school" type="text" maxlength="140" value="${htmlEscape(data.school)}"></label>
          <label>Start <input class="rb-edu-start" type="text" maxlength="40" value="${htmlEscape(data.start)}"></label>
          <label>End <input class="rb-edu-end" type="text" maxlength="40" value="${htmlEscape(data.end)}"></label>
        </div>
        <label>Details
          <textarea class="rb-edu-details" rows="3">${htmlEscape(data.details)}</textarea>
        </label>
      </article>
    `
  );
}

function appendProjectCard(data = blankProject()) {
  const bullets = (data.bullets || []).join("\n");
  rbProjectList.insertAdjacentHTML(
    "beforeend",
    `
      <article class="rb-card" data-card="project">
        <div class="rb-card-head">
          <span class="rb-card-title">Project</span>
          <button type="button" class="rb-remove" data-remove="project">Remove</button>
        </div>
        <div class="rb-grid-two">
          <label>Project Name* <input class="rb-proj-name" type="text" maxlength="140" value="${htmlEscape(data.name)}"></label>
          <label>Year <input class="rb-proj-year" type="text" maxlength="40" value="${htmlEscape(data.year)}"></label>
          <label style="grid-column: 1 / -1;">Link
            <input class="rb-proj-link" type="text" maxlength="200" value="${htmlEscape(data.link)}" placeholder="https://...">
          </label>
        </div>
        <label>Bullet Points (one per line)
          <textarea class="rb-proj-bullets" rows="4">${htmlEscape(bullets)}</textarea>
        </label>
      </article>
    `
  );
}

function populateResumeModal(data) {
  const safe = deepClone(data || createDefaultResumeData());

  rbName.value = safe.profile.name || "";
  rbHeadline.value = safe.profile.headline || "";
  rbLocation.value = safe.profile.location || "";
  rbEmail.value = safe.profile.email || "";
  rbPhone.value = safe.profile.phone || "";
  rbWebsite.value = safe.profile.website || "";
  rbSummary.value = safe.summary || "";
  rbSkillsLanguages.value = safe.skills.languages || "";
  rbSkillsTools.value = safe.skills.tools || "";
  rbSkillsOther.value = safe.skills.other || "";

  rbExperienceList.innerHTML = "";
  rbEducationList.innerHTML = "";
  rbProjectList.innerHTML = "";

  (safe.experiences || []).forEach((item) => appendExperienceCard(item));
  (safe.education || []).forEach((item) => appendEducationCard(item));
  (safe.projects || []).forEach((item) => appendProjectCard(item));
}

function openResumeModal() {
  rbError.textContent = "";
  if (!hasLikelyTex(editor.value)) {
    setStatus("Load or paste a TeX resume first, then use Edit Resume.", "warn");
    return;
  }

  const parsed = parseResumeFromTex(editor.value);
  if (!parsed.ok) {
    setStatus("Could not detect recognizable resume sections in this TeX.", "error");
    return;
  }

  state.resumeData = parsed.data;
  const found = parsed.sectionsFound.filter(Boolean).join(", ");
  if (found) {
    setStatus(`Detected sections: ${found}`, "ok");
  }

  populateResumeModal(state.resumeData);
  resumeModal.classList.add("open");
  resumeModal.setAttribute("aria-hidden", "false");
}

function closeResumeModal() {
  resumeModal.classList.remove("open");
  resumeModal.setAttribute("aria-hidden", "true");
}

function collectResumeDataFromModal() {
  const experiences = Array.from(rbExperienceList.querySelectorAll(".rb-card"))
    .map((card) => ({
      role: card.querySelector(".rb-exp-role").value.trim(),
      company: card.querySelector(".rb-exp-company").value.trim(),
      start: card.querySelector(".rb-exp-start").value.trim(),
      end: card.querySelector(".rb-exp-end").value.trim(),
      bullets: splitLines(card.querySelector(".rb-exp-bullets").value),
    }))
    .filter((item) => item.role || item.company || item.start || item.end || item.bullets.length);

  const education = Array.from(rbEducationList.querySelectorAll(".rb-card"))
    .map((card) => ({
      degree: card.querySelector(".rb-edu-degree").value.trim(),
      school: card.querySelector(".rb-edu-school").value.trim(),
      start: card.querySelector(".rb-edu-start").value.trim(),
      end: card.querySelector(".rb-edu-end").value.trim(),
      details: card.querySelector(".rb-edu-details").value.trim(),
    }))
    .filter((item) => item.degree || item.school || item.start || item.end || item.details);

  const projects = Array.from(rbProjectList.querySelectorAll(".rb-card"))
    .map((card) => ({
      name: card.querySelector(".rb-proj-name").value.trim(),
      link: card.querySelector(".rb-proj-link").value.trim(),
      year: card.querySelector(".rb-proj-year").value.trim(),
      bullets: splitLines(card.querySelector(".rb-proj-bullets").value),
    }))
    .filter((item) => item.name || item.link || item.year || item.bullets.length);

  return {
    profile: {
      name: rbName.value.trim(),
      headline: rbHeadline.value.trim(),
      location: rbLocation.value.trim(),
      email: rbEmail.value.trim(),
      phone: rbPhone.value.trim(),
      website: rbWebsite.value.trim(),
    },
    summary: rbSummary.value.trim(),
    experiences,
    education,
    projects,
    skills: {
      languages: rbSkillsLanguages.value.trim(),
      tools: rbSkillsTools.value.trim(),
      other: rbSkillsOther.value.trim(),
    },
  };
}

function validateResumeData(data) {
  const errors = [];
  if (!data.profile.name) errors.push("Full Name is required.");
  if (!data.profile.headline) errors.push("Headline / Role is required.");

  data.experiences.forEach((item, index) => {
    const anyData = item.role || item.company || item.start || item.end || item.bullets.length;
    if (!anyData) return;
    if (!item.role) errors.push(`Experience ${index + 1}: Role is required.`);
    if (!item.company) errors.push(`Experience ${index + 1}: Company is required.`);
  });

  data.education.forEach((item, index) => {
    const anyData = item.degree || item.school || item.start || item.end || item.details;
    if (!anyData) return;
    if (!item.degree) errors.push(`Education ${index + 1}: Degree is required.`);
    if (!item.school) errors.push(`Education ${index + 1}: School is required.`);
  });

  data.projects.forEach((item, index) => {
    const anyData = item.name || item.link || item.year || item.bullets.length;
    if (!anyData) return;
    if (!item.name) errors.push(`Project ${index + 1}: Project Name is required.`);
  });

  return errors;
}

function escapeLatex(value) {
  return String(value || "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/&/g, "\\&")
    .replace(/%/g, "\\%")
    .replace(/\$/g, "\\$")
    .replace(/#/g, "\\#")
    .replace(/_/g, "\\_")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

function buildDateRange(start, end) {
  const a = (start || "").trim();
  const b = (end || "").trim();
  if (a && b) return `${a} -- ${b}`;
  return a || b || "";
}

function buildResumeTex(data) {
  const t = (value) => escapeLatex(value);
  const lines = [];

  lines.push("\\documentclass[11pt]{article}");
  lines.push("\\usepackage[utf8]{inputenc}");
  lines.push("\\usepackage[a4paper,margin=0.8in]{geometry}");
  lines.push("\\usepackage{enumitem}");
  lines.push("\\usepackage[hidelinks]{hyperref}");
  lines.push("\\setlist[itemize]{leftmargin=1.2em,topsep=2pt,itemsep=2pt}");
  lines.push("\\pagestyle{empty}");
  lines.push("\\begin{document}");
  lines.push("\\begin{center}");
  lines.push(`{\\LARGE \\textbf{${t(data.profile.name)}}}\\\\`);
  lines.push(`${t(data.profile.headline)}\\\\`);

  const contactParts = [
    data.profile.location,
    data.profile.email,
    data.profile.phone,
    data.profile.website,
  ]
    .filter((part) => part && part.trim())
    .map((part) => t(part));
  if (contactParts.length > 0) lines.push(contactParts.join(" \\textbar{} "));
  lines.push("\\end{center}");
  lines.push("");

  if (data.summary) {
    lines.push("\\section*{Summary}");
    lines.push(t(data.summary));
    lines.push("");
  }

  if (data.experiences.length > 0) {
    lines.push("\\section*{Experience}");
    data.experiences.forEach((exp) => {
      const role = t(exp.role);
      const company = t(exp.company);
      const range = t(buildDateRange(exp.start, exp.end));
      let header = `\\textbf{${role}} --- ${company}`;
      if (range) header += ` \\hfill ${range}`;
      lines.push(`${header}\\\\`);
      if (exp.bullets.length > 0) {
        lines.push("\\begin{itemize}");
        exp.bullets.forEach((bullet) => lines.push(`\\item ${t(bullet)}`));
        lines.push("\\end{itemize}");
      }
      lines.push("");
    });
  }

  if (data.education.length > 0) {
    lines.push("\\section*{Education}");
    data.education.forEach((edu) => {
      const degree = t(edu.degree);
      const school = t(edu.school);
      const range = t(buildDateRange(edu.start, edu.end));
      let header = `\\textbf{${degree}} --- ${school}`;
      if (range) header += ` \\hfill ${range}`;
      lines.push(`${header}\\\\`);
      if (edu.details) lines.push(`${t(edu.details)}\\\\`);
      lines.push("");
    });
  }

  if (data.projects.length > 0) {
    lines.push("\\section*{Projects}");
    data.projects.forEach((project) => {
      const name = t(project.name);
      const year = t(project.year);
      const link = t(project.link);
      let header = `\\textbf{${name}}`;
      if (year) header += ` \\hfill ${year}`;
      lines.push(`${header}\\\\`);
      if (link) lines.push(`${link}\\\\`);
      if (project.bullets.length > 0) {
        lines.push("\\begin{itemize}");
        project.bullets.forEach((bullet) => lines.push(`\\item ${t(bullet)}`));
        lines.push("\\end{itemize}");
      }
      lines.push("");
    });
  }

  const skills = [];
  if (data.skills.languages) skills.push(`\\textbf{Languages:} ${t(data.skills.languages)}`);
  if (data.skills.tools) skills.push(`\\textbf{Tools:} ${t(data.skills.tools)}`);
  if (data.skills.other) skills.push(`\\textbf{Other:} ${t(data.skills.other)}`);
  if (skills.length > 0) {
    lines.push("\\section*{Skills}");
    skills.forEach((line) => lines.push(`${line}\\\\`));
    lines.push("");
  }

  lines.push("\\end{document}");
  return lines.join("\n");
}

function applyResumeToEditor() {
  rbError.textContent = "";
  const data = collectResumeDataFromModal();
  const errors = validateResumeData(data);
  if (errors.length > 0) {
    rbError.textContent = errors.join("\n");
    return;
  }

  state.resumeData = data;
  editor.value = buildResumeTex(data);
  if (!state.fileName || state.fileName === "Untitled.tex") state.fileName = "resume.tex";
  markDirty(true);
  setStatus("Structured resume applied to editor.", "ok");
  closeResumeModal();
}

function removeCard(button) {
  const card = button.closest(".rb-card");
  if (!card) return;
  card.remove();
}

function installResumeEditorEvents() {
  editResumeBtn.addEventListener("click", openResumeModal);
  resumeCloseBtn.addEventListener("click", closeResumeModal);
  resumeCancelBtn.addEventListener("click", closeResumeModal);
  resumeApplyBtn.addEventListener("click", applyResumeToEditor);

  resumeModal.addEventListener("click", (event) => {
    if (event.target === resumeModal) closeResumeModal();
  });

  rbAddExperience.addEventListener("click", () => appendExperienceCard(blankExperience()));
  rbAddEducation.addEventListener("click", () => appendEducationCard(blankEducation()));
  rbAddProject.addEventListener("click", () => appendProjectCard(blankProject()));

  rbExperienceList.addEventListener("click", (event) => {
    const removeBtn = event.target.closest('button[data-remove="experience"]');
    if (removeBtn) removeCard(removeBtn);
  });

  rbEducationList.addEventListener("click", (event) => {
    const removeBtn = event.target.closest('button[data-remove="education"]');
    if (removeBtn) removeCard(removeBtn);
  });

  rbProjectList.addEventListener("click", (event) => {
    const removeBtn = event.target.closest('button[data-remove="project"]');
    if (removeBtn) removeCard(removeBtn);
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
