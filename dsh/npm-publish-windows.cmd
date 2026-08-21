@echo off

where node >nul 2>&1
if errorlevel 1 goto :missing_node
where npm >nul 2>&1
if errorlevel 1 goto :missing_node

call npm --prefix "%~dp0.." run emit:dsh-release
if errorlevel 1 exit /b %ERRORLEVEL%
node "%~dp0build\npm-publish.mjs"
exit /b %ERRORLEVEL%

:missing_node
echo Error: node and npm must be available on PATH. Install Node.js and try again.
echo.
pause
exit /b 1
