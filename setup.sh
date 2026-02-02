#!/bin/bash
#
# Resume Optimizer Setup Script
# Automates integration into salesforce-job-scrapper
#

set -e

echo "🚀 Resume Optimizer Setup"
echo "================================"
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo -e "${RED}Error: package.json not found${NC}"
    echo "Please run this script from your salesforce-job-scrapper directory"
    exit 1
fi

echo -e "${GREEN}✓${NC} Found package.json"

# Step 1: Install dependencies
echo ""
echo "📦 Step 1: Installing dependencies..."
if command -v npm &> /dev/null; then
    npm install @anthropic-ai/sdk
    echo -e "${GREEN}✓${NC} Installed @anthropic-ai/sdk"
else
    echo -e "${RED}Error: npm not found${NC}"
    exit 1
fi

# Step 2: Create directories
echo ""
echo "📁 Step 2: Creating directories..."
mkdir -p public/js
mkdir -p public/css
mkdir -p resume
echo -e "${GREEN}✓${NC} Directories created"

# Step 3: Copy core files
echo ""
echo "📋 Step 3: Copying core files..."

SOURCE_DIR="/home/claude"

if [ -f "$SOURCE_DIR/anthropic_resume_optimizer.js" ]; then
    cp "$SOURCE_DIR/anthropic_resume_optimizer.js" .
    echo -e "${GREEN}✓${NC} Copied anthropic_resume_optimizer.js"
else
    echo -e "${YELLOW}⚠${NC}  anthropic_resume_optimizer.js not found"
fi

if [ -f "$SOURCE_DIR/resume_api_routes.js" ]; then
    cp "$SOURCE_DIR/resume_api_routes.js" .
    echo -e "${GREEN}✓${NC} Copied resume_api_routes.js"
else
    echo -e "${YELLOW}⚠${NC}  resume_api_routes.js not found"
fi

# Step 4: Copy frontend files
echo ""
echo "🎨 Step 4: Copying frontend files..."

if [ -f "$SOURCE_DIR/public_resume_optimizer.js" ]; then
    cp "$SOURCE_DIR/public_resume_optimizer.js" public/js/
    echo -e "${GREEN}✓${NC} Copied public_resume_optimizer.js"
else
    echo -e "${YELLOW}⚠${NC}  public_resume_optimizer.js not found"
fi

if [ -f "$SOURCE_DIR/resume_optimizer_styles.css" ]; then
    cp "$SOURCE_DIR/resume_optimizer_styles.css" public/css/
    echo -e "${GREEN}✓${NC} Copied resume_optimizer_styles.css"
else
    echo -e "${YELLOW}⚠${NC}  resume_optimizer_styles.css not found"
fi

# Step 5: Copy resume
echo ""
echo "📄 Step 5: Copying resume..."

if [ -f "$SOURCE_DIR/resume/Patrick_Condon_Resume.txt" ]; then
    cp "$SOURCE_DIR/resume/Patrick_Condon_Resume.txt" resume/
    echo -e "${GREEN}✓${NC} Copied resume"
else
    echo -e "${YELLOW}⚠${NC}  Resume not found - you'll need to create resume/Patrick_Condon_Resume.txt"
fi

# Step 6: Copy utilities
echo ""
echo "🔧 Step 6: Copying utilities..."

if [ -f "$SOURCE_DIR/test_resume_optimizer.js" ]; then
    cp "$SOURCE_DIR/test_resume_optimizer.js" .
    echo -e "${GREEN}✓${NC} Copied test script"
fi

if [ -f "$SOURCE_DIR/extract_resume_text.js" ]; then
    cp "$SOURCE_DIR/extract_resume_text.js" .
    echo -e "${GREEN}✓${NC} Copied extraction utility"
fi

# Step 7: Check for .env
echo ""
echo "🔑 Step 7: Checking environment..."

if [ ! -f ".env" ]; then
    echo "Creating .env file..."
    touch .env
    echo -e "${GREEN}✓${NC} Created .env file"
fi

if ! grep -q "ANTHROPIC_API_KEY" .env; then
    echo ""
    echo -e "${YELLOW}⚠${NC}  ANTHROPIC_API_KEY not found in .env"
    echo ""
    echo "Please add your Anthropic API key to .env:"
    echo "  ANTHROPIC_API_KEY=sk-ant-api03-your-key-here"
    echo ""
    echo "Get your key from: https://console.anthropic.com/"
else
    echo -e "${GREEN}✓${NC} API key found in .env"
fi

# Step 8: Copy documentation
echo ""
echo "📚 Step 8: Copying documentation..."

if [ -f "$SOURCE_DIR/INTEGRATION_GUIDE.md" ]; then
    cp "$SOURCE_DIR/INTEGRATION_GUIDE.md" .
    echo -e "${GREEN}✓${NC} Copied INTEGRATION_GUIDE.md"
fi

if [ -f "$SOURCE_DIR/README_RESUME_OPTIMIZER.md" ]; then
    cp "$SOURCE_DIR/README_RESUME_OPTIMIZER.md" .
    echo -e "${GREEN}✓${NC} Copied README_RESUME_OPTIMIZER.md"
fi

if [ -f "$SOURCE_DIR/IMPLEMENTATION_SUMMARY.md" ]; then
    cp "$SOURCE_DIR/IMPLEMENTATION_SUMMARY.md" .
    echo -e "${GREEN}✓${NC} Copied IMPLEMENTATION_SUMMARY.md"
fi

# Summary
echo ""
echo "================================"
echo -e "${GREEN}✓ Setup Complete!${NC}"
echo "================================"
echo ""
echo "📋 Next Steps:"
echo ""
echo "1. Set your API key in .env:"
echo "   ANTHROPIC_API_KEY=sk-ant-api03-your-key-here"
echo ""
echo "2. Test the integration:"
echo "   node test_resume_optimizer.js"
echo ""
echo "3. Update your server.js to include routes:"
echo "   const resumeRoutes = require('./resume_api_routes');"
echo "   app.use('/api', resumeRoutes);"
echo ""
echo "4. Update your dashboard template to include:"
echo "   <link rel='stylesheet' href='/css/resume_optimizer_styles.css'>"
echo "   <script src='/js/public_resume_optimizer.js'></script>"
echo ""
echo "5. Add buttons to your job cards:"
echo "   <button class='btn-optimize-resume'>⚡ Optimize Resume</button>"
echo ""
echo "📚 Documentation:"
echo "   - INTEGRATION_GUIDE.md (detailed setup)"
echo "   - README_RESUME_OPTIMIZER.md (features & usage)"
echo "   - IMPLEMENTATION_SUMMARY.md (overview)"
echo ""
echo "🎯 Ready to optimize your job search!"
echo ""
