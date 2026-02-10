import 'dotenv/config';
import express from 'express';
import { exec } from 'child_process';
import fs from 'fs/promises';
import puppeteer from 'puppeteer-core';
import { JobDatabase } from './database.js';
import { loadSitesFromCSV, validateCSV } from './sites-config.js';
import path from 'path';
import { fileURLToPath } from 'url';
import resumeRoutes from './resume_api_routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path bases — set by startDashboard() options or fall back to __dirname
let resourcesBase = __dirname;
let writableBase = __dirname;
let chromePath = null;
let configRef = null;

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

// --- Security middleware ---

// 1. DNS rebinding protection: reject requests with unexpected Host headers
app.use((req, res, next) => {
  const host = (req.headers.host || '').replace(`:${PORT}`, '');
  if (host === 'localhost' || host === '127.0.0.1') {
    return next();
  }
  res.status(403).send('Forbidden');
});

// 2. Rate limiting for expensive API endpoints (Anthropic calls)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 20; // max requests per window

function rateLimiter(req, res, next) {
  const now = Date.now();
  const entry = rateLimitMap.get('global') || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  entry.count++;
  rateLimitMap.set('global', entry);

  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }
  next();
}

app.use(express.json());
app.set('view engine', 'ejs');

// Static files and views — configured in startDashboard() after paths are set
// Defaults here for legacy `node dashboard.js` usage
let db;
let lastRunFile;

