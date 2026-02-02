/**
 * Test script for Resume Optimizer
 * Validates API integration and core functionality
 */

const ResumeOptimizer = require('./anthropic_resume_optimizer');
const fs = require('fs').promises;
const path = require('path');

// Sample job description for testing
const SAMPLE_JOB = {
  title: 'Senior Salesforce Administrator',
  company: 'TechCorp Solutions',
  description: `
We are seeking an experienced Senior Salesforce Administrator to join our growing team.

Key Responsibilities:
- Manage and optimize our Salesforce instance including Sales Cloud and Service Cloud
- Design and implement Flow automation to streamline business processes  
- Create and maintain dashboards and reports for leadership
- Collaborate with cross-functional teams to gather requirements
- Ensure data quality and security best practices
- Train end users and drive adoption

Required Qualifications:
- 5+ years of Salesforce administration experience
- Salesforce Advanced Administrator certification required
- Expert knowledge of Flow Builder and automation tools
- Experience with Experience Cloud (Community Cloud)
- Strong understanding of revenue operations and pipeline management
- Excellent communication and stakeholder management skills
- Bachelor's degree in related field

Preferred Qualifications:
- Additional Salesforce certifications (Business Analyst, Education Cloud)
- Experience with CPQ or similar quote-to-cash tools
- Project management certification (PMP or similar)
- Experience in higher education or nonprofit sectors

We offer competitive compensation, full benefits, and remote work options.
`
};

