@echo off
cd /d "C:\Users\pcond\vs-code-projects\career-future"
node index.js --now --weekly
del "C:\Users\pcond\vs-code-projects\career-future\.scraper-running"
echo.
echo Search complete. Press any key to close.
pause > nul
exit