"""Local-first TeX desktop app with PDF preview/export.

Features:
- Local editor UI served from bundled static files
- Local LaTeX compile when an engine exists (tectonic/pdflatex/xelatex/lualatex)
- Always-works fallback: export source text to PDF
- Native desktop window via pywebview
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from dataclasses import dataclass
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

try:
    import webview
except ImportError:
    webview = None

APP_TITLE = "TeX Studio Local"
ENTRYPOINT = "local_app/index.html"
MAX_BODY_BYTES = 4 * 1024 * 1024
LATEX_ENGINES = ("tectonic", "pdflatex", "xelatex", "lualatex")

DOC_CLASS_RE = re.compile(r"\\documentclass(?:\s|\[|\{)", re.IGNORECASE)
BEGIN_DOC_RE = re.compile(r"\\begin\s*\{\s*document\s*\}", re.IGNORECASE)
END_DOC_RE = re.compile(r"\\end\s*\{\s*document\s*\}", re.IGNORECASE)

# ─── Gemini AI Config ───
_gemini_config: dict = {
    "api_key": "",
    "model": "gemini-2.0-flash",
    "last_request_time": 0.0,
    "rate_limit_seconds": 5.0,
}

GEMINI_SYSTEM_PROMPT = """You are an expert LaTeX debugger. The user has a LaTeX document that failed to compile.
You will receive the LaTeX source code and the compiler error log.

Your job:
1. Identify the root cause of the error — be specific (line number, missing package, typo, etc.)
2. Explain the error in one short paragraph a beginner would understand.
3. Provide the COMPLETE corrected LaTeX source code that will compile successfully.

Rules:
- Only fix actual errors. Do not change content, style, or formatting unless it is the cause of the error.
- If the error is a missing package, add the \\usepackage line in the preamble.
- If the error is a structural issue (missing \\end, unmatched braces), fix only that.
- Return your response in this exact format:

DIAGNOSIS:
[your explanation here]