async function loadLastRun() {
  try {
    const data = await fs.readFile(lastRunFile, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveLastRun(info) {
  await fs.writeFile(lastRunFile, JSON.stringify(info, null, 2));
}

app.get('/', async (req, res) => {
  try {
    await db.load();
    const stats = db.getStats();

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const jobs = Array.from(db.jobs.values())
      .filter(job => new Date(job.firstSeen) >= sevenDaysAgo)
      .sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));

    const byCompany = {};
    jobs.forEach(job => {
      if (!byCompany[job.company]) {
        byCompany[job.company] = [];
      }
      byCompany[job.company].push(job);
    });

    const lastRun = await loadLastRun();

    res.render('index', {
      stats,
      jobs,
      byCompany,
      totalCompanies: Object.keys(byCompany).length,
      lastRun
    });
  } catch (error) {
    res.status(500).send('Error loading jobs: ' + error.message);
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    await db.load();
    const jobs = Array.from(db.jobs.values());
    res.json(jobs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    await db.load();
    const stats = db.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/export', async (req, res) => {
  try {
    await db.load();
    const jobs = Array.from(db.jobs.values());
    
    const csvRows = [
      'Title,Company,Location,URL,First Seen,Last Seen'
    ];
    
    jobs.forEach(job => {
      csvRows.push([
        `"${job.title.replace(/"/g, '""')}"`,
        `"${job.company}"`,
        `"${job.location || 'N/A'}"`,
        `"${job.url}"`,
        job.firstSeen,
        job.lastSeen
      ].join(','));
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=jobs_export.csv');
    res.send(csvRows.join('\n'));
  } catch (error) {
    res.status(500).send('Error exporting jobs: ' + error.message);
  }
});

app.get('/companies', async (req, res) => {
  try {
    const csvPath = path.join(resourcesBase, 'companies.csv');
    const validation = await validateCSV(csvPath);
    const sites = await loadSitesFromCSV(csvPath, false);

    res.render('companies', { sites, validation });
  } catch (error) {
    res.status(500).send('Error loading companies: ' + error.message);
  }
});

app.get('/companies-weekly', async (req, res) => {
  try {
    const csvPath = path.join(resourcesBase, 'companies-weekly.csv');
    const validation = await validateCSV(csvPath);
    const sites = await loadSitesFromCSV(csvPath, false);

    res.render('companies-weekly', { sites, validation });
  } catch (error) {
    res.status(500).send('Error loading weekly companies: ' + error.message);
  }
});

// Run scraper endpoints — signal/bat files in writable location
let scraperSignalFile;
let scraperBatFile;

async function isScraperRunning() {
  try {
    await fs.access(scraperSignalFile);
    return true;
  } catch {
    return false;
  }
}

app.post('/api/run-scraper', async (req, res) => {
  const mode = req.body.mode === 'weekly' ? 'weekly' : 'daily';
  const searchValue = (req.body.searchValue || '').trim();

  if (await isScraperRunning()) {
    return res.status(409).json({ error: 'A scraper is already running' });
  }

  const runName = mode === 'weekly' ? 'Companies List Weekly' : 'Companies List';
  await saveLastRun({ searchValue, runName, timestamp: new Date().toISOString() });
  await fs.writeFile(scraperSignalFile, mode);

  const weeklyFlag = mode === 'weekly' ? ' --weekly' : '';
  const batContent = [
    '@echo off',
    `cd /d "${writableBase}"`,
    `node index.js --now${weeklyFlag}`,
    `del "${scraperSignalFile}"`,
    'echo.',
    'echo Scraper complete. Press any key to close.',
    'pause > nul',
    'exit'
  ].join('\r\n');

  await fs.writeFile(scraperBatFile, batContent);
  exec(`start "${runName}" "${scraperBatFile}"`);

  res.json({ message: `${mode} scraper started` });
});

app.get('/api/scraper-status', async (req, res) => {
  res.json({ running: await isScraperRunning() });
});

// Fetch job description from URL using Puppeteer
app.post('/api/fetch-job-description', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  let browser;
  try {
    const launchOpts = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    };
    if (chromePath) launchOpts.executablePath = chromePath;
    browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const text = await page.evaluate(() => document.body.innerText);
    res.json({ description: text });
  } catch (error) {
    console.error('Error fetching job description:', error.message);
    res.status(500).json({ error: 'Failed to fetch job page: ' + error.message });
  } finally {
    if (browser) await browser.close();
  }
});

// Resume optimizer API routes (rate-limited — these call the Anthropic API)
app.use('/api', rateLimiter, resumeRoutes);

// --- Settings routes ---

app.get('/settings', (req, res) => {
  if (!configRef) return res.status(503).send('Config not available');
  const settings = {
    keywords: configRef.getKeywords(),
    locations: configRef.getLocations(),
    schedule: configRef.getSchedule(),
    email: {
      user: configRef.getEmailConfig().user || '',
      hasPassword: !!configRef.getEmailConfig().appPassword,
      service: configRef.getEmailConfig().service || 'gmail'
    },
    hasApiKey: !!configRef.getAnthropicApiKey(),
    resumePath: configRef.getResumePath() || '',
    companies: configRef.getCompaniesPaths(),
    database: configRef.getDatabasePaths(),
    dashboardPort: configRef.getDashboardPort(),
    system: configRef.getSystemConfig(),
    license: configRef.getLicenseInfo()
  };
  res.render('settings', { settings });
});

app.get('/api/settings', (req, res) => {
  if (!configRef) return res.status(503).json({ error: 'Config not available' });
  res.json({
    keywords: configRef.getKeywords(),
    locations: configRef.getLocations(),
    schedule: configRef.getSchedule(),
    email: {
      user: configRef.getEmailConfig().user || '',
      hasPassword: !!configRef.getEmailConfig().appPassword,
      service: configRef.getEmailConfig().service || 'gmail'
    },
    hasApiKey: !!configRef.getAnthropicApiKey(),
    resumePath: configRef.getResumePath() || '',
    companies: configRef.getCompaniesPaths(),
    database: configRef.getDatabasePaths(),
    dashboardPort: configRef.getDashboardPort(),
    system: configRef.getSystemConfig(),
    license: configRef.getLicenseInfo()
  });
});

app.post('/api/settings', (req, res) => {
  if (!configRef) return res.status(503).json({ error: 'Config not available' });
  const { section, data } = req.body;
  try {
    switch (section) {
      case 'search':
        if (data.keywords) configRef.setKeywords(data.keywords);
        if (data.locations) configRef.setLocations(data.locations);
        break;
      case 'schedule':
        configRef.setSchedule(data);
        break;
      case 'email':
        configRef.setEmailConfig(data.user, data.appPassword, data.service);
        break;
      case 'apiKey':
        configRef.setAnthropicApiKey(data.apiKey);
        break;
      case 'resume':
        configRef.setResumePath(data.path);
        break;
      case 'companies':
        configRef.setCompaniesPaths(data.daily, data.weekly);
        break;
      case 'database':
        configRef.setDatabasePaths(data.daily, data.weekly);
        break;
      case 'dashboardPort':
        configRef.setDashboardPort(data.port);
        break;
      case 'system':
        configRef.setSystemConfig(data);
        break;
      default:
        return res.status(400).json({ error: 'Unknown settings section' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

export function startDashboard(options = {}) {
  // Set path bases from caller (Electron main process) or fall back to __dirname
  resourcesBase = options.resourcesPath || __dirname;
  writableBase = options.writablePath || __dirname;
  chromePath = options.chromePath || null;
  configRef = options.config || null;

  // Configure Express paths now that bases are set
  app.use(express.static(path.join(resourcesBase, 'public')));
  app.set('views', path.join(resourcesBase, 'views'));

  // Initialize path-dependent variables
  db = new JobDatabase(path.join(writableBase, 'jobs_database.json'));
  lastRunFile = path.join(writableBase, 'last_run.json');
  scraperSignalFile = path.join(writableBase, '.scraper-running');
  scraperBatFile = path.join(writableBase, '.run-scraper.bat');

  // Make resourcesBase available to sub-routers via app.locals
  app.locals.resourcesBase = resourcesBase;
  app.locals.writableBase = writableBase;

  // Bind to localhost only — prevents access from other devices on the network
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Dashboard running at http://localhost:${PORT} (localhost only)`);
  });
}

// Start when run directly (legacy mode: node dashboard.js)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  startDashboard();
}
