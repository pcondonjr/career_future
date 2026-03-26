import 'dotenv/config';
import express from 'express';
import { execFile, spawn } from 'child_process';
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
let weeklyDb;
let dorkDb;
let lastRunFile;
let weeklyLastRunFile;
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

async function loadWeeklyLastRun() {
  try {
    const data = await fs.readFile(weeklyLastRunFile, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveWeeklyLastRun(info) {
  await fs.writeFile(weeklyLastRunFile, JSON.stringify(info, null, 2));
}

async function saveDorkLastRun(info) {
  await fs.writeFile(dorkLastRunFile, JSON.stringify(info, null, 2));
}

app.get('/', async (req, res) => {
  try {
    await db.load();
    await weeklyDb.load();
    await dorkDb.load();

    // Time range filtering (shared across all tabs)
    const range = req.query.range || '30d';
    let cutoff = null;
    if (range !== 'all') {
      const days = range === '24h' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 30;
      cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    }

    // Server-side keyword filter: only show jobs matching current config keywords
    const activeKeywords = configRef ? configRef.getKeywords().filter(k => k.trim()) : [];
    const keywordFilter = (job) => {
      if (activeKeywords.length === 0) return true;
      const title = (job.title || '').toLowerCase();
      return activeKeywords.some(kw => title.includes(kw.toLowerCase()));
    };

    const filterAndSort = (database) =>
      Array.from(database.jobs.values())
        .filter(job => !cutoff || new Date(job.firstSeen) >= cutoff)
        .filter(keywordFilter)
        .sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));

    const dailyJobs = filterAndSort(db);
    const weeklyJobs = filterAndSort(weeklyDb);
    const dorkJobs = filterAndSort(dorkDb);

    // Count enabled/disabled companies from CSVs
    const dailyCsvPath = path.join(resourcesBase, 'data/companies.csv');
    const weeklyCsvPath = path.join(resourcesBase, 'data/companies-weekly.csv');
    const atsCsvPath = path.join(resourcesBase, 'data/ats-list.csv');

    const dailySites = await loadSitesFromCSV(dailyCsvPath, false);
    const weeklySites = await loadSitesFromCSV(weeklyCsvPath, false);

    // Count ATS queries (non-comment, non-empty lines minus header)
    let atsQueryCount = 0;
    try {
      const atsContent = await fs.readFile(atsCsvPath, 'utf-8');
      atsQueryCount = atsContent.split('\n')
        .filter(l => l.trim() && !l.trim().startsWith('#')).length - 1;
    } catch { atsQueryCount = 0; }

    // Load all last-run data
    const dailyLastRun = await loadLastRun();
    const weeklyLastRun = await loadWeeklyLastRun();
    const dorkLastRun = await loadDorkLastRun();

    // Per-tab stats
    const tabStats = {
      daily: {
        companiesEnabled: dailySites.filter(s => s.enabled).length,
        companiesDisabled: dailySites.filter(s => !s.enabled).length,
        jobCount: dailyJobs.length,
        lastRun: dailyLastRun
      },
      weekly: {
        companiesEnabled: weeklySites.filter(s => s.enabled).length,
        companiesDisabled: weeklySites.filter(s => !s.enabled).length,
        jobCount: weeklyJobs.length,
        lastRun: weeklyLastRun
      },
      ats: {
        queriesCount: atsQueryCount,
        jobCount: dorkJobs.length,
        lastRun: dorkLastRun
      }
    };

    // Determine most recent run and default tab
    const allRuns = [
      dailyLastRun && { ...dailyLastRun, _tab: 'daily' },
      weeklyLastRun && { ...weeklyLastRun, _tab: 'weekly' },
      dorkLastRun && { ...dorkLastRun, _tab: 'ats' }
    ].filter(Boolean);
    const mostRecent = allRuns.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    const headerSearchValue = mostRecent?.searchValue || null;
    const defaultTab = mostRecent?._tab || 'daily';

    const activeKeyword = activeKeywords[0] || '';

    res.render('index', {
      tabStats,
      dailyJobs,
      weeklyJobs,
      dorkJobs,
      headerSearchValue,
      defaultTab,
      range,
      activeKeyword
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

app.get('/companies', async (req, res) => {
  try {
    const csvPath = path.join(resourcesBase, 'data/companies.csv');
    const validation = await validateCSV(csvPath);
    const sites = await loadSitesFromCSV(csvPath, false);
    const enabledCount = sites.filter(s => s.enabled).length;
    const disabledCount = sites.filter(s => !s.enabled).length;

    res.render('companies', { sites, validation, enabledCount, disabledCount });
  } catch (error) {
    res.status(500).send('Error loading companies: ' + error.message);
  }
});

app.get('/ats-list', async (req, res) => {
  try {
    const csvPath = path.join(resourcesBase, 'data/ats-list.csv');
    const content = await fs.readFile(csvPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    const header = lines[0];
    const rows = [];
    // Simple CSV parse — fields may be quoted
    for (let i = 1; i < lines.length; i++) {
      const cols = [];
      let cur = '', inQuote = false;
      for (const ch of lines[i]) {
        if (ch === '"') { inQuote = !inQuote; }
        else if (ch === ',' && !inQuote) { cols.push(cur); cur = ''; }
        else { cur += ch; }
      }
      cols.push(cur);
      if (cols.length >= 5) {
        rows.push({ id: cols[0], category: cols[1], query: cols[2], frequency: cols[3], notes: cols[4] });
      }
    }
    res.render('ats-list', { rows, total: rows.length });
  } catch (error) {
    res.status(500).send('Error loading ATS list: ' + error.message);
  }
});

app.get('/companies-weekly', async (req, res) => {
  try {
    const csvPath = path.join(resourcesBase, 'data/companies-weekly.csv');
    const validation = await validateCSV(csvPath);
    const sites = await loadSitesFromCSV(csvPath, false);
    const enabledCount = sites.filter(s => s.enabled).length;
    const disabledCount = sites.filter(s => !s.enabled).length;

    res.render('companies-weekly', { sites, validation, enabledCount, disabledCount });
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
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {});
  } else {
    proc.kill('SIGTERM');
  }
}

app.post('/api/run-scraper', async (req, res) => {
  const mode = req.body.mode === 'weekly' ? 'weekly' : 'daily';
  const searchValue = (req.body.searchValue || '').trim();
  const matchMode = (req.body.matchMode || '').trim() || 'contains';

  if (!searchValue) {
    return res.status(400).json({ error: 'Search term is required. Enter a value in the search box before running.' });
  }

  if (isScraperRunning()) {
    return res.status(409).json({ error: 'A search is already running' });
  }

  const runName = mode === 'weekly' ? 'Weekly Companies' : 'Daily Companies';
  const runInfo = { searchValue, matchMode, runName, timestamp: new Date().toISOString() };
  if (mode === 'weekly') {
    await saveWeeklyLastRun(runInfo);
  } else {
    await saveLastRun(runInfo);
  }

  clearLog();
  appendLog(`Starting ${runName} search...`);

  const cliArgs = ['index.js', '--now'];
  if (mode === 'weekly') cliArgs.push('--weekly');

  // Pass search value and match mode via env vars to avoid shell word splitting
  const env = { ...process.env };
  if (searchValue) env.CF_SEARCH_VALUE = searchValue;
  if (matchMode) env.CF_MATCH_MODE = matchMode;

  scraperProcess = spawn('node', cliArgs, {
    cwd: writableBase,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env
  });

  pipeProcessOutput(scraperProcess);

  scraperProcess.on('close', (code, signal) => {
    if (code === 0) {
      appendLog('Search complete.');
    } else if (signal) {
      appendLog(`Search killed by signal ${signal}`);
    } else {
      appendLog(`Search crashed with exit code ${code} — Chrome may have run out of memory`);
    }
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

app.get('/api/scraper-progress', async (req, res) => {
  const progressPath = path.join(writableBase, '.scraper-progress.json');
  try {
    const raw = await fs.readFile(progressPath, 'utf8');
    return res.json(JSON.parse(raw));
  } catch { /* file doesn't exist or parse error */ }
  res.json(null);
});

// Phantom process detector — find orphaned Chrome/Node processes from previous scraper runs
app.get('/api/phantom-processes', async (req, res) => {
  try {
    const { execSync } = await import('child_process');
    const processes = [];

    // Get all chrome.exe and node.exe processes with their command lines
    const raw = execSync(
      'powershell -c "Get-CimInstance Win32_Process -Filter \\"name=\'chrome.exe\' OR name=\'node.exe\'\\" | Select ProcessId,Name,CommandLine,WorkingSetSize,CreationDate | ConvertTo-Json"',
      { encoding: 'utf8', timeout: 10000 }
    );
    const procs = JSON.parse(raw);
    const procList = Array.isArray(procs) ? procs : [procs];

    // Current dashboard PID and active child PIDs — these are NOT phantoms
    const safePids = new Set([process.pid]);
    if (scraperProcess && scraperProcess.pid) safePids.add(scraperProcess.pid);
    if (dorkProcess && dorkProcess.pid) safePids.add(dorkProcess.pid);

    for (const p of procList) {
      if (!p || safePids.has(p.ProcessId)) continue;
      const cmd = (p.CommandLine || '').toLowerCase();
      const name = (p.Name || '').toLowerCase();
      const memMB = Math.round((p.WorkingSetSize || 0) / 1024 / 1024);

      let source = '';
      let isPhantom = false;

      if (name === 'node.exe') {
        // Only flag node processes related to this project
        if (cmd.includes('index.js') && (cmd.includes('--now') || cmd.includes('--weekly') || cmd.includes('--dorks') || cmd.includes('--jobs'))) {
          source = 'Scraper child process';
          isPhantom = !isScraperRunning() && !isDorkRunning();
        }
      } else if (name === 'chrome.exe') {
        // Headless Chrome spawned by puppeteer (has --headless flag)
        if (cmd.includes('--headless') && (cmd.includes('--no-sandbox') || cmd.includes('--disable-dev-shm'))) {
          source = 'Puppeteer headless Chrome';
          isPhantom = !isScraperRunning();
        }
      }

      if (isPhantom) {
        processes.push({
          pid: p.ProcessId,
          name: p.Name,
          source,
          memMB,
          createdAt: p.CreationDate ? (() => { try { const d = new Date(p.CreationDate); return isNaN(d) ? null : d.toISOString(); } catch { return null; } })() : null
        });
      }
    }

    const totalMemMB = processes.reduce((sum, p) => sum + p.memMB, 0);
    res.json({ processes, totalMemMB });
  } catch (err) {
    res.json({ processes: [], totalMemMB: 0, error: err.message });
  }
});

app.post('/api/kill-phantom-processes', async (req, res) => {
  const { pids } = req.body;
  if (!Array.isArray(pids) || pids.length === 0) {
    return res.status(400).json({ error: 'No PIDs provided' });
  }

  const results = [];
  for (const pid of pids) {
    try {
      const numPid = parseInt(pid, 10);
      if (isNaN(numPid) || numPid === process.pid) continue;
      execFile('taskkill', ['/pid', String(numPid), '/T', '/F'], () => {});
      results.push({ pid: numPid, killed: true });
    } catch (err) {
      results.push({ pid, killed: false, error: err.message });
    }
  }
  res.json({ results });
});

app.post('/api/run-dorks', async (req, res) => {
  const searchValue = (req.body?.searchValue || '').trim();
  const matchMode = (req.body?.matchMode || '').trim() || 'contains';

  if (!searchValue) {
    return res.status(400).json({ error: 'Search term is required. Enter a value in the search box before running.' });
  }

  if (isDorkRunning()) {
    return res.status(409).json({ error: 'Applicant Tracking search is already running' });
  }
  await saveDorkLastRun({ searchValue, matchMode, runName: 'Applicant Tracking', timestamp: new Date().toISOString() });

  clearLog();
  appendLog('Starting Applicant Tracking search...');

  const dorkArgs = ['index.js', '--now', '--dorks', '--all'];

  // Pass search value and match mode via env vars to avoid shell word splitting
  const env = { ...process.env };
  if (searchValue) env.CF_SEARCH_VALUE = searchValue;
  if (matchMode) env.CF_MATCH_MODE = matchMode;

  dorkProcess = spawn('node', dorkArgs, {
    cwd: writableBase,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env
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

// --- Sort company CSV ---
app.post('/api/sort-companies', async (req, res) => {
  const { file } = req.body; // 'daily' or 'weekly'
  const csvFile = file === 'weekly' ? 'data/companies-weekly.csv' : 'data/companies.csv';
  const csvPath = path.join(resourcesBase, csvFile);

  try {
    const content = await fs.readFile(csvPath, 'utf-8');
    const lines = content.split('\n');
    const header = lines[0];
    const rows = lines.slice(1).filter(l => l.trim() && !l.trim().startsWith('#'));

    // Parse each row respecting quoted fields
    function parseRow(line) {
      const cols = [];
      let cur = '', inQuote = false;
      for (const ch of line) {
        if (ch === '"') { inQuote = !inQuote; }
        else if (ch === ',' && !inQuote) { cols.push(cur); cur = ''; }
        else { cur += ch; }
      }
      cols.push(cur);
      return { line, name: cols[0].toLowerCase(), enabled: cols[6] === 'true' };
    }

    const parsed = rows.map(parseRow);
    parsed.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const result = header + '\n' + parsed.map(r => r.line).join('\n') + '\n';
    await fs.writeFile(csvPath, result);

    const enabled = parsed.filter(r => r.enabled).length;
    const disabled = parsed.filter(r => !r.enabled).length;
    res.json({ success: true, enabled, disabled, total: parsed.length });
  } catch (error) {
    res.status(500).json({ error: 'Sort failed: ' + error.message });
  }
});

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

// Clear all job databases (used when keywords change to remove stale results)
app.post('/api/clear-databases', async (req, res) => {
  try {
    const targets = req.body.targets || ['daily', 'weekly', 'dorks'];
    const cleared = [];

    if (targets.includes('daily') && db) {
      db.jobs = new Map();
      await db.save();
      cleared.push('daily');
    }
    if (targets.includes('weekly') && weeklyDb) {
      weeklyDb.jobs = new Map();
      await weeklyDb.save();
      cleared.push('weekly');
    }
    if (targets.includes('dorks') && dorkDb) {
      dorkDb.jobs = new Map();
      await dorkDb.save();
      cleared.push('dorks');
    }

    res.json({ success: true, cleared });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear databases: ' + error.message });
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
  weeklyDb = new JobDatabase(path.join(writableBase, 'jobs_database_weekly.json'));
  dorkDb = new JobDatabase(path.join(writableBase, 'jobs_database_dorks.json'));
  lastRunFile = path.join(writableBase, 'last_run.json');
  weeklyLastRunFile = path.join(writableBase, 'last_run_weekly.json');
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
  // Inline Chrome discovery — can't import paths.js (depends on Electron)
  const fsSync = await import('fs');
  const candidates = [
    path.join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  const detectedChrome = candidates.find(c => c && fsSync.existsSync(c)) || null;
  startDashboard({ config: configManager, chromePath: detectedChrome });
}
