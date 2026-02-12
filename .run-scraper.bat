@echo off
cd /d "C:\Users\pcond\salesforce-projects\jobs-scrapers\career-future"
node index.js --now --weekly
del "C:\Users\pcond\salesforce-projects\jobs-scrapers\career-future\.scraper-running"
echo.
echo Scraper complete. Press any key to close.
pause > nul
exit