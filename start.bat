@echo off
cd /d %~dp0
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not found.
  echo Install Node.js 22 LTS from nodejs.org - Node 18 also works for signal and paper modes - then CLOSE this window and run start.bat again.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo Node version: %%v
REM Install packages the first time, and again whenever package.json changed (e.g. after an update of this program).
set NEED=0
if not exist node_modules set NEED=1
fc /b package.json node_modules\.tvhub-package.json >nul 2>nul
if errorlevel 1 set NEED=1
if "%NEED%"=="1" (
  echo Installing packages, please wait...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Read the message above.
    echo If it is a network error, try a VPN, or run this once:
    echo npm config set registry https://registry.npmmirror.com
    pause
    exit /b 1
  )
  copy /y package.json node_modules\.tvhub-package.json >nul
)
REM The exchange library (ccxt) is only needed for REAL crypto orders; signal and paper modes work without it.
node system-check.js install
if errorlevel 1 (
  echo.
  echo [WARNING] ccxt is not installed ^(internet/filtering?^). Signal and paper modes work fine.
  echo Real crypto orders will NOT work until it is installed: turn on a VPN and run start.bat again,
  echo or press the install button in the dashboard.
  echo.
)
if not exist .env copy .env.example .env >nul
echo.
echo Starting... open http://localhost:3000 in your browser
node server.js
echo.
echo [The program stopped. Read the message above.]
pause
