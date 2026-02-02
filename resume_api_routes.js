/**
 * API Routes for Resume Optimization
 * Integrates with salesforce-job-scrapper dashboard
 */

import express from 'express';
import ResumeOptimizer from './anthropic_resume_optimizer.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Initialize optimizer (API key from environment)
const optimizer = new ResumeOptimizer();

// Store for caching resume text to avoid repeated file reads
let cachedResumeText = null;
let resumeLastModified = null;

/**
 * Load resume text from file with caching
 */
async function getResumeText() {
  const resumePath = path.join(__dirname, 'resume', 'Patrick_Condon_Resume.txt');
  
  try {
    const stats = await fs.stat(resumePath);
    const currentModified = stats.mtime.getTime();
    
    // Return cached version if file hasn't changed
    if (cachedResumeText && resumeLastModified === currentModified) {
      return cachedResumeText;
    }
    
    // Read and cache resume
    cachedResumeText = await fs.readFile(resumePath, 'utf-8');
    resumeLastModified = currentModified;
    return cachedResumeText;
  } catch (error) {
    console.error('Error reading resume:', error);
    throw new Error('Resume file not found. Please ensure resume is available at /resume/Patrick_Condon_Resume.txt');
  }
}

/**
 * POST /api/analyze-job
 * Analyze job description against resume
 * Body: { jobDescription, jobTitle, company }
 */
router.post('/analyze-job', async (req, res) => {
  try {
    const { jobDescription, jobTitle, company } = req.body;
    
    if (!jobDescription) {
      return res.status(400).json({ error: 'Job description is required' });
    }
    
    // Load resume
    const resumeText = await getResumeText();
    
    // Estimate cost before processing
    const estimatedInputTokens = optimizer.estimateTokens(jobDescription + resumeText);
    const estimatedOutputTokens = 3000; // Approximate for analysis response
    const estimatedCost = optimizer.calculateCost(estimatedInputTokens, estimatedOutputTokens);
    
    console.log(`Analyzing job: ${jobTitle || 'Unknown'} at ${company || 'Unknown'}`);
    console.log(`Estimated cost: $${estimatedCost.toFixed(4)}`);
    
    // Perform analysis
    const startTime = Date.now();
    const analysis = await optimizer.analyzeJobMatch(jobDescription, resumeText);
    const duration = Date.now() - startTime;
    
    console.log(`Analysis completed in ${duration}ms`);
    console.log(`Compatibility score: ${analysis.compatibilityScore}%`);
    
    res.json({
      success: true,
      analysis,
      metadata: {
        estimatedCost,
        processingTime: duration,
        jobTitle,
        company
      }
    });
    
  } catch (error) {
    console.error('Error in /analyze-job:', error);
    res.status(500).json({ 
      error: 'Failed to analyze job',
      message: error.message 
    });
  }
});

/**
 * POST /api/generate-cover-letter
 * Generate tailored cover letter
 * Body: { jobDescription, jobTitle, company, hiringManager }
 */
router.post('/generate-cover-letter', async (req, res) => {
  try {
    const { jobDescription, jobTitle, company, hiringManager } = req.body;
    
    if (!jobDescription || !company || !jobTitle) {
      return res.status(400).json({ 
        error: 'Job description, company, and job title are required' 
      });
    }
    
    // Load resume
    const resumeText = await getResumeText();
    
    // Generate cover letter
    const startTime = Date.now();
    const coverLetter = await optimizer.generateCoverLetter(
      jobDescription,
      resumeText,
      { companyName: company, roleTitle: jobTitle, hiringManager }
    );
    const duration = Date.now() - startTime;
    
    console.log(`Cover letter generated in ${duration}ms for ${company}`);
    
    res.json({
      success: true,
      coverLetter,
      metadata: {
        processingTime: duration,
        wordCount: coverLetter.split(/\s+/).length
      }
    });
    
  } catch (error) {
    console.error('Error in /generate-cover-letter:', error);
    res.status(500).json({ 
      error: 'Failed to generate cover letter',
      message: error.message 
    });
  }
});

/**
 * POST /api/optimize-bullets
 * Optimize specific bullet points for a job
 * Body: { jobDescription, currentBullets, roleTitle, company }
 */
