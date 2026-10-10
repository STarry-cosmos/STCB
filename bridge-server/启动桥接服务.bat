@echo off
rem GBK / CP936 encoded - do NOT re-save as UTF-8
setlocal enabledelayedexpansion
title STCB 桥接服务
cd /d "%~dp0"

echo ============================================
echo   STCB 桥接服务
echo   SillyTavern x ComfyUI
echo ============================================
echo.

rem ---------- 1. 找 Python ----------
set "PY="

if not exist "python-path.txt" goto no_pyfile
set /p PY=<python-path.txt
if not defined PY goto no_pyfile
if exist "!PY!" goto py_found
echo [警告] python-path.txt 里写的路径不存在：!PY!
set "PY="

:no_pyfile
where python >nul 2>&1
if errorlevel 1 goto no_python
set "PY=python"

:py_found
echo [信息] 使用 Python: %PY%
"%PY%" --version
if errorlevel 1 goto python_broken

rem ---------- 2. 检查依赖 ----------
"%PY%" -c "import aiohttp" >nul 2>&1
if not errorlevel 1 goto deps_ok

echo.
echo [提示] 这个 Python 里没有 aiohttp，桥接服务需要它。
echo        安装位置：%PY%
set "ANS="
set /p ANS=是否现在安装？(Y/N) 
if /i "!ANS!"=="Y" goto do_install
echo.
echo [取消] 没有安装。你也可以手动执行：
echo        %PY% -m pip install aiohttp
goto the_end_fail

:do_install
"%PY%" -m pip install aiohttp
if errorlevel 1 goto deps_failed

:deps_ok
rem ---------- 3. 启动 ----------
echo.
echo [启动] 服务运行中，按 Ctrl+C 可停止
echo.
"%PY%" bridge_server.py %*
echo.
echo [退出] 服务已停止
goto the_end_ok

:no_python
echo [错误] 没有找到 Python。
echo.
echo 两个办法，任选其一：
echo   1. 安装 Python，安装时勾选 "Add Python to PATH"
echo   2. 在本文件旁边建一个 python-path.txt，里面只写一行 Python 的完整路径
echo      例如： D:\ComfyUI\python_embeded\python.exe
echo.
echo 提示：如果你装了 ComfyUI，它自带的 Python 就能用，
echo       通常在 ComfyUI 目录下的 python_embeded\python.exe
goto the_end_fail

:python_broken
echo [错误] Python 无法正常运行，请检查上面的输出
goto the_end_fail

:deps_failed
echo [错误] aiohttp 安装失败。可以手动执行：
echo   %PY% -m pip install aiohttp
goto the_end_fail

:the_end_ok
pause
endlocal
exit /b 0

:the_end_fail
echo.
pause
endlocal
exit /b 1
