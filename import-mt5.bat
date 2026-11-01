@echo off
cd /d %~dp0
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not found. Install it from nodejs.org and run this again.
  pause
  exit /b 1
)
REM Reads the CSV files that mt5\TvHubExport.mq5 wrote in MetaTrader and puts the candles into the separate MetaTrader archive.
REM The report is saved as mt5-import-report.txt and opened in Notepad (the Windows console cannot show Persian).
REM Extra options can be added after the name, e.g.  import-mt5.bat --dry   or   import-mt5.bat --offset ny:7
del mt5-import-report.txt 2>nul
node mt5-import.js %* --out mt5-import-report.txt
if exist mt5-import-report.txt start "" notepad mt5-import-report.txt
echo.
pause
