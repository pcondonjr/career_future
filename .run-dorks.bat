@echo off
cd /d "C:\Users\pcond\vs-code-projects\career-future"
node index.js --now --dorks
del "C:\Users\pcond\vs-code-projects\career-future\.dork-running"
echo.
echo Applicant Tracking search complete. Press any key to close.
pause > nul
exit