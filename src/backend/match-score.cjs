/**
 * src/backend/match-score.cjs
 *
 * Sonnet-powered resume-to-job-description match scorer.
 * Runs AFTER triage.cjs (title/location filter) and fetch-jd.cjs (JD text) —
 * only scores jobs that already passed both, since this is the expensive step.
 *
 * Uses a forced tool-use call so the model returns structured JSON directly
 * (no free-text parsing, unlike triage.cjs's "YES, reason" format).
 *
 * Usage:
 *   node src/backend/match-score.cjs                -- score batch of 20
 *   node src/backend/match-score.cjs --batch 10
 *   node src/backend/match-score.cjs --dry-run
 */

'use strict';

require('dotenv').config();
const fs        = require('fs');
const path       = require('path');
const Anthropic  = require('@anthropic-ai/sdk');
const { Pool }   = require('pg');

// ── Config ────────────────────────────────────────────────────────────────────

const MODEL = 'claude-sonnet-5';
const SCORE_CONCURRENCY = 3;

const BATCH_SIZE = parseInt(process.argv.find(a => a.startsWith('--batch='))?.split('=')[1]
                     || (process.argv.indexOf('--batch') > -1
                         ? process.argv[process.argv.indexOf('--batch') + 1]
                         : '20')) || 20;

const DRY_RUN = process.argv.includes('--dry-run');

const RESUME_PATH = path.join(__dirname, '..', '..', 'resume', 'Patrick_Condon_Resume.txt');
const RESUME_TEXT = fs.readFileSync(RESUME_PATH, 'utf8');

const client = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const pool = new Pool({
  connectionString: process.env.CAREER_NEON_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a job-fit evaluator scoring how well a job posting matches a candidate's resume.
Score against these criteria:
- Role type & seniority: does the job title/level match the candidate's Salesforce Admin/BA/PM/Consultant background?
- Salesforce skill & certification overlap: Flow, Experience Cloud, Service Cloud, Sales Cloud, specific certs, etc.
- Location/timezone fit: remote, or a location the candidate could reasonably work from.
- Responsibility overlap: do the day-to-day duties in the JD match what the candidate has actually done?
Score 0-100. 70+ = strong, 40-69 = possible, below 40 = weak.
Call the score_match tool with your structured assessment. Keep reasoning to 2-3 sentences.`;

const SCORE_TOOL = {
  name: 'score_match',
  description: 'Report a structured match score between the resume and the job posting.',
  input_schema: {
    type: 'object',
    properties: {
      score:           { type: 'integer', minimum: 0, maximum: 100 },
      tier:            { type: 'string', enum: ['strong', 'possible', 'weak'] },
      matched_skills:  { type: 'array', items: { type: 'string' }, description: 'Skills/experience from the resume that match this job' },
      missing_skills:  { type: 'array', items: { type: 'string' }, description: 'Requirements in the JD not evidenced in the resume' },
      reasoning:       { type: 'string', description: '2-3 sentence explanation of the score' },
    },
    required: ['score', 'tier', 'matched_skills', 'missing_skills', 'reasoning'],
  },
};

function buildPrompt(job) {
  return `RESUME:\n${RESUME_TEXT}\n\n---\n\nJOB POSTING:\nTitle: ${job.job_title}\nCompany: ${job.company_name}\nLocation: ${job.location || 'not specified'}\n\n${job.full_jd_text}`;
}

// ── Core scoring ──────────────────────────────────────────────────────────────

async function scoreJob(job) {
  try {
    const message = await client.messages.create({
      model:       MODEL,
      max_tokens:  1024,
      system:      SYSTEM_PROMPT,
      tools:       [SCORE_TOOL],
      tool_choice: { type: 'tool', name: 'score_match' },
      messages:    [{ role: 'user', content: buildPrompt(job) }],
    });

    const toolUse = message.content.find(b => b.type === 'tool_use');
    if (!toolUse) return { ok: false, reason: 'no tool_use block in response' };

    return { ok: true, result: toolUse.input };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── DB ────────────────────────────────────────────────────────────────────────

async function getPendingJobs(client, limit) {
  const { rows } = await client.query(`
    SELECT id, job_title, company_name, location, full_jd_text
    FROM job_postings
    WHERE triage_result = 'yes'
      AND full_jd_text IS NOT NULL
      AND match_scored_at IS NULL
    ORDER BY first_seen DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

async function saveScore(client, id, r) {
  if (DRY_RUN) return;
  await client.query(`
    UPDATE job_postings
    SET match_score = $1, match_tier = $2, match_reasoning = $3,
        match_skills_matched = $4, match_skills_missing = $5, match_scored_at = NOW()
    WHERE id = $6
  `, [
    r.score, r.tier, r.reasoning,
    (r.matched_skills || []).join(', '),
    (r.missing_skills || []).join(', '),
    id,
  ]);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`Match scoring${DRY_RUN ? ' (DRY RUN)' : ''} — batch ${BATCH_SIZE}, model ${MODEL}`);

  const client = await pool.connect();
  let scored = 0, failed = 0;

  try {
    const jobs = await getPendingJobs(client, BATCH_SIZE);
    console.log(`${jobs.length} jobs pending match score`);

    for (let i = 0; i < jobs.length; i += SCORE_CONCURRENCY) {
      const chunk = jobs.slice(i, i + SCORE_CONCURRENCY);
      await Promise.all(chunk.map(async job => {
        const outcome = await scoreJob(job);
        if (outcome.ok) {
          await saveScore(client, job.id, outcome.result);
          scored++;
          console.log(`  [${outcome.result.score}/${outcome.result.tier}] ${job.job_title} @ ${job.company_name}`);
        } else {
          failed++;
          console.log(`  [skip] id=${job.id} "${job.job_title}" — ${outcome.reason}`);
        }
      }));
    }

    console.log(`Done. Scored: ${scored}, Failed/skipped: ${failed}`);
    return { scored, failed };
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error('Match scoring failed:', err.message);
    process.exit(1);
  });
}

module.exports = { run, scoreJob };
