@echo off
cd /d C:\Users\pcond\vs-code-projects\career-future
if not exist logs mkdir logs
start "CF-Neon" /b cmd /c ""C:\Program Files\nodejs\node.exe" neon-dashboard-server.cjs 1>>logs\neon-dashboard.log 2>&1"
start "CF-Scheduler" /b cmd /c ""C:\Program Files\nodejs\node.exe" index.js 1>>logs\scheduler.log 2>&1"
start "CF-NeonScheduler" /b cmd /c ""C:\Program Files\nodejs\node.exe" src\backend\neon-scheduler.cjs 1>>logs\neon-scheduler.log 2>&1"
