/**
 * src/backend/blocked-domains.cjs
 *
 * Canonical list of ATS platforms and popular job boards to exclude from
 * "hidden posting" discovery — shared by discover-companies.cjs (Serper
 * -site: exclusion) and scripts/ingest-claude-job.cjs (hard domain check
 * before any insert), so the two stay in sync instead of drifting.
 */

'use strict';

const BLOCKED_DOMAINS = new Set([
  // ATS platforms
  'greenhouse.io', 'lever.co', 'workday.com', 'myworkdayjobs.com',
  'bamboohr.com', 'ashby.com', 'ashbyhq.com', 'workable.com', 'apply.workable.com',
  'smartrecruiters.com', 'icims.com', 'taleo.net', 'jobvite.com', 'jobs.jobvite.com',
  'jazz.co', 'applytojob.com', 'breezy.hr', 'recruitee.com', 'pinpointhq.com',
  'paylocity.com', 'ultipro.com', 'phenom.com', 'eightfold.ai', 'teamtailor.com',
  'rippling.com', 'adp.com', 'successfactors.com', 'oraclecloud.com',
  'dayforce.com', 'ceridian.com', 'paychex.com', 'cornerstoneondemand.com',
  // Job boards
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com',
  'monster.com', 'careerbuilder.com', 'simplyhired.com', 'dice.com',
  'wellfound.com', 'angel.co', 'builtin.com', 'builtinnyc.com',
  'builtinchicago.com', 'builtinboston.com', 'builtinseattle.com',
  'idealist.org', 'techcareers.com', 'cybercoders.com', 'hired.com',
  'salary.com', 'payscale.com',
]);

/** True if url's hostname is (or is a subdomain of) a blocked domain. */
function isBlockedUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    for (const domain of BLOCKED_DOMAINS) {
      if (host === domain || host.endsWith('.' + domain)) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

module.exports = { BLOCKED_DOMAINS, isBlockedUrl };
