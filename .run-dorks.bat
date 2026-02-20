@echo off
cd /d "C:\Users\pcond\salesforce-projects\career-future"
node index.js --now --dorks
del "C:\Users\pcond\salesforce-projects\career-future\.dork-running"
echo.
echo Applicant Tracking search complete. Press any key to close.
pause > nul
exit