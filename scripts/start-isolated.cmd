@echo off
REM ============================================================
REM Start an ISOLATED DSH host for testing the bridge.
REM - uses its own DSH_HOME, never touches your daily ~/.dsh
REM - prints a token URL; open it in a browser to get the pet panel
REM
REM Configure via env vars (or edit the defaults below):
REM   DSH_BIN     path to dsh.cmd
REM   DSH_HOME    isolated home dir
REM   DSH_PROFILE profile name inside that home
REM   DSH_PORT    web port
REM ============================================================
setlocal

if "%DSH_BIN%"=="" set "DSH_BIN=dsh"
if "%DSH_HOME%"=="" set "DSH_HOME=%~dp0..\..\petlab-dsh-home"
if "%DSH_PROFILE%"=="" set "DSH_PROFILE=petlab"
if "%DSH_PORT%"=="" set "DSH_PORT=39190"

echo [petlab] DSH_BIN     = %DSH_BIN%
echo [petlab] DSH_HOME    = %DSH_HOME%
echo [petlab] DSH_PROFILE = %DSH_PROFILE%
echo [petlab] port        = %DSH_PORT%
echo.
echo Copy the "dsh web: http://127.0.0.1:%DSH_PORT%/?token=..." line into your browser.
echo Close this window to stop the host.
echo.

"%DSH_BIN%" --profile %DSH_PROFILE% --no-open --port %DSH_PORT%
endlocal
