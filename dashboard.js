import 'dotenv/config';
import express from 'express';
import { JobDatabase } from './database.js';
import { loadSitesFromCSV, validateCSV } from './sites-config.js';
import path from 'path';
import { fileURLToPath } from 'url';
import resumeRoutes from './resume_api_routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const db = new JobDatabase();

app.get('/', async (req, res) => {
  try {
    await db.load();
    const stats = db.getStats();
    
    const jobs = Array.from(db.jobs.values())
      .sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));
    
    const byCompany = {};
    jobs.forEach(job => {
      if (!byCompany[job.company]) {
        byCompany[job.company] = [];
      }
      byCompany[job.company].push(job);
    });
    
    res.render('index', { 
      stats, 
      jobs, 
      byCompany,
      totalCompanies: Object.keys(byCompany).length 
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
    const validation = await validateCSV();
    const sites = await loadSitesFromCSV('./companies.csv', false);

    res.render('companies', { sites, validation });
  } catch (error) {
    res.status(500).send('Error loading companies: ' + error.message);
  }
});

// Resume optimizer API routes (rate-limited — these call the Anthropic API)
app.use('/api', rateLimiter, resumeRoutes);

export function startDashboard() {
  // 3. Bind to localhost only — prevents access from other devices on the network
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`\n🌐 Dashboard running at http://localhost:${PORT} (localhost only)`);
    console.log(`📊 View your jobs in your browser!`);
  });
}

// Start when run directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  startDashboard();
}
