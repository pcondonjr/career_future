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

CRITICAL RULES:
- NEVER add skills, tools, technologies, or experience that are NOT already in the resume.
- NEVER fabricate or invent accomplishments, metrics, or capabilities.
- ONLY recommend reframing, reordering, or emphasizing content that ALREADY EXISTS in the resume.
- If the job requires something the candidate does not have, list it as a genuine gap — do NOT silently add it to recommendations.
- Keywords to emphasize must ONLY come from skills/experience already present in the resume that also appear in the job description.

CURRENT RESUME:
${resumeText}

JOB DESCRIPTION:
${jobDescription}

Please analyze this job posting and provide:

1. COMPATIBILITY SCORE (0-100%): Overall match between candidate's ACTUAL experience and job requirements. Be honest — do not inflate the score.

2. KEY REQUIREMENTS: Extract the 5-7 most important qualifications, skills, or experiences the job requires.

3. MATCHING STRENGTHS: Which parts of the resume ALREADY align well with the job requirements. Reference specific resume content.

4. GAPS TO ADDRESS: Requirements from the job description that are NOT reflected in the resume. Be specific about what is missing.

5. QUESTIONS TO EXPLORE: For each gap, suggest a question to ask the candidate — they may have relevant experience not captured in the current resume. For example: "The job requires Pardot experience. Have you worked with Pardot or any marketing automation tools that could be highlighted?"

6. RESUME OPTIMIZATION RECOMMENDATIONS:
   - Existing bullet points to reword or reorder to better match the job (reference the original bullet)
   - Skills already in the resume that should be moved higher or emphasized
   - Keywords that appear in BOTH the resume AND the job description (overlap only)
   - Ways to reframe existing experience to better align with the job's language

7. PRIORITY ADJUSTMENTS: Top 3-5 concrete changes using ONLY existing resume content

Format your response as valid JSON with this structure:
{
  "compatibilityScore": 85,
  "keyRequirements": ["requirement 1", "requirement 2", ...],
  "matchingStrengths": ["strength 1", "strength 2", ...],
  "gaps": ["gap 1", "gap 2", ...],
  "questionsToExplore": ["question about gap 1", "question about gap 2", ...],
  "recommendations": {
    "bulletPoints": ["reworded existing bullet 1", ...],
    "skillsToEmphasize": ["existing skill 1", "existing skill 2", ...],
    "keywords": ["overlapping keyword 1", "overlapping keyword 2", ...],
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

CRITICAL RULES:
- ONLY reference accomplishments, skills, tools, and experience that are EXPLICITLY stated in the resume below.
- NEVER add skills, certifications, or tools the candidate does not have.
- NEVER fabricate metrics, numbers, or achievements. If a specific metric is in the resume, you may use it. If not, describe the accomplishment without inventing numbers.
- If the job requires something not in the resume, do NOT mention it in the cover letter. Focus on what the candidate CAN offer.
- The cover letter should authentically represent this specific candidate, not a generic ideal candidate.

RESUME:
${resumeText}

JOB DESCRIPTION:
${jobDescription}

COMPANY: ${companyName}
ROLE: ${roleTitle}
${hiringManager ? `HIRING MANAGER: ${hiringManager}` : ''}

Write a professional cover letter that:
1. Opens with genuine enthusiasm for the specific role and company
2. Highlights 2-3 most relevant accomplishments FROM THE RESUME that match job requirements
3. Connects the candidate's actual experience to the company's needs
4. Shows personality while maintaining professionalism
5. Closes with a strong call to action
6. Keeps length to 3-4 paragraphs, around 300-350 words

Every claim in the cover letter must be traceable back to the resume. Do not embellish or add capabilities beyond what is documented.`;

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

Rewrite these bullet points to better align with the job requirements. Follow these rules strictly:
1. ONLY use information already present in the original bullet points — do not add skills, tools, or achievements that are not there
2. Reframe and reword to emphasize aspects that match the job requirements
3. Use metrics ONLY if they already exist in the original bullets — never invent numbers
4. Start with strong action verbs
5. Keep each bullet to 1-2 lines for readability
6. Do NOT add keywords from the job description unless the candidate's bullet already demonstrates that capability
7. The number of output bullets should match the number of input bullets

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

CRITICAL RULES — YOU MUST FOLLOW THESE:
- NEVER add skills, tools, technologies, certifications, or experience that are NOT in the original resume.
- NEVER fabricate or invent metrics, numbers, or accomplishments.
- NEVER insert keywords from the job description unless the resume already demonstrates that capability.
- You may REWORD, REORDER, and EMPHASIZE existing content to better align with the job — but you must not add new content.
- If a job requirement is not reflected in the resume, leave it out. Do not try to fill gaps with invented content.
- The output resume must be a truthful representation of this specific candidate.

CURRENT RESUME:
${resumeText}

JOB DESCRIPTION:
${jobDescription}
${analysisContext}

Please rewrite and optimize the resume to better match this job opportunity. Follow these guidelines:

1. STRUCTURE - Keep a clean, professional format with clear sections:
   - Contact info (keep as-is)
   - Professional Summary (tailored to this role using ONLY existing experience and skills)
   - Core Competencies (reorganized to list job-relevant skills FIRST, but only skills already present)
   - Experience (bullet points reworded to emphasize job-relevant aspects of existing achievements)
   - Certifications (reordered with most relevant to this job listed first)
   - Education (keep as-is)

2. OPTIMIZATION TECHNIQUES:
   - Reorder bullet points within each role to lead with the most relevant accomplishments
   - Reword bullets to use language that mirrors the job description WHERE the underlying experience supports it
   - Emphasize existing metrics and quantified results
   - Use strong action verbs
   - Move the most job-relevant roles and experiences higher when possible

3. ATS OPTIMIZATION:
   - Use standard section headings
   - Use keywords that overlap between the resume and job description (not job-only keywords)
   - Avoid tables, graphics, or complex formatting

4. LENGTH - Keep it concise (ideally 1-2 pages worth of content)

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
