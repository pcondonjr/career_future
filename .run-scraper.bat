@echo off
cd /d "C:\VS Code Projects\salesforce-job-scraper"
node index.js --now --weekly
del "C:\VS Code Projects\salesforce-job-scraper\.scraper-running"
echo.
echo Scraper complete. Press any key to close.
pause > nul