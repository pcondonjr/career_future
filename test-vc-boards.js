import { JobScraper } from './scraper.js';

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
  await scraper.initialize();

  console.log('Testing VC job boards with improved scraper...\n');

  for (const site of VC_SITES) {
    const jobs = await scraper.scrapeSite(site);
    console.log(`\n${site.name}:`);
    console.log(`  Total jobs found: ${jobs.length}`);
    jobs.slice(0, 3).forEach(j => {
      console.log(`  - ${j.title}`);
      console.log(`    Location: ${j.location || 'N/A'}`);
      console.log(`    URL: ${j.url.substring(0, 60)}...`);
    });
  }

  await scraper.close();
}

main().catch(console.error);
