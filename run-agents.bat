@echo off
REM Launch 4 parallel selector discovery agents
REM Each agent claims rows independently via Neon row locking
REM Logs written to agent-N.log files
REM Monitor progress at http://localhost:3001

cd /d "C:\Users\pcond\vs-code-projects\career-future"

echo Starting 4 parallel agents...

start /min "Agent 1" cmd /c "node oxylabs_selector_discovery.cjs --agent-id agent-1 > agent-1.log 2>&1"
start /min "Agent 2" cmd /c "node oxylabs_selector_discovery.cjs --agent-id agent-2 > agent-2.log 2>&1"
start /min "Agent 3" cmd /c "node oxylabs_selector_discovery.cjs --agent-id agent-3 > agent-3.log 2>&1"
start /min "Agent 4" cmd /c "node oxylabs_selector_discovery.cjs --agent-id agent-4 > agent-4.log 2>&1"

echo.
echo Agents launched. Monitor at http://localhost:3001
echo Logs: agent-1.log, agent-2.log, agent-3.log, agent-4.log
echo.
echo To check progress: curl http://localhost:3001/api/stats
pause
