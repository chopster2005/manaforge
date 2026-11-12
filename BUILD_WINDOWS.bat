@echo off
setlocal
cd /d "%~dp0"
where tsc >nul 2>nul
if errorlevel 1 (
  echo Installing the TypeScript compiler...
  npm install -g typescript
  if errorlevel 1 goto failed
)
tsc -p tsconfig.static.json
if errorlevel 1 goto failed
node build-static.mjs
if errorlevel 1 goto failed
echo Build completed successfully.
pause
exit /b 0
:failed
echo Build failed. Review the TypeScript errors above.
pause
exit /b 1
