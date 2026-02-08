/**
 * Frontend JavaScript for Resume Optimization Features
 * Add this to your dashboard's public/js folder
 */

class ResumeOptimizerUI {
  constructor() {
    this.currentAnalysis = null;
    this.initializeEventListeners();
  }

  initializeEventListeners() {
    // Listen for "Optimize Resume" button clicks on job cards
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-optimize-resume')) {
        e.preventDefault();
        const jobData = this.extractJobData(e.target);
        this.showOptimizationModal(jobData);
      }
    });

    // Listen for "Analyze External Job" button click
    document.addEventListener('click', (e) => {
      if (e.target.id === 'analyze-external-job-btn') {
        e.preventDefault();
        this.showExternalJobForm();
      }
    });

    // Close modal when clicking outside content
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal')) {
        e.target.classList.remove('active');
      }
    });

    // Close modal with Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const modal = document.getElementById('optimization-modal');
        if (modal) modal.classList.remove('active');
      }
    });
  }

  /**
   * Extract job data from button's parent element
   */
  extractJobData(button) {
    const jobCard = button.closest('.job-card') || button.closest('tr');

    return {
      title: jobCard.querySelector('.job-title')?.textContent?.trim() || '',
      company: jobCard.querySelector('.job-company')?.textContent?.trim() || '',
      location: jobCard.querySelector('.job-location')?.textContent?.trim() || '',
      description: jobCard.dataset.description || '',
      url: jobCard.dataset.url || '',
      source: jobCard.dataset.source || ''
    };
  }

  /**
   * Show optimization modal - first prompt for job description if not available
   */
  async showOptimizationModal(jobData) {
    // Create modal if it doesn't exist
    if (!document.getElementById('optimization-modal')) {
      this.createOptimizationModal();
    }

    const modal = document.getElementById('optimization-modal');
    const modalBody = modal.querySelector('.modal-body');

    modal.classList.add('active');
    modal.querySelector('.modal-title').textContent =
      `Optimize for: ${jobData.title}${jobData.company ? ' at ' + jobData.company : ''}`;

    // If no description, show input form first
    if (!jobData.description) {
      this.showDescriptionInputForm(jobData);
      return;
    }

    // Otherwise proceed with analysis
    this.runAnalysis(jobData);
  }

  /**
   * Show form to paste job description
   */
  showDescriptionInputForm(jobData) {
    const modal = document.getElementById('optimization-modal');
    const modalBody = modal.querySelector('.modal-body');

    modalBody.innerHTML = `
      <div class="description-input-form">
        <p style="margin-bottom: 15px;">
          <strong>Step 1:</strong> Auto-fetch the job description or paste it manually below.
        </p>
        <p style="margin-bottom: 15px; display: flex; gap: 10px; flex-wrap: wrap;">
          <button id="auto-fetch-btn" class="btn btn-primary" style="display: inline-flex; align-items: center; gap: 8px;">
            Auto-Fetch Description
          </button>
          <a href="${jobData.url}" target="_blank" class="btn btn-secondary" style="display: inline-flex; align-items: center; gap: 8px;">
            Open Job Posting
          </a>
        </p>
        <label for="job-description-input">
          <strong>Job Description:</strong>
        </label>
        <textarea
          id="job-description-input"
          rows="12"
          placeholder="Paste the full job description here...

Include:
- Job responsibilities
- Required qualifications
- Preferred qualifications
- Skills and certifications mentioned"
          style="width: 100%; font-family: inherit; font-size: 0.95rem; resize: vertical;"
        ></textarea>
        <div class="action-buttons" style="margin-top: 20px;">
          <button id="analyze-btn" class="btn btn-primary">
            Analyze Job Match
          </button>
          <button onclick="document.getElementById('optimization-modal').classList.remove('active')"
                  class="btn btn-secondary">
            Cancel
          </button>
        </div>
        <div class="metadata" style="margin-top: 15px;">
          <small>Analysis uses Claude AI and costs approximately $0.02-0.05 per request</small>
        </div>
      </div>
    `;

    // Add event listener for analyze button
    document.getElementById('analyze-btn').addEventListener('click', () => {
      const description = document.getElementById('job-description-input').value.trim();
      if (!description) {
        alert('Please paste the job description first.');
        return;
      }
      jobData.description = description;
      this.runAnalysis(jobData);
    });

    // Add event listener for auto-fetch button
    document.getElementById('auto-fetch-btn').addEventListener('click', async () => {
      const btn = document.getElementById('auto-fetch-btn');
      const textarea = document.getElementById('job-description-input');
      const fetchUrl = jobData.url;

      if (!fetchUrl || fetchUrl === '#') {
        alert('No URL available for this job.');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Fetching...';

      try {
        const res = await fetch('/api/fetch-job-description', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: fetchUrl })
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Fetch failed');
        }

        textarea.value = data.description;
        btn.textContent = 'Fetched!';
        setTimeout(() => { btn.textContent = 'Auto-Fetch Description'; btn.disabled = false; }, 2000);
      } catch (err) {
        alert('Failed to fetch: ' + err.message);
        btn.textContent = 'Auto-Fetch Description';
        btn.disabled = false;
      }
    });
  }

  /**
   * Show form for analyzing external job postings
   */
  showExternalJobForm() {
    // Create modal if it doesn't exist
    if (!document.getElementById('optimization-modal')) {
      this.createOptimizationModal();
    }

    const modal = document.getElementById('optimization-modal');
    const modalBody = modal.querySelector('.modal-body');

    modal.classList.add('active');
    modal.querySelector('.modal-title').textContent = 'Analyze External Job Posting';

    modalBody.innerHTML = `
      <div class="description-input-form">
        <p style="margin-bottom: 20px;">
          Enter job details from any job posting to analyze compatibility with your resume.
        </p>

        <div style="display: grid; gap: 15px;">
          <div>
            <label for="external-job-title"><strong>Job Title:</strong></label>
            <input
              type="text"
              id="external-job-title"
              placeholder="e.g., Salesforce Administrator"
              style="width: 100%;"
            />
          </div>

          <div>
            <label for="external-company"><strong>Company:</strong></label>
            <input
              type="text"
              id="external-company"
              placeholder="e.g., Acme Corporation"
              style="width: 100%;"
            />
          </div>

          <div>
            <label for="external-job-url"><strong>Job URL (optional):</strong></label>
            <input
              type="url"
              id="external-job-url"
              placeholder="https://..."
              style="width: 100%;"
            />
          </div>

          <div>
            <button id="auto-fetch-external-btn" class="btn btn-secondary" type="button">
              Auto-Fetch Description from URL
            </button>
          </div>

          <div>
            <label for="external-job-description"><strong>Job Description:</strong></label>
            <textarea
              id="external-job-description"
              rows="12"
              placeholder="Paste the full job description here...

Include:
- Job responsibilities
- Required qualifications
- Preferred qualifications
- Skills and certifications mentioned"
              style="width: 100%; font-family: inherit; font-size: 0.95rem; resize: vertical;"
            ></textarea>
          </div>
        </div>

        <div class="action-buttons" style="margin-top: 20px;">
          <button id="analyze-external-btn" class="btn btn-primary">
            Analyze Job Match
          </button>
          <button onclick="document.getElementById('optimization-modal').classList.remove('active')"
                  class="btn btn-secondary">
            Cancel
          </button>
        </div>

        <div class="metadata" style="margin-top: 15px;">
          <small>Analysis uses Claude AI and costs approximately $0.02-0.05 per request</small>
        </div>
      </div>
    `;

    // Add event listener for analyze button
    document.getElementById('analyze-external-btn').addEventListener('click', () => {
      const title = document.getElementById('external-job-title').value.trim();
      const company = document.getElementById('external-company').value.trim();
      const url = document.getElementById('external-job-url').value.trim();
      const description = document.getElementById('external-job-description').value.trim();

      if (!title) {
        alert('Please enter the job title.');
        return;
      }
      if (!description) {
        alert('Please paste the job description.');
        return;
      }

      const jobData = {
        title: title,
        company: company,
        url: url || '#',
        description: description,
        location: '',
        source: 'external'
      };

      modal.querySelector('.modal-title').textContent = `Optimize for: ${title}${company ? ' at ' + company : ''}`;
      this.runAnalysis(jobData);
    });

    // Add event listener for auto-fetch button
    document.getElementById('auto-fetch-external-btn').addEventListener('click', async () => {
      const btn = document.getElementById('auto-fetch-external-btn');
      const urlInput = document.getElementById('external-job-url').value.trim();
      const textarea = document.getElementById('external-job-description');

      if (!urlInput) {
        alert('Please enter a Job URL first.');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Fetching...';

      try {
        const res = await fetch('/api/fetch-job-description', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: urlInput })
        });
        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Fetch failed');
        }

        textarea.value = data.description;
        btn.textContent = 'Fetched!';
        setTimeout(() => { btn.textContent = 'Auto-Fetch Description from URL'; btn.disabled = false; }, 2000);
      } catch (err) {
        alert('Failed to fetch: ' + err.message);
        btn.textContent = 'Auto-Fetch Description from URL';
        btn.disabled = false;
      }
    });
  }

  /**
   * Run the actual analysis API call
   */
  async runAnalysis(jobData) {
    const modal = document.getElementById('optimization-modal');
    const modalBody = modal.querySelector('.modal-body');

    // Show loading state
    modalBody.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p>Analyzing job match...</p>
        <small>This typically takes 5-10 seconds</small>
      </div>
    `;

    try {
      // Call API to analyze job
      const response = await fetch('/api/analyze-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobDescription: jobData.description,
          jobTitle: jobData.title,
          company: jobData.company
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Analysis failed');
      }

      this.currentAnalysis = { ...result, jobData };
      this.displayAnalysisResults(result.analysis, result.metadata);

    } catch (error) {
      console.error('Analysis error:', error);
      modalBody.innerHTML = `
        <div class="error-state">
          <p>Failed to analyze job</p>
          <p style="color: #657786; font-size: 0.9rem;">${error.message}</p>
          <div class="action-buttons" style="justify-content: center;">
            <button onclick="resumeOptimizerUI.showDescriptionInputForm(resumeOptimizerUI.currentAnalysis?.jobData || {})"
                    class="btn btn-secondary">Try Again</button>
            <button onclick="document.getElementById('optimization-modal').classList.remove('active')"
                    class="btn btn-secondary">Close</button>
          </div>
        </div>
      `;
    }
  }

  /**
   * Display analysis results in modal
   */
  displayAnalysisResults(analysis, metadata) {
    const modal = document.getElementById('optimization-modal');
    const modalBody = modal.querySelector('.modal-body');

    const scoreClass = analysis.compatibilityScore >= 70 ? 'score-high' : 
                      analysis.compatibilityScore >= 50 ? 'score-medium' : 'score-low';

    modalBody.innerHTML = `
      <div class="analysis-results">
        <!-- Compatibility Score -->
        <div class="score-section ${scoreClass}">
          <h3>Compatibility Score</h3>
          <div class="score-circle">
            <span class="score-value">${analysis.compatibilityScore}%</span>
          </div>
          <p class="score-label">${this.getScoreLabel(analysis.compatibilityScore)}</p>
        </div>

        <!-- Key Requirements -->
        <div class="requirements-section">
          <h4>🎯 Key Requirements</h4>
          <ul>
            ${analysis.keyRequirements.map(req => `<li>${req}</li>`).join('')}
          </ul>
        </div>

        <!-- Matching Strengths -->
        <div class="strengths-section">
          <h4>✅ Your Matching Strengths</h4>
          <ul>
            ${analysis.matchingStrengths.map(str => `<li>${str}</li>`).join('')}
          </ul>
        </div>

        <!-- Gaps to Address -->
        ${analysis.gaps && analysis.gaps.length > 0 ? `
          <div class="gaps-section">
            <h4>⚠️ Gaps to Address</h4>
            <ul>
              ${analysis.gaps.map(gap => `<li>${gap}</li>`).join('')}
            </ul>
          </div>
        ` : ''}

        <!-- Questions to Explore -->
        ${analysis.questionsToExplore && analysis.questionsToExplore.length > 0 ? `
          <div class="questions-section" style="background: #f0f7ff; border-left: 4px solid #3b82f6; padding: 15px; border-radius: 4px; margin: 15px 0;">
            <h4>❓ Questions to Explore</h4>
            <p style="font-size: 0.9rem; color: #555; margin-bottom: 10px;">You may have experience not captured in your resume. Consider these before generating an optimized resume:</p>
            <ul>
              ${analysis.questionsToExplore.map(q => `<li>${q}</li>`).join('')}
            </ul>
          </div>
        ` : ''}

        <!-- Priority Adjustments -->
        <div class="adjustments-section">
          <h4>🚀 Priority Adjustments</h4>
          <ol>
            ${analysis.priorityAdjustments.map(adj => `<li>${adj}</li>`).join('')}
          </ol>
        </div>

        <!-- Recommendations -->
        <div class="recommendations-section">
          <h4>💡 Detailed Recommendations</h4>
          
          ${analysis.recommendations.skillsToEmphasize?.length > 0 ? `
            <div class="rec-subsection">
              <strong>Skills to Emphasize:</strong>
              <div class="tags">
                ${analysis.recommendations.skillsToEmphasize.map(skill => 
                  `<span class="tag">${skill}</span>`
                ).join('')}
              </div>
            </div>
          ` : ''}

          ${analysis.recommendations.keywords?.length > 0 ? `
            <div class="rec-subsection">
              <strong>Keywords for ATS:</strong>
              <div class="tags">
                ${analysis.recommendations.keywords.map(kw => 
                  `<span class="tag tag-keyword">${kw}</span>`
                ).join('')}
              </div>
            </div>
          ` : ''}
        </div>

        <!-- Action Buttons -->
        <div class="action-buttons">
          <button id="generate-optimized-resume-btn" class="btn btn-primary">
            Generate Optimized Resume
          </button>
          <button id="generate-cover-letter-btn" class="btn btn-secondary">
            Generate Cover Letter
          </button>
          <button id="download-analysis" class="btn btn-secondary">
            Download Analysis
          </button>
          <button id="view-job-posting" class="btn btn-secondary">
            View Job Posting
          </button>
        </div>

        <!-- Metadata -->
        <div class="metadata">
          <small>
            Processing time: ${metadata.processingTime}ms |
            Estimated cost: $${metadata.estimatedCost.toFixed(4)}
          </small>
        </div>
      </div>
    `;

    // Add event listeners for action buttons
    document.getElementById('generate-optimized-resume-btn').addEventListener('click', () => {
      this.generateOptimizedResume(this.currentAnalysis.jobData, this.currentAnalysis.analysis);
    });

    document.getElementById('generate-cover-letter-btn').addEventListener('click', () => {
      this.generateCoverLetter(this.currentAnalysis.jobData);
    });

    document.getElementById('download-analysis').addEventListener('click', () => {
      this.downloadAnalysis();
    });

    document.getElementById('view-job-posting').addEventListener('click', () => {
      window.open(this.currentAnalysis.jobData.url, '_blank');
    });
  }

  /**
   * Generate cover letter for job
   */
  async generateCoverLetter(jobData) {
    const modal = document.getElementById('optimization-modal');

    if (!modal.classList.contains('active')) {
      modal.classList.add('active');
    }

    // Use description from current analysis if available
    if (!jobData.description && this.currentAnalysis?.jobData?.description) {
      jobData.description = this.currentAnalysis.jobData.description;
    }

    // If still no description, we need to get it
    if (!jobData.description) {
      modal.querySelector('.modal-title').textContent =
        `Cover Letter: ${jobData.title}${jobData.company ? ' at ' + jobData.company : ''}`;
      this.showDescriptionInputFormForCoverLetter(jobData);
      return;
    }

    this.runCoverLetterGeneration(jobData);
  }

  /**
   * Show form to paste job description for cover letter
   */
  showDescriptionInputFormForCoverLetter(jobData) {
    const modal = document.getElementById('optimization-modal');
    const modalBody = modal.querySelector('.modal-body');

    modalBody.innerHTML = `
      <div class="description-input-form">
        <p style="margin-bottom: 15px;">
          <strong>Step 1:</strong> Paste the job description to generate a tailored cover letter.
        </p>
        <p style="margin-bottom: 15px;">
          <a href="${jobData.url}" target="_blank" class="btn btn-secondary">
            Open Job Posting
          </a>
        </p>
        <label for="job-description-input">
          <strong>Job Description:</strong>
        </label>
        <textarea
          id="job-description-input"
          rows="12"
          placeholder="Paste the full job description here..."
          style="width: 100%; font-family: inherit; font-size: 0.95rem; resize: vertical;"
        ></textarea>
        <div class="action-buttons" style="margin-top: 20px;">
          <button id="generate-cl-btn" class="btn btn-primary">
            Generate Cover Letter
          </button>
          <button onclick="document.getElementById('optimization-modal').classList.remove('active')"
                  class="btn btn-secondary">
            Cancel
          </button>
        </div>
      </div>
    `;

    document.getElementById('generate-cl-btn').addEventListener('click', () => {
      const description = document.getElementById('job-description-input').value.trim();
      if (!description) {
        alert('Please paste the job description first.');
        return;
      }
      jobData.description = description;
      this.runCoverLetterGeneration(jobData);
    });
  }

  /**
   * Run the actual cover letter generation API call
   */
  async runCoverLetterGeneration(jobData) {
    const modal = document.getElementById('optimization-modal');
    const modalBody = modal.querySelector('.modal-body');

    modalBody.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p>Generating cover letter...</p>
        <small>This may take 10-15 seconds</small>
      </div>
    `;

    try {
      const response = await fetch('/api/generate-cover-letter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobDescription: jobData.description,
          jobTitle: jobData.title,
          company: jobData.company
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Generation failed');
      }

      this.displayCoverLetter(result.coverLetter, result.metadata, jobData);

    } catch (error) {
      console.error('Cover letter error:', error);
      modalBody.innerHTML = `
        <div class="error-state">
          <p>Failed to generate cover letter</p>
          <p style="color: #657786; font-size: 0.9rem;">${error.message}</p>
          <button onclick="document.getElementById('optimization-modal').classList.remove('active')"
                  class="btn btn-secondary">Close</button>
        </div>
      `;
    }
  }

  /**
   * Display generated cover letter
   */
  displayCoverLetter(coverLetter, metadata, jobData) {
    const modal = document.getElementById('optimization-modal');
    const modalBody = modal.querySelector('.modal-body');

    // Store cover letter for copy/download actions
    this.currentCoverLetter = { content: coverLetter, company: jobData.company };

    // Escape HTML entities for safe display
    const escapedCoverLetter = coverLetter
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    modalBody.innerHTML = `
      <div class="cover-letter-display">
        <h3>Generated Cover Letter</h3>

        <div class="cover-letter-content">
          <pre>${escapedCoverLetter}</pre>
        </div>

        <div class="action-buttons">
          <button id="copy-cover-letter" class="btn btn-primary">
            Copy to Clipboard
          </button>
          <button id="download-cover-letter" class="btn btn-secondary">
            Download as .txt
          </button>
          <button id="back-to-analysis-cl" class="btn btn-secondary">
            Back to Analysis
          </button>
          <button onclick="document.getElementById('optimization-modal').classList.remove('active')"
                  class="btn btn-secondary">
            Close
          </button>
        </div>

        <div class="metadata">
          <small>Word count: ${metadata.wordCount} | Processing time: ${metadata.processingTime}ms</small>
        </div>
      </div>
    `;

    // Add event listeners for copy and download
    document.getElementById('copy-cover-letter').addEventListener('click', () => {
      navigator.clipboard.writeText(this.currentCoverLetter.content)
        .then(() => {
          const btn = document.getElementById('copy-cover-letter');
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy to Clipboard'; }, 2000);
        })
        .catch(err => alert('Failed to copy: ' + err.message));
    });

    document.getElementById('download-cover-letter').addEventListener('click', () => {
      this.downloadCoverLetter(this.currentCoverLetter.content, this.currentCoverLetter.company);
    });

    document.getElementById('back-to-analysis-cl').addEventListener('click', () => {
      this.displayAnalysisResults(this.currentAnalysis.analysis, this.currentAnalysis.metadata);
      modal.querySelector('.modal-title').textContent =
        `Optimize for: ${this.currentAnalysis.jobData.title}${this.currentAnalysis.jobData.company ? ' at ' + this.currentAnalysis.jobData.company : ''}`;
    });
  }

  /**
   * Generate optimized resume for job
   */
  async generateOptimizedResume(jobData, analysis) {
    const modal = document.getElementById('optimization-modal');
    const modalBody = modal.querySelector('.modal-body');

    modal.querySelector('.modal-title').textContent =
      `Optimized Resume: ${jobData.title}${jobData.company ? ' at ' + jobData.company : ''}`;

    modalBody.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p>Generating optimized resume...</p>
        <small>This may take 15-20 seconds</small>
      </div>
    `;

    try {
      const response = await fetch('/api/generate-optimized-resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobDescription: jobData.description,
          jobTitle: jobData.title,
          company: jobData.company,
          analysis: analysis
        })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Generation failed');
      }

      this.displayOptimizedResume(result.optimizedResume, result.metadata, jobData);

    } catch (error) {
      console.error('Optimized resume error:', error);
      modalBody.innerHTML = `
        <div class="error-state">
          <p>Failed to generate optimized resume</p>
          <p style="color: #657786; font-size: 0.9rem;">${error.message}</p>
          <button onclick="document.getElementById('optimization-modal').classList.remove('active')"
                  class="btn btn-secondary">Close</button>
        </div>
      `;
    }
  }

  /**
   * Display generated optimized resume
   */
  displayOptimizedResume(optimizedResume, metadata, jobData) {
    const modal = document.getElementById('optimization-modal');
    const modalBody = modal.querySelector('.modal-body');

    // Store for copy/download actions
    this.currentOptimizedResume = { content: optimizedResume, company: jobData.company, title: jobData.title };

    // Escape HTML entities for safe display
    const escapedResume = optimizedResume
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    modalBody.innerHTML = `
      <div class="cover-letter-display">
        <h3>Optimized Resume for ${jobData.company}</h3>
        <p style="color: #657786; margin-bottom: 15px;">
          This resume has been tailored to match the job requirements. Review and adjust as needed before using.
        </p>

        <div class="cover-letter-content" style="max-height: 400px; overflow-y: auto;">
          <pre>${escapedResume}</pre>
        </div>

        <div class="action-buttons">
          <button id="copy-optimized-resume" class="btn btn-primary">
            Copy to Clipboard
          </button>
          <button id="download-optimized-resume" class="btn btn-secondary">
            Download as .txt
          </button>
          <button id="back-to-analysis" class="btn btn-secondary">
            Back to Analysis
          </button>
        </div>

        <div class="metadata">
          <small>Processing time: ${metadata.processingTime}ms | Original: ${metadata.originalLength} chars | Optimized: ${metadata.optimizedLength} chars</small>
        </div>
      </div>
    `;

    // Add event listeners
    document.getElementById('copy-optimized-resume').addEventListener('click', () => {
      navigator.clipboard.writeText(this.currentOptimizedResume.content)
        .then(() => {
          const btn = document.getElementById('copy-optimized-resume');
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy to Clipboard'; }, 2000);
        })
        .catch(err => alert('Failed to copy: ' + err.message));
    });

    document.getElementById('download-optimized-resume').addEventListener('click', () => {
      this.downloadOptimizedResume();
    });

    document.getElementById('back-to-analysis').addEventListener('click', () => {
      this.displayAnalysisResults(this.currentAnalysis.analysis, this.currentAnalysis.metadata);
      modal.querySelector('.modal-title').textContent =
        `Optimize for: ${this.currentAnalysis.jobData.title}${this.currentAnalysis.jobData.company ? ' at ' + this.currentAnalysis.jobData.company : ''}`;
    });
  }

  /**
   * Download optimized resume as text file
   */
  downloadOptimizedResume() {
    if (!this.currentOptimizedResume) return;

    const blob = new Blob([this.currentOptimizedResume.content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `optimized-resume-${this.currentOptimizedResume.company}-${Date.now()}.txt`;
    a.click();

    URL.revokeObjectURL(url);
  }

  /**
   * Create optimization modal structure
   */
  createOptimizationModal() {
    const modalHTML = `
      <div id="optimization-modal" class="modal">
        <div class="modal-content">
          <div class="modal-header">
            <h2 class="modal-title">Resume Optimization</h2>
            <button class="modal-close" onclick="document.getElementById('optimization-modal').classList.remove('active')">
              ×
            </button>
          </div>
          <div class="modal-body">
            <!-- Content dynamically inserted -->
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHTML);
  }

  /**
   * Get descriptive label for compatibility score
   */
  getScoreLabel(score) {
    if (score >= 85) return 'Excellent Match - Apply ASAP!';
    if (score >= 70) return 'Strong Match - Highly Recommended';
    if (score >= 55) return 'Good Match - Worth Applying';
    if (score >= 40) return 'Moderate Match - Consider Carefully';
    return 'Weak Match - May Not Be Priority';
  }

  /**
   * Download analysis as JSON
   */
  downloadAnalysis() {
    if (!this.currentAnalysis) return;

    const dataStr = JSON.stringify(this.currentAnalysis, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `job-analysis-${this.currentAnalysis.jobData.company}-${Date.now()}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
  }

  /**
   * Download cover letter as text file
   */
  downloadCoverLetter(content, company) {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `cover-letter-${company}-${Date.now()}.txt`;
    a.click();
    
    URL.revokeObjectURL(url);
  }
}

// Initialize when DOM is ready
let resumeOptimizerUI;
document.addEventListener('DOMContentLoaded', () => {
  resumeOptimizerUI = new ResumeOptimizerUI();
});
