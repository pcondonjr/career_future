# Project Overview

career-future is a Salesforce job-search automation harness: discovering/scraping companies, triaging and match-scoring postings against Patrick's resume (Neon-backed pipeline), plus tailoring resumes and cover letters to specific job descriptions. See README.md, NEON-DASHBOARD.md, and JOB-MATCHING-HARNESS.md for architecture.

# Resume / DOCX Formatting

- Target exactly 2 pages, ATS-safe formatting, ~95%+ page fill. Compress from 3 pages rather than leaving a sparse partial page.
- Before making spacing edits to a DOCX resume, inspect its section/column structure first — balanced 2-column sections can silently absorb paragraph-spacing changes with no visible effect on page length. Diagnose what actually controls page length (column balance, font size, margins) before iterating on spacing tweaks.
