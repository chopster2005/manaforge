@echo off
setlocal
cd /d "%~dp0"
echo ==============================================
echo   AETHERFORGE MTG v3.0 - LOCAL CARD SCANNER
echo ==============================================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js LTS from https://nodejs.org/
  pause
  exit /b 1
)
if exist "dist\index.html" (
  echo Starting the prebuilt app. No npm install is required.
) else (
  echo The built app was not found. Install TypeScript with: npm install -g typescript
  echo Then run BUILD_WINDOWS.bat.
  pause
  exit /b 1
)
node serve.mjs
pause
