@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
if errorlevel 1 exit /b 1

echo Preparing the project's Python environment...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-python.ps1"
if errorlevel 1 goto failed

echo Collecting landscape display photos from 500px...
"%~dp0.venv\Scripts\python.exe" -X utf8 -B "%~dp0scripts\sync-500px-covers.py" %*
if errorlevel 1 goto failed

echo.
echo Covers updated. Refresh the album homepage to see them.
popd
pause
exit /b 0

:failed
echo.
echo Update failed. Your previous homepage cover list has been kept.
popd
pause
exit /b 1
