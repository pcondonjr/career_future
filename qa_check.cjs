/**
 * qa_check.cjs — Multi-gate QA runner
 *
 * Runs automated quality gates before code is committed.
 * Can be run standalone or triggered by git pre-commit hook.
 *
 * Usage:
 *   node qa_check.cjs              (run all gates)
 *   node qa_check.cjs --gate 1     (run specific gate)
 *   node qa_check.cjs --fix        (auto-fix what's possible)
 *   node qa_check.cjs --staged     (only check staged files)
 *
 * Gates:
 *   1. Syntax & lint check
 *   2. Security scan (credentials, injection patterns, npm audit)
 *   3. Functional check (scripts parse without errors)
 *   4. Regression check (key files exist and haven't lost exports)
 *   5. Cost guard (flag new paid API calls)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FIX_MODE = process.argv.includes('--fix');
const STAGED_ONLY = process.argv.includes('--staged');
const SPECIFIC_GATE = parseInt(
  process.argv.find(a => a.startsWith('--gate'))?.split('=')[1]
  || process.argv[process.argv.indexOf('--gate') + 1]
  || '0'
) || 0;

const ROOT = __dirname;
let totalIssues = 0;
let totalWarnings = 0;
const results = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', timeout: 30000, ...opts });
  } catch (err) {
    return err.stdout || err.stderr || err.message;
  }
}

function getStagedFiles() {
  const output = run('git diff --cached --name-only --diff-filter=ACM');
  return output.split('\n').filter(f => f.trim() && (f.endsWith('.js') || f.endsWith('.cjs')));
}

function getJSFiles() {
  if (STAGED_ONLY) return getStagedFiles();
  const ignore = ['node_modules', 'dist', 'build', '.git'];
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignore.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs')) files.push(full);
    }
  }
  walk(ROOT);
  return files;
}

function gateHeader(num, name) {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`  Gate ${num}: ${name}`);
  console.log('━'.repeat(60));
}

function pass(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ⚠ ${msg}`); totalWarnings++; }
function fail(msg) { console.log(`  ✗ ${msg}`); totalIssues++; }

// ─── Gate 1: Syntax & Lint ───────────────────────────────────────────────────

function gate1() {
  gateHeader(1, 'Syntax & Lint');
  let issues = 0;

  // ESLint
  const eslintCmd = FIX_MODE
    ? 'npx eslint --fix "**/*.{js,cjs}" --no-error-on-unmatched-pattern'
    : 'npx eslint "**/*.{js,cjs}" --no-error-on-unmatched-pattern';

  const eslintOutput = run(eslintCmd);
  const errorMatch = eslintOutput.match(/(\d+) errors?/);
  const warnMatch = eslintOutput.match(/(\d+) warnings?/);
  const errors = errorMatch ? parseInt(errorMatch[1]) : 0;
  const warnings = warnMatch ? parseInt(warnMatch[1]) : 0;

  if (errors > 0) {
    fail(`ESLint: ${errors} errors`);
    console.log(eslintOutput.split('\n').filter(l => l.includes('error')).slice(0, 10).map(l => `    ${l}`).join('\n'));
    issues += errors;
  } else {
    pass(`ESLint: no errors${warnings > 0 ? ` (${warnings} warnings)` : ''}`);
  }
  if (warnings > 0) totalWarnings += warnings;

  // Syntax check: try to parse each file
  const files = getJSFiles();
  let syntaxErrors = 0;
  for (const file of files) {
    const result = run(`node --check "${file}" 2>&1`);
    if (result.includes('SyntaxError')) {
      fail(`Syntax error in ${path.relative(ROOT, file)}`);
      syntaxErrors++;
    }
  }
  if (syntaxErrors === 0) pass(`All ${files.length} JS/CJS files parse successfully`);

  totalIssues += issues + syntaxErrors;
  results.push({ gate: 1, name: 'Syntax & Lint', passed: issues + syntaxErrors === 0 });
}

// ─── Gate 2: Security Scan ───────────────────────────────────────────────────

