/**
 * src/backend/triage.cjs
 *
 * Haiku-powered YES/NO filter for job postings.
 * Takes a job title + location and returns whether it's relevant
 * for Patrick's search (Salesforce Admin, BA, PM, Solutions Consultant, EST).
 *
 * Cost: ~$0.0001 per call (claude-haiku-4-5, 100 max_tokens)
 * Never called on full JD text — title + location only.
 *
 * Usage:
 *   const { triageJob, triageBatch } = require('./triage.cjs');
 *   const result = await triageJob('Salesforce Administrator', 'Charlotte, NC');
 *   // { relevant: true, reason: 'Salesforce Admin role in EST timezone' }
 */

'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Prompt ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a job relevance filter for a Salesforce professional's job search.
Reply with YES or NO followed by a comma and one short reason (under 10 words).
Format exactly: YES, reason  or  NO, reason`;

const ROLES = [
  'Salesforce Administrator',
  'Salesforce Admin',
  'Salesforce Business Analyst',
  'Salesforce BA',
  'Salesforce Platform Lead',
  'Salesforce Consultant',
  'Salesforce Solutions Consultant',
  'CRM Administrator',
  'CRM Analyst',
  'Business Systems Analyst',
  'Project Manager',
  'IT Project Manager',
  'Business Analyst',
  'IT Operations Manager',
  'Systems Administrator',
].join(', ');

const EST_STATES = 'CT, DC, DE, FL, GA, IN, KY, MA, MD, ME, MI, NC, NH, NJ, NY, OH, PA, RI, SC, TN, VA, VT, WV';

function buildPrompt(title, location) {
  return `Job title: "${title}"
Location: "${location}"

Is this relevant? Criteria:
- Role type: ${ROLES}
- Location: Remote (any), or in EST timezone states (${EST_STATES}), or unspecified
- NOT relevant: accounting, legal, healthcare clinical, sales rep, customer service agent

Reply format: YES, reason  or  NO, reason`;
}

// ── Cache ─────────────────────────────────────────────────────────────────────
// Simple in-memory cache to avoid re-triaging identical title+location combos
// within the same run. Not persisted — resets each process start.

const cache = new Map();

function cacheKey(title, location) {
  return `${title.toLowerCase().trim()}|${(location || '').toLowerCase().trim()}`;
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Triage a single job posting.
 *
 * @param {string} title     — job title
 * @param {string} location  — location string from the career page
 * @returns {{ relevant: boolean, reason: string, cached: boolean }}
 */
async function triageJob(title, location = '') {
  const key = cacheKey(title, location);
  if (cache.has(key)) {
    return { ...cache.get(key), cached: true };
  }

  try {
    const message = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system:     SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: buildPrompt(title, location) }
      ],
    });

    const raw = message.content[0]?.text?.trim() || '';

    // Parse "YES, reason" or "NO, reason"
    const isYes    = /^yes/i.test(raw);
    const commaIdx = raw.indexOf(',');
    const reason   = commaIdx > -1
      ? raw.slice(commaIdx + 1).trim()
      : raw.slice(3).trim();

    const result = { relevant: isYes, reason, cached: false };
    cache.set(key, { relevant: isYes, reason });
    return result;

  } catch (err) {
    // On API error, default to relevant=true so we don't miss jobs
    console.error(`  [triage] API error for "${title}": ${err.message}`);
    return { relevant: true, reason: 'triage error — defaulting to include', cached: false };
  }
}

/**
 * Triage multiple jobs with concurrency control.
 *
 * @param {Array<{title, location}>} jobs
 * @param {object} options
 * @param {number} options.concurrency  — parallel Haiku calls (default 5)
 * @param {Function} options.onResult   — called after each job is triaged
 * @returns {Array<{title, location, relevant, reason, cached}>}
 */
async function triageBatch(jobs, { concurrency = 5, onResult } = {}) {
  const results = [];

  for (let i = 0; i < jobs.length; i += concurrency) {
    const chunk = jobs.slice(i, i + concurrency);
    const batch = await Promise.all(
      chunk.map(async job => {
        const result = await triageJob(job.title, job.location);
        const enriched = { ...job, ...result };
        if (onResult) onResult(enriched);
        return enriched;
      })
    );
    results.push(...batch);
  }

  return results;
}

module.exports = { triageJob, triageBatch };

// ── CLI test mode ─────────────────────────────────────────────────────────────
// node src/backend/triage.cjs "Salesforce Administrator" "Charlotte, NC"

if (require.main === module) {
  const title    = process.argv[2];
  const location = process.argv[3] || '';

  if (!title) {
    console.error('Usage: node src/backend/triage.cjs "Job Title" "Location"');
    console.error('Example: node src/backend/triage.cjs "Salesforce Administrator" "Charlotte, NC"');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  console.log(`Triaging: "${title}" in "${location}"\n`);

  triageJob(title, location).then(result => {
    console.log('Relevant :', result.relevant ? '✅ YES' : '❌ NO');
    console.log('Reason   :', result.reason);
    console.log('Cached   :', result.cached);
  }).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