FIXED_SOURCE:
[the complete corrected LaTeX source code here]
"""


def _gemini_available() -> bool:
    return bool(_gemini_config.get("api_key", "").strip())


def _call_gemini(source: str, log_text: str, error_text: str) -> dict:
    if not _gemini_available():
        return {"ok": False, "error": "AI is not configured. Start with --gemini-key."}

    now = time.time()
    elapsed = now - _gemini_config["last_request_time"]
    if elapsed < _gemini_config["rate_limit_seconds"]:
        wait = _gemini_config["rate_limit_seconds"] - elapsed
        return {"ok": False, "error": f"Rate limited. Try again in {wait:.0f}s."}
    _gemini_config["last_request_time"] = now

    api_key = _gemini_config["api_key"]
    model = _gemini_config["model"]
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"

    # Truncate source and log to stay within free-tier token limits
    max_source = 8000
    max_log = 4000
    truncated_source = source[:max_source] + ("\n... [truncated]" if len(source) > max_source else "")
    truncated_log = log_text[-max_log:] if len(log_text) > max_log else log_text

    user_message = (
        f"LaTeX Source Code:\n```latex\n{truncated_source}\n```\n\n"
        f"Compiler Error Log:\n```\n{truncated_log}\n```"
    )
    if error_text:
        user_message += f"\n\nError Summary: {error_text}"

    payload = json.dumps({
        "system_instruction": {"parts": [{"text": GEMINI_SYSTEM_PROMPT}]},
        "contents": [{"parts": [{"text": user_message}]}],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 8192,
        },
    }).encode("utf-8")

    req = Request(url, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")

    try:
        with urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        return {"ok": False, "error": f"Gemini API error {exc.code}: {body}"}
    except (URLError, OSError) as exc:
        return {"ok": False, "error": f"Network error: {exc}"}
    except Exception as exc:
        return {"ok": False, "error": f"Unexpected error: {exc}"}

    # Parse the Gemini response
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError):
        return {"ok": False, "error": "Unexpected AI response format."}

    # Extract DIAGNOSIS and FIXED_SOURCE sections
    diagnosis = ""
    fixed_source = ""
    if "DIAGNOSIS:" in text:
        parts = text.split("DIAGNOSIS:", 1)[1]
        if "FIXED_SOURCE:" in parts:
            diagnosis, rest = parts.split("FIXED_SOURCE:", 1)
            diagnosis = diagnosis.strip()
            # Extract code from markdown fence if present
            fixed_source = rest.strip()
            if fixed_source.startswith("```"):
                # Remove opening fence
                first_newline = fixed_source.index("\n") if "\n" in fixed_source else len(fixed_source)
                fixed_source = fixed_source[first_newline + 1:]
                # Remove closing fence
                if "```" in fixed_source:
                    fixed_source = fixed_source[:fixed_source.rindex("```")]
            fixed_source = fixed_source.strip()
        else:
            diagnosis = parts.strip()
    else:
        diagnosis = text.strip()

    suggestion = diagnosis if diagnosis else text.strip()
    return {
        "ok": True,
        "suggestion": suggestion,
        "fixed_source": fixed_source,
        "diagnosis": diagnosis,
        "raw": text,
    }


@dataclass
class CompileResult:
    ok: bool
    engine: str
    pdf_bytes: bytes
    log: str
    tried: list[str]
    prep_note: str


class LocalAppHandler(SimpleHTTPRequestHandler):
    """HTTP server for static app files and local JSON APIs."""

    def __init__(self, *args, directory: str | None = None, **kwargs):
        super().__init__(*args, directory=directory, **kwargs)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            self.path = f"/{ENTRYPOINT}"
            return super().do_GET()
        if parsed.path == "/api/health":
            return self._send_json({"ok": True, "app": APP_TITLE})
        if parsed.path == "/api/engines":
            app_root = Path(self.directory).resolve() if self.directory else resolve_root()
            return self._send_json({"ok": True, "engines": discover_engines(app_root)})
        if parsed.path == "/api/ai-status":
            return self._send_json({"ok": True, "available": _gemini_available()})
        return super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/pdf":
            return self._handle_pdf()
        if parsed.path == "/api/ai-help":
            return self._handle_ai_help()
        self.send_error(HTTPStatus.NOT_FOUND, "Endpoint not found")

    def _read_json_body(self) -> dict | None:
        try:
            content_len = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json({"ok": False, "error": "Invalid Content-Length"}, status=400)
            return None

        if content_len <= 0:
            self._send_json({"ok": False, "error": "Empty request body"}, status=400)
            return None

        if content_len > MAX_BODY_BYTES:
            self._send_json({"ok": False, "error": "Request body too large"}, status=413)
            return None

        raw = self.rfile.read(content_len)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json({"ok": False, "error": "Body must be valid JSON"}, status=400)
            return None
        if not isinstance(payload, dict):
            self._send_json({"ok": False, "error": "JSON body must be an object"}, status=400)
            return None
        return payload

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_pdf(self) -> None:
        payload = self._read_json_body()
        if payload is None:
            return

        source = str(payload.get("source", ""))
        source = source if source else ""
        engine = str(payload.get("engine", "auto")).strip().lower() or "auto"
        allow_fallback = bool(payload.get("allow_text_fallback", True))

        app_root = Path(self.directory).resolve() if self.directory else resolve_root()
        result = render_pdf_payload(
            source=source,
            requested_engine=engine,
            allow_text_fallback=allow_fallback,
            app_root=app_root,
        )
        self._send_json(result, status=200 if result.get("ok") else 400)

    def _handle_ai_help(self) -> None:
        if not _gemini_available():
            return self._send_json({"ok": False, "error": "AI is not configured."}, status=503)

        payload = self._read_json_body()
        if payload is None:
            return

        source = str(payload.get("source", ""))[:16000]
        log_text = str(payload.get("log", ""))[:8000]
        error_text = str(payload.get("error", ""))[:500]

        if not source.strip():
            return self._send_json({"ok": False, "error": "No source provided."}, status=400)

        result = _call_gemini(source, log_text, error_text)
        self._send_json(result, status=200 if result.get("ok") else 429 if "Rate limited" in result.get("error", "") else 500)


class DesktopBridge:
    """Functions exposed to frontend JS when running in pywebview."""

    def __init__(self) -> None:
        self.window = None

    def set_window(self, window) -> None:
        self.window = window

    def save_pdf_base64(self, pdf_base64: str, suggested_name: str = "document.pdf") -> dict:
        if webview is None:
            return {"ok": False, "error": "pywebview is not available."}
        if self.window is None:
            return {"ok": False, "error": "Desktop window is not ready."}

        safe_name = (suggested_name or "document.pdf").strip() or "document.pdf"
        if not safe_name.lower().endswith(".pdf"):
            safe_name = f"{safe_name}.pdf"

        try:
            pdf_bytes = base64.b64decode(pdf_base64)
        except Exception:
            return {"ok": False, "error": "Invalid PDF payload."}

        try:
            result = self.window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=safe_name,
                file_types=("PDF files (*.pdf)", "All files (*.*)"),
            )
        except TypeError:
            # Compatibility with older pywebview versions.
            result = self.window.create_file_dialog(
                webview.SAVE_DIALOG,
                save_filename=safe_name,
            )
        except Exception as exc:
            return {"ok": False, "error": f"Failed to open save dialog: {exc}"}

        if not result:
            return {"ok": False, "cancelled": True}

        file_path = result[0] if isinstance(result, (list, tuple)) else result
        if not file_path:
            return {"ok": False, "cancelled": True}

        try:
            out_path = Path(file_path)
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(pdf_bytes)
            return {"ok": True, "path": str(out_path)}
        except Exception as exc:
            return {"ok": False, "error": f"Failed to save file: {exc}"}


def resolve_root() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(getattr(sys, "_MEIPASS")).resolve()
    return Path(__file__).resolve().parent


def normalize_tex_source(source: str) -> tuple[str, str]:
    cleaned = source.replace("\r\n", "\n").replace("\r", "\n")
    if not cleaned.strip():
        cleaned = "Write TeX here."
    if not DOC_CLASS_RE.search(cleaned) or not BEGIN_DOC_RE.search(cleaned):
        wrapped = (
            "\\documentclass[11pt]{article}\n"
            "\\usepackage[utf8]{inputenc}\n"
            "\\usepackage{amsmath,amssymb}\n"
            "\\usepackage[a4paper,margin=1in]{geometry}\n"
            "\\begin{document}\n\n"
            f"{cleaned.strip()}\n\n"
            "\\end{document}\n"
        )
        return wrapped, "Added default document wrapper automatically."
    if not END_DOC_RE.search(cleaned):
        return cleaned.rstrip() + "\n\n\\end{document}\n", "Added missing \\end{document}."
    return cleaned, ""


def build_engine_order(requested_engine: str) -> list[str]:
    requested = requested_engine.lower()
    if requested != "auto" and requested in LATEX_ENGINES:
        return [requested] + [eng for eng in LATEX_ENGINES if eng != requested]
    return list(LATEX_ENGINES)


def _tectonic_bundled_candidates(app_root: Path) -> list[Path]:
    exe_name = "tectonic.exe" if os.name == "nt" else "tectonic"
    env_candidate = os.environ.get("TEXSTUDIO_TECTONIC_PATH", "").strip()
    candidates: list[Path] = []
    if env_candidate:
        candidates.append(Path(env_candidate))
    candidates.extend(
        [
            app_root / "tools" / "tectonic" / exe_name,
            app_root / "tectonic" / exe_name,
        ]
    )
    return candidates


def resolve_engine_binary(engine: str, app_root: Path) -> tuple[str | None, str]:
    if engine == "tectonic":
        for candidate in _tectonic_bundled_candidates(app_root):
            if candidate.exists() and candidate.is_file():
                return str(candidate), "bundled"

    on_path = shutil.which(engine)
    if on_path:
        return on_path, "PATH"
    return None, ""


def discover_engines(app_root: Path) -> list[dict]:
    engines: list[dict] = []
    for engine in LATEX_ENGINES:
        binary, source_kind = resolve_engine_binary(engine, app_root)
        engines.append(
            {
                "name": engine,
                "available": bool(binary),
                "source": source_kind if binary else "",
                "path": binary or "",
            }
        )
    return engines


def compile_tex_to_pdf(source: str, requested_engine: str, app_root: Path) -> CompileResult:
    tex_source, prep_note = normalize_tex_source(source)
    attempt_order = build_engine_order(requested_engine)
    tried: list[str] = []
    logs: list[str] = []

    with tempfile.TemporaryDirectory(prefix="texstudio_") as tmpdir_raw:
        tmpdir = Path(tmpdir_raw)
        tex_file = tmpdir / "main.tex"
        tex_file.write_text(tex_source, encoding="utf-8")

        for engine in attempt_order:
            binary, source_kind = resolve_engine_binary(engine, app_root)
            if not binary:
                logs.append(f"[skip] {engine}: not found (bundled location or PATH)")
                continue

            if engine == "tectonic":
                command = [binary, "main.tex", "--keep-logs", "--outdir", "."]
            else:
                command = [binary, "-interaction=nonstopmode", "-halt-on-error", "main.tex"]

            tried.append(engine)
            logs.append(f"[run] {engine} ({source_kind}): {' '.join(command)}")

            try:
                creationflags = 0
                startupinfo = None
                if os.name == "nt":
                    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                    startupinfo = subprocess.STARTUPINFO()
                    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    if hasattr(subprocess, "SW_HIDE"):
                        startupinfo.wShowWindow = subprocess.SW_HIDE

                proc = subprocess.run(
                    command,
                    cwd=tmpdir,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=90,
                    check=False,
                    creationflags=creationflags,
                    startupinfo=startupinfo,
                )
            except subprocess.TimeoutExpired:
                logs.append(f"[fail] {engine}: timed out after 90s")
                continue
            except OSError as exc:
                logs.append(f"[fail] {engine}: {exc}")
                continue

            pdf_path = tmpdir / "main.pdf"
            stdout = proc.stdout.strip()
            stderr = proc.stderr.strip()
            if stdout:
                logs.append(f"[{engine} stdout]\n{stdout}")
            if stderr:
                logs.append(f"[{engine} stderr]\n{stderr}")

            log_file = tmpdir / "main.log"
            if log_file.exists():
                try:
                    latex_log = log_file.read_text(encoding="utf-8", errors="replace").strip()
                except OSError:
                    latex_log = ""
                if latex_log:
                    logs.append(f"[{engine} main.log]\n{latex_log[-12000:]}")

            if proc.returncode == 0 and pdf_path.exists():
                return CompileResult(
                    ok=True,
                    engine=engine,
                    pdf_bytes=pdf_path.read_bytes(),
                    log="\n\n".join(logs),
                    tried=tried,
                    prep_note=prep_note,
                )

            logs.append(f"[fail] {engine}: exit code {proc.returncode}")

    if not tried:
        logs.append("No LaTeX engine was available. Install tectonic or TeX Live.")

    return CompileResult(
        ok=False,
        engine="",
        pdf_bytes=b"",
        log="\n\n".join(logs),
        tried=tried,
        prep_note=prep_note,
    )


def _pdf_escape(text: str) -> str:
    safe = text.encode("latin-1", "replace").decode("latin-1")
    return safe.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _wrap_lines(text: str, max_chars: int = 95) -> list[str]:
    lines: list[str] = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if len(line) <= max_chars:
            lines.append(line)
            continue
        remaining = line
        while len(remaining) > max_chars:
            lines.append(remaining[:max_chars])
            remaining = remaining[max_chars:]
        lines.append(remaining)
    return lines if lines else [""]


def _assemble_pdf(objects: list[bytes]) -> bytes:
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]

    for obj_id, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{obj_id} 0 obj\n".encode("ascii"))
        output.extend(obj)
        if not obj.endswith(b"\n"):
            output.extend(b"\n")
        output.extend(b"endobj\n")

    xref_start = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
            f"startxref\n{xref_start}\n%%EOF\n"
        ).encode("ascii")
    )
    return bytes(output)


def export_text_pdf(source: str) -> bytes:
    lines = _wrap_lines(source)
    lines_per_page = 50
    pages = [lines[i : i + lines_per_page] for i in range(0, len(lines), lines_per_page)]
    if not pages:
        pages = [[""]]

    objects: list[bytes] = []
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")

    page_count = len(pages)
    font_obj_id = 3 + page_count * 2
    kids = " ".join(f"{3 + i * 2} 0 R" for i in range(page_count))
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {page_count} >>".encode("ascii"))

    for idx, page_lines in enumerate(pages):
        page_obj_id = 3 + idx * 2
        content_obj_id = page_obj_id + 1

        text_ops = [
            "BT",
            "/F1 10 Tf",
            "14 TL",
            "50 795 Td",
        ]
        for line in page_lines:
            text_ops.append(f"({_pdf_escape(line)}) Tj")
            text_ops.append("T*")
        text_ops.append("ET")
        stream = "\n".join(text_ops).encode("latin-1", "replace")

        page_obj = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            f"/Resources << /Font << /F1 {font_obj_id} 0 R >> >> "
            f"/Contents {content_obj_id} 0 R >>"
        ).encode("ascii")
        objects.append(page_obj)

        content_obj = (
            f"<< /Length {len(stream)} >>\nstream\n".encode("ascii")
            + stream
            + b"\nendstream"
        )
        objects.append(content_obj)

    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>")
    return _assemble_pdf(objects)


def render_pdf_payload(
    source: str,
    requested_engine: str = "auto",
    allow_text_fallback: bool = True,
    app_root: Path | None = None,
) -> dict:
    root = app_root or resolve_root()
    compile_result = compile_tex_to_pdf(source, requested_engine, root)

    if compile_result.ok:
        return {
            "ok": True,
            "mode": "latex",
            "engine": compile_result.engine,
            "prep_note": compile_result.prep_note,
            "message": f"Compiled with {compile_result.engine}.",
            "log": compile_result.log,
            "pdf_base64": base64.b64encode(compile_result.pdf_bytes).decode("ascii"),
        }

    if allow_text_fallback:
        fallback_pdf = export_text_pdf(source)
        fallback_message = (
            "LaTeX compile failed or no engine was found. "
            "Exported a plain text PDF fallback."
        )
        log = compile_result.log
        if compile_result.prep_note:
            log = f"{compile_result.prep_note}\n\n{log}" if log else compile_result.prep_note
        return {
            "ok": True,
            "mode": "text",
            "engine": "text-export",
            "prep_note": compile_result.prep_note,
            "message": fallback_message,
            "log": log,
            "pdf_base64": base64.b64encode(fallback_pdf).decode("ascii"),
        }

    return {
        "ok": False,
        "error": "LaTeX compile failed and fallback is disabled.",
        "prep_note": compile_result.prep_note,
        "log": compile_result.log,
    }


def start_local_server(root: Path) -> ThreadingHTTPServer:
    handler = partial(LocalAppHandler, directory=str(root))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    return server


def open_in_browser(url: str) -> None:
    webbrowser.open(url, new=1)


def run_gui(url: str) -> None:
    if webview is None:
        raise RuntimeError(
            "pywebview is not installed. Install it with: pip install pywebview"
        )

    bridge = DesktopBridge()
    window = webview.create_window(
        APP_TITLE,
        url=url,
        width=1540,
        height=980,
        min_size=(1100, 760),
        resizable=True,
        js_api=bridge,
    )
    bridge.set_window(window)
    webview.start(debug=False)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run TeX Studio Local desktop app.")
    parser.add_argument(
        "--browser",
        action="store_true",
        help="Open in the default browser instead of a native desktop window.",
    )
    parser.add_argument(
        "--gemini-key",
        type=str,
        default="",
        help="Gemini API key for AI error diagnostics. Also reads GEMINI_API_KEY env var.",
    )
    args = parser.parse_args()

    # Configure Gemini AI
    gemini_key = (args.gemini_key or os.environ.get("GEMINI_API_KEY", "")).strip()
    if gemini_key:
        _gemini_config["api_key"] = gemini_key
        print(f"Gemini AI enabled (model: {_gemini_config['model']})")
    else:
        print("Gemini AI disabled (no --gemini-key or GEMINI_API_KEY).")

    root = resolve_root()
    entry_file = root / ENTRYPOINT
    if not entry_file.exists():
        print(f"Missing app entry file: {entry_file}")
        return 1

    server = start_local_server(root)
    url = f"http://127.0.0.1:{server.server_port}/"

    try:
        if args.browser:
            open_in_browser(url)
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                return 0
        run_gui(url)
        return 0
    except RuntimeError as exc:
        print(str(exc))
        return 1
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
