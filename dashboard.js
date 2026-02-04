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

// Resume optimizer API routes
app.use('/api', resumeRoutes);

export function startDashboard() {
  app.listen(PORT, () => {
    console.log(`\n🌐 Dashboard running at http://localhost:${PORT}`);
    console.log(`📊 View your jobs in your browser!`);
  });
}

// Start when run directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  startDashboard();
}
