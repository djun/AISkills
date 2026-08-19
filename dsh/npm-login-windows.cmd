@echo off
setlocal EnableExtensions

set "REGISTRY=https://registry.npmjs.org/"

where npm >nul 2>&1
if errorlevel 1 goto npm_missing

echo Logging in to %REGISTRY%
echo npm may open a browser to complete authentication.
echo.

call npm login --registry="%REGISTRY%"
if errorlevel 1 goto login_failed

set "NPM_USER="
for /f "delims=" %%A in ('call npm whoami --registry="%REGISTRY%" 2^>nul') do set "NPM_USER=%%A"
if not defined NPM_USER goto verify_failed

echo.
echo Authenticated npm account: %NPM_USER%
echo Registry: %REGISTRY%
echo.
pause
exit /b 0

:npm_missing
echo Error: npm was not found on PATH. Install Node.js and try again.
goto failed

:login_failed
echo.
echo Error: npm login failed.
goto failed

:verify_failed
echo.
echo Error: login finished, but npm whoami could not verify the account.

:failed
echo.
pause
exit /b 1
