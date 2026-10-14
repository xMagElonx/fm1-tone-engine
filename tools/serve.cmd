@echo off
rem ===========================================================================
rem  Double-click this file to serve the FM-1 tone workbench on localhost.
rem  Why you may need it: Web MIDI requires a secure context. Whether file://
rem  counts is not consistent across browsers, so if connecting to the device
rem  is refused, use http://localhost instead -- that is what this starts.
rem
rem  Keep this file ASCII-only: cmd.exe reads .cmd in the system codepage,
rem  and non-ASCII bytes here would come out garbled.
rem ===========================================================================
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this machine.
  echo   Install it from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

node tools\serve.mjs
echo.
echo   Server stopped.
pause
