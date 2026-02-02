# ⚡ Quick Start Guide

## 5-Minute Setup

### 1. Prerequisites
- ✅ Node.js installed (https://nodejs.org/)
- ✅ Gmail account

### 2. Install
```powershell
cd salesforce-job-scraper
npm install
```
*Wait 2-3 minutes for installation*

### 3. Configure Email
1. Copy `.env.example` to `.env`
2. Get Gmail app password: https://myaccount.google.com/apppasswords
3. Edit `.env`:
```
EMAIL_USER=youremail@gmail.com
EMAIL_APP_PASSWORD=yourapppassword
DASHBOARD_PORT=3000
```

### 4. Test
```powershell
npm run test
```
*You should see browsers opening and jobs being found*

### 5. Start
```powershell
# Terminal 1: Start scheduler
npm start

# Terminal 2: Start dashboard
npm run dashboard
```

Visit: http://localhost:3000

## Done! 🎉

The scraper will now run at 8 AM and 5 PM daily.

## Next Steps

- Edit `companies.csv` to add/remove job sites
- Customize keywords in `sites-config.js`
- Check dashboard for found jobs

## Common Issues

**Email not working?**
- Use app password, not regular password
- Enable 2-Step Verification first

**No jobs found?**
- Run `npm run validate` to check CSV
- Some sites may have changed structure

**Need help?**
- See full README.md
- Check troubleshooting section
