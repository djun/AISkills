@echo off

where node >nul 2>&1
if errorlevel 1 (
  echo Error: node was not found on PATH. Install Node.js and try again.
  echo.
  pause
  exit /b 1
)

node "%~dp0npm-publish.mjs"
exit /b %ERRORLEVEL%
