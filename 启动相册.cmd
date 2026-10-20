@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24 或更新版本。
  pause
  exit /b 1
)
if not exist "node_modules\express\package.json" (
  echo 首次启动，正在安装项目依赖，需要联网……
  call npm.cmd install --no-fund --no-audit --registry=https://registry.npmjs.org
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)
if not exist "dist\index.html" (
  call npm.cmd run build
  if errorlevel 1 (
    echo 构建失败，请查看上方错误信息。
    pause
    exit /b 1
  )
)
echo.
echo 光影相册正在启动。
echo 浏览器访问：http://127.0.0.1:3001
echo 默认邀请码：FRAME-FIRST-100
echo 关闭此窗口将停止本地服务。照片和账号会保存在 data 目录中。
echo.
call npm.cmd start
if errorlevel 1 pause
