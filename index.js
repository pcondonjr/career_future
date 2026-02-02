import cron from 'node-cron';
import dotenv from 'dotenv';
import { JobScraper } from './scraper.js';
import { JobDatabase } from './database.js';
import { JobEmailer } from './emailer.js';
import { loadSitesFromCSV, validateCSV } from './sites-config.js';

dotenv.config();

// Configuration for different scraper modes
const CONFIG = {
  daily: {
    csvPath: './companies.csv',
    dbPath: './jobs_database.json',
    name: 'Daily'
  },
  weekly: {
    csvPath: './companies-weekly.csv',
    dbPath: './jobs_database_weekly.json',
    name: 'Weekly'
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
      console.log('⚠️  No enabled sites found in CSV. Add companies to scrape.');
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

// CLI mode
const isWeekly = process.argv.includes('--weekly');
const csvToValidate = isWeekly ? './companies-weekly.csv' : './companies.csv';

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
} else if (process.argv.includes('--now')) {
  // Run immediately for testing
  const mode = isWeekly ? 'weekly' : 'daily';
  runJobSearch(mode);
} else {
  // Scheduled mode
  console.log('🚀 Salesforce Job Scraper Started');
  console.log('📅 Daily scraper: 8:00 AM and 5:00 PM');
  console.log('📅 Weekly scraper: Sundays at 10:00 AM');

  // Run daily at 8 AM and 5 PM every day
  cron.schedule('0 8,17 * * *', () => {
    runJobSearch('daily');
  });

  // Run weekly scraper on Sundays at 10 AM
  cron.schedule('0 10 * * 0', () => {
    runJobSearch('weekly');
  });

  // Weekly summary every Monday at 9 AM
  cron.schedule('0 9 * * 1', async () => {
    const db = new JobDatabase();
    const emailer = new JobEmailer();
    await db.load();
    await emailer.sendWeeklySummary(db);
  });

  console.log('\n✅ Scheduler is running. Press Ctrl+C to stop.\n');
}
