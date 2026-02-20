import 'dotenv/config';
import express from 'express';
import { exec, spawn } from 'child_process';
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
let dorkDb;
let lastRunFile;
let dorkLastRunFile;

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

async function loadDorkLastRun() {
  try {
    const data = await fs.readFile(dorkLastRunFile, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveDorkLastRun(info) {
  await fs.writeFile(dorkLastRunFile, JSON.stringify(info, null, 2));
}

app.get('/', async (req, res) => {
  try {
    await db.load();
    await dorkDb.load();
    const stats = db.getStats();
    const dorkStats = dorkDb.getStats();

    const range = req.query.range || '30d';
    let cutoff = null;
    if (range !== 'all') {
      const days = range === '24h' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 30;
      cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    }
    const jobs = Array.from(db.jobs.values())
      .filter(job => !cutoff || new Date(job.firstSeen) >= cutoff)
      .sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));

    const dorkJobs = Array.from(dorkDb.jobs.values())
      .filter(job => !cutoff || new Date(job.firstSeen) >= cutoff)
      .sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));

    const byCompany = {};
    jobs.forEach(job => {
      if (!byCompany[job.company]) {
        byCompany[job.company] = [];
      }
      byCompany[job.company].push(job);
    });

    const lastRun = await loadLastRun();
    const dorkLastRun = await loadDorkLastRun();

    res.render('index', {
      stats,
      dorkStats,
      jobs,
      dorkJobs,
      byCompany,
      totalCompanies: Object.keys(byCompany).length,
      lastRun,
      dorkLastRun,
      range
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
    const csvPath = path.join(resourcesBase, 'data/companies.csv');
    const validation = await validateCSV(csvPath);
    const sites = await loadSitesFromCSV(csvPath, false);

    res.render('companies', { sites, validation });
  } catch (error) {
    res.status(500).send('Error loading companies: ' + error.message);
  }
});

app.get('/companies-weekly', async (req, res) => {
  try {
    const csvPath = path.join(resourcesBase, 'data/companies-weekly.csv');
    const validation = await validateCSV(csvPath);
    const sites = await loadSitesFromCSV(csvPath, false);

    res.render('companies-weekly', { sites, validation });
  } catch (error) {
    res.status(500).send('Error loading weekly companies: ' + error.message);
  }
});

// Run scraper endpoints — track child processes so they can be stopped
let scraperSignalFile;
let dorkSignalFile;

// Track running child processes for stop functionality
let scraperProcess = null;
let dorkProcess = null;

// Live log buffer — ring buffer of recent output lines
const LOG_MAX_LINES = 500;
let logBuffer = [];
let logClients = new Set(); // SSE clients listening for log updates

function appendLog(line) {
  const entry = { ts: Date.now(), text: line };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX_LINES) logBuffer.shift();
  // Push to all SSE clients
  for (const client of logClients) {
    client.write(`data: ${JSON.stringify(entry)}\n\n`);
  }
}

function clearLog() {
  logBuffer = [];
}

function pipeProcessOutput(proc) {
  if (proc.stdout) {
    proc.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      lines.forEach(l => appendLog(l));
    });
  }
  if (proc.stderr) {
    proc.stderr.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(l => l.trim());
      lines.forEach(l => appendLog(l));
    });
  }
}

function isScraperRunning() {
  return scraperProcess !== null && !scraperProcess.killed;
}

function isDorkRunning() {
  return dorkProcess !== null && !dorkProcess.killed;
}

async function cleanupSignalFile(filePath) {
  try { await fs.unlink(filePath); } catch { /* already gone */ }
}

function stopProcess(proc) {
  if (!proc || proc.killed) return;
  // On Windows, taskkill /T kills the process tree (node + chrome children)
  if (process.platform === 'win32') {
    exec(`taskkill /pid ${proc.pid} /T /F`, () => {});
  } else {
    proc.kill('SIGTERM');
  }
}

