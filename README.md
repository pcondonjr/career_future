# 🎯 Salesforce Job Scraper with Dashboard

Automated job scraper for Salesforce positions with email notifications and a web-based dashboard. Completely free to run - uses Puppeteer for scraping (no API costs).

## ✨ Features

- 🔍 **Automated Job Discovery** - Scrapes 25+ job sites twice daily
- 📧 **Email Notifications** - Get alerts for new jobs matching your criteria
- 🌐 **Web Dashboard** - View and manage jobs in your browser
- 📊 **Analytics** - Track job trends and statistics
- 💾 **CSV Management** - Easy company list management via spreadsheet
- 🔒 **Smart Deduplication** - Never see the same job twice
- 📥 **Export Functionality** - Export jobs to CSV for tracking

## 📋 Requirements

- Windows 10/11 (or Mac/Linux)
- Node.js 18+ (LTS recommended)
- Gmail account (for notifications)

## 🚀 Quick Start (Windows)

### 1. Install Node.js

Download from https://nodejs.org/ and install the **LTS version**.

Verify installation:
```powershell
node --version
npm --version
```

### 2. Download This Project

Clone or download this repository to your computer.

### 3. Install Dependencies

```powershell
cd salesforce-job-scraper
npm install
```

This installs all required packages (may take 2-3 minutes).

### 4. Configure Email

1. **Create Gmail App Password:**
   - Go to https://myaccount.google.com/apppasswords
   - Enable 2-Step Verification if not already enabled
   - Create app password for "Mail" → "Windows Computer"
   - Copy the 16-character password

2. **Create .env file:**
   - Copy `.env.example` to `.env`
   - Edit `.env` and add your credentials:
     ```
     EMAIL_USER=your-email@gmail.com
     EMAIL_APP_PASSWORD=abcdefghijklmnop
     DASHBOARD_PORT=3000
     ```

### 5. Test the Setup

```powershell
npm run test
```

You should see browser windows opening, sites being scraped, and (if jobs found) an email notification.

## 🎮 Usage

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

## 📁 Project Structure

```
salesforce-job-scraper/
├── .env                 # Your credentials (create from .env.example)
├── companies.csv        # Company list (EDIT THIS!)
├── jobs_database.json   # Tracked jobs (auto-generated)
├── package.json         # Dependencies
├── index.js             # Main scheduler
├── dashboard.js         # Web dashboard
├── scraper.js           # Puppeteer logic
├── database.js          # Job storage
├── emailer.js           # Email sender
├── sites-config.js      # CSV loader
└── views/               # Dashboard templates
    ├── index.ejs
    └── companies.ejs
```

## ⚙️ Configuration

### Add/Remove Companies

Edit `companies.csv` in Excel or any text editor:

```csv
company_name,careers_url,job_card_selector,title_selector,location_selector,link_selector,enabled,notes
Salesforce,https://careers.salesforce.com/...,selector1,selector2,selector3,selector4,true,Notes here
```

To disable a company: change `enabled` from `true` to `false`

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

## 🐛 Troubleshooting

### "npm is not recognized"
- Reinstall Node.js
- Restart computer

### Email not sending
- Check 2-Step Verification is enabled
- Use app password, NOT regular password
- Verify `.env` file exists with correct values

### No jobs found
- Sites may have changed HTML structure
- Check `npm run validate` for CSV errors
- Some sites may block automated access

### Dashboard won't start
- Port 3000 in use? Change `DASHBOARD_PORT` in `.env`
- Run `npm install express ejs`

## 📞 Support

For issues:
1. Check the troubleshooting section
2. Validate your CSV: `npm run validate`
3. Check logs for error messages

## 📝 License

MIT License - Free to use and modify

---

**Built for Salesforce job seekers** 🎯

Happy job hunting!
