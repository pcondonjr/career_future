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
    // Listen for "Optimize Resume" button clicks
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-optimize-resume')) {
        e.preventDefault();
        const jobData = this.extractJobData(e.target);
        this.showOptimizationModal(jobData);
      }

      if (e.target.classList.contains('btn-generate-cover-letter')) {
        e.preventDefault();
        const jobData = this.extractJobData(e.target);
        this.generateCoverLetter(jobData);
      }

      if (e.target.id === 'download-analysis') {
        this.downloadAnalysis();
      }
    });
  }

  /**
   * Extract job data from button's parent element
   */
  extractJobData(button) {
    const jobCard = button.closest('.job-card') || button.closest('tr');
    
    return {
      title: jobCard.querySelector('.job-title')?.textContent || '',
      company: jobCard.querySelector('.job-company')?.textContent || '',
      location: jobCard.querySelector('.job-location')?.textContent || '',
      description: jobCard.dataset.description || '',
      url: jobCard.dataset.url || '',
      source: jobCard.dataset.source || ''
    };
  }

  /**
   * Show optimization modal with loading state
   */
  async showOptimizationModal(jobData) {
    // Create modal if it doesn't exist
    if (!document.getElementById('optimization-modal')) {
      this.createOptimizationModal();
    }

    const modal = document.getElementById('optimization-modal');
    const modalBody = modal.querySelector('.modal-body');
    
    // Show modal with loading state
    modal.classList.add('active');
    modalBody.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <p>Analyzing job match...</p>
        <small>This typically takes 3-5 seconds</small>
      </div>
    `;

    // Update modal title
    modal.querySelector('.modal-title').textContent = 
      `Optimize for: ${jobData.title} at ${jobData.company}`;

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
          <p>❌ Failed to analyze job</p>
          <small>${error.message}</small>
          <button onclick="location.reload()" class="btn btn-secondary">Retry</button>
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
          <button id="download-analysis" class="btn btn-primary">
            📥 Download Analysis
          </button>
          <button class="btn-generate-cover-letter btn btn-secondary">
            📝 Generate Cover Letter
          </button>
          <button onclick="window.open('${this.currentAnalysis.jobData.url}', '_blank')" 
                  class="btn btn-secondary">
            🔗 View Job Posting
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
  }

  /**
   * Generate cover letter for job
   */
  async generateCoverLetter(jobData) {
    const modal = document.getElementById('optimization-modal');
    
    if (!modal.classList.contains('active')) {
      modal.classList.add('active');
    }

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
          <p>❌ Failed to generate cover letter</p>
          <small>${error.message}</small>
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

    modalBody.innerHTML = `
      <div class="cover-letter-display">
        <h3>📝 Generated Cover Letter</h3>
        
        <div class="cover-letter-content">
          <pre>${coverLetter}</pre>
        </div>

        <div class="action-buttons">
          <button onclick="navigator.clipboard.writeText(\`${coverLetter.replace(/`/g, '\\`')}\`)" 
                  class="btn btn-primary">
            📋 Copy to Clipboard
          </button>
          <button onclick="resumeOptimizerUI.downloadCoverLetter(\`${coverLetter.replace(/`/g, '\\`')}\`, '${jobData.company}')" 
                  class="btn btn-secondary">
            📥 Download as .txt
          </button>
        </div>

        <div class="metadata">
          <small>Word count: ${metadata.wordCount} | Processing time: ${metadata.processingTime}ms</small>
        </div>
      </div>
    `;
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
