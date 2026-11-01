@echo off
cd /d %~dp0
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not found. Install it from nodejs.org and run this again.
  pause
  exit /b 1
)
REM Downloads years of 1-hour candles for 8 big crypto pairs from Binance's public data archive (data.binance.vision) into the candle archive.
REM The report is saved as crypto-import-report.txt and opened in Notepad (the Windows console cannot show Persian).
REM Stop the bot first (or run this while it is idle). Candles already in the archive are never changed.
REM Needs a connection that can reach data.binance.vision. If it is blocked, add a proxy:  import-crypto.bat --proxy http://127.0.0.1:10809
REM Other timeframe or start:  import-crypto.bat --tf 30 --from 2022-01     (the ML lab needs the SAME timeframe for all pairs it uses together)
del crypto-import-report.txt 2>nul
node history-import.js --symbols BINANCE:BTCUSDT,BINANCE:ETHUSDT,BINANCE:SOLUSDT,BINANCE:BNBUSDT,BINANCE:XRPUSDT,BINANCE:ADAUSDT,BINANCE:DOGEUSDT,BINANCE:LINKUSDT --tf 60 --from 2021-01 %* > crypto-import-report.txt 2>&1
if exist crypto-import-report.txt start "" notepad crypto-import-report.txt
echo.
pause
