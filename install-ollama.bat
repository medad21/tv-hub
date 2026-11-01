@echo off
rem Installs Ollama (the free local AI runner) if it is missing, then downloads a model that fits THIS computer's memory.
rem Run it yourself, once (double-click). Afterwards open TV Hub > Assistant > "Set up Ollama" and tap the model: that is the whole connection.
setlocal enabledelayedexpansion
chcp 65001 >nul
set RAM=0
for /f %%i in ('powershell -NoProfile -Command "[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB)"') do set RAM=%%i
rem same rule as the program itself (assistant.js recommendModel)
set MODEL=qwen2.5:7b
if %RAM% LSS 12 set MODEL=qwen2.5:3b
if %RAM% LSS 6 set MODEL=qwen2.5:1.5b
if %RAM% LEQ 0 set MODEL=qwen2.5:3b
echo System memory about %RAM% GB  -^>  model: %MODEL%

where ollama >nul 2>nul
if %errorlevel%==0 (
  echo Ollama is already installed.
) else (
  where winget >nul 2>nul
  if !errorlevel!==0 (
    echo Installing Ollama with winget...
    winget install -e --id Ollama.Ollama --accept-package-agreements --accept-source-agreements
  ) else (
    echo winget is not available. Opening the download page: install Ollama, then run this file again.
    start https://ollama.com/download
    pause
    exit /b 1
  )
  rem the new PATH is not visible to this window: use the default install folder
  if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Ollama"
)

where ollama >nul 2>nul
if not %errorlevel%==0 (
  echo Ollama was installed but this window cannot see it yet. Close this window, open it again and run this file once more.
  pause
  exit /b 1
)
curl -s http://localhost:11434/api/tags >nul 2>nul
if not %errorlevel%==0 (
  echo Starting Ollama...
  start "" /min ollama serve
  timeout /t 5 /nobreak >nul
)
ollama pull %MODEL%
echo.
echo Done. In TV Hub open: Assistant ^> Set up Ollama ^> tap  %MODEL%
pause
