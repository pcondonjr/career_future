import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';

const follows = parse(readFileSync('data/linkedin-follows.csv', 'utf-8'), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
const weekly = parse(readFileSync('data/companies-weekly.csv', 'utf-8'), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
const daily = parse(readFileSync('data/companies.csv', 'utf-8'), { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });

const weeklySet = new Set(weekly.map(r => r.company_name.toLowerCase().trim()));
const dailySet = new Set(daily.map(r => r.company_name.toLowerCase().trim()));
const allExisting = new Set([...weeklySet, ...dailySet]);

const followNames = follows.map(r => r.Organization.trim());
const notInAny = followNames.filter(f => !allExisting.has(f.toLowerCase()));
const inWeekly = followNames.filter(f => weeklySet.has(f.toLowerCase()));
const inDaily = followNames.filter(f => dailySet.has(f.toLowerCase()) && !weeklySet.has(f.toLowerCase()));

// Filter out non-employer entries (AI tools, newsletters, communities, learning platforms, etc)
const skipPatterns = /chatgpt|claude|openai|microsoft copilot|microsoft developer|microsoft 365|grok conference|ai central|neuron.*ai|playwright|slack|nebula logger|naukri|shine\.com|xelplus|the crm success|get force certified|ayan insights|feedcoyote|the nonprofit hive|the referral bench|upstate upstarts|user stories|confidential careers|paw journey|remote climate|early exit club|flight levels academy/i;
const employers = notInAny.filter(f => !skipPatterns.test(f));

console.log(`Total follows: ${followNames.length}`);
console.log(`Already in weekly: ${inWeekly.length}`);
console.log(`In daily only: ${inDaily.length}`);
console.log(`Not in any list: ${notInAny.length}`);
console.log(`After filtering non-employers: ${employers.length}`);
console.log('---');
employers.forEach(c => console.log(c));