function gate2() {
  gateHeader(2, 'Security Scan');
  let issues = 0;

  // Check .gitignore has .env
  const gitignore = fs.existsSync(path.join(ROOT, '.gitignore'))
    ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';
  if (gitignore.includes('.env')) {
    pass('.env is in .gitignore');
  } else {
    fail('.env is NOT in .gitignore — credentials at risk!');
    issues++;
  }

  // Check for hardcoded credentials in source files
  const credPatterns = [
    { pattern: /sk-ant-api\w{10,}/g, name: 'Anthropic API key' },
    { pattern: /sk-[a-zA-Z0-9]{20,}/g, name: 'API secret key' },
    { pattern: /password\s*[:=]\s*['"][^'"]{6,}['"]/gi, name: 'hardcoded password' },
    { pattern: /(?:api[_-]?key|apikey|secret)\s*[:=]\s*['"][a-zA-Z0-9_-]{15,}['"]/gi, name: 'hardcoded API key' },
  ];

  const files = getJSFiles();
  let credLeaks = 0;
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const relPath = path.relative(ROOT, file);
    for (const { pattern, name } of credPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        fail(`${relPath}: possible ${name} found (${matches.length} match${matches.length > 1 ? 'es' : ''})`);
        credLeaks++;
      }
    }
  }
  if (credLeaks === 0) pass('No hardcoded credentials in source files');

  // Check for exec() with template literals (command injection)
  let injectionRisks = 0;
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const relPath = path.relative(ROOT, file);
    const execMatches = content.match(/exec\s*\(\s*`[^`]*\$\{/g);
    if (execMatches) {
      fail(`${relPath}: exec() with template literal — command injection risk (${execMatches.length})`);
      injectionRisks++;
    }
    // Check for shell: true in spawn (skip QA script's own detection patterns)
    if (relPath !== 'qa_check.cjs') {
      const shellMatches = content.match(/shell\s*:\s*true/g);
      if (shellMatches) {
        warn(`${relPath}: spawn with shell:true (${shellMatches.length})`);
      }
    }
  }
  if (injectionRisks === 0) pass('No command injection patterns (exec with template literals)');

  // Check staged files don't include .env or credentials
  if (STAGED_ONLY || true) {
    const staged = run('git diff --cached --name-only');
    const dangerousFiles = ['.env', 'credentials', '.key', '.pem', '.secret'];
    for (const danger of dangerousFiles) {
      if (staged.includes(danger)) {
        fail(`STAGED: ${danger} is about to be committed!`);
        issues++;
      }
    }
    if (!dangerousFiles.some(d => staged.includes(d))) {
      pass('No credential files staged for commit');
    }
  }

  // npm audit (quick check)
  const auditOutput = run('npm audit --json');
  try {
    const audit = JSON.parse(auditOutput);
    const vulns = audit.metadata?.vulnerabilities || {};
    const critical = vulns.critical || 0;
    const high = vulns.high || 0;
    if (critical > 0) {
      warn(`npm audit: ${critical} critical vulnerabilities (run: npm audit fix)`);
    } else if (high > 0) {
      warn(`npm audit: ${high} high vulnerabilities`);
    } else {
      pass('npm audit: no critical/high vulnerabilities');
    }
  } catch {
    warn('npm audit: could not parse results');
  }

  totalIssues += issues + credLeaks + injectionRisks;
  results.push({ gate: 2, name: 'Security Scan', passed: issues + credLeaks + injectionRisks === 0 });
}

// ─── Gate 3: Functional Check ────────────────────────────────────────────────

function gate3() {
  gateHeader(3, 'Functional Check');
  let issues = 0;

  // Key scripts that must parse without errors
  const criticalScripts = [
    'index.js',
    'dashboard.js',
    'scraper.js',
    'database.js',
    'ats_api_discovery.cjs',
    'playwright_selector_discovery.cjs',
    'setup_neon.cjs',
    'export_neon.cjs',
    'qa_check.cjs',
  ];

  for (const script of criticalScripts) {
    const fullPath = path.join(ROOT, script);
    if (!fs.existsSync(fullPath)) {
      warn(`${script}: file not found (may have been renamed)`);
      continue;
    }
    const result = run(`node --check "${fullPath}" 2>&1`);
    if (result.includes('SyntaxError') || result.includes('Error')) {
      fail(`${script}: fails to parse`);
      console.log(`    ${result.split('\n')[0]}`);
      issues++;
    } else {
      pass(`${script}: parses OK`);
    }
  }

  // Check required dependencies are installed
  const requiredDeps = ['pg', 'express', 'dotenv', 'csv-parse', 'csv-stringify', '@anthropic-ai/sdk'];
  for (const dep of requiredDeps) {
    try {
      require.resolve(dep);
      pass(`${dep}: installed`);
    } catch {
      fail(`${dep}: NOT installed`);
      issues++;
    }
  }

  totalIssues += issues;
  results.push({ gate: 3, name: 'Functional Check', passed: issues === 0 });
}

// ─── Gate 4: Regression Check ────────────────────────────────────────────────

