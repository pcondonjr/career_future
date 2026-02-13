import cron from 'node-cron';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { JobScraper } from './scraper.js';
import { JobDatabase } from './database.js';
import { JobEmailer } from './emailer.js';
import { loadSitesFromCSV, validateCSV } from './sites-config.js';
import { GoogleDorkScraper } from './google-dork-scraper.js';
import { startDashboard } from './dashboard.js';
import configManager from './src/main/config.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build paths from Dashboard config (fall back to defaults)
const companiesPaths = configManager.getCompaniesPaths();
const databasePaths = configManager.getDatabasePaths();

const CONFIG = {
  daily: {
    csvPath: path.resolve(__dirname, companiesPaths.daily),
    dbPath: path.resolve(__dirname, databasePaths.daily),
    name: 'Daily'
  },
  weekly: {
    csvPath: path.resolve(__dirname, companiesPaths.weekly),
    dbPath: path.resolve(__dirname, databasePaths.weekly),
    name: 'Weekly'
  },
  dorks: {
    csvPath: path.join(__dirname, 'google-dorks.csv'),
    dbPath: path.join(__dirname, 'jobs_database_dorks.json'),
    name: 'Google Dorks'
  }
};

async function runJobSearch(mode = 'daily') {
  const config = CONFIG[mode];

  console.log('\n' + '='.repeat(60));
  console.log(`🔍 Starting ${config.name} job search at ${new Date().toLocaleString()}`);
  console.log('='.repeat(60) + '\n');

  const scraper = new JobScraper();
  const db = new JobDatabase(config.dbPath);
  const emailer = new JobEmailer();

  // For weekly mode, load the daily database to filter out already-discovered jobs
  let dailyDb = null;
  if (mode === 'weekly') {
    dailyDb = new JobDatabase(CONFIG.daily.dbPath);
    await dailyDb.load();
    console.log(`📋 Loaded ${dailyDb.jobs.size} jobs from daily database (will exclude these)\n`);
  }

  try {
    // Validate CSV before loading
    console.log(`Validating ${config.csvPath}...`);
    const validation = await validateCSV(config.csvPath);

    if (!validation.valid) {
      console.error('❌ CSV validation failed:');
      validation.errors.forEach(err => console.error(`  - ${err}`));
      return;
    }

    if (validation.warnings.length > 0) {
      console.warn('⚠️  CSV warnings:');
      validation.warnings.forEach(warn => console.warn(`  - ${warn}`));
    }

    console.log(`✅ CSV valid: ${validation.totalRows} companies configured\n`);

    // Load sites from CSV
    const sites = await loadSitesFromCSV(config.csvPath);
    console.log(`📋 Loading ${sites.length} enabled sites\n`);

    if (sites.length === 0) {
      console.log('⚠️  No enabled sites found in CSV. Add companies to search.');
      return;
    }

    // Load existing jobs
    await db.load();

    // Initialize browser
    await scraper.initialize();

    // Scrape all sites
    const allJobs = await scraper.scrapeAllSites(sites);
    console.log(`\n📊 Total jobs found: ${allJobs.length}`);

    // Filter for new jobs only (not in this mode's database)
    let newJobs = db.filterNewJobs(allJobs);
    console.log(`✨ New jobs (not in ${config.name.toLowerCase()} database): ${newJobs.length}`);

    // For weekly mode, also filter out jobs already in daily database
    if (mode === 'weekly' && dailyDb) {
      const beforeFilter = newJobs.length;
      newJobs = newJobs.filter(job => !dailyDb.hasJob(job));
      const filtered = beforeFilter - newJobs.length;
      console.log(`🔍 Filtered out ${filtered} jobs already in daily database`);
      console.log(`📬 Jobs to report (truly new): ${newJobs.length}`);
    }

    // Save updated database
    await db.save();

    // Send email if there are new jobs
    if (newJobs.length > 0) {
      const stats = db.getStats();
      await emailer.sendJobAlert(newJobs, stats, mode);
    }

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log(`${config.name} search complete!`);
    console.log(`New jobs found: ${newJobs.length}`);
    console.log(`Total jobs tracked (${config.name.toLowerCase()}): ${db.jobs.size}`);
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('Error during job search:', error);
  } finally {
    await scraper.close();
  }
}

