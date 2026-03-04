# TeX Studio Local

TeX Studio Local is a local-first Windows desktop app for editing TeX resumes and exporting PDF.

## Features

- TeX editor with live PDF preview
- Native `Save As PDF` dialog in desktop mode
- Structured `Edit Resume` mode:
  - parses existing TeX resume sections
  - maps recognized fields (profile, experience, education, projects, skills)
  - regenerates safe TeX with escaping/validation
- Local PDF generation pipeline:
  - bundled `tectonic` (if present)
  - fallback to `tectonic` / `pdflatex` / `xelatex` / `lualatex` on PATH
  - text-PDF fallback if no TeX engine is available

## Repository Layout

- `texviewer_app.py`: Python desktop launcher + local API server
- `local_app/`: frontend (HTML/CSS/JS)
- `scripts/setup_tectonic.ps1`: helper to bundle `tectonic` into `tools/tectonic`
- `tools/tectonic/`: optional bundled engine folder
- `texviewer_app.spec`: PyInstaller build config
- `requirements.txt`: runtime Python dependency list

## Prerequisites

- Windows 10/11
- Python 3.9+ (recommended)
- PowerShell

## Setup (from a fresh clone)

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install -r .\requirements.txt
.\.venv\Scripts\python -m pip install pyinstaller
```

## Optional: Bundle `tectonic` for fully local compile

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
& .\scripts\setup_tectonic.ps1
```

Expected output file:

- `tools\tectonic\tectonic.exe`

## Run in Dev Mode

```powershell
.\.venv\Scripts\python .\texviewer_app.py --browser
```

## Build EXE (PyInstaller)

```powershell
.\.venv\Scripts\python -m PyInstaller --clean --noconfirm .\texviewer_app.spec
```

Build output:

- `dist\TeXViewerDesktop.exe`

## Reproducible Workflow

1. Clone repo
2. Create venv and install dependencies
3. Optionally bundle `tectonic`
4. Build with PyInstaller spec
5. Run or ship `dist\TeXViewerDesktop.exe`

## Shipping the EXE

If you want to distribute binaries publicly, the recommended approach is:

1. Keep source in Git
2. Build EXE in CI or release machine
3. Upload `TeXViewerDesktop.exe` to GitHub Releases

If you prefer committing the EXE directly, you can, but repository size will grow over time.