function gate4() {
  gateHeader(4, 'Regression Check');
  let issues = 0;

  // Critical files must exist
  const requiredFiles = [
    'index.js',
    'dashboard.js',
    'scraper.js',
    'database.js',
    'package.json',
    '.env',
    '.gitignore',
    'data/companies-weekly.csv',
    'start-career-future.vbs',
  ];

  for (const file of requiredFiles) {
    if (fs.existsSync(path.join(ROOT, file))) {
      pass(`${file}: exists`);
    } else {
      fail(`${file}: MISSING`);
      issues++;
    }
  }

  // Check that key patterns still exist in critical files (catch accidental deletions)
  const regressionChecks = [
    { file: 'dashboard.js', pattern: 'express', desc: 'Express import' },
    { file: 'dashboard.js', pattern: 'execFile', desc: 'safe execFile (not exec)' },
    { file: 'dashboard.js', pattern: '127.0.0.1', desc: 'localhost-only binding' },
    { file: 'database.js', pattern: 'class JobDatabase', desc: 'JobDatabase class' },
    { file: 'index.js', pattern: 'schedule', desc: 'scheduler logic' },
  ];

  for (const check of regressionChecks) {
    const fullPath = path.join(ROOT, check.file);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf8');
    if (content.includes(check.pattern)) {
      pass(`${check.file}: has ${check.desc}`);
    } else {
      fail(`${check.file}: missing ${check.desc} — possible regression`);
      issues++;
    }
  }

  totalIssues += issues;
  results.push({ gate: 4, name: 'Regression Check', passed: issues === 0 });
}

// ─── Gate 5: Cost Guard ──────────────────────────────────────────────────────

function gate5() {
  gateHeader(5, 'Cost Guard');
  let issues = 0;

  // Check for new paid API calls in staged/changed files
  const paidPatterns = [
    { pattern: /anthropic|claude\.messages\.create|ANTHROPIC_API_KEY/gi, name: 'Anthropic/Claude API', costNote: '$3-15/MTok' },
    { pattern: /oxylabsFetch|realtime\.oxylabs\.io/gi, name: 'Oxylabs API', costNote: 'paid per request' },
    { pattern: /firecrawl|FIRECRAWL_API_KEY/gi, name: 'Firecrawl API', costNote: 'credit-based' },
    { pattern: /serper|SERPER_API_KEY/gi, name: 'Serper API', costNote: 'credit-based' },
    { pattern: /apify|APIFY_API_TOKEN/gi, name: 'Apify API', costNote: 'credit-based' },
  ];

  // If --staged, only check staged diffs
  const diffOutput = STAGED_ONLY
    ? run('git diff --cached --unified=0')
    : run('git diff HEAD --unified=0');

  const addedLines = diffOutput.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));

  if (addedLines.length === 0) {
    pass('No new/changed code to check');
  } else {
    const addedText = addedLines.join('\n');
    let foundPaid = false;

    for (const { pattern, name, costNote } of paidPatterns) {
      const matches = addedText.match(pattern);
      if (matches) {
        warn(`New code references ${name} (${costNote}) — ${matches.length} occurrence(s)`);
        foundPaid = true;
      }
    }

    if (!foundPaid) {
      pass('No new paid API calls in changed code');
    }
  }

  // Check for accidentally expensive patterns
  const files = getJSFiles();
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    const relPath = path.relative(ROOT, file);

    // Flag files that call Claude API inside a loop (skip QA script itself)
    if (relPath === 'qa_check.cjs') continue;
    if (content.includes('claude.messages.create') && (content.includes('for (') || content.includes('while ('))) {
      warn(`${relPath}: calls Claude API inside a loop — verify cost`);
    }
  }

  totalIssues += issues;
  results.push({ gate: 5, name: 'Cost Guard', passed: issues === 0 });
}

// ─── Main ────────────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║              QA CHECK — Pre-Commit Gates                ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log(`  Mode: ${STAGED_ONLY ? 'staged files only' : 'full project'} ${FIX_MODE ? '(auto-fix)' : ''}`);

const gates = [gate1, gate2, gate3, gate4, gate5];

if (SPECIFIC_GATE >= 1 && SPECIFIC_GATE <= gates.length) {
  gates[SPECIFIC_GATE - 1]();
} else {
  gates.forEach(g => g());
}

// Summary
console.log(`\n${'═'.repeat(60)}`);
console.log('  SUMMARY');
console.log('═'.repeat(60));

for (const r of results) {
  const icon = r.passed ? '✓' : '✗';
  console.log(`  ${icon} Gate ${r.gate}: ${r.name}`);
}

console.log(`\n  Issues: ${totalIssues}  |  Warnings: ${totalWarnings}`);

if (totalIssues > 0) {
  console.log('\n  RESULT: FAILED — fix issues before committing\n');
  process.exit(1);
} else if (totalWarnings > 0) {
  console.log('\n  RESULT: PASSED with warnings\n');
  process.exit(0);
} else {
  console.log('\n  RESULT: ALL CLEAR\n');
  process.exit(0);
}
