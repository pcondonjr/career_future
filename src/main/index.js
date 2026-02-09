import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import trayManager from './tray.js';
import scheduler from '../backend/scheduler.js';

// ES module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let dashboardPort = 3000;

/**
 * Create the main application window
 */
async function createWindow() {
  // Initialize config manager
  config.init();

  // Get dashboard port from config
  dashboardPort = config.getDashboardPort();

  // Create browser window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, '../../assets/icons/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    },
    title: 'Career Future',
    show: false // Don't show until ready
  });

  // Show window when ready to prevent flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Load the Express dashboard
  // Note: The dashboard server needs to be started first
  const dashboardUrl = `http://localhost:${dashboardPort}`;

  console.log(`Loading dashboard from ${dashboardUrl}`);

  // Wait a bit for dashboard server to start, then load
  setTimeout(() => {
    mainWindow.loadURL(dashboardUrl).catch(err => {
      console.error('Failed to load dashboard:', err);
      // Show error page
      mainWindow.loadFile(path.join(__dirname, '../renderer/error.html'));
    });
  }, 2000);

  // Handle window close
  mainWindow.on('close', (event) => {
    if (config.getSystemConfig().minimizeToTray && !app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Setup system tray
  trayManager.create(mainWindow);
}

/**
 * Start the dashboard server
 */
async function startDashboard() {
  // Import the dashboard dynamically
  const { startDashboard: launchDashboard } = await import('../../dashboard.js');

  try {
    await launchDashboard(dashboardPort);
    console.log(`✅ Dashboard server started on port ${dashboardPort}`);
  } catch (error) {
    console.error('Failed to start dashboard:', error);
  }
}

/**
 * Start the job scheduler
 */
function startScheduler() {
  const schedule = config.getSchedule();

  if (schedule.enabled) {
    scheduler.start();
    console.log('✅ Job scheduler started');
  } else {
    console.log('ℹ️  Job scheduler disabled in configuration');
  }
}

// ===== App Lifecycle Events =====

app.whenReady().then(async () => {
  console.log('🚀 Career Future starting...');

  // Check if first run
  if (config.isFirstRun()) {
    console.log('📋 First run detected - setup wizard needed');
    // TODO: Show setup wizard instead of main window
    // For now, just create main window
  }

  // Start backend services
  await startDashboard();
  startScheduler();

  // Create main window
  await createWindow();

  console.log('✅ Career Future ready!');
});

app.on('activate', () => {
  // On macOS, re-create window when dock icon is clicked
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow) {
    mainWindow.show();
  }
});

app.on('window-all-closed', () => {
  // On macOS, keep app running even when all windows closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;

  // Stop scheduler
  if (scheduler.isRunning) {
    scheduler.stop();
  }
});

// Handle errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Export for testing
export { mainWindow, createWindow };
