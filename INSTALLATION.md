# 📦 Installation Guide - Windows

## Step-by-Step Installation

### Step 1: Download Project

You should have downloaded this folder: `salesforce-job-scraper`

Extract it to a location like:
```
C:\Users\YourName\Documents\salesforce-job-scraper
```

### Step 2: Install Node.js

1. Go to https://nodejs.org/
2. Download the **LTS version** (v20.x or v18.x)
3. Run the installer
4. ✅ Check "Automatically install necessary tools"
5. Complete installation
6. **Restart your computer**

### Step 3: Verify Node.js Installation

Open PowerShell or Command Prompt:

```powershell
node --version
# Should show: v18.x.x or v20.x.x

npm --version  
# Should show: 9.x.x or 10.x.x
```

If these commands don't work, Node.js wasn't installed correctly.

### Step 4: Navigate to Project Folder

```powershell
cd C:\Users\YourName\Documents\salesforce-job-scraper
```

### Step 5: Install Dependencies

```powershell
npm install
```

This will take 2-3 minutes and download:
- Puppeteer (~170MB - includes Chrome browser)
- Express, EJS, Nodemailer, etc.

You'll see a progress bar.

### Step 6: Setup Email Credentials

#### A. Create Gmail App Password

1. Go to https://myaccount.google.com/
2. Click **Security** (left menu)
3. Under "How you sign in to Google":
   - Enable **2-Step Verification** (if not already)
4. Go back to Security
5. Click **App passwords**
6. Select:
   - App: **Mail**
   - Device: **Windows Computer**
7. Click **Generate**
8. **Copy the 16-character password** (looks like: `abcd efgh ijkl mnop`)

#### B. Create .env File

1. In the project folder, **copy** `.env.example` to `.env`
2. Open `.env` in Notepad
3. Replace placeholders:

```
EMAIL_USER=your-actual-email@gmail.com
EMAIL_APP_PASSWORD=abcdefghijklmnop
DASHBOARD_PORT=3000
```

**Important:**
- Remove spaces from app password
- Use the 16-char app password, NOT your regular password
- Don't add quotes around values

### Step 7: Test Installation

```powershell
npm run test
```

You should see:
1. ✅ CSV validation passes
2. 🌐 Browser windows opening (Puppeteer)
3. 📊 Sites being scraped
4. ✨ Jobs found
5. 📧 Email sent (if jobs found)

### Step 8: Customize Companies (Optional)

Edit `companies.csv` in Excel:
- Add new companies
- Disable companies (change `enabled` to `false`)
- Add notes

Validate changes:
```powershell
npm run validate
```

### Step 9: Start the Scraper

#### Option A: Scheduled Mode (Recommended)

```powershell
npm start
```

Runs automatically at 8 AM and 5 PM daily.
Keep this window open or minimize it.

#### Option B: Dashboard Mode

Open a **second** terminal:

```powershell
npm run dashboard
```

Then visit in browser: **http://localhost:3000**

### Step 10: Keep Running 24/7 (Optional)

**Method 1: Just leave PowerShell open**
- Minimize the window
- Don't close it

**Method 2: Use PM2 (Advanced)**

```powershell
npm install -g pm2
pm2 start index.js --name "job-scraper"
pm2 start dashboard.js --name "dashboard"
pm2 save
pm2 startup
```

PM2 will auto-restart on crashes and Windows reboot.

## ✅ Installation Complete!

You should now have:
- ✅ Scraper running at 8 AM and 5 PM
- ✅ Dashboard at http://localhost:3000
- ✅ Email alerts for new jobs
- ✅ CSV export capability

## 🎯 Daily Workflow

1. Check email for new job alerts
2. Visit dashboard to see all jobs
3. Export to CSV for tracking applications
4. Update `companies.csv` as needed

## 🆘 Troubleshooting

See README.md for detailed troubleshooting.

Quick fixes:
- **Email not working?** Check app password, not regular password
- **No jobs found?** Run `npm run validate`
- **Scraper crashed?** Restart with `npm start`
- **Dashboard won't load?** Check port 3000 is free

## 📞 Need Help?

1. Read QUICKSTART.md for common issues
2. Read README.md for full documentation
3. Check error messages in terminal
4. Validate CSV: `npm run validate`

---

Good luck with your job search! 🎉
