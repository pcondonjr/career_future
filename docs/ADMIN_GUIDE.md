# Career Future - System Administrator Guide

## Table of Contents

1. [Application Overview](#1-application-overview)
2. [Installation & Initial Setup](#2-installation--initial-setup)
3. [Application Management](#3-application-management)
4. [License & Payment Setup](#4-license--payment-setup)
5. [Updating the Application](#5-updating-the-application)
6. [Configuration Reference](#6-configuration-reference)
7. [Security](#7-security)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Application Overview

**Career Future** is an Electron desktop application that automates job searching by scraping company career pages, tracking new listings in a local database, and sending email notifications when matching jobs are found.

### Technology Stack

| Component | Technology |
|-----------|------------|
| Desktop Framework | Electron 33.x |
| Build System | electron-vite 5.x, electron-builder 26.x |
| Backend | Node.js (ES modules), Express.js |
| Web Scraping | puppeteer-core 24.x |
| Scheduling | node-cron 3.x |
| Email | nodemailer 7.x |
| AI Features | Anthropic SDK (Claude API) |
| Config Storage | electron-store 11.x |

### System Requirements (End User)

| Requirement | Details |
|-------------|---------|
| Operating System | Windows 7 or later (x64) |
| Disk Space | ~500 MB |
| RAM | 2 GB minimum |
| Browser | Chrome or Edge (required for scraping) |
| Admin Rights | Not required (per-user installation) |
| Network | Internet access for scraping and email |

---

## 2. Installation & Initial Setup

### 2.1 Building the Installer

From the development machine:

```bash
# Install dependencies
npm install

# Generate application icons
node scripts/generate-icons.js

# Build and create NSIS installer
npm run dist
```

The installer is output to:
```
release/Career Future Setup <version>.exe
```

### 2.2 Installing on a User Machine

1. Run `Career Future Setup <version>.exe`
2. Choose installation directory (default: `%LOCALAPPDATA%\Programs\Career Future\`)
3. Select shortcut options (Desktop, Start Menu)
4. Click Install
5. Application launches automatically after installation

### 2.3 First-Run Setup Wizard

On first launch, a setup wizard guides the user through configuration:

| Step | Required | Description |
|------|----------|-------------|
| Welcome | - | Introduction screen |
| Keywords | Yes | Job search terms (e.g., "salesforce", "developer") |
| Locations | Yes | Geographic preferences (e.g., "remote", "charlotte") |
| Email | No | Gmail address + App Password for notifications |
| AI Resume | No | Anthropic API key + resume file path |
| Schedule | Yes | When to run automated scrapes |
| Summary | - | Review and confirm all settings |

After the wizard completes, the 7-day trial begins and the app transitions to the main dashboard.

### 2.4 File Locations After Installation

| Purpose | Path |
|---------|------|
| Application files | `%LOCALAPPDATA%\Programs\Career Future\` |
| Read-only resources | `...\resources\app-data\` (views, icons, sample CSVs) |
| User data & config | `%APPDATA%\Career Future\` |
| Config file | `%APPDATA%\Career Future\career-future-config.json` |
| Job databases | `%APPDATA%\Career Future\jobs_database.json` |
| Weekly database | `%APPDATA%\Career Future\jobs_database_weekly.json` |

---

## 3. Application Management

### 3.1 Starting the Application

- **Desktop shortcut:** Double-click "Career Future" on the desktop
- **Start Menu:** Start > Career Future
- **System tray:** If minimized to tray, double-click the tray icon

### 3.2 System Tray Menu

Right-click the system tray icon for quick actions:

```
Licensed to: user@example.com    (or Trial: X days remaining)
─────────────────────────────
Show Dashboard
Hide Dashboard
─────────────────────────────
Run Scraper Now  >  Daily Scrape
                    Weekly Scrape
─────────────────────────────
Scheduler  >  Running / Stopped
               Start Scheduler
               Stop Scheduler
─────────────────────────────
Settings
About
─────────────────────────────
Quit Career Future
```

### 3.3 Dashboard

The dashboard runs as a local Express web server at `http://localhost:3000` (configurable).

**Dashboard features:**
- View all discovered jobs (last 7 days)
- Group jobs by company
- Export jobs to CSV
- View/manage company lists (daily and weekly)
- Run scraper manually
- AI-powered resume optimization
- Full settings panel at `/settings`

### 3.4 Managing the Scheduler

The scheduler runs cron jobs to automatically scrape at configured times.

**Starting/stopping from the tray:**
- Right-click tray icon > Scheduler > Start/Stop

**Configuring schedule (Settings > Schedule):**
- Enable/disable automatic scheduling
- Set daily scrape times (e.g., 08:00 and 17:00)
- Set weekly scrape day and time (e.g., Sunday at 10:00)

**Manual scrape runs:**
- Tray menu > Run Scraper Now > Daily/Weekly
- Dashboard > Run Scraper button

### 3.5 Managing Company Lists

Company scraping targets are stored in CSV files:

| File | Purpose |
|------|---------|
| `companies.csv` | Daily scraping targets |
| `companies-weekly.csv` | Weekly scraping targets (broader search) |

**CSV format:**
```csv
Company,URL,Enabled
Salesforce,https://salesforce.wd5.myworkdayjobs.com/,true
Acme Corp,https://careers.acme.com/jobs,true
Old Company,https://old.example.com/jobs,false
```

Edit these files through:
- Dashboard > Companies / Companies Weekly pages
- Direct file editing at `%APPDATA%\Career Future\`

### 3.6 Email Notifications

**Prerequisites:**
- Gmail account with 2-Step Verification enabled
- Gmail App Password (not your regular password)

**Setting up Gmail App Password:**
1. Go to https://myaccount.google.com/apppasswords
2. Select "Mail" and "Windows Computer"
3. Click "Generate"
4. Copy the 16-character password
5. Enter in Career Future Settings > Email Notifications

**Notification types:**
- **Daily job alert:** Sent after each daily scrape with new listings
- **Weekly job alert:** Sent after weekly scrape with listings not found in daily
- **Weekly summary:** Sent every Monday at 9 AM with stats

### 3.7 AI Resume Optimizer

Requires an Anthropic API key from https://console.anthropic.com/

**Setup:**
1. Settings > AI Resume Optimizer
2. Enter your Anthropic API key
3. Set the path to your resume text file

**Usage:** Available on the dashboard to tailor your resume to specific job descriptions.

### 3.8 Backup & Restore

**Backing up user data:**
```
Copy the entire %APPDATA%\Career Future\ directory:
  - career-future-config.json    (all settings)
  - jobs_database.json           (daily job history)
  - jobs_database_weekly.json    (weekly job history)
```

**Restoring:**
1. Install Career Future on the new machine
2. Close the application
3. Copy backed-up files to `%APPDATA%\Career Future\`
4. Restart the application

**Config export/import (programmatic):**
```javascript
// Export (excludes sensitive fields: passwords, API keys, license)
config.exportConfig()

// Import (merges non-sensitive fields)
config.importConfig(data)
```

### 3.9 Resetting the Application

To reset all configuration and start fresh:
1. Close Career Future completely (Quit from tray)
2. Delete the folder: `%APPDATA%\Career Future\`
3. Restart the application (setup wizard will appear)

---

## 4. License & Payment Setup

### 4.1 License Model Overview

Career Future uses an **offline RSA-signed license key** system:

| Feature | Details |
|---------|---------|
| Trial period | 7 days from first launch |
| License format | `<base64url-payload>.<base64url-signature>` |
| Verification | RSA-2048 + SHA-256 (offline, no server needed) |
| Key types | `pro` (default), custom types supported |
| Expiration | Optional per-key (can be perpetual) |

### 4.2 Setting Up the License Key Infrastructure

#### Step 1: Generate RSA Key Pair (First Time Only)

```bash
node scripts/generate-license.js --help
```

On first run, this automatically generates:
- `scripts/keys/license-private.pem` — **KEEP SECRET** (signs licenses)
- `scripts/keys/license-public.pem` — Embedded in the app (verifies licenses)

**CRITICAL:** Store the private key securely. Anyone with access to it can generate valid license keys.

#### Step 2: Embed the Public Key in the Application

The public key must be embedded in [src/main/license.js](src/main/license.js):

```javascript
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
-----END PUBLIC KEY-----`;
```

This is done automatically on first key generation. If you regenerate keys, manually update this file and rebuild.

#### Step 3: Generate License Keys for Customers

```bash
# Perpetual license
node scripts/generate-license.js --email customer@example.com

# Perpetual license with custom type
node scripts/generate-license.js --email customer@example.com --type pro

# Time-limited license (expires on date)
node scripts/generate-license.js --email customer@example.com --expires 2027-06-01
```

**Output:**
```
============================================================
LICENSE KEY GENERATED
============================================================
Email:   customer@example.com
Type:    pro
Expires: Never

License Key:
eyJlbWFpbCI6ImN1c3RvbWVyQGV4YW1wbGUuY29tIiwid....<signature>

============================================================
```

#### Step 4: Deliver the License Key to the Customer

Send the customer:
1. Their email address (must match the one used during generation)
2. The license key string

### 4.3 Customer License Activation

Customers activate their license through the app:

**If trial has expired:**
1. App automatically shows the License Activation page
2. Enter email address
3. Paste the license key
4. Click "Activate License"
5. App validates the key offline and transitions to the dashboard

**If trial is still active:**
1. Open Settings (tray menu or dashboard)
2. Scroll to the License section
3. Current trial status is displayed (read-only in settings)
4. To activate early, use the license activation IPC from the app

### 4.4 Integrating a Payment Processor

Career Future does not currently include a built-in payment processor. Here are the recommended steps to add one:

#### Option A: Manual Payment + License Delivery

Best for small-scale or internal distribution.

1. Accept payment through any processor (Stripe, PayPal, Gumroad, etc.)
2. After payment confirmation, generate a license key:
   ```bash
   node scripts/generate-license.js --email buyer@example.com --type pro
   ```
3. Email the license key to the customer
4. Customer activates in-app

#### Option B: Automated with Stripe + Webhook

For automated license delivery:

1. **Create a Stripe product** at https://dashboard.stripe.com/products
   - Set product name: "Career Future Pro License"
   - Set price (one-time or subscription)

2. **Set up a payment page** using Stripe Checkout or Payment Links

3. **Create a webhook endpoint** that:
   - Listens for `checkout.session.completed` events
   - Extracts the customer email
   - Calls the license generation function programmatically
   - Emails the license key to the customer

   Example webhook handler (pseudo-code):
   ```javascript
   app.post('/webhook/stripe', async (req, res) => {
     const event = stripe.webhooks.constructEvent(req.body, sig, secret);

     if (event.type === 'checkout.session.completed') {
       const email = event.data.object.customer_email;
       const licenseKey = generateLicense(email, 'pro', null, privateKey);
       await sendLicenseEmail(email, licenseKey);
     }

     res.json({ received: true });
   });
   ```

4. **Host the webhook** on a server (AWS Lambda, Vercel, your own VPS)

#### Option C: Gumroad / LemonSqueezy Integration

For the simplest setup:

1. List the product on Gumroad or LemonSqueezy
2. Use their webhook/API to trigger license generation after purchase
3. Deliver via their built-in email system or your own

### 4.5 License Key Management

#### Revoking a License

There is no remote revocation mechanism since validation is offline. Options:

1. **Time-limited keys:** Issue keys with `--expires` dates so they naturally expire
2. **Key rotation:** Regenerate the RSA key pair, update the public key in the app, and rebuild. All old keys become invalid.
3. **Future enhancement:** Add an online license check endpoint

#### Viewing License Status

**In-app:**
- System tray shows license status at the top of the menu
- Settings page > License section shows full details

**Programmatically:**
```javascript
import { getLicenseStatus } from './src/main/license.js';
import config from './src/main/config.js';

const status = getLicenseStatus(config);
// { licensed: true, trial: false, expired: false, email: "...", type: "pro", ... }
```

#### Key Pair Rotation

If the private key is compromised:

1. Delete `scripts/keys/license-private.pem` and `scripts/keys/license-public.pem`
2. Run `node scripts/generate-license.js --email test@test.com` to generate new pair
3. Copy the new public key into `src/main/license.js`
4. Rebuild and redistribute the app
5. Regenerate license keys for all existing customers

---

## 5. Updating the Application

### 5.1 Current Update Process (Manual)

Career Future does not currently include an auto-update mechanism. Updates are distributed manually.

#### Step 1: Bump the Version

Edit [package.json](package.json):
```json
{
  "version": "1.1.0"
}
```

Follow semantic versioning:
- **Patch** (1.0.1): Bug fixes, minor tweaks
- **Minor** (1.1.0): New features, non-breaking changes
- **Major** (2.0.0): Breaking changes, major overhauls

#### Step 2: Build the New Installer

```bash
# Ensure icons are generated
node scripts/generate-icons.js

# Build application
npm run build

# Create installer
npm run dist
```

Output: `release/Career Future Setup <version>.exe`

#### Step 3: Distribute to Users

1. Host the installer on your distribution channel (website, cloud storage, email)
2. Notify users of the update
3. Users download and run the new installer

#### Step 4: User Installs the Update

1. Close Career Future completely (right-click tray > Quit)
2. Run the new installer
3. Install to the same directory (overwrites previous version)
4. **User data is preserved** — config, databases, and license remain in `%APPDATA%\Career Future\`

### 5.2 What Gets Preserved During Updates

| Data | Location | Preserved? |
|------|----------|------------|
| Settings & config | `%APPDATA%\Career Future\` | Yes |
| Job databases | `%APPDATA%\Career Future\` | Yes |
| License activation | `%APPDATA%\Career Future\` | Yes |
| Trial start date | `%APPDATA%\Career Future\` | Yes |
| Application files | `%LOCALAPPDATA%\Programs\` | Overwritten |
| Company CSVs (modified) | `%APPDATA%\Career Future\` | Yes |

### 5.3 Adding Auto-Updates (Future Enhancement)

To implement automatic updates:

#### Step 1: Set Up a Release Server

Choose a hosting solution for update files:
- **GitHub Releases** (free, recommended)
- **Amazon S3** / **Azure Blob Storage**
- **Self-hosted server**

#### Step 2: Install electron-updater

```bash
npm install electron-updater
```

#### Step 3: Configure electron-builder.yml

Replace `publish: null` with your provider:

```yaml
# For GitHub Releases:
publish:
  provider: github
  owner: your-github-username
  repo: career-future

# For S3:
publish:
  provider: s3
  bucket: your-bucket-name
  region: us-east-1

# For generic server:
publish:
  provider: generic
  url: https://updates.yoursite.com/releases
```

#### Step 4: Add Update Check to Main Process

```javascript
import { autoUpdater } from 'electron-updater';

// Check for updates on app start
app.whenReady().then(() => {
  autoUpdater.checkForUpdatesAndNotify();
});

// Handle update events
autoUpdater.on('update-available', (info) => {
  // Notify user
});

autoUpdater.on('update-downloaded', (info) => {
  // Prompt user to restart
  autoUpdater.quitAndInstall();
});
```

#### Step 5: Publish Updates

```bash
# Build and publish to configured provider
npm run dist -- --publish always
```

#### Step 6: Code Signing (Recommended for Auto-Updates)

For auto-updates to work securely on Windows:
1. Obtain a code signing certificate (e.g., from DigiCert, Sectigo)
2. Configure in `electron-builder.yml`:
   ```yaml
   win:
     signAndEditExecutable: true
     certificateFile: path/to/cert.pfx
     certificatePassword: your-password
   ```
3. Rebuild and distribute

### 5.4 Rollback Procedure

If an update causes issues:

1. Quit Career Future
2. Reinstall the previous version using the old installer
3. User data remains intact (stored separately in `%APPDATA%`)

**Recommendation:** Keep previous installer versions archived for rollback capability.

### 5.5 Update Checklist

Before releasing an update:

- [ ] Update version in `package.json`
- [ ] Test the setup wizard flow (new installs)
- [ ] Test the update flow (existing installation with data)
- [ ] Verify license activation still works
- [ ] Test scraper with current company CSVs
- [ ] Verify email notifications
- [ ] Test all scheduler modes (daily, weekly, manual)
- [ ] Verify settings persistence across update
- [ ] Build installer: `npm run dist`
- [ ] Test installer on a clean Windows machine
- [ ] Test installer as an update over the previous version
- [ ] Archive the previous installer for rollback
- [ ] Update release notes / changelog

---

## 6. Configuration Reference

### 6.1 Config File Location

| Environment | Path |
|-------------|------|
| Development | `{project-root}/career-future-config.json` |
| Production | `%APPDATA%/Career Future/career-future-config.json` |

### 6.2 Configuration Schema

```json
{
  "firstRunComplete": true,
  "license": {
    "key": "<license-key-string>",
    "email": "user@example.com",
    "type": "pro",
    "activatedAt": "2026-02-10T12:00:00.000Z",
    "trialStartDate": "2026-02-01T08:00:00.000Z"
  },
  "search": {
    "keywords": ["salesforce", "developer"],
    "locations": ["remote", "charlotte"],
    "schedule": {
      "enabled": true,
      "dailyTimes": ["08:00", "17:00"],
      "weeklyDay": 0,
      "weeklyTime": "10:00"
    }
  },
  "email": {
    "user": "you@gmail.com",
    "service": "gmail",
    "appPassword": "<encrypted-base64>"
  },
  "anthropic": {
    "apiKey": "<encrypted-base64>"
  },
  "resume": {
    "path": "C:/Users/you/Documents/resume.txt",
    "lastModified": "2026-02-10T12:00:00.000Z"
  },
  "companies": {
    "dailyPath": "companies.csv",
    "weeklyPath": "companies-weekly.csv"
  },
  "database": {
    "path": "jobs_database.json",
    "weeklyPath": "jobs_database_weekly.json"
  },
  "dashboard": {
    "port": 3000,
    "autoOpen": true
  },
  "system": {
    "autoStart": false,
    "minimizeToTray": true,
    "checkUpdates": true
  }
}
```

### 6.3 Sensitive Fields

These fields are encrypted using Electron's `safeStorage` (OS credential store):

| Field | Purpose |
|-------|---------|
| `email.appPassword` | Gmail App Password |
| `anthropic.apiKey` | Anthropic API key |

In plain Node.js mode (non-Electron), these are stored as plaintext. Use environment variables instead for non-Electron deployments.

### 6.4 Environment Variables (Legacy/Development)

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key (overrides config) |
| `EMAIL_USER` | Gmail address |
| `EMAIL_APP_PASSWORD` | Gmail App Password |
| `DASHBOARD_PORT` | Override dashboard port (default: 3000) |

### 6.5 Modifying Settings

**Through the UI:**
- Dashboard > Settings (`http://localhost:3000/settings`)
- System tray > Settings

**Through the API:**
```
POST http://localhost:3000/api/settings
Content-Type: application/json

{
  "section": "search",
  "data": {
    "keywords": ["salesforce", "admin"],
    "locations": ["remote"]
  }
}
```

Available sections: `search`, `schedule`, `email`, `apiKey`, `resume`, `companies`, `database`, `dashboardPort`, `system`

**Direct file editing:**
1. Quit Career Future
2. Edit `%APPDATA%\Career Future\career-future-config.json`
3. Restart the application

---

## 7. Security

### 7.1 Network Security

| Protection | Implementation |
|------------|----------------|
| Localhost-only binding | Dashboard binds to `127.0.0.1` only |
| DNS rebinding protection | Rejects requests with non-localhost Host headers |
| Rate limiting | 20 requests/minute on API endpoints |
| No external access | Dashboard is not accessible from other machines |

### 7.2 Electron Security

| Feature | Status |
|---------|--------|
| Context isolation | Enabled |
| Node integration | Disabled in renderer |
| Web security | Enabled |
| IPC whitelist | Only approved channels accessible |
| Content Security Policy | Applied to wizard and license pages |

### 7.3 Data Security

| Data | Protection |
|------|------------|
| Gmail App Password | Encrypted via OS credential store |
| Anthropic API Key | Encrypted via OS credential store |
| License private key | Stored offline, not in distribution |
| Config export | Automatically strips sensitive fields |

### 7.4 Code Signing

Currently **not enabled** (`signAndEditExecutable: false`). Windows SmartScreen may show warnings on first run.

To enable code signing:
1. Obtain a code signing certificate
2. Update `electron-builder.yml`:
   ```yaml
   win:
     signAndEditExecutable: true
     certificateFile: ./certs/cert.pfx
     certificatePassword: ${env.CSC_KEY_PASSWORD}
   ```
3. Rebuild

---

## 8. Troubleshooting

### 8.1 Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Chrome not found" errors | No Chrome/Edge installed | Install Chrome or Edge |
| Scraper finds no jobs | Invalid CSV URLs | Verify company URLs in CSV files |
| Email not sending | Invalid app password | Regenerate Gmail app password |
| "License expired" on launch | Trial ended, no license key | Activate a license key |
| Dashboard won't load | Port 3000 in use | Change port in Settings or config file |
| SmartScreen warning | Unsigned installer | Click "More info" > "Run anyway" |
| App doesn't start | Corrupted config | Delete `%APPDATA%\Career Future\` and restart |

### 8.2 Viewing Logs

Application logs are output to the console. In production, view logs by:

1. Launch from command line: `"C:\...\Career Future.exe"` from a terminal
2. Or check the Electron DevTools: View > Toggle Developer Tools

### 8.3 Browser Executable Detection

Career Future searches for Chrome/Edge at these paths:

```
%PROGRAMFILES%\Google\Chrome\Application\chrome.exe
%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe
%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe
%PROGRAMFILES(X86)%\Microsoft\Edge\Application\msedge.exe
%PROGRAMFILES%\Microsoft\Edge\Application\msedge.exe
```

If Chrome/Edge is installed in a non-standard location, the scraper will fail to launch a browser.

### 8.4 Resetting Trial Period

The trial start date is stored in the config file. To reset (for testing):

1. Quit the application
2. Edit `%APPDATA%\Career Future\career-future-config.json`
3. Remove or modify the `license.trialStartDate` field
4. Restart the application

### 8.5 Support

For issues and feature requests: https://github.com/anthropics/claude-code/issues

---

*Career Future v1.0.0 | Copyright 2026 Career Future*