app.post('/api/run-scraper', async (req, res) => {
  const mode = req.body.mode === 'weekly' ? 'weekly' : 'daily';
  const searchValue = (req.body.searchValue || '').trim();

  if (isScraperRunning()) {
    return res.status(409).json({ error: 'A search is already running' });
  }

  const runName = mode === 'weekly' ? 'Companies List Weekly' : 'Companies List';
  await saveLastRun({ searchValue, runName, timestamp: new Date().toISOString() });

  clearLog();
  appendLog(`Starting ${runName} search...`);

  const weeklyFlag = mode === 'weekly' ? ' --weekly' : '';
  const args = `--now${weeklyFlag}`;

  scraperProcess = spawn('node', ['index.js', ...args.split(' ').filter(Boolean)], {
    cwd: writableBase,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    shell: true
  });

  pipeProcessOutput(scraperProcess);

  scraperProcess.on('close', (code) => {
    appendLog(code === 0 ? 'Search complete.' : `Search exited with code ${code}`);
    scraperProcess = null;
  });
  scraperProcess.on('error', (err) => {
    appendLog(`Error: ${err.message}`);
    scraperProcess = null;
  });

  res.json({ message: `${mode} search started` });
});

app.post('/api/stop-scraper', async (req, res) => {
  if (!isScraperRunning()) {
    await cleanupSignalFile(scraperSignalFile);
    return res.json({ message: 'No search running' });
  }

  stopProcess(scraperProcess);
  scraperProcess = null;
  appendLog('Search stopped by user.');
  await cleanupSignalFile(scraperSignalFile);

  res.json({ message: 'Search stopped' });
});

app.get('/api/scraper-status', async (req, res) => {
  res.json({ running: isScraperRunning() });
});

app.post('/api/run-dorks', async (req, res) => {
  if (isDorkRunning()) {
    return res.status(409).json({ error: 'Applicant Tracking search is already running' });
  }

  await saveDorkLastRun({ runName: 'Applicant Tracking', timestamp: new Date().toISOString() });

  clearLog();
  appendLog('Starting Applicant Tracking search...');

  dorkProcess = spawn('node', ['index.js', '--now', '--dorks'], {
    cwd: writableBase,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    shell: true
  });

  pipeProcessOutput(dorkProcess);

  dorkProcess.on('close', (code) => {
    appendLog(code === 0 ? 'Applicant Tracking search complete.' : `Search exited with code ${code}`);
    dorkProcess = null;
  });
  dorkProcess.on('error', (err) => {
    appendLog(`Error: ${err.message}`);
    dorkProcess = null;
  });

  res.json({ message: 'Applicant Tracking search started' });
});

app.post('/api/stop-dorks', async (req, res) => {
  if (!isDorkRunning()) {
    await cleanupSignalFile(dorkSignalFile);
    return res.json({ message: 'No search running' });
  }

  stopProcess(dorkProcess);
  dorkProcess = null;
  appendLog('Applicant Tracking search stopped by user.');
  await cleanupSignalFile(dorkSignalFile);

  res.json({ message: 'Applicant Tracking search stopped' });
});

app.get('/api/dork-status', async (req, res) => {
  res.json({ running: isDorkRunning() });
});

// SSE endpoint — streams live log output to the Dashboard
app.get('/api/logs/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });

  // Send buffered lines so the client catches up
  for (const entry of logBuffer) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  logClients.add(res);
  req.on('close', () => { logClients.delete(res); });
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
  dorkDb = new JobDatabase(path.join(writableBase, 'jobs_database_dorks.json'));
  lastRunFile = path.join(writableBase, 'last_run.json');
  dorkLastRunFile = path.join(writableBase, 'last_run_dorks.json');
  scraperSignalFile = path.join(writableBase, '.scraper-running');
  dorkSignalFile = path.join(writableBase, '.dork-running');

  // Clean up any stale signal files left from previous crashes
  cleanupSignalFile(scraperSignalFile);
  cleanupSignalFile(dorkSignalFile);

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
  const configManager = (await import('./src/main/config.js')).default;
  startDashboard({ config: configManager });
}
