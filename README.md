# Salesforce Job Scraper with Dashboard

Automated job scraper for Salesforce positions with email notifications and a web-based dashboard. Completely free to run - uses Puppeteer for scraping (no API costs).

## Features

- **Automated Job Discovery** - Scrapes 25+ job sites twice daily
- **Email Notifications** - Get alerts for new jobs matching your criteria
- **Web Dashboard** - View and manage jobs in your browser
- **Analytics** - Track job trends and statistics
- **CSV Management** - Easy company list management via spreadsheet
- **Smart Deduplication** - Never see the same job twice
- **Export Functionality** - Export jobs to CSV for tracking
- **Security Hardened** - Localhost-only binding, DNS rebinding protection, rate limiting

## Requirements

- Windows 10/11 (or Mac/Linux)
- Node.js 18+ (LTS recommended)
- Gmail account (for notifications)

## Installation

### Step 1: Install Node.js

1. Download from https://nodejs.org/ (LTS version)
2. Run the installer - check "Automatically install necessary tools"
3. Restart your computer

Verify installation:
```powershell
node --version
npm --version
```

### Step 2: Download This Project

Clone or download this repository, then extract it to a location like:
```
C:\Users\YourName\Documents\salesforce-job-scraper
```

### Step 3: Install Dependencies

```powershell
cd salesforce-job-scraper
npm install
```

This will take 2-3 minutes and downloads Puppeteer (~170MB, includes Chrome), Express, Nodemailer, and other packages.

### Step 4: Configure Email

#### A. Create Gmail App Password

1. Go to https://myaccount.google.com/
2. Click **Security** (left menu)
3. Under "How you sign in to Google", enable **2-Step Verification** if not already enabled
4. Go to https://myaccount.google.com/apppasswords
5. Create app password for **Mail** > **Windows Computer**
6. Copy the 16-character password (looks like: `abcd efgh ijkl mnop`)

#### B. Create .env File

1. Copy `.env.example` to `.env`
2. Open `.env` in a text editor and add your credentials:
   ```
   EMAIL_USER=your-email@gmail.com
   EMAIL_APP_PASSWORD=abcdefghijklmnop
   DASHBOARD_PORT=3000
   ```

**Important:**
- Remove spaces from the app password
- Use the 16-char app password, NOT your regular password
- Don't add quotes around values

### Step 5: Test the Setup

```powershell
npm run test
```

You should see:
1. CSV validation passes
2. Browser windows opening (Puppeteer)
3. Sites being scraped
4. Jobs found
5. Email sent (if jobs found)

## Usage

### Run the Scheduler + Dashboard

```powershell
npm start
```

Starts the cron scheduler (8 AM and 5 PM daily) **and** the web dashboard together in a single process.

Then visit: **http://localhost:3000**

Press Ctrl+C to stop.

### Run the Dashboard Only

```powershell
npm run dashboard
```

Starts just the dashboard without the scheduler (useful if you only want to browse existing results).

### Other Commands

```powershell
# Validate CSV file
npm run validate

# Add new company interactively
npm run add-company

# Export jobs to CSV
npm run export

# Run immediately (testing)
npm run test
```

## Running 24/7 with PM2

To keep the scraper running in the background (survives closing VS Code and reboots):

### Install and Start

```powershell
npm install -g pm2
pm2 start index.js --name "job-scraper"
pm2 save
```

This starts both the scheduler and dashboard as a background process.

### Auto-Start on Windows Boot

A startup script (`pm2-resurrect.bat`) in your Windows Startup folder will automatically restore your PM2 processes on login. To set this up manually:

1. Place a file named `pm2-resurrect.bat` in `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`
2. Contents:
   ```bat
   @echo off
   timeout /t 10 /nobreak >nul
   pm2 resurrect
   ```

### PM2 Commands

| Command | What it does |
|---|---|
| `pm2 status` | Check if it's running |
| `pm2 logs job-scraper` | View live logs |
| `pm2 restart job-scraper` | Restart after code changes |
| `pm2 stop job-scraper` | Stop it |
| `pm2 delete job-scraper` | Remove it from PM2 |

## Security

The dashboard includes the following protections:

- **Localhost-only binding** - The server binds to `127.0.0.1`, so only your machine can access it. Other devices on your network cannot reach the dashboard.
- **DNS rebinding protection** - Requests with unexpected `Host` headers are rejected with `403 Forbidden`, preventing malicious websites from accessing the dashboard through DNS rebinding attacks.
- **Rate limiting** - The resume optimizer API endpoints (which call the paid Anthropic API) are rate-limited to 20 requests per minute to prevent cost abuse.

## Configuration

### Add/Remove Companies

Edit `companies.csv` in Excel or any text editor:

```csv
company_name,careers_url,job_card_selector,title_selector,location_selector,link_selector,enabled,notes
Salesforce,https://careers.salesforce.com/...,selector1,selector2,selector3,selector4,true,Notes here
```

To disable a company: change `enabled` from `true` to `false`

Validate changes:
```powershell
npm run validate
```

### Customize Keywords

Edit `sites-config.js`:
```javascript
export const KEYWORDS = [
  'salesforce',
  'administrator',
  'business analyst',
  // Add your keywords
];
```

### Change Schedule

Edit `index.js`:
```javascript
// Default: 8 AM and 5 PM
cron.schedule('0 8,17 * * *', runJobSearch);

// Every 4 hours:
cron.schedule('0 */4 * * *', runJobSearch);
```

## Project Structure

```
salesforce-job-scraper/
├── .env                 # Your credentials (create from .env.example)
├── companies.csv        # Company list (EDIT THIS!)
├── jobs_database.json   # Tracked jobs (auto-generated)
├── package.json         # Dependencies
├── index.js             # Main scheduler + dashboard launcher
├── dashboard.js         # Web dashboard server
├── scraper.js           # Puppeteer logic
├── database.js          # Job storage
├── emailer.js           # Email sender
├── sites-config.js      # CSV loader
└── views/               # Dashboard templates
    ├── index.ejs
    └── companies.ejs
```

## Troubleshooting

### "npm is not recognized"
- Reinstall Node.js and restart your computer

### Email not sending
- Check 2-Step Verification is enabled on your Google account
- Use the app password, NOT your regular password
- Verify `.env` file exists with correct values
- Don't add quotes around values in `.env`

### No jobs found
- Sites may have changed their HTML structure
- Run `npm run validate` to check for CSV errors
- Some sites may block automated access

### Dashboard won't start
- Port 3000 in use? Change `DASHBOARD_PORT` in `.env`
- Run `npm install express ejs`

### Scraper crashed
- Restart with `npm start` or `pm2 restart job-scraper`
- Check logs: `pm2 logs job-scraper`

## Daily Workflow

1. Check email for new job alerts
2. Visit dashboard at http://localhost:3000 to see all jobs
3. Export to CSV for tracking applications
4. Update `companies.csv` as needed

## License

MIT License - Free to use and modify

---

**Built for Salesforce job seekers**

Happy job hunting!
