@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 goto failed
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required. Run the album launcher first.
  goto failed
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto failed
echo Updating homepage covers from the cover-materials folder...
node "%~dp0scripts\update-covers.mjs"
if errorlevel 1 goto failed
echo.
echo Done. Refresh the local homepage to see the new selection.
echo For the online site, commit the public/covers output and redeploy.
pause
exit /b 0
:failed
echo.
echo Update failed. The previous cover selection was retained. Check the error above.
pause
exit /b 1
