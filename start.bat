@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ================================================
echo   MaiMen Smart Order - one-click launcher
echo ================================================
echo.

REM 1. Check Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node.js 18+ first.
  echo         https://nodejs.org/
  echo.
  pause
  exit /b 1
)

REM 2. Install frontend deps on first run only
if not exist "web\node_modules" (
  echo [1/3] First run: installing frontend dependencies...
  echo       ^(this only happens once^)
  pushd web
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check your network and retry.
    popd
    pause
    exit /b 1
  )
  popd
  echo.
)

REM 3. Optional MCP token from .env (git-ignored, token stays out of git)
if exist ".env" (
  for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /i "%%A"=="MCD_MCP_TOKEN" if not "%%B"=="" set "MCD_MCP_TOKEN=%%B"
  )
)

REM Backend must listen on 3000 to match the Vite /api proxy.
set "PORT=3000"

REM 4. Launch backend
echo [2/3] Starting backend  -^>  http://127.0.0.1:3000
start "MaiMen - Backend" /d "%~dp0" cmd /k "node server\api.js"

REM 5. Launch frontend (Vite dev server)
echo [3/3] Starting frontend -^>  http://localhost:5173
start "MaiMen - Frontend" /d "%~dp0web" cmd /k "call npm run dev"

REM 6. Open the browser after Vite is ready
timeout /t 5 /nobreak >nul
start "" http://localhost:5173

echo.
echo Done. Two windows are now running:
echo   - MaiMen - Backend   ^(port 3000^)
echo   - MaiMen - Frontend  ^(port 5173^)
echo.
echo Close each window ^(or press Ctrl+C^) to stop that service.
echo.
echo Tip: to use live store data ^(optional^), create a ".env" file here:
echo       MCD_MCP_TOKEN=xxx
echo       The demo works fully offline without it.
echo.
pause
