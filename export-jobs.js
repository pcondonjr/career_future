import { JobDatabase } from './database.js';
import fs from 'fs/promises';

async function exportToCSV() {
  const db = new JobDatabase();
  await db.load();
  
  const rows = [
    'Title,Company,Location,URL,First Seen,Last Seen'
  ];
  
  for (const [, job] of db.jobs) {
    rows.push([
      `"${job.title.replace(/"/g, '""')}"`,
      `"${job.company}"`,
      `"${job.location || 'N/A'}"`,
      `"${job.url}"`,
      job.firstSeen,
      job.lastSeen
    ].join(','));
  }
  
  await fs.writeFile('jobs_export.csv', rows.join('\n'));
  console.log(`✅ Exported ${db.jobs.size} jobs to jobs_export.csv`);
}

exportToCSV();
