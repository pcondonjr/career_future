import { addCompanyToCSV } from './sites-config.js';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise(resolve => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  console.log('🏢 Add New Company to Job Scraper\n');
  
  const company = {
    name: await question('Company name: '),
    url: await question('Careers page URL: '),
    selectors: {
      jobCard: await question('Job card selector (e.g., .job-listing): '),
      title: await question('Title selector (e.g., h3, .job-title): '),
      location: await question('Location selector (e.g., .location): '),
      link: await question('Link selector (e.g., a): ')
    },
    enabled: true,
    notes: await question('Notes (optional): ')
  };

  console.log('\n📝 Review your entry:');
  console.log(JSON.stringify(company, null, 2));
  
  const confirm = await question('\nAdd this company? (yes/no): ');
  
  if (confirm.toLowerCase() === 'yes' || confirm.toLowerCase() === 'y') {
    await addCompanyToCSV(company);
    console.log('✅ Company added successfully!');
  } else {
    console.log('❌ Cancelled');
  }
  
  rl.close();
}

main();
