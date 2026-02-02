/**
 * Anthropic Resume Optimizer
 * Analyzes job descriptions and generates tailored resume recommendations
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs/promises';
import path from 'path';

class ResumeOptimizer {
  constructor(apiKey) {
    this.client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY
    });
  }

  /**
   * Analyze job description against resume
   * @param {string} jobDescription - The job posting text
   * @param {string} resumeText - Current resume content
   * @returns {Object} Analysis results with compatibility score and recommendations
   */
  async analyzeJobMatch(jobDescription, resumeText) {
    const prompt = `You are a resume optimization expert helping a Salesforce professional tailor their resume for specific job opportunities.

CURRENT RESUME:
${resumeText}

JOB DESCRIPTION:
${jobDescription}

Please analyze this job posting and provide:

1. COMPATIBILITY SCORE (0-100%): Overall match between candidate's experience and job requirements

2. KEY REQUIREMENTS: Extract the 5-7 most important qualifications, skills, or experiences mentioned

3. MATCHING STRENGTHS: Which parts of the resume align well with the job requirements

4. GAPS TO ADDRESS: What's missing or could be emphasized more

5. RESUME OPTIMIZATION RECOMMENDATIONS:
   - Specific bullet points to add or modify
   - Skills/certifications to emphasize
   - Keywords to incorporate for ATS optimization
   - Experience to reframe or highlight

6. PRIORITY ADJUSTMENTS: Top 3-5 concrete changes to make for maximum impact

Format your response as valid JSON with this structure:
{
  "compatibilityScore": 85,
  "keyRequirements": ["requirement 1", "requirement 2", ...],
  "matchingStrengths": ["strength 1", "strength 2", ...],
  "gaps": ["gap 1", "gap 2", ...],
  "recommendations": {
    "bulletPoints": ["new/modified bullet 1", ...],
    "skillsToEmphasize": ["skill 1", "skill 2", ...],
    "keywords": ["keyword 1", "keyword 2", ...],
    "experienceReframing": ["reframing suggestion 1", ...]
  },
  "priorityAdjustments": ["adjustment 1", "adjustment 2", ...]
}`;

    try {
      const message = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: prompt
        }]
      });

      // Extract JSON from response
      const responseText = message.content[0].text;
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      } else {
        // Fallback parsing if JSON isn't cleanly formatted
        return {
          compatibilityScore: 0,
          rawAnalysis: responseText
        };
      }
    } catch (error) {
      console.error('Error analyzing job match:', error);
      throw error;
    }
  }

  /**
   * Generate tailored cover letter
   * @param {string} jobDescription - The job posting text
   * @param {string} resumeText - Current resume content
   * @param {Object} companyInfo - Company name, role title, etc.
   * @returns {string} Generated cover letter
   */
  async generateCoverLetter(jobDescription, resumeText, companyInfo) {
    const { companyName, roleTitle, hiringManager } = companyInfo;
    
    const prompt = `You are helping a Salesforce professional craft a compelling cover letter.

RESUME:
${resumeText}

JOB DESCRIPTION:
${jobDescription}

COMPANY: ${companyName}
ROLE: ${roleTitle}
${hiringManager ? `HIRING MANAGER: ${hiringManager}` : ''}

Write a professional cover letter that:
1. Opens with genuine enthusiasm for the specific role and company
2. Highlights 2-3 most relevant accomplishments that match job requirements
3. Demonstrates understanding of the company's needs
4. Shows personality while maintaining professionalism
5. Closes with a strong call to action
6. Keeps length to 3-4 paragraphs, around 300-350 words

Use specific metrics and achievements from the resume where relevant. Make it compelling and ATS-friendly.`;

    try {
      const message = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: prompt
        }]
      });

      return message.content[0].text;
    } catch (error) {
      console.error('Error generating cover letter:', error);
      throw error;
    }
  }

  /**
   * Generate optimized resume bullet points for specific sections
   * @param {string} jobDescription - The job posting text
   * @param {string} currentBullets - Current bullets for a specific role/section
   * @param {Object} context - Additional context about the section
   * @returns {Array} Optimized bullet points
   */
  async optimizeBulletPoints(jobDescription, currentBullets, context = {}) {
    const prompt = `You are optimizing resume bullet points for a Salesforce professional.

JOB REQUIREMENTS:
${jobDescription}

CURRENT BULLET POINTS:
${currentBullets}

${context.roleTitle ? `ROLE BEING DESCRIBED: ${context.roleTitle}` : ''}
${context.company ? `COMPANY: ${context.company}` : ''}

Rewrite these bullet points to:
1. Emphasize skills and experience that match the job requirements
2. Incorporate relevant keywords from the job description naturally
3. Quantify achievements with metrics where possible
4. Start with strong action verbs
5. Keep each bullet to 1-2 lines for readability
6. Maintain truthfulness - don't fabricate experience

Return ONLY the optimized bullet points as a JSON array of strings.
Example: ["Bullet point 1", "Bullet point 2", ...]`;

    try {
      const message = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: prompt
        }]
      });

      const responseText = message.content[0].text;
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      } else {
        // Return as array of lines if JSON parsing fails
        return responseText.split('\n').filter(line => line.trim());
      }
    } catch (error) {
      console.error('Error optimizing bullet points:', error);
      throw error;
    }
  }

  /**
   * Generate an optimized resume tailored for a specific job
   * @param {string} jobDescription - The job posting text
   * @param {string} resumeText - Current resume content
   * @param {Object} analysis - Previous analysis results (optional)
   * @returns {string} Optimized resume text
   */
  async generateOptimizedResume(jobDescription, resumeText, analysis = null) {
    const analysisContext = analysis ? `
PREVIOUS ANALYSIS:
- Compatibility Score: ${analysis.compatibilityScore}%
- Gaps Identified: ${analysis.gaps?.join(', ') || 'None'}
- Priority Adjustments: ${analysis.priorityAdjustments?.join(', ') || 'None'}
- Keywords to Add: ${analysis.recommendations?.keywords?.join(', ') || 'None'}
` : '';

    const prompt = `You are a professional resume writer helping a Salesforce professional optimize their resume for a specific job opportunity.

CURRENT RESUME:
${resumeText}

JOB DESCRIPTION:
${jobDescription}
${analysisContext}

Please rewrite and optimize the resume to better match this job opportunity. Follow these guidelines:

1. MAINTAIN TRUTHFULNESS - Do not fabricate experience, skills, or achievements. Only reframe and emphasize existing content.

2. STRUCTURE - Keep a clean, professional format with clear sections:
   - Contact info (keep as-is)
   - Professional Summary (tailored to this role)
   - Skills (reorganized to highlight relevant skills first)
   - Experience (bullet points rewritten to emphasize relevant achievements)
   - Certifications (relevant ones first)
   - Education

3. OPTIMIZATION TECHNIQUES:
   - Incorporate keywords from the job description naturally
   - Quantify achievements where possible
   - Use strong action verbs
   - Emphasize skills and experience that match job requirements
   - Reorder bullet points to lead with most relevant accomplishments

4. ATS OPTIMIZATION:
   - Use standard section headings
   - Include exact keyword matches from the job posting
   - Avoid tables, graphics, or complex formatting

5. LENGTH - Keep it concise (ideally 1-2 pages worth of content)

Return ONLY the optimized resume text, ready to be copied into a document. Do not include any commentary or explanations.`;

    try {
      const message = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: prompt
        }]
      });

      return message.content[0].text;
    } catch (error) {
      console.error('Error generating optimized resume:', error);
      throw error;
    }
  }

  /**
   * Calculate estimated API cost for analysis
   * @param {number} inputTokens - Estimated input tokens
   * @param {number} outputTokens - Estimated output tokens
   * @returns {number} Cost in dollars
   */
  calculateCost(inputTokens, outputTokens) {
    // Claude Sonnet 4 pricing (as of Feb 2025)
    const INPUT_COST_PER_1M = 3.00;  // $3 per million input tokens
    const OUTPUT_COST_PER_1M = 15.00; // $15 per million output tokens
    
    const inputCost = (inputTokens / 1_000_000) * INPUT_COST_PER_1M;
    const outputCost = (outputTokens / 1_000_000) * OUTPUT_COST_PER_1M;
    
    return inputCost + outputCost;
  }

  /**
   * Estimate token count (rough approximation: 1 token ≈ 4 characters)
   * @param {string} text - Text to estimate
   * @returns {number} Estimated token count
   */
  estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }
}

export default ResumeOptimizer;