router.post('/optimize-bullets', async (req, res) => {
  try {
    const { jobDescription, currentBullets, roleTitle, company } = req.body;
    
    if (!jobDescription || !currentBullets) {
      return res.status(400).json({ 
        error: 'Job description and current bullets are required' 
      });
    }
    
    // Optimize bullets
    const optimizedBullets = await optimizer.optimizeBulletPoints(
      jobDescription,
      currentBullets,
      { roleTitle, company }
    );
    
    res.json({
      success: true,
      optimizedBullets,
      originalCount: currentBullets.split('\n').filter(b => b.trim()).length,
      optimizedCount: optimizedBullets.length
    });
    
  } catch (error) {
    console.error('Error in /optimize-bullets:', error);
    res.status(500).json({ 
      error: 'Failed to optimize bullets',
      message: error.message 
    });
  }
});

/**
 * POST /api/batch-analyze
 * Analyze multiple jobs at once (for high-priority batch processing)
 * Body: { jobs: [{ jobDescription, jobTitle, company, url }] }
 */
router.post('/batch-analyze', async (req, res) => {
  try {
    const { jobs } = req.body;
    
    if (!jobs || !Array.isArray(jobs)) {
      return res.status(400).json({ error: 'Jobs array is required' });
    }
    
    // Limit batch size to prevent abuse
    if (jobs.length > 10) {
      return res.status(400).json({ 
        error: 'Maximum 10 jobs per batch request' 
      });
    }
    
    const resumeText = await getResumeText();
    const results = [];
    
    console.log(`Starting batch analysis of ${jobs.length} jobs`);
    
    for (const job of jobs) {
      try {
        const analysis = await optimizer.analyzeJobMatch(
          job.jobDescription,
          resumeText
        );
        
        results.push({
          jobTitle: job.jobTitle,
          company: job.company,
          url: job.url,
          compatibilityScore: analysis.compatibilityScore,
          keyRequirements: analysis.keyRequirements,
          analysis
        });
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        results.push({
          jobTitle: job.jobTitle,
          company: job.company,
          url: job.url,
          error: error.message
        });
      }
    }
    
    // Sort by compatibility score
    results.sort((a, b) => (b.compatibilityScore || 0) - (a.compatibilityScore || 0));
    
    console.log(`Batch analysis complete. Top score: ${results[0]?.compatibilityScore}%`);
    
    res.json({
      success: true,
      totalJobs: jobs.length,
      successfulAnalyses: results.filter(r => !r.error).length,
      results
    });
    
  } catch (error) {
    console.error('Error in /batch-analyze:', error);
    res.status(500).json({ 
      error: 'Failed to complete batch analysis',
      message: error.message 
    });
  }
});

/**
 * POST /api/generate-optimized-resume
 * Generate an optimized resume tailored for the job
 * Body: { jobDescription, jobTitle, company, analysis }
 */
router.post('/generate-optimized-resume', async (req, res) => {
  try {
    const { jobDescription, jobTitle, company, analysis } = req.body;

    if (!jobDescription) {
      return res.status(400).json({
        error: 'Job description is required'
      });
    }

    // Load resume
    const resumeText = await getResumeText();

    console.log(`Generating optimized resume for: ${jobTitle || 'Unknown'} at ${company || 'Unknown'}`);

    // Generate optimized resume
    const startTime = Date.now();
    const optimizedResume = await optimizer.generateOptimizedResume(
      jobDescription,
      resumeText,
      analysis
    );
    const duration = Date.now() - startTime;

    console.log(`Optimized resume generated in ${duration}ms`);

    res.json({
      success: true,
      optimizedResume,
      metadata: {
        processingTime: duration,
        jobTitle,
        company,
        originalLength: resumeText.length,
        optimizedLength: optimizedResume.length
      }
    });

  } catch (error) {
    console.error('Error in /generate-optimized-resume:', error);
    res.status(500).json({
      error: 'Failed to generate optimized resume',
      message: error.message
    });
  }
});

/**
 * GET /api/cost-estimate
 * Estimate cost for analyzing a job description
 * Query: ?descriptionLength=5000
 */
router.get('/cost-estimate', async (req, res) => {
  try {
    const descriptionLength = parseInt(req.query.descriptionLength) || 3000;
    const resumeText = await getResumeText();
    
    const estimatedInputTokens = optimizer.estimateTokens(
      'x'.repeat(descriptionLength) + resumeText
    );
    const estimatedOutputTokens = 3000;
    const estimatedCost = optimizer.calculateCost(estimatedInputTokens, estimatedOutputTokens);
    
    res.json({
      success: true,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCost,
      costBreakdown: {
        inputCost: optimizer.calculateCost(estimatedInputTokens, 0),
        outputCost: optimizer.calculateCost(0, estimatedOutputTokens)
      }
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
