@echo off
cd /d "C:\Users\pcond\vs-code-projects\career-future"
start /min "Agent3" cmd /c "node oxylabs_selector_discovery.cjs --agent-id agent-3 >> agent-3.log 2>&1"
start /min "Agent4" cmd /c "node oxylabs_selector_discovery.cjs --agent-id agent-4 >> agent-4.log 2>&1"
echo Agents 3 and 4 restarted.
