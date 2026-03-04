# TecTex

I started **TecTex** because I wanted to make a genuinely good resume, and I realised LaTeX gives the best results for clean, professional formatting.

The problem: LaTeX tools can feel annoying for quick resume edits.

So I built this as a local-first desktop app where I can:
- edit TeX directly,
- preview PDF quickly,
- use a structured resume editor that detects sections from existing TeX and prevents easy formatting breakage.

It’s still a work in progress, and I’ll keep improving it over time until it reaches my vision: an all-in-one resume editor with LaTeX at its core.

## What TecTex Does

- TeX editor + PDF preview
- Native `Save As PDF` in desktop mode
- Structured `Edit Resume` mode that:
- reads current TeX resume content,
- detects sections (profile, experience, education, projects, skills),
- maps fields into editable form inputs,
- regenerates safe escaped TeX
- Local PDF generation pipeline:
- bundled `tectonic` if present,
- fallback to `tectonic` / `pdflatex` / `xelatex` / `lualatex` from PATH,
- final text-PDF fallback if no engine is available

## Tech Stack

- Python backend launcher/API: `texviewer_app.py`
- Frontend app: `local_app/` (HTML/CSS/JS)
- Packaging: PyInstaller (`texviewer_app.spec`)

## Project Structure

- `texviewer_app.py`
- `texviewer_app.spec`
- `local_app/index.html`
- `local_app/styles.css`
- `local_app/app.js`
- `scripts/setup_tectonic.ps1`
- `tools/tectonic/README.txt`
- `requirements.txt`

## Local Setup

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install -r .\requirements.txt
.\.venv\Scripts\python -m pip install pyinstaller
```

## Optional: Bundle Tectonic

If you want local LaTeX compile without relying on system PATH:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
& .\scripts\setup_tectonic.ps1
```

Expected bundled binary:
- `tools\tectonic\tectonic.exe`

## Run in Dev Mode

```powershell
.\.venv\Scripts\python .\texviewer_app.py --browser
```

## Build Windows EXE

```powershell
.\.venv\Scripts\python -m PyInstaller --clean --noconfirm .\texviewer_app.spec
```

Output:
- `dist\TeXViewerDesktop.exe`

## Why This Exists

This is a personal project that grew from my own workflow pain.
I wanted resume quality from LaTeX without the usual friction.
TecTex is my attempt to make that process faster, safer, and practical for day-to-day updates.
