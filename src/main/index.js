import { app, BrowserWindow, ipcMain, dialog, Notification } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import trayManager from './tray.js';
import scheduler from '../backend/scheduler.js';
import { initTrial, isAppUsable, getLicenseStatus, validateLicenseKey } from './license.js';

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

  // Resolve icon path (may not exist yet)
  const iconPath = path.join(__dirname, '../../assets/icons/icon.png');

  // Create browser window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.mjs'),
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

  // Initialize trial tracking on every launch
  initTrial(config);

  // Load content based on app state
  if (config.isFirstRun()) {
    console.log('Loading setup wizard...');
    mainWindow.loadFile(path.join(__dirname, '../renderer/wizard.html'));
  } else if (isAppUsable(config)) {
    loadDashboard();
  } else {
    console.log('License required - loading activation page...');
    mainWindow.loadFile(path.join(__dirname, '../renderer/license.html'));
  }

  // Handle window close - minimize to tray instead
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
 * Load the Express dashboard into the main window
 */
function loadDashboard() {
  const dashboardUrl = `http://localhost:${dashboardPort}`;
  console.log(`Loading dashboard from ${dashboardUrl}`);

  setTimeout(() => {
    mainWindow.loadURL(dashboardUrl).catch(err => {
      console.error('Failed to load dashboard:', err);
      mainWindow.loadFile(path.join(__dirname, '../renderer/error.html'));
    });
  }, 2000);
}

/**
 * Start the dashboard server
 */
async function startDashboardServer() {
  try {
    const dashboardModule = await import('../../dashboard.js');
    dashboardModule.startDashboard();
    console.log(`Dashboard server starting on port ${dashboardPort}`);
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
    console.log('Job scheduler started');
  } else {
    console.log('Job scheduler disabled in configuration');
  }
}

// ===== IPC Handlers =====

function registerIpcHandlers() {
  // App info
  ipcMain.handle('app:getVersion', () => app.getVersion());

  // Configuration read/write
  ipcMain.handle('config:get', (_event, key) => {
    return config.store.get(key);
  });

  ipcMain.handle('config:set', (_event, key, value) => {
    config.store.set(key, value);
    // Notify renderer of config change
    if (mainWindow) {
      mainWindow.webContents.send('config:changed', key, value);
    }
  });

  // Scraper controls
  ipcMain.handle('scraper:run', async (_event, mode) => {
    try {
      await scheduler.runNow(mode || 'daily');
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Scheduler controls
  ipcMain.handle('scheduler:start', () => {
    scheduler.start();
    if (mainWindow) {
      mainWindow.webContents.send('scheduler:status-changed', true);
    }
    return { running: true };
  });

  ipcMain.handle('scheduler:stop', () => {
    scheduler.stop();
    if (mainWindow) {
      mainWindow.webContents.send('scheduler:status-changed', false);
    }
    return { running: false };
  });

  ipcMain.handle('scheduler:status', () => {
    return { running: scheduler.isRunning };
  });

  // Window controls
  ipcMain.on('window:minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on('window:close', () => {
    mainWindow?.close();
  });

  // Notifications
  ipcMain.on('notification:show', (_event, title, body) => {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  });

  // File dialogs
  ipcMain.handle('dialog:selectFile', async (_event, options) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      ...options
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('dialog:selectFolder', async (_event, options) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      ...options
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Setup wizard
  ipcMain.on('wizard:complete', (_event, data) => {
    // Apply wizard configuration
    if (data.keywords) config.setKeywords(data.keywords);
    if (data.locations) config.setLocations(data.locations);
    if (data.email && data.appPassword) {
      config.setEmailConfig(data.email, data.appPassword);
    }
    if (data.anthropicApiKey) config.setAnthropicApiKey(data.anthropicApiKey);
    if (data.resumePath) config.setResumePath(data.resumePath);
    if (data.schedule) config.setSchedule(data.schedule);

    config.markFirstRunComplete();
    console.log('Setup wizard completed');

    // Transition to dashboard
    loadDashboard();
  });

  // License status
  ipcMain.handle('license:status', () => {
    return getLicenseStatus(config);
  });

  // License activation - validates key, stores it, and transitions to dashboard
  ipcMain.handle('license:activate', (_event, email, key) => {
    const result = validateLicenseKey(key);
    if (result.valid) {
      config.setLicenseInfo({
        ...config.getLicenseInfo(),
        key,
        email: result.email,
        type: result.type,
        activatedAt: new Date().toISOString()
      });
      console.log(`License activated for ${result.email}`);
      // Transition to dashboard
      loadDashboard();
    }
    return result;
  });
}

// ===== App Lifecycle Events =====

app.whenReady().then(async () => {
  console.log('Career Future starting...');

  // Register IPC handlers before creating any windows
  registerIpcHandlers();

  // Start backend services
  await startDashboardServer();
  startScheduler();

  // Create main window
  await createWindow();

  console.log('Career Future ready!');
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else if (mainWindow) {
    mainWindow.show();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
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

export { mainWindow, createWindow };
