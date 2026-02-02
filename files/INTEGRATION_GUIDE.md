# Resume Optimizer Integration Guide

Complete guide to integrating AI-powered resume optimization into your salesforce-job-scrapper app.

## 📋 Prerequisites

- Node.js 16+ installed
- Anthropic API key (get from https://console.anthropic.com/)
- Existing salesforce-job-scrapper app running

## 🚀 Installation Steps

### 1. Install Required Dependencies

```bash
npm install @anthropic-ai/sdk
```

Your package.json should include:
```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.1",
    "express": "^4.18.2",
    "ejs": "^3.1.9",
    "node-cron": "^3.0.2",
    // ... your other dependencies
  }
}
```

### 2. Set Up Environment Variables

Add to your `.env` file:
```bash
# Anthropic API Configuration
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here

# Optional: Cost tracking
ENABLE_COST_TRACKING=true
MAX_DAILY_API_COST=5.00
```

### 3. Add Resume Text File

Create a text version of your resume for analysis:

```bash
mkdir -p resume
# Copy your resume content to resume/Patrick_Condon_Resume.txt
```

You can extract text from your DOCX using:
```bash
# Using python-docx (if you have Python)
python -c "
from docx import Document
doc = Document('Patrick_Condon_Resume_Zenkraft.docx')
text = '\n'.join([p.text for p in doc.paragraphs])
with open('resume/Patrick_Condon_Resume.txt', 'w') as f:
    f.write(text)
"

# OR using LibreOffice (command line)
libreoffice --headless --convert-to txt Patrick_Condon_Resume_Zenkraft.docx --outdir resume/
```

### 4. Integrate Backend Files

Copy the created files into your project:

```bash
# Core optimizer module
cp anthropic_resume_optimizer.js /path/to/your/project/

# API routes
cp resume_api_routes.js /path/to/your/project/routes/

# Or if you don't have a routes folder:
cp resume_api_routes.js /path/to/your/project/
```

### 5. Update Your Main Server File

In your `server.js` or `app.js`:

```javascript
const express = require('express');
const resumeRoutes = require('./resume_api_routes'); // Adjust path as needed

const app = express();

// ... your existing middleware ...

// Add resume optimization routes
app.use('/api', resumeRoutes);

// ... rest of your server config ...
```

### 6. Add Frontend Files

```bash
# Create public directories if they don't exist
mkdir -p public/js
mkdir -p public/css

# Copy frontend files
cp public_resume_optimizer.js public/js/
cp resume_optimizer_styles.css public/css/
```

### 7. Update Your Dashboard Template

Add to your dashboard EJS template (e.g., `views/dashboard.ejs`):

```html
<head>
  <!-- Add CSS -->
  <link rel="stylesheet" href="/css/resume_optimizer_styles.css">
</head>

<body>
  <!-- Your existing dashboard content -->
  
  <!-- Add before closing </body> tag -->
  <script src="/js/public_resume_optimizer.js"></script>
</body>
```

### 8. Add Optimization Buttons to Job Cards

In your job listing template, add buttons:

```html
<div class="job-card" 
     data-description="<%= job.description %>"
     data-url="<%= job.url %>">
  
  <!-- Your existing job card content -->
  
  <div class="job-actions">
    <button class="btn-optimize-resume">
      ⚡ Optimize Resume
    </button>
    <button class="btn-generate-cover-letter btn btn-secondary">
      📝 Cover Letter
    </button>
  </div>
</div>
```

## 🧪 Testing the Integration

### 1. Start Your Server

```bash
node server.js
# or
npm start
```

### 2. Test API Endpoints

```bash
# Test cost estimation
curl http://localhost:3000/api/cost-estimate?descriptionLength=5000

# Test job analysis (with sample data)
curl -X POST http://localhost:3000/api/analyze-job \
  -H "Content-Type: application/json" \
  -d '{
    "jobDescription": "Salesforce Administrator needed...",
    "jobTitle": "Salesforce Admin",
    "company": "Test Company"
  }'
```

### 3. Test UI Features

1. Navigate to your dashboard
2. Click "Optimize Resume" on any job
3. Modal should appear with analysis
4. Try generating a cover letter

## 📊 Understanding Costs

Based on current Anthropic pricing (Claude Sonnet 4):
- **Input**: $3.00 per million tokens
- **Output**: $15.00 per million tokens

Typical costs per operation:
- **Job Analysis**: ~$0.03-0.05 (resume + job description analysis)
- **Cover Letter**: ~$0.02-0.04 (generation)
- **Batch Analysis** (10 jobs): ~$0.30-0.50

Example daily usage:
- 20 job analyses: ~$0.80
- 5 cover letters: ~$0.15
- **Total**: ~$0.95/day

Much cheaper than commercial services ($30-50/month)!

## 🎯 Usage Recommendations

### When to Analyze Jobs

**Always analyze:**
- Jobs at target companies (high priority)
- Roles with 70%+ estimated match
- Positions requiring cover letters

**Selective analysis:**
- Generic "Salesforce Admin" postings
- Roles outside preferred location
- Jobs with limited description

### Batch Operations

Use batch analysis for:
- Morning review of overnight scrapes
- Weekly targeted company searches
- Monthly portfolio company updates

Avoid batch analysis for:
- Low-quality job boards
- Duplicate postings
- Clearly mismatched roles

## 🔧 Advanced Configuration

### Custom Analysis Prompts

Edit `anthropic_resume_optimizer.js` to customize analysis:

```javascript
// Adjust scoring weights
const prompt = `... emphasize ${specificSkill} over general experience ...`;

// Change output format
// Add industry-specific keywords
// Adjust compatibility scoring logic
```

### Rate Limiting

Add rate limiting to prevent API cost spikes:

```javascript
// In resume_api_routes.js
const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 50 requests per windowMs
  message: 'Too many requests, please try again later'
});

router.use('/api/', apiLimiter);
```

### Cost Tracking

Implement daily cost tracking:

```javascript
// Add to your database or file storage
const costTracker = {
  date: new Date().toISOString().split('T')[0],
  totalCost: 0,
  requestCount: 0
};

// Check before each request
if (costTracker.totalCost > process.env.MAX_DAILY_API_COST) {
  throw new Error('Daily API cost limit reached');
}
```

## 🐛 Troubleshooting

### Issue: "Resume file not found"
**Solution**: Ensure `resume/Patrick_Condon_Resume.txt` exists and contains your resume text.

### Issue: API returns 401 Unauthorized
**Solution**: Check that `ANTHROPIC_API_KEY` is correctly set in `.env` file.

### Issue: Modal doesn't appear
**Solution**: 
1. Check browser console for JavaScript errors
2. Ensure `public_resume_optimizer.js` is loaded
3. Verify job card has required `data-description` attribute

### Issue: Slow analysis (>30 seconds)
**Solution**: 
1. Check internet connection
2. Verify API key has sufficient quota
3. Consider using streaming responses for faster perceived performance

### Issue: High API costs
**Solution**:
1. Implement caching for analyzed jobs
2. Add rate limiting
3. Only analyze high-value opportunities
4. Use batch analysis for efficiency

## 📈 Monitoring & Optimization

### Track Key Metrics

Create a simple logging system:

```javascript
// Add to resume_api_routes.js
const analysisLog = [];

router.post('/analyze-job', async (req, res) => {
  const startTime = Date.now();
  // ... analysis code ...
  
  analysisLog.push({
    timestamp: new Date(),
    company: req.body.company,
    score: analysis.compatibilityScore,
    cost: metadata.estimatedCost,
    duration: Date.now() - startTime
  });
  
  // Periodically save to file or database
});
```

### Weekly Review

Check your logs for:
- Average compatibility scores
- Cost per successful application
- Most expensive analysis types
- Fastest/slowest API responses

## 🚢 Deployment Considerations

When deploying to production (Railway, Heroku, etc.):

1. **Environment Variables**: Set `ANTHROPIC_API_KEY` in platform settings
2. **File Storage**: Ensure resume file is included in deployment
3. **Rate Limiting**: Implement stricter limits for public instances
4. **Caching**: Consider Redis for caching analysis results
5. **Monitoring**: Set up alerts for high API costs

## 📚 Next Steps

1. ✅ Test integration with sample jobs
2. ✅ Analyze 5-10 real job postings
3. ✅ Generate cover letters for top matches
4. ✅ Track costs and adjust usage patterns
5. ✅ Optimize prompts based on results
6. ✅ Implement caching for efficiency
7. ✅ Add batch analysis workflows

## 🆘 Support

If you encounter issues:
1. Check this guide's troubleshooting section
2. Review Anthropic API documentation: https://docs.anthropic.com
3. Test API directly with curl commands
4. Check browser console for frontend errors

## 💡 Tips for Best Results

1. **Resume Quality**: Keep your text resume updated and well-formatted
2. **Job Descriptions**: The better the job description data, the better the analysis
3. **Keyword Matching**: Pay attention to keyword recommendations for ATS
4. **Iterative Improvement**: Use analysis results to refine your base resume
5. **Cost Management**: Focus on high-probability opportunities

---

## Example Workflow

Here's a typical daily workflow:

```bash
# Morning: Run scrapers (automated via cron)
# Scrapers collect new jobs overnight

# Review dashboard
# Jobs sorted by estimated relevance

# Batch analyze top 10 prospects
curl -X POST http://localhost:3000/api/batch-analyze \
  -H "Content-Type: application/json" \
  -d @top_jobs.json

# For 80%+ matches: Generate cover letters
# Click "Generate Cover Letter" button in UI

# Apply to top 3-5 opportunities
# Using optimized resume + custom cover letter

# Weekly: Review cost and effectiveness
# Adjust targeting based on results
```

Cost for this workflow: ~$0.50-0.75 per day

---

**Happy job hunting! 🎯**