async function runTests() {
  console.log('🧪 Resume Optimizer Test Suite\n');
  console.log('='.repeat(60));
  
  // Check environment
  console.log('\n1️⃣ Checking Environment...');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY not found in environment');
    console.log('   Set it in your .env file or export it:');
    console.log('   export ANTHROPIC_API_KEY=sk-ant-api03-...');
    return false;
  }
  console.log('✅ API key found');
  
  // Check resume file
  console.log('\n2️⃣ Checking Resume File...');
  const resumePath = path.join(__dirname, 'resume', 'Patrick_Condon_Resume.txt');
  try {
    const resumeText = await fs.readFile(resumePath, 'utf-8');
    console.log(`✅ Resume loaded (${resumeText.length} characters)`);
  } catch (error) {
    console.error(`❌ Resume file not found: ${resumePath}`);
    console.log('   Run: node extract_resume_text.js');
    return false;
  }
  
  // Initialize optimizer
  console.log('\n3️⃣ Initializing Optimizer...');
  let optimizer;
  try {
    optimizer = new ResumeOptimizer();
    console.log('✅ Optimizer initialized');
  } catch (error) {
    console.error('❌ Failed to initialize:', error.message);
    return false;
  }
  
  // Test token estimation
  console.log('\n4️⃣ Testing Token Estimation...');
  const sampleText = 'Hello world! This is a test.';
  const tokens = optimizer.estimateTokens(sampleText);
  console.log(`✅ Estimated ${tokens} tokens for "${sampleText}"`);
  
  // Test cost calculation
  console.log('\n5️⃣ Testing Cost Calculation...');
  const cost = optimizer.calculateCost(5000, 2000);
  console.log(`✅ Cost for 5K input + 2K output: $${cost.toFixed(4)}`);
  
  // Test job analysis
  console.log('\n6️⃣ Testing Job Analysis...');
  console.log(`   Analyzing: ${SAMPLE_JOB.title} at ${SAMPLE_JOB.company}`);
  console.log('   This will take 3-5 seconds and cost ~$0.03-0.05...\n');
  
  try {
    const resumeText = await fs.readFile(resumePath, 'utf-8');
    const startTime = Date.now();
    
    const analysis = await optimizer.analyzeJobMatch(
      SAMPLE_JOB.description,
      resumeText
    );
    
    const duration = Date.now() - startTime;
    
    console.log('\n📊 Analysis Results:');
    console.log('─'.repeat(60));
    console.log(`   Compatibility Score: ${analysis.compatibilityScore}%`);
    console.log(`   Processing Time: ${duration}ms`);
    console.log(`   Key Requirements: ${analysis.keyRequirements?.length || 0} identified`);
    console.log(`   Matching Strengths: ${analysis.matchingStrengths?.length || 0} found`);
    console.log(`   Gaps: ${analysis.gaps?.length || 0} identified`);
    console.log(`   Priority Adjustments: ${analysis.priorityAdjustments?.length || 0} recommended`);
    
    // Display key findings
    if (analysis.compatibilityScore >= 70) {
      console.log('\n✅ STRONG MATCH - Recommend applying!');
    } else if (analysis.compatibilityScore >= 50) {
      console.log('\n⚠️  MODERATE MATCH - Consider carefully');
    } else {
      console.log('\n❌ WEAK MATCH - May not be priority');
    }
    
    // Sample of recommendations
    if (analysis.keyRequirements && analysis.keyRequirements.length > 0) {
      console.log('\n🎯 Top Requirements:');
      analysis.keyRequirements.slice(0, 3).forEach((req, i) => {
        console.log(`   ${i + 1}. ${req}`);
      });
    }
    
    if (analysis.priorityAdjustments && analysis.priorityAdjustments.length > 0) {
      console.log('\n🚀 Top Recommendations:');
      analysis.priorityAdjustments.slice(0, 3).forEach((adj, i) => {
        console.log(`   ${i + 1}. ${adj}`);
      });
    }
    
    console.log('\n✅ Job analysis test passed!');
    
  } catch (error) {
    console.error('\n❌ Analysis failed:', error.message);
    if (error.status === 401) {
      console.log('   Check your API key is valid');
    } else if (error.status === 429) {
      console.log('   Rate limit reached - wait a moment and try again');
    }
    return false;
  }
  
  // Test cover letter generation (optional - costs extra)
  const testCoverLetter = process.argv.includes('--cover-letter');
  
  if (testCoverLetter) {
    console.log('\n7️⃣ Testing Cover Letter Generation...');
    console.log('   This will take 10-15 seconds and cost ~$0.02-0.04...\n');
    
    try {
      const resumeText = await fs.readFile(resumePath, 'utf-8');
      const startTime = Date.now();
      
      const coverLetter = await optimizer.generateCoverLetter(
        SAMPLE_JOB.description,
        resumeText,
        {
          companyName: SAMPLE_JOB.company,
          roleTitle: SAMPLE_JOB.title
        }
      );
      
      const duration = Date.now() - startTime;
      const wordCount = coverLetter.split(/\s+/).length;
      
      console.log(`✅ Cover letter generated!`);
      console.log(`   Processing Time: ${duration}ms`);
      console.log(`   Word Count: ${wordCount}`);
      console.log('\n   Preview:');
      console.log('   ' + '─'.repeat(58));
      console.log(coverLetter.split('\n').slice(0, 5).map(line => '   ' + line).join('\n'));
      console.log('   ...');
      console.log('   ' + '─'.repeat(58));
      
    } catch (error) {
      console.error('\n❌ Cover letter generation failed:', error.message);
      return false;
    }
  } else {
    console.log('\n7️⃣ Skipping Cover Letter Test (optional)');
    console.log('   Run with --cover-letter flag to test:');
    console.log('   node test_resume_optimizer.js --cover-letter');
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('✅ All tests passed!\n');
  console.log('📦 Integration ready. Next steps:');
  console.log('   1. Add API routes to your server');
  console.log('   2. Include frontend JS and CSS');
  console.log('   3. Add buttons to job cards');
  console.log('   4. Test in your dashboard');
  console.log('\n📚 See INTEGRATION_GUIDE.md for detailed instructions');
  
  return true;
}

// Run tests
if (require.main === module) {
  runTests()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

module.exports = { runTests };
