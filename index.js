import cron from 'node-cron';
import dotenv from 'dotenv';
import { JobScraper } from './scraper.js';
import { JobDatabase } from './database.js';
import { JobEmailer } from './emailer.js';
import { loadSitesFromCSV, validateCSV } from './sites-config.js';

dotenv.config();

async function runJobSearch() {
  console.log('\n' + '='.repeat(60));
  console.log(`🔍 Starting job search at ${new Date().toLocaleString()}`);
  console.log('='.repeat(60) + '\n');

  const scraper = new JobScraper();
  const db = new JobDatabase();
  const emailer = new JobEmailer();

  try {
    // Validate CSV before loading
    console.log('Validating companies.csv...');
    const validation = await validateCSV();
    
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
    const sites = await loadSitesFromCSV();
    console.log(`📋 Loading ${sites.length} enabled sites\n`);

    // Load existing jobs
    await db.load();

    // Initialize browser
    await scraper.initialize();

    // Scrape all sites
    const allJobs = await scraper.scrapeAllSites(sites);
    console.log(`\n📊 Total jobs found: ${allJobs.length}`);

    // Filter for new jobs only
    const newJobs = db.filterNewJobs(allJobs);
    console.log(`✨ New jobs: ${newJobs.length}`);

    // Save updated database
    await db.save();

    // Send email if there are new jobs
    if (newJobs.length > 0) {
      const stats = db.getStats();
      await emailer.sendJobAlert(newJobs, stats);
    }

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('Search complete!');
    console.log(`New jobs found: ${newJobs.length}`);
    console.log(`Total jobs tracked: ${db.jobs.size}`);
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('Error during job search:', error);
  } finally {
    await scraper.close();
  }
}

// CLI mode
if (process.argv.includes('--validate')) {
  // Validate CSV and exit
  validateCSV().then(result => {
    console.log('\n📋 CSV Validation Results:');
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
  runJobSearch();
} else {
  // Scheduled mode
  console.log('🚀 Salesforce Job Scraper Started');
  console.log('📅 Scheduled to run at 8:00 AM and 5:00 PM daily');
  
  // Run at 8 AM and 5 PM every day
  cron.schedule('0 8,17 * * *', () => {
    runJobSearch();
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
