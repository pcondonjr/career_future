import cron from 'node-cron';
import { JobScraper } from '../../scraper.js';
import { JobDatabase } from '../../database.js';
import { JobEmailer } from '../../emailer.js';
import { loadSitesFromCSV, validateCSV } from '../../sites-config.js';
import config from '../main/config.js';

/**
 * Job Scheduler for Career Future
 * Manages scheduled job scraping runs
 */

export class Scheduler {
  constructor() {
    this.tasks = [];
    this.isRunning = false;
  }

  /**
   * Run a job search
   * @param {string} mode - 'daily' or 'weekly'
   */
  async runJobSearch(mode = 'daily') {
    const paths = config.getCompaniesPaths();
    const dbPaths = config.getDatabasePaths();

    const modeConfig = {
      daily: {
        csvPath: paths.daily,
        dbPath: dbPaths.daily,
        name: 'Daily'
      },
      weekly: {
        csvPath: paths.weekly,
        dbPath: dbPaths.weekly,
        name: 'Weekly'
      }
    };

    const currentConfig = modeConfig[mode];

    console.log('\n' + '='.repeat(60));
    console.log(`🔍 Starting ${currentConfig.name} job search at ${new Date().toLocaleString()}`);
    console.log('='.repeat(60) + '\n');

    const scraper = new JobScraper();
    const db = new JobDatabase(currentConfig.dbPath);
    const emailer = new JobEmailer();

    // For weekly mode, load the daily database to filter out already-discovered jobs
    let dailyDb = null;
    if (mode === 'weekly') {
      dailyDb = new JobDatabase(modeConfig.daily.dbPath);
      await dailyDb.load();
      console.log(`📋 Loaded ${dailyDb.jobs.size} jobs from daily database (will exclude these)\n`);
    }

    try {
      // Validate CSV before loading
      console.log(`Validating ${currentConfig.csvPath}...`);
      const validation = await validateCSV(currentConfig.csvPath);

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
      const sites = await loadSitesFromCSV(currentConfig.csvPath);
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
      console.log(`✨ New jobs (not in ${currentConfig.name.toLowerCase()} database): ${newJobs.length}`);

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
      console.log(`${currentConfig.name} search complete!`);
      console.log(`New jobs found: ${newJobs.length}`);
      console.log(`Total jobs tracked (${currentConfig.name.toLowerCase()}): ${db.jobs.size}`);
      console.log('='.repeat(60) + '\n');

    } catch (error) {
      console.error('Error during job search:', error);
    } finally {
      await scraper.close();
    }
  }

  /**
   * Start the scheduler with configured schedule
   */
  start() {
    if (this.isRunning) {
      console.log('Scheduler is already running');
      return;
    }

    const schedule = config.getSchedule();

    if (!schedule.enabled) {
      console.log('Scheduler is disabled in configuration');
      return;
    }

    console.log('🚀 Career Future Scheduler Started');

    // Convert daily times to cron expressions
    // e.g., ["08:00", "17:00"] -> "0 8,17 * * *"
    const dailyHours = schedule.dailyTimes.map(time => {
      const [hour] = time.split(':');
      return parseInt(hour);
    }).join(',');

    const dailyCron = `0 ${dailyHours} * * *`;
    console.log(`📅 Daily scraper: ${schedule.dailyTimes.join(', ')}`);

    // Weekly scraper cron
    const [weeklyHour] = schedule.weeklyTime.split(':');
    const weeklyCron = `0 ${weeklyHour} * * ${schedule.weeklyDay}`;
    const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    console.log(`📅 Weekly scraper: ${weekdayNames[schedule.weeklyDay]}s at ${schedule.weeklyTime}`);

    // Schedule daily job
    const dailyTask = cron.schedule(dailyCron, () => {
      this.runJobSearch('daily');
    });
    this.tasks.push(dailyTask);

    // Schedule weekly job
    const weeklyTask = cron.schedule(weeklyCron, () => {
      this.runJobSearch('weekly');
    });
    this.tasks.push(weeklyTask);

    // Weekly summary every Monday at 9 AM
    const summaryTask = cron.schedule('0 9 * * 1', async () => {
      const dbPaths = config.getDatabasePaths();
      const db = new JobDatabase(dbPaths.daily);
      const emailer = new JobEmailer();
      await db.load();
      await emailer.sendWeeklySummary(db);
    });
    this.tasks.push(summaryTask);

    this.isRunning = true;
    console.log('\n✅ Scheduler is running. Press Ctrl+C to stop.\n');
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (!this.isRunning) {
      console.log('Scheduler is not running');
      return;
    }

    this.tasks.forEach(task => task.stop());
    this.tasks = [];
    this.isRunning = false;

    console.log('🛑 Scheduler stopped');
  }

  /**
   * Run immediately (for testing or manual triggers)
   * @param {string} mode - 'daily' or 'weekly'
   */
  async runNow(mode = 'daily') {
    await this.runJobSearch(mode);
  }
}

// Export singleton instance
export const scheduler = new Scheduler();
export default scheduler;
