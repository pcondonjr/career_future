@echo off
cd /d "C:\Users\pcond\vs-code-projects\career-future"

echo Starting 2 Playwright agents...

start /min "PW Agent 1" cmd /c "node playwright_selector_discovery.cjs --agent-id pw-1 > pw-agent-1.log 2>&1"
start /min "PW Agent 2" cmd /c "node playwright_selector_discovery.cjs --agent-id pw-2 > pw-agent-2.log 2>&1"

echo.
echo Playwright agents launched.
echo Logs: pw-agent-1.log, pw-agent-2.log
pause
