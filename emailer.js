import nodemailer from 'nodemailer';

export class JobEmailer {
  constructor() {
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_APP_PASSWORD
      }
    });
  }

  async sendJobAlert(jobs, stats, mode = 'daily') {
    if (jobs.length === 0) {
      console.log('No new jobs to send');
      return;
    }

    const isWeekly = mode === 'weekly';
    const html = this.generateEmailHTML(jobs, stats, isWeekly);
    const subject = isWeekly
      ? `📅 Weekly: ${jobs.length} New Salesforce Job${jobs.length > 1 ? 's' : ''} (Not in Daily List)`
      : `🎯 ${jobs.length} New Salesforce Job${jobs.length > 1 ? 's' : ''} Found`;

    try {
      await this.transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_USER,
        subject: subject,
        html: html
      });

      console.log(`Email sent with ${jobs.length} jobs (${mode} mode)`);
    } catch (error) {
      console.error('Failed to send email:', error.message);
    }
  }

  generateEmailHTML(jobs, stats, isWeekly = false) {
    // Group jobs by company
    const grouped = jobs.reduce((acc, job) => {
      if (!acc[job.company]) {
        acc[job.company] = [];
      }
      acc[job.company].push(job);
      return acc;
    }, {});

    const jobsHTML = Object.entries(grouped)
      .map(([company, companyJobs]) => `
        <div style="margin-bottom: 30px; border-left: 4px solid #0176D3; padding-left: 15px;">
          <h3 style="color: #0176D3; margin: 0 0 15px 0;">${company} (${companyJobs.length})</h3>
          ${companyJobs.map(job => `
            <div style="margin-bottom: 15px; padding: 12px; background: #f4f6f9; border-radius: 4px;">
              <h4 style="margin: 0 0 8px 0; color: #032e61;">
                <a href="${job.url}" style="color: #032e61; text-decoration: none;">
                  ${job.title}
                </a>
              </h4>
              <p style="margin: 0; color: #666; font-size: 14px;">
                📍 ${job.location || 'Location not specified'}
              </p>
              <p style="margin: 8px 0 0 0;">
                <a href="${job.url}"
                   style="display: inline-block; padding: 8px 16px; background: #0176D3;
                          color: white; text-decoration: none; border-radius: 4px; font-size: 14px;">
                  View Job →
                </a>
              </p>
            </div>
          `).join('')}
        </div>
      `).join('');

    const headerGradient = isWeekly
      ? 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)'
      : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';

    const headerTitle = isWeekly
      ? '📅 Weekly Salesforce Jobs Alert'
      : '🎯 New Salesforce Jobs Alert';

    const headerSubtitle = isWeekly
      ? `Found ${jobs.length} new position${jobs.length > 1 ? 's' : ''} not in your daily list`
      : `Found ${jobs.length} new position${jobs.length > 1 ? 's' : ''} matching your criteria`;

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                   line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px;">

        <div style="background: ${headerGradient};
                    padding: 30px; border-radius: 8px; margin-bottom: 30px;">
          <h1 style="color: white; margin: 0; font-size: 28px;">
            ${headerTitle}
          </h1>
          <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px;">
            ${headerSubtitle}
          </p>
        </div>

        <div style="background: #e8f4f8; padding: 15px; border-radius: 6px; margin-bottom: 25px;">
          <h3 style="margin: 0 0 10px 0; color: #0176D3;">📊 Database Statistics</h3>
          <ul style="margin: 0; padding-left: 20px;">
            <li>Total jobs tracked: <strong>${stats.total}</strong></li>
            <li>New in last 24 hours: <strong>${stats.last24Hours}</strong></li>
            <li>New this week: <strong>${stats.lastWeek}</strong></li>
          </ul>
        </div>

        ${jobsHTML}

        <div style="margin-top: 40px; padding-top: 20px; border-top: 2px solid #e0e0e0; 
                    color: #666; font-size: 13px; text-align: center;">
          <p>💡 <strong>Application Tips:</strong></p>
          <ul style="text-align: left; max-width: 600px; margin: 10px auto;">
            <li>Review the job description carefully and tailor your resume</li>
            <li>Highlight relevant certifications (especially Advanced Admin, Business Analyst)</li>
            <li>Emphasize Flow automation and process improvement experience</li>
            <li>Apply within 48 hours for best visibility</li>
          </ul>
          <p style="margin-top: 20px;">
            Generated on ${new Date().toLocaleString()}
          </p>
        </div>

      </body>
      </html>
    `;
  }

  async sendWeeklySummary(db) {
    const stats = db.getStats();
    
    const html = `
      <!DOCTYPE html>
      <html>
      <body style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>📈 Weekly Job Search Summary</h2>
        <p>Here's your job search activity for the past week:</p>
        <ul>
          <li>Total jobs in database: <strong>${stats.total}</strong></li>
          <li>New jobs this week: <strong>${stats.lastWeek}</strong></li>
          <li>Average per day: <strong>${Math.round(stats.lastWeek / 7)}</strong></li>
        </ul>
        <p>Keep up the momentum! 💪</p>
      </body>
      </html>
    `;

    try {
      await this.transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_USER,
        subject: '📈 Weekly Salesforce Job Search Summary',
        html: html
      });
      console.log('Weekly summary sent');
    } catch (error) {
      console.error('Failed to send weekly summary:', error.message);
    }
  }
}
