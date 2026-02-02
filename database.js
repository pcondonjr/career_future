import fs from 'fs/promises';

const DB_FILE = './jobs_database.json';

export class JobDatabase {
  constructor() {
    this.jobs = new Map();
  }

  async load() {
    try {
      const data = await fs.readFile(DB_FILE, 'utf8');
      const parsed = JSON.parse(data);
      this.jobs = new Map(Object.entries(parsed));
      console.log(`Loaded ${this.jobs.size} jobs from database`);
    } catch (error) {
      // File doesn't exist yet, start fresh
      console.log('Starting with empty database');
      this.jobs = new Map();
    }
  }

  async save() {
    const obj = Object.fromEntries(this.jobs);
    await fs.writeFile(DB_FILE, JSON.stringify(obj, null, 2));
    console.log(`Saved ${this.jobs.size} jobs to database`);
  }

  addJob(job) {
    const key = this.generateKey(job);
    const existing = this.jobs.get(key);
    
    if (existing) {
      // Update last seen
      existing.lastSeen = new Date().toISOString();
      return { isNew: false, job: existing };
    } else {
      // New job
      const newJob = {
        ...job,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        id: key
      };
      this.jobs.set(key, newJob);
      return { isNew: true, job: newJob };
    }
  }

  generateKey(job) {
    // Create unique key from URL
    return Buffer.from(job.url).toString('base64').substring(0, 32);
  }

  filterNewJobs(jobs) {
    const newJobs = [];
    
    for (const job of jobs) {
      const result = this.addJob(job);
      if (result.isNew) {
        newJobs.push(result.job);
      }
    }
    
    return newJobs;
  }

  getStats() {
    const now = new Date();
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    
    const stats = {
      total: this.jobs.size,
      last24Hours: 0,
      lastWeek: 0
    };
    
    for (const [, job] of this.jobs) {
      const firstSeen = new Date(job.firstSeen);
      if (firstSeen > oneDayAgo) stats.last24Hours++;
      if (firstSeen > oneWeekAgo) stats.lastWeek++;
    }
    
    return stats;
  }

  // Clean up old jobs (optional - run monthly)
  async cleanOldJobs(daysOld = 90) {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
    let removed = 0;
    
    for (const [key, job] of this.jobs) {
      if (new Date(job.lastSeen) < cutoff) {
        this.jobs.delete(key);
        removed++;
      }
    }
    
    console.log(`Removed ${removed} jobs older than ${daysOld} days`);
    await this.save();
  }
}
