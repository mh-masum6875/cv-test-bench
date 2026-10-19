@echo off
REM Double-click to start CV Test Bench on Windows. Needs Python 3.10 or newer.
cd /d "%~dp0"
if not exist .venv (
  echo First run: creating a virtual environment and installing packages...
  python -m venv .venv
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\pip install -r requirements.txt
)
start "" http://127.0.0.1:8000
.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
pause
