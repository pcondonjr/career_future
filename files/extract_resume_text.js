/**
 * Extract plain text from DOCX resume file
 * Utility script to prepare resume for Anthropic analysis
 */

const fs = require('fs');
const path = require('path');

// Try to require docx parsing libraries
let extractText;

try {
  // Try mammoth first (better formatting preservation)
  const mammoth = require('mammoth');
  
  extractText = async (docxPath) => {
    const result = await mammoth.extractRawText({ path: docxPath });
    return result.value;
  };
  
  console.log('Using mammoth for text extraction');
} catch (err) {
  console.log('mammoth not available, trying alternative method');
  
  try {
    // Fallback to officegen-docx or similar
    // For now, provide manual instructions
    extractText = null;
  } catch (err2) {
    extractText = null;
  }
}

async function main() {
  const docxPath = process.argv[2] || './Patrick_Condon_Resume_Zenkraft.docx';
  const outputPath = process.argv[3] || './resume/Patrick_Condon_Resume.txt';
  
  console.log(`Extracting text from: ${docxPath}`);
  console.log(`Output to: ${outputPath}`);
  
  // Check if input file exists
  if (!fs.existsSync(docxPath)) {
    console.error(`Error: File not found: ${docxPath}`);
    console.log('\nUsage: node extract_resume_text.js <input.docx> <output.txt>');
    process.exit(1);
  }
  
  // Create output directory if needed
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  if (extractText) {
    try {
      const text = await extractText(docxPath);
      fs.writeFileSync(outputPath, text, 'utf-8');
      console.log('✅ Text extraction successful!');
      console.log(`📄 Extracted ${text.length} characters`);
      console.log(`📝 Saved to: ${outputPath}`);
    } catch (error) {
      console.error('Error extracting text:', error.message);
      showManualInstructions();
    }
  } else {
    console.log('\n⚠️  Automatic extraction not available.');
    showManualInstructions();
  }
}

function showManualInstructions() {
  console.log('\n📋 Manual Extraction Methods:\n');
  
  console.log('Method 1 - Using LibreOffice (command line):');
  console.log('  libreoffice --headless --convert-to txt Patrick_Condon_Resume_Zenkraft.docx --outdir resume/\n');
  
  console.log('Method 2 - Using Python with python-docx:');
  console.log('  pip install python-docx');
  console.log('  python -c "from docx import Document; doc = Document(\'Patrick_Condon_Resume_Zenkraft.docx\'); print(\'\\n\'.join([p.text for p in doc.paragraphs]))" > resume/Patrick_Condon_Resume.txt\n');
  
  console.log('Method 3 - Using Microsoft Word or Google Docs:');
  console.log('  1. Open the DOCX file');
  console.log('  2. Select All (Ctrl+A / Cmd+A)');
  console.log('  3. Copy (Ctrl+C / Cmd+C)');
  console.log('  4. Paste into a text editor');
  console.log('  5. Save as resume/Patrick_Condon_Resume.txt\n');
  
  console.log('Method 4 - Install mammoth for automatic extraction:');
  console.log('  npm install mammoth');
  console.log('  node extract_resume_text.js\n');
}

// If mammoth is available, you can also try installing it automatically
if (!extractText) {
  console.log('\n💡 Tip: Install mammoth for automatic extraction:');
  console.log('   npm install mammoth');
  console.log('   Then run this script again.\n');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
