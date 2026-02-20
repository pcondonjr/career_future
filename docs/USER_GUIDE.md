# Career Future - User Guide

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Setup Wizard](#2-setup-wizard)
3. [Dashboard](#3-dashboard)
4. [Running a Search](#4-running-a-search)
5. [Managing Company Lists](#5-managing-company-lists)
6. [ATS List Search](#6-ats-list-search)
7. [Email Notifications](#7-email-notifications)
8. [AI Resume Optimizer](#8-ai-resume-optimizer)
9. [Settings](#9-settings)
10. [System Tray](#10-system-tray)
11. [License Activation](#11-license-activation)
12. [Backup & Restore](#12-backup--restore)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Getting Started

### What is Career Future?

Career Future is a desktop application that automates your job search. It searches company career pages on a schedule, tracks new listings, and notifies you by email when matching jobs appear. It also includes an AI-powered resume optimizer that helps you tailor your resume to specific job descriptions.

### System Requirements

| Requirement | Details |
|-------------|---------|
| Operating System | Windows 7 or later (64-bit) |
| Disk Space | ~500 MB |
| RAM | 2 GB minimum |
| Browser | Chrome or Edge must be installed |
| Network | Internet access required |

### Installing

1. Run `Career Future Setup <version>.exe`
2. Choose an installation directory (the default is fine for most users)
3. Select whether to create a Desktop and/or Start Menu shortcut
4. Click **Install**
5. The application launches automatically when installation finishes

### Where Your Data is Stored

| Data | Location |
|------|----------|
| Your settings | `%APPDATA%\Career Future\career-future-config.json` |
| Job databases | `%APPDATA%\Career Future\jobs_database.json` |
| Company lists | `%APPDATA%\Career Future\data\companies.csv` |

Your data is stored separately from the application files, so it is preserved when you update to a new version.

---

## 2. Setup Wizard

On first launch, a setup wizard walks you through initial configuration. You can change all of these settings later.

### Step 1: Welcome

An introduction to Career Future. Click **Next** to begin.

### Step 2: Search Keywords

Enter the job titles and roles you are looking for (e.g., "salesforce", "developer", "project manager"). Press **Enter** after typing each keyword to add it as a tag. Click the **x** on any tag to remove it.

### Step 3: Locations

Enter your preferred locations (e.g., "remote", "new york", "charlotte"). These work the same way as keywords — press **Enter** to add each one.

### Step 4: Email Notifications (Optional)

Set up email alerts so you get notified when new jobs are found. This requires:

- A **Gmail address**
- A **Gmail App Password** (not your regular Gmail password)

If you do not have an App Password yet, see [Setting Up Gmail App Password](#setting-up-gmail-app-password) below. You can skip this step and configure it later in Settings.

### Step 5: AI Resume Optimizer (Optional)

Enable AI-powered resume analysis. This requires:

- An **Anthropic API key** from https://console.anthropic.com/
- The **file path** to your resume (supports PDF, DOCX, DOC, TXT, and MD files)

You can skip this step and configure it later in Settings.

### Step 6: Career Future Search Schedule

Configure when Career Future should automatically search for new jobs:

- **Enable/disable** automatic scheduling
- **Daily search times** — defaults to 8:00 AM and 5:00 PM
- **Weekly deep search** — defaults to Sunday at 10:00 AM (uses a broader company list)

### Step 7: Summary

Review all your settings. Click **Finish** to complete setup and launch the dashboard.

After the wizard completes, your **7-day free trial** begins.

---

## 3. Dashboard

The dashboard is the main interface of Career Future. It opens automatically at `http://localhost:3000` in the Electron window.

### Job List

The main area displays all discovered jobs as cards, each showing:

- **Job title** (clickable link to the posting)
- **Company name**
- **Location**
- **Date found**
- **View Job** button — opens the posting in your browser
- **Optimize Resume** button — launches the AI resume analyzer for that job

### Quick Stats

At the top of the dashboard you will see:

- **Total Jobs** found
- **Last 24 Hours** count
- **This Week** count
- **Companies** being tracked

### Search and Filter

Use the filter bar to narrow your results:

- **Time Range** — Last 24 hours, 7 days, 30 days, or All time
- **Search Field** — Search by Title, Company, or Location
- **Match Type** — Contains, Exact Match, Begins With, or Ends With
- **Search box** — Type your search term and press Enter

### Action Buttons

| Button | What it does |
|--------|-------------|
| **Export CSV** | Downloads all visible jobs as a spreadsheet |
| **Daily Companies** | View your daily company search list |
| **Weekly Companies** | View your weekly company search list |
| **Settings** | Open the settings panel |
| **Analyze External Job** | Paste any job description for AI analysis |
| **Run Companies List Now** | Manually trigger a daily search |
| **Run Companies-Weekly List Now** | Manually trigger a weekly search |
| **Run ATS List Now** | Manually trigger an ATS (Applicant Tracking System) search using Google Dork queries |
| **Stop** | Appears while a search is running — click to cancel the current search |

### Live Log Panel

When a search is running, a live log panel appears at the bottom of the dashboard showing real-time output from the search process. You can:

- **Show/Hide** the log panel with the toggle button
- Watch progress as each company page is visited
- See errors if a company page fails to load

The log panel auto-scrolls to show the latest output and disappears when the search completes.

---

## 4. Running a Search

Career Future visits company career pages, searches for jobs matching your keywords and locations, and saves new results to your database.

### Automatic Scheduling

If you enabled scheduling during setup (or in Settings), searches run automatically at your configured times. You do not need to keep the dashboard open — the app runs in the background via the system tray.

- **Daily searches** check your main company list at the times you set
- **Weekly searches** check a broader company list once per week

### Manual Search

You can trigger a search at any time:

- **From the dashboard:** Click **Run Companies List Now** or **Run Companies-Weekly List Now**
- **From the system tray:** Right-click the tray icon > **Run Search Now** > **Daily Search** or **Weekly Search**

While a search is running, a status indicator on the dashboard shows the current operation. A **Stop** button appears so you can cancel the search at any time, and a live log panel shows real-time progress.

### Stopping a Search

Click the **Stop** button on the dashboard to cancel any running search. This immediately terminates the search process and any browser instances it launched.

---

## 5. Managing Company Lists

Career Future searches two separate lists of company career pages:

| List | File | Purpose |
|------|------|---------|
| Daily | `data/companies.csv` | Your core target companies, checked frequently |
| Weekly | `data/companies-weekly.csv` | A broader set of companies, checked once per week |

### Viewing Company Lists

Click **Daily Companies** or **Weekly Companies** on the dashboard to see each list in a table format showing company name, URL, and enabled/disabled status.

### Editing Company Lists

Open the CSV files directly in Excel, Google Sheets, or a text editor. The format is:

```csv
Company,URL,Enabled
Salesforce,https://salesforce.wd5.myworkdayjobs.com/,true
Acme Corp,https://careers.acme.com/jobs,true
Old Company,https://old.example.com/jobs,false
```

- Set `Enabled` to `true` or `false` to include or exclude a company
- The file paths can be changed in Settings > File Paths

---

## 6. ATS List Search

In addition to searching company career pages directly, Career Future can search Google for job listings using targeted search queries (Google Dorks) and the Serper API.

### How It Works

The ATS list search uses template-based Google search queries defined in `data/ats-list.csv`. Each query targets specific Applicant Tracking Systems (ATS) like Workday, Greenhouse, Lever, and others using your configured keywords and locations.

### Running an ATS Search

- **From the dashboard:** Click **Run ATS List Now**
- **Automatically:** ATS searches run 30 minutes after scheduled company searches

### Results

ATS search results are stored in a separate database (`jobs_database_dorks.json`) and appear on the dashboard alongside your company search results. Results are filtered to:

- Only include US-based positions
- Exclude dead links (404/410 pages)
- Skip international results

### Serper Jobs API

Career Future also uses the Serper Jobs API to pull structured job data directly from Google Jobs. This runs automatically at :45 past the hour and stores results in `jobs_database_jobs.json`.

### API Key Required

ATS list search requires a Serper API key. Set the `SERPER_API_KEY` in your `.env` file. The free tier provides 2,500 queries, after which usage costs $50/month for 50,000 queries.

---

## 7. Email Notifications

When configured, Career Future sends you email alerts:

- **Daily job alert** — Sent after each daily search with new listings
- **Weekly job alert** — Sent after the weekly search with listings not found in daily runs
- **Weekly summary** — Sent every Monday at 9 AM with stats from the past week

### Setting Up Gmail App Password

Career Future uses Gmail App Passwords (not your regular password) for security:

1. Go to https://myaccount.google.com/apppasswords
   - You must have **2-Step Verification** enabled on your Google account first
2. Select **Mail** and **Windows Computer**
3. Click **Generate**
4. Copy the 16-character password that appears
5. Paste it into Career Future's email settings (Setup Wizard or Settings > Email Notifications)

---

## 7. AI Resume Optimizer

The AI resume optimizer uses Claude (by Anthropic) to analyze how well your resume matches a specific job posting and suggests improvements — using only your existing experience.

### Prerequisites

- An **Anthropic API key** — sign up at https://console.anthropic.com/
- Your **resume file** configured in Settings
- Each analysis costs approximately $0.02–0.05 in API usage

### How to Use It

**Option A: From a job card on the dashboard**

1. Find a job you are interested in
2. Click **Optimize Resume** on that job's card
3. In the modal that appears, click **Auto-Fetch Description** to pull the job details automatically, or paste the description manually
4. Click **Analyze Job Match**

**Option B: For any job posting**

1. Click **Analyze External Job** at the top of the dashboard
2. Paste a job URL or the full job description text
3. Click **Analyze Job Match**

### What You Get

The analysis returns:

| Section | Description |
|---------|-------------|
| **Compatibility Score** | A 0–100% rating of how well you match |
| **Key Requirements** | The 5–7 most important qualifications from the posting |
| **Matching Strengths** | Parts of your resume that align well |
| **Gaps to Address** | Requirements you may be missing |
| **Questions to Explore** | Prompts to help you think about how you might fill gaps |
| **Resume Recommendations** | Specific suggestions for rewording, reordering, and emphasizing content |
| **Priority Adjustments** | The top 3–5 concrete changes to make |

The AI will never fabricate experience or skills. It only recommends reframing and reorganizing what is already in your resume.

---

## 8. Settings

Open Settings from the dashboard (**Settings** button) or the system tray menu.

The settings page is organized into collapsible sections. Each section has its own **Save** button — changes are not saved until you click it.

### Search Keywords & Locations

Add or remove keywords and locations used for searching. Works the same as the setup wizard — type and press **Enter** to add tags, click **x** to remove.

### Schedule

- Toggle automatic scheduling on or off
- Add or remove daily search times
- Set the weekly search day and time

### Email Notifications

- Gmail address
- App Password (displayed as a masked field)
- Email service (Gmail or Outlook)

### AI Resume Optimizer

- Anthropic API Key (masked)
- Resume file path

### File Paths

- Change the location of your company CSV files
- Change the location of your job database files

### System

- **Dashboard Port** — Change the port the dashboard runs on (default: 3000). Requires an app restart.
- **Start on system login** — Launch Career Future automatically when Windows starts
- **Minimize to system tray** — Keep running in the background when you close the window
- **Check for updates** — Look for new versions on startup

### License

Displays your current license status:

- **Licensed** (green) — Shows your email, license type, and activation date
- **Trial** (amber) — Shows days remaining
- **Trial Expired** (red) — You need to activate a license to continue

---

## 9. System Tray

When you close the window (with "Minimize to system tray" enabled), Career Future continues running in the background. Look for its icon in the Windows system tray (bottom-right corner of the taskbar).

### Tray Menu Options

| Option | Description |
|--------|-------------|
| **License status** | Shows your license or trial status at the top |
| **Show Dashboard** | Brings the dashboard window back |
| **Hide Dashboard** | Minimizes to tray |
| **Run Search Now** | Trigger a Daily or Weekly search immediately |
| **Scheduler** | View scheduler status, start or stop it |
| **Settings** | Open the settings page |
| **About** | Shows the app version |
| **Quit Career Future** | Fully exits the application |

**Tip:** Double-click the tray icon to quickly show or hide the dashboard.

---

## 10. License Activation

Career Future includes a **7-day free trial**. After the trial ends, you need a license key to continue using the app.

### Activating Your License

1. If your trial has expired, the License Activation screen appears automatically on launch
2. Enter the **email address** associated with your purchase
3. Paste the **license key** you received
4. Click **Activate License**

The license is validated offline — no internet connection is required for activation.

If your trial is still active and you want to activate early, the license status is visible in Settings > License.

### Getting a License Key

Purchase a license from the Career Future website. Your license key will be emailed to you automatically after purchase.

---

## 11. Backup & Restore

### Backing Up Your Data

Copy the entire `%APPDATA%\Career Future\` folder to a safe location. This includes:

- `career-future-config.json` — All your settings
- `jobs_database.json` — Your daily job history
- `jobs_database_weekly.json` — Your weekly job history
- `data/companies.csv` — Your daily company list
- `data/companies-weekly.csv` — Your weekly company list

**To open this folder:** Press `Win + R`, type `%APPDATA%\Career Future`, and press Enter.

### Restoring Your Data

1. Install Career Future on your new machine
2. Close the application completely (Quit from tray)
3. Copy your backed-up files into `%APPDATA%\Career Future\`
4. Restart the application

---

## 12. Troubleshooting

### Common Issues

| Problem | Solution |
|---------|----------|
| **"Chrome not found" error** | Install Google Chrome or Microsoft Edge |
| **Search finds no jobs** | Check that your company URLs are correct and enabled in the CSV files |
| **Not receiving email alerts** | Verify your Gmail App Password in Settings > Email. Make sure 2-Step Verification is enabled on your Google account |
| **Dashboard won't load** | Another application may be using port 3000. Change the port in Settings > System |
| **Windows SmartScreen warning** | This appears because the installer is not code-signed. Click **More info** then **Run anyway** |
| **App won't start** | Your config file may be corrupted. Delete the folder `%APPDATA%\Career Future\` and restart the app. You will need to go through the setup wizard again |
| **License key not accepted** | Make sure the email you enter matches the email used when the key was generated. Paste the full key including both parts separated by a period |
| **Search takes a long time** | Each company page takes a few seconds to load. If you have many companies enabled, consider disabling some in the CSV file |

### Resetting the Application

If you need to start fresh:

1. Quit Career Future completely (right-click tray icon > **Quit Career Future**)
2. Press `Win + R`, type `%APPDATA%\Career Future`, and press Enter
3. Delete everything in this folder
4. Restart the application — the setup wizard will appear again

### Getting Help

For issues and feature requests, visit: https://github.com/pcondonjr/career-future/issues

---

*Career Future v1.0.0 | Copyright 2026 Career Future*
