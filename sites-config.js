import fs from 'fs/promises';
import { parse } from 'csv-parse/sync';

// Keywords to filter for relevant positions
export const KEYWORDS = [
  'salesforce'
];

// Location preferences
export const LOCATIONS = [
  'remote',
  'greenville',
  'south carolina',
  'sc',
  'charlotte',
  'atlanta',
  'hybrid'
];

/**
 * Load job sites from CSV file
 * @param {string} csvPath - Path to the CSV file
 * @param {boolean} onlyEnabled - Only return sites where enabled=true
 * @returns {Promise<Array>} Array of site configurations
 */
export async function loadSitesFromCSV(csvPath = './companies.csv', onlyEnabled = true) {
  try {
    const fileContent = await fs.readFile(csvPath, 'utf-8');
    
    const records = parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      comment: '#'
    });

    const sites = records
      .filter(row => {
        // Filter by enabled status if requested
        if (onlyEnabled && row.enabled.toLowerCase() !== 'true') {
          return false;
        }
        
        // Skip rows with empty required fields
        if (!row.company_name || !row.careers_url) {
          console.warn(`Skipping row with missing company_name or careers_url`);
          return false;
        }
        
        return true;
      })
      .map(row => ({
        name: row.company_name,
        url: row.careers_url,
        selectors: {
          jobCard: row.job_card_selector,
          title: row.title_selector,
          location: row.location_selector,
          link: row.link_selector
        },
        enabled: row.enabled.toLowerCase() === 'true',
        skipKeywordFilter: row.skip_keyword_filter?.toLowerCase() === 'true',
        notes: row.notes || ''
      }));

    console.log(`Loaded ${sites.length} sites from ${csvPath}`);
    return sites;

  } catch (error) {
    console.error(`Error loading CSV file: ${error.message}`);
    throw error;
  }
}

/**
 * Add a new company to the CSV
 * @param {Object} company - Company configuration object
 */
export async function addCompanyToCSV(company, csvPath = './companies.csv') {
  const newRow = [
    company.name,
    company.url,
    company.selectors.jobCard,
    company.selectors.title,
    company.selectors.location,
    company.selectors.link,
    company.enabled !== false ? 'true' : 'false',
    company.notes || ''
  ].join(',');

  try {
    await fs.appendFile(csvPath, '\n' + newRow);
    console.log(`Added ${company.name} to ${csvPath}`);
  } catch (error) {
    console.error(`Error adding company to CSV: ${error.message}`);
    throw error;
  }
}

/**
 * Validate CSV format and required fields
 */
export async function validateCSV(csvPath = './companies.csv') {
  try {
    const fileContent = await fs.readFile(csvPath, 'utf-8');
    const records = parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
      comment: '#'
    });

    const errors = [];
    const warnings = [];

    records.forEach((row, index) => {
      const lineNum = index + 2; // +2 because of header row and 0-indexing

      // Check required fields
      if (!row.company_name) {
        errors.push(`Line ${lineNum}: Missing company_name`);
      }
      if (!row.careers_url) {
        errors.push(`Line ${lineNum}: Missing careers_url`);
      }
      if (!row.job_card_selector) {
        warnings.push(`Line ${lineNum}: Missing job_card_selector for ${row.company_name}`);
      }

      // Validate URL format
      if (row.careers_url && !row.careers_url.startsWith('http')) {
        errors.push(`Line ${lineNum}: Invalid URL for ${row.company_name}`);
      }

      // Validate enabled field
      if (row.enabled && !['true', 'false'].includes(row.enabled.toLowerCase())) {
        warnings.push(`Line ${lineNum}: Invalid enabled value for ${row.company_name} (should be 'true' or 'false')`);
      }
    });

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      totalRows: records.length
    };

  } catch (error) {
    return {
      valid: false,
      errors: [`Failed to parse CSV: ${error.message}`],
      warnings: [],
      totalRows: 0
    };
  }
}
