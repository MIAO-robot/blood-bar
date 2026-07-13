@echo off
chcp 65001 >nul
title 抖音血条插件
echo ================================
echo    抖音直播血条插件
echo ================================
echo.
echo 正在启动...
echo.

:: 检查 Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

:: 进入程序目录
cd /d "%~dp0"

:: 检查是否已安装依赖
if not exist "node_modules" (
    echo [提示] 正在安装依赖...
    call npm install
)

:: 启动程序
echo [提示] 请确保已启动 douyinLive 服务 (默认端口 1088)
echo.
npx electron . --no-sandbox

pause
