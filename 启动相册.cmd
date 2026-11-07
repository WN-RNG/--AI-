@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
title 光影相册 - 本地启动
cd /d "%~dp0"
if errorlevel 1 goto directory_error

where node >nul 2>nul
if errorlevel 1 goto node_error
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto node_error
where npm.cmd >nul 2>nul
if errorlevel 1 goto npm_error

rem Local startup uses its own address, independent of Render environment settings.
if not defined ALBUM_PORT set "ALBUM_PORT=3001"
set "PORT=%ALBUM_PORT%"
node -e "const p=process.env.PORT;process.exit(/^[1-9][0-9]{0,4}$/.test(p) && Number(p)<=65535 ? 0 : 1)"
if errorlevel 1 goto port_setting_error
set "HOST=127.0.0.1"
set "PUBLIC_ORIGIN=http://127.0.0.1:%PORT%"
if not defined DATA_DIR set "DATA_DIR=%CD%\data"

node -e "const s=require('node:net').createServer();s.once('error',()=>process.exit(1));s.listen(Number(process.env.PORT),'127.0.0.1',()=>s.close(()=>process.exit(0)));"
if errorlevel 1 goto port_busy

node -e "require('sharp');for(const m of ['express','multer','react','react-dom','lucide-react','typescript','vite','@vitejs/plugin-react'])require.resolve(m)" >nul 2>nul
if errorlevel 1 goto install_dependencies
goto build_latest

:install_dependencies
echo 首次启动或依赖不完整，正在安装项目依赖，需要联网……
if exist "package-lock.json" (
  call npm.cmd ci --include=dev --no-fund --no-audit --registry=https://registry.npmjs.org
) else (
  call npm.cmd install --include=dev --no-fund --no-audit --registry=https://registry.npmjs.org
)
if errorlevel 1 goto install_error

:build_latest
echo.
echo 正在构建最新相册界面，请稍候……
rem Node.js 24 loads the Vite configuration natively, including Windows paths.
call npm.cmd run build -- --configLoader native
if errorlevel 1 goto build_error

echo.
echo 光影相册正在启动。
echo 访问地址：%PUBLIC_ORIGIN%
if /i "%ALBUM_OPEN_BROWSER%"=="0" (
  echo 请在浏览器打开上方地址。
) else (
  echo 服务就绪后会自动打开浏览器。
)
echo 数据目录："%DATA_DIR%"
if defined INVITE_CODE (
  echo 邀请码：使用你设置的 INVITE_CODE 环境变量。
) else (
  echo 本地默认邀请码：FRAME-FIRST-100
)
echo 保持此窗口开启，关闭窗口会停止本地服务。
echo.

rem Set ALBUM_OPEN_BROWSER=0 to start without opening a browser.
if /i "%ALBUM_OPEN_BROWSER%"=="0" goto run_server
start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "$url=$env:PUBLIC_ORIGIN; $deadline=(Get-Date).AddSeconds(45); while((Get-Date) -lt $deadline) { try { $response=Invoke-WebRequest -Uri ($url+'/api/auth/session') -UseBasicParsing -TimeoutSec 2; if($response.StatusCode -eq 200) { Start-Process -FilePath $url; exit 0 } } catch {}; Start-Sleep -Milliseconds 400 }" >nul 2>nul

:run_server
call npm.cmd start
if errorlevel 1 goto server_error
exit /b 0

:directory_error
echo 无法进入项目目录，请把此启动文件放在相册项目根目录。
goto failed
:node_error
echo 请先安装 Node.js 24 或更新版本，再重新双击启动。
goto failed
:npm_error
echo 未找到 npm，请检查 Node.js 是否已完整安装。
goto failed
:port_setting_error
echo ALBUM_PORT 必须是 1 到 65535 之间的整数。
goto failed
:port_busy
echo 端口 %PORT% 已被占用。
echo 请先关闭之前的相册服务窗口，再重新双击启动。
echo 如果是其他程序占用，可通过 ALBUM_PORT 环境变量选择其他端口。
goto failed
:install_error
echo 依赖安装失败，请检查上方错误和网络后重试。
goto failed
:build_error
echo 构建失败，已停止启动，请查看上方错误信息。
goto failed
:server_error
echo 服务启动或运行失败，请查看上方错误信息。
:failed
echo.
pause
exit /b 1
