@echo off
set "PATH=%~dp0;%PATH%"
node "%~dp0..\node_modules\pnpm\bin\pnpm.cjs" %*
