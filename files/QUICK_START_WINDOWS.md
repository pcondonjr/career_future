# Quick Start Guide for Windows/WSL

## 📥 Step 1: Download All Files

You now have access to all 13+ files. You can either:

**Option A: Download Complete Package (Recommended)**
- Download `resume-optimizer-package.tar.gz` 
- Extract it in your project directory

**Option B: Download Individual Files**
- Download each file separately from the list above
- Organize them as shown in the structure below

## 📂 Step 2: File Organization

Once downloaded, organize files in your `salesforce-job-scraper` directory:

```
/mnt/c/VS Code Projects/salesforce-job-scraper/
├── anthropic_resume_optimizer.js       ← Root directory
├── resume_api_routes.js                ← Root directory
├── extract_resume_text.js              ← Root directory
├── test_resume_optimizer.js            ← Root directory
├── setup.sh                            ← Root directory (optional)
├── public/
│   ├── js/
│   │   └── public_resume_optimizer.js  ← Copy here
│   └── css/
│       └── resume_optimizer_styles.css ← Copy here
├── resume/
│   └── Patrick_Condon_Resume.txt       ← Copy here
├── views/
│   └── dashboard.ejs                   ← Update this (see guide)
├── INTEGRATION_GUIDE.md                ← Root directory (docs)
├── README_RESUME_OPTIMIZER.md          ← Root directory (docs)
└── IMPLEMENTATION_SUMMARY.md           ← Root directory (docs)
```

## 🚀 Step 3: Manual Setup (WSL/Windows)

Since the automated setup script won't work from my environment, here's the manual process:

### 1. Create Directories

```bash
cd "/mnt/c/VS Code Projects/salesforce-job-scraper"

# Create directories if they don't exist
mkdir -p public/js
mkdir -p public/css
mkdir -p resume
```

### 2. Install Dependencies

```bash
npm install @anthropic-ai/sdk
```

### 3. Copy/Move Files to Correct Locations

After downloading, move files:

```bash
# If you downloaded the tar.gz package:
tar -xzf resume-optimizer-package.tar.gz

# Move frontend files
mv public_resume_optimizer.js public/js/
mv resume_optimizer_styles.css public/css/

# Move resume
mv Patrick_Condon_Resume.txt resume/

# Core files stay in root:
# - anthropic_resume_optimizer.js
# - resume_api_routes.js
# - test_resume_optimizer.js
# - extract_resume_text.js
```

### 4. Set Up Environment Variable

```bash
# Add to your .env file (create if it doesn't exist)
echo "ANTHROPIC_API_KEY=your-key-here" >> .env

# Or manually edit .env:
nano .env
# Add this line:
# ANTHROPIC_API_KEY=sk-ant-api03-your-actual-key-here
```

**Get your API key from**: https://console.anthropic.com/

### 5. Update Your Server File

Edit your `server.js` or `app.js`:

```javascript
// Add this near the top with other requires
const resumeRoutes = require('./resume_api_routes');

// Add this after your other route definitions
app.use('/api', resumeRoutes);
```

### 6. Update Your Dashboard Template

Edit `views/dashboard.ejs` (or whatever your main template is):

```html
<!DOCTYPE html>
<html>
<head>
    <!-- Your existing head content -->
    
    <!-- ADD THIS: Resume optimizer styles -->
    <link rel="stylesheet" href="/css/resume_optimizer_styles.css">
</head>
<body>
    <!-- Your existing body content -->
    
    <!-- ADD THIS: Resume optimizer JavaScript (before closing </body>) -->
    <script src="/js/public_resume_optimizer.js"></script>
</body>
</html>
```

### 7. Add Buttons to Job Cards

Find where you display job cards in your template and add the optimization buttons:

```html
<div class="job-card" 
     data-description="<%= job.description %>"
     data-url="<%= job.url %>">
    
    <!-- Your existing job card content -->
    <h3><%= job.title %></h3>
    <p><%= job.company %></p>
    
    <!-- ADD THESE BUTTONS -->
    <div class="job-actions">
        <button class="btn-optimize-resume">
            ⚡ Optimize Resume
        </button>
        <button class="btn-generate-cover-letter btn btn-secondary">
            📝 Cover Letter
        </button>
    </div>
</div>
```

## 🧪 Step 4: Test the Integration

```bash
# Run the test suite
node test_resume_optimizer.js

# Expected output:
# ✅ API key found
# ✅ Resume loaded
# ✅ Optimizer initialized
# ✅ Job analysis successful (85% match)
# ✅ All tests passed!
```

If tests fail, check:
1. API key is correct in `.env`
2. Resume file exists at `resume/Patrick_Condon_Resume.txt`
3. All dependencies installed (`npm install @anthropic-ai/sdk`)

## 🎯 Step 5: Start Your Server & Test

```bash
# Start your server
node server.js
# or
npm start

# Open your browser and go to your dashboard
# Click "Optimize Resume" on any job card
# Modal should appear with analysis!
```

## 📋 Verification Checklist

Before going live, verify:

- [ ] Files in correct directories (see structure above)
- [ ] `ANTHROPIC_API_KEY` set in `.env`
- [ ] Dependencies installed (`@anthropic-ai/sdk`)
- [ ] Server file updated with API routes
- [ ] Dashboard template includes CSS and JS
- [ ] Job cards have `data-description` and `data-url` attributes
- [ ] Test script passes all tests
- [ ] Modal appears when clicking "Optimize Resume"

## 🐛 Common Issues

### Issue: "Cannot find module '@anthropic-ai/sdk'"
```bash
npm install @anthropic-ai/sdk
```

### Issue: "Resume file not found"
```bash
# Check file exists
ls resume/Patrick_Condon_Resume.txt

# If missing, ensure you moved it from download location
```

### Issue: "401 Unauthorized"
```bash
# Verify API key
cat .env | grep ANTHROPIC_API_KEY

# Make sure it starts with sk-ant-api03-
```

### Issue: "Modal doesn't appear"
```
1. Open browser DevTools (F12)
2. Check Console tab for errors
3. Verify files loaded:
   - /css/resume_optimizer_styles.css
   - /js/public_resume_optimizer.js
```

## 💰 Cost Control

Set a daily budget to avoid surprises:

```javascript
// Optional: Add to resume_api_routes.js
const MAX_DAILY_COST = 5.00;
let dailySpend = 0;

// Check before each analysis
if (dailySpend > MAX_DAILY_COST) {
    return res.status(429).json({ error: 'Daily budget exceeded' });
}
```

## 📊 Typical Usage

**Daily Job Search (15 minutes):**
```
1. Check new jobs from scrapers
2. Batch analyze top 10: ~$0.40
3. Generate 3-5 cover letters: ~$0.15
4. Apply to best matches
Total: ~$0.55/day = $16.50/month
```

## 🎉 You're Ready!

Once setup is complete:
1. Your job scraper continues running as normal
2. Each job now has an "Optimize Resume" button
3. Click it to get instant AI analysis
4. Generate tailored cover letters in seconds
5. Track costs (should be $20-30/month for active searching)

## 📚 Next Steps

- Read `INTEGRATION_GUIDE.md` for detailed documentation
- See `README_RESUME_OPTIMIZER.md` for advanced features
- Check `IMPLEMENTATION_SUMMARY.md` for workflows

## 🆘 Need Help?

If you run into issues:
1. Check the troubleshooting section above
2. Review `INTEGRATION_GUIDE.md`
3. Run `node test_resume_optimizer.js` to diagnose
4. Check browser console (F12) for frontend errors

---

**Good luck with your job search! 🎯**
