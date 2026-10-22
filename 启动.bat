@echo off
title FastGC 聊天系统
set FASTGC_ALLOW_DEV_START=1
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo 正在安装依赖，请稍候...
  call npm install
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