async function runDorkSearch(frequency = 'daily') {
  const config = CONFIG.dorks;

  console.log('\n' + '='.repeat(60));
  console.log(`🔍 Starting ${config.name} (${frequency}) search at ${new Date().toLocaleString()}`);
  console.log('='.repeat(60) + '\n');

  let dorkScraper;
  try {
    dorkScraper = new GoogleDorkScraper();
  } catch {
    // Constructor prints setup instructions
    return;
  }

  const db = new JobDatabase(config.dbPath);
  const dailyDb = new JobDatabase(CONFIG.daily.dbPath);
  const weeklyDb = new JobDatabase(CONFIG.weekly.dbPath);
  const emailer = new JobEmailer();

  try {
    await db.load();
    await dailyDb.load();
    await weeklyDb.load();
    console.log(`📋 Loaded ${dailyDb.jobs.size} daily + ${weeklyDb.jobs.size} weekly jobs for deduplication\n`);

    // Run the dork search
    const allJobs = await dorkScraper.runDorkSearch(config.csvPath, frequency);

    // Filter new jobs against dorks DB
    let newJobs = db.filterNewJobs(allJobs);
    console.log(`✨ New jobs (not in dorks database): ${newJobs.length}`);

    // Also filter out jobs already in daily or weekly databases
    const beforeFilter = newJobs.length;
    newJobs = newJobs.filter(job => !dailyDb.hasJob(job) && !weeklyDb.hasJob(job));
    const filtered = beforeFilter - newJobs.length;
    if (filtered > 0) {
      console.log(`🔍 Filtered out ${filtered} jobs already in daily/weekly databases`);
    }
    console.log(`📬 Jobs to report (truly new): ${newJobs.length}`);

    // Save updated dorks database
    await db.save();

    // Send email if there are new jobs
    if (newJobs.length > 0) {
      const stats = db.getStats();
      await emailer.sendJobAlert(newJobs, stats, 'dorks');
    }

    console.log('\n' + '='.repeat(60));
    console.log(`${config.name} (${frequency}) search complete!`);
    console.log(`New jobs found: ${newJobs.length}`);
    console.log(`Total jobs tracked (dorks): ${db.jobs.size}`);
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('Error during dork search:', error);
  }
}

// CLI mode
const isWeekly = process.argv.includes('--weekly');
const csvToValidate = isWeekly ? CONFIG.weekly.csvPath : CONFIG.daily.csvPath;

if (process.argv.includes('--validate')) {
  // Validate CSV and exit
  validateCSV(csvToValidate).then(result => {
    console.log(`\n📋 CSV Validation Results (${csvToValidate}):`);
    console.log(`Total rows: ${result.totalRows}`);

    if (result.errors.length > 0) {
      console.log('\n❌ Errors:');
      result.errors.forEach(err => console.log(`  ${err}`));
    }

    if (result.warnings.length > 0) {
      console.log('\n⚠️  Warnings:');
      result.warnings.forEach(warn => console.log(`  ${warn}`));
    }

    if (result.valid && result.warnings.length === 0) {
      console.log('\n✅ CSV is valid with no warnings!');
    }

    process.exit(result.valid ? 0 : 1);
  });
} else if (process.argv.includes('--now') && process.argv.includes('--dorks')) {
  // Run dork search immediately for testing
  const frequency = isWeekly ? 'weekly' : 'daily';
  runDorkSearch(frequency);
} else if (process.argv.includes('--now')) {
  // Run immediately for testing
  const mode = isWeekly ? 'weekly' : 'daily';
  runJobSearch(mode);
} else {
  // Scheduled mode — read schedule from Dashboard config
  const schedule = configManager.getSchedule();
  const dailyTimes = schedule.dailyTimes || ['08:00', '17:00'];
  const weeklyDay = schedule.weeklyDay ?? 0; // 0 = Sunday
  const weeklyTime = schedule.weeklyTime || '10:00';

  // Parse times into hour:minute for cron expressions
  const dailyHours = dailyTimes.map(t => t.split(':')[0]).join(',');
  const [weeklyHour, weeklyMin] = weeklyTime.split(':');

  // Dork searches run 30 minutes after the first configured daily time
  const firstDailyHour = dailyTimes[0].split(':')[0];
  const dorkDailyMin = '30';
  // Weekly dorks run day after weekly scraper
  const dorkWeeklyDay = (weeklyDay + 1) % 7;

  console.log('🚀 Career Future Search Started');
  console.log(`📅 Daily search: ${dailyTimes.join(' and ')}`);
  console.log(`📅 Weekly search: ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][weeklyDay]}s at ${weeklyTime}`);
  console.log(`📅 Daily dorks: ${firstDailyHour}:${dorkDailyMin}`);
  console.log(`📅 Weekly dorks: ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dorkWeeklyDay]}s at ${weeklyHour}:${dorkDailyMin}`);

  // Daily scraper at configured times
  cron.schedule(`0 ${dailyHours} * * *`, () => {
    runJobSearch('daily');
  });

  // Weekly scraper at configured day/time
  cron.schedule(`${weeklyMin} ${weeklyHour} * * ${weeklyDay}`, () => {
    runJobSearch('weekly');
  });

  // Daily dork search 30 min after first daily time
  cron.schedule(`${dorkDailyMin} ${firstDailyHour} * * *`, () => {
    runDorkSearch('daily');
  });

  // Weekly dork search day after weekly scraper
  cron.schedule(`${dorkDailyMin} ${weeklyHour} * * ${dorkWeeklyDay}`, () => {
    runDorkSearch('weekly');
  });

  // Weekly summary on the day after the weekly scraper at 9 AM
  cron.schedule(`0 9 * * ${dorkWeeklyDay}`, async () => {
    const db = new JobDatabase();
    const emailer = new JobEmailer();
    await db.load();
    await emailer.sendWeeklySummary(db);
  });

  // Start the dashboard server alongside the scheduler
  startDashboard();

  console.log('\n✅ Scheduler is running. Press Ctrl+C to stop.\n');
}
