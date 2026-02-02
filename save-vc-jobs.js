import { JobScraper } from './scraper.js';
import { JobDatabase } from './database.js';

const VC_SITES = [
  {
    name: 'Insight Partners',
    url: 'https://jobs.insightpartners.com/jobs?q=salesforce',
    selectors: {
      jobCard: '.job-card',
      title: '[itemprop="title"]',
      location: '[itemprop="addressLocality"]',
      link: '[itemprop="title"]'
    }
  },
  {
    name: 'Tech Jobs for Good',
    url: 'https://techjobsforgood.com/?q=salesforce',
    selectors: {
      jobCard: '.job-card',
      title: '.job-title',
      location: '.location',
      link: 'a'
    }
  }
];

async function main() {
  const scraper = new JobScraper();
  const db = new JobDatabase();

  await scraper.initialize();
  await db.load();

  console.log('Scraping VC job boards and saving to database...\n');

  let allJobs = [];
  for (const site of VC_SITES) {
    const jobs = await scraper.scrapeSite(site);
    console.log(`${site.name}: Found ${jobs.length} relevant jobs`);
    allJobs.push(...jobs);
  }

  await scraper.close();

  // Save to database
  const newJobs = db.filterNewJobs(allJobs);
  for (const job of allJobs) {
    db.addJob(job);
  }
  await db.save();

  console.log(`\n✅ Total jobs found: ${allJobs.length}`);
  console.log(`✨ New jobs: ${newJobs.length}`);
  console.log(`📊 Total jobs in database: ${db.jobs.size}`);
}

main().catch(console.error);
