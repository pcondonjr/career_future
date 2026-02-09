@echo off
cd /d "C:\Users\pcond\salesforce-projects\jobs-scrapers\salesforce-job-scraper"
node index.js --now
del "C:\Users\pcond\salesforce-projects\jobs-scrapers\salesforce-job-scraper\.scraper-running"
echo.
echo Scraper complete. Press any key to close.
pause > nul
exit