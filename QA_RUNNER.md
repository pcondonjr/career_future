# QA Runner — Pre-Commit Quality Gates

Automated multi-gate quality checks that run before every git commit. Catches security vulnerabilities, token waste, regressions, and code quality issues.

## Quick Start

```bash
# Run all gates
node qa_check.cjs

# Or double-click
run-qa.bat

# Or in VS Code: Ctrl+Shift+P → "Run Task" → "QA Check - Project"
# Or keyboard shortcut: Ctrl+Shift+T (runs default test task)
```

## The 5 Gates

### Gate 1: Syntax & Lint
- Runs ESLint on all `.js` and `.cjs` files
- Runs `node --check` to verify every file parses without syntax errors
- Config: `eslint.config.js`

**Fails on:** ESLint errors, syntax errors
**Warns on:** ESLint warnings (unused vars, etc.)

### Gate 2: Security Scan
- Verifies `.env` is in `.gitignore`
- Scans all source files for hardcoded credentials (API keys, passwords)
- Detects `exec()` with template literals (command injection risk)
- Detects `shell: true` in spawn calls
- Checks staged files for `.env`, `.key`, `.pem`, `.secret`
- Runs `npm audit` for critical vulnerabilities

**Fails on:** Hardcoded credentials, command injection patterns, credential files staged
**Warns on:** `shell: true`, npm audit critical/high vulnerabilities

### Gate 3: Functional Check
- Verifies all critical scripts parse without errors:
  - `index.js`, `dashboard.js`, `scraper.js`, `database.js`
  - `ats_api_discovery.cjs`, `playwright_selector_discovery.cjs`
  - `setup_neon.cjs`, `export_neon.cjs`, `qa_check.cjs`
- Verifies required npm packages are installed:
  - `pg`, `express`, `dotenv`, `csv-parse`, `csv-stringify`, `@anthropic-ai/sdk`

**Fails on:** Script parse errors, missing dependencies

### Gate 4: Regression Check
- Verifies critical files exist (index.js, dashboard.js, .env, companies CSV, etc.)
- Pattern checks on key files:
  - `dashboard.js` must have: `execFile` (not `exec`), `127.0.0.1` (localhost binding), Express import
  - `database.js` must have: `JobDatabase` class
  - `index.js` must have: scheduler logic

**Fails on:** Missing critical files, missing key patterns (indicates accidental deletion/regression)

### Gate 5: Cost Guard
- Scans changed code for new references to paid APIs:
  - Anthropic/Claude ($3-15/MTok)
  - Oxylabs (paid per request)
  - Firecrawl (credit-based)
  - Serper (credit-based)
  - Apify (credit-based)
- Detects Claude API calls inside loops (expensive pattern)

**Warns on:** New paid API references, Claude-in-loop patterns

## Usage Options

### Command Line

```bash
# All gates
node qa_check.cjs

# Specific gate only
node qa_check.cjs --gate 1    # Lint only
node qa_check.cjs --gate 2    # Security only
node qa_check.cjs --gate 3    # Functional only
node qa_check.cjs --gate 4    # Regression only
node qa_check.cjs --gate 5    # Cost guard only

# Staged files only (what git commit will include)
node qa_check.cjs --staged

# Auto-fix lint issues
node qa_check.cjs --fix

# Combine flags
node qa_check.cjs --staged --fix
```

### Batch File (Windows)

```bash
run-qa.bat              # All gates
run-qa.bat --fix        # Auto-fix
run-qa.bat --staged     # Staged only
run-qa.bat --gate 2     # Specific gate
```

### VS Code Tasks

**Ctrl+Shift+P** → type "Run Task" → choose:
- **QA Check - Project** — all 5 gates (default test task)
- **QA Check - Staged Only** — pre-commit check
- **QA Check - Auto Fix** — fix lint issues
- **QA Check - Security Only** — gate 2
- **QA Check - Cost Guard Only** — gate 5

**Keyboard shortcut:** `Ctrl+Shift+T` runs the default test task (QA Check - Project)

### Git Pre-Commit Hook (Automatic)

The hook at `.git/hooks/pre-commit` runs `node qa_check.cjs --staged` automatically on every `git commit`. If any gate fails, the commit is blocked.

**Emergency bypass:** `git commit --no-verify`

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | All gates passed (may have warnings) |
| 1 | One or more gates failed — fix before committing |

## Adding to Other Projects

To use the QA runner in another project:

1. Copy these files to the project root:
   - `qa_check.cjs`
   - `eslint.config.js`
   - `run-qa.bat`

2. Edit the `criticalScripts` array in Gate 3 to match the project's key files

3. Edit the `requiredFiles` and `regressionChecks` arrays in Gate 4

4. Edit the `requiredDeps` array in Gate 3

5. Set up the git hook:
   ```bash
   # Create .git/hooks/pre-commit with:
   #!/bin/sh
   node qa_check.cjs --staged
   exit $?
   ```

6. Copy `.vscode/tasks.json` for VS Code integration

The global VS Code tasks at `%APPDATA%\Code\User\tasks.json` will automatically find `qa_check.cjs` in any workspace that has it.

## Credential Patterns Detected (Gate 2)

| Pattern | What it catches |
|---------|----------------|
| `sk-ant-api...` | Anthropic API keys |
| `sk-...` (20+ chars) | Generic API secret keys |
| `password = "..."` | Hardcoded passwords in source |
| `api_key = "..."` | Hardcoded API keys in source |
| `` exec(`...${var}...`) `` | Command injection via exec |
| `shell: true` | Shell injection via spawn |

## Cost Guard Patterns (Gate 5)

| API | Detected patterns | Typical cost |
|-----|-------------------|-------------|
| Anthropic/Claude | `anthropic`, `claude.messages.create`, `ANTHROPIC_API_KEY` | $3-15/MTok |
| Oxylabs | `oxylabsFetch`, `realtime.oxylabs.io` | Per request |
| Firecrawl | `firecrawl`, `FIRECRAWL_API_KEY` | Credits |
| Serper | `serper`, `SERPER_API_KEY` | Credits |
| Apify | `apify`, `APIFY_API_TOKEN` | Credits |
