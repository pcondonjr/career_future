import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import scheduler from '../backend/scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * System Tray Manager for Career Future
 * Provides quick access to app functions from the system tray
 */
class TrayManager {
  constructor() {
    this.tray = null;
    this.mainWindow = null;
  }

  /**
   * Create the system tray icon and menu
   * @param {BrowserWindow} mainWindow - Reference to the main application window
   */
  create(mainWindow) {
    this.mainWindow = mainWindow;

    // Create tray icon
    const iconPath = this.getIconPath();
    const icon = nativeImage.createFromPath(iconPath);

    // Resize icon for tray (platform-specific sizes)
    const trayIcon = icon.resize({
      width: process.platform === 'darwin' ? 22 : 16,
      height: process.platform === 'darwin' ? 22 : 16
    });

    this.tray = new Tray(trayIcon);
    this.tray.setToolTip('Career Future - Job Search Assistant');

    // Create context menu
    this.updateMenu();

    // Double-click to show/hide window
    this.tray.on('double-click', () => {
      this.toggleWindow();
    });

    console.log('✅ System tray icon created');
  }

  /**
   * Get the appropriate icon path based on platform
   */
  getIconPath() {
    const iconsDir = path.join(__dirname, '../../assets/icons');

    // Platform-specific icon paths
    if (process.platform === 'darwin') {
      return path.join(iconsDir, 'tray-iconTemplate.png'); // macOS template
    } else if (process.platform === 'win32') {
      return path.join(iconsDir, 'tray-icon.ico'); // Windows
    } else {
      return path.join(iconsDir, 'tray-icon.png'); // Linux
    }
  }

  /**
   * Update the tray context menu
   */
  updateMenu() {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Dashboard',
        click: () => this.showWindow()
      },
      {
        label: 'Hide Dashboard',
        click: () => this.hideWindow()
      },
      { type: 'separator' },
      {
        label: 'Run Scraper Now',
        submenu: [
          {
            label: 'Daily Scrape',
            click: () => this.runScraper('daily')
          },
          {
            label: 'Weekly Scrape',
            click: () => this.runScraper('weekly')
          }
        ]
      },
      { type: 'separator' },
      {
        label: 'Scheduler',
        submenu: [
          {
            label: scheduler.isRunning ? '✓ Running' : '⏸ Stopped',
            enabled: false
          },
          { type: 'separator' },
          {
            label: 'Start Scheduler',
            enabled: !scheduler.isRunning,
            click: () => this.startScheduler()
          },
          {
            label: 'Stop Scheduler',
            enabled: scheduler.isRunning,
            click: () => this.stopScheduler()
          }
        ]
      },
      { type: 'separator' },
      {
        label: 'Settings',
        click: () => this.openSettings()
      },
      {
        label: 'About',
        click: () => this.showAbout()
      },
      { type: 'separator' },
      {
        label: 'Quit Career Future',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  /**
   * Toggle window visibility
   */
  toggleWindow() {
    if (this.mainWindow.isVisible()) {
      this.mainWindow.hide();
    } else {
      this.mainWindow.show();
      this.mainWindow.focus();
    }
  }

  /**
   * Show the main window
   */
  showWindow() {
    if (this.mainWindow) {
      this.mainWindow.show();
      this.mainWindow.focus();
    }
  }

  /**
   * Hide the main window
   */
  hideWindow() {
    if (this.mainWindow) {
      this.mainWindow.hide();
    }
  }

  /**
   * Run the job scraper
   * @param {string} mode - 'daily' or 'weekly'
   */
  async runScraper(mode) {
    console.log(`Running ${mode} scraper from tray menu...`);

    // Show notification
    this.showNotification(
      'Career Future',
      `Starting ${mode} job scraper...`
    );

    try {
      await scheduler.runNow(mode);
      this.updateMenu(); // Refresh menu after completion
    } catch (error) {
      console.error(`Failed to run ${mode} scraper:`, error);
      this.showNotification(
        'Career Future - Error',
        `Failed to run ${mode} scraper. Check console for details.`
      );
    }
  }

  /**
   * Start the scheduler
   */
  startScheduler() {
    scheduler.start();
    this.updateMenu();
    this.showNotification(
      'Career Future',
      'Job scheduler started'
    );
  }

  /**
   * Stop the scheduler
   */
  stopScheduler() {
    scheduler.stop();
    this.updateMenu();
    this.showNotification(
      'Career Future',
      'Job scheduler stopped'
    );
  }

  /**
   * Open settings window
   */
  openSettings() {
    // TODO: Implement settings window
    console.log('Opening settings...');
    if (this.mainWindow) {
      this.mainWindow.show();
      this.mainWindow.focus();
      // Navigate to settings in dashboard
      this.mainWindow.webContents.executeJavaScript(`
        window.location.hash = '#settings';
      `);
    }
  }

  /**
   * Show about dialog
   */
  showAbout() {
    const { dialog } = require('electron');
    dialog.showMessageBox(this.mainWindow, {
      type: 'info',
      title: 'About Career Future',
      message: 'Career Future',
      detail: `Version: ${app.getVersion()}\n\nAutomated job search assistant for career-focused professionals.\n\n© 2026 Career Future`,
      buttons: ['OK']
    });
  }

  /**
   * Show system notification
   * @param {string} title - Notification title
   * @param {string} body - Notification body
   */
  showNotification(title, body) {
    const { Notification } = require('electron');

    if (Notification.isSupported()) {
      new Notification({
        title,
        body,
        icon: this.getIconPath()
      }).show();
    }
  }

  /**
   * Destroy the tray icon
   */
  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

// Export singleton instance
const trayManager = new TrayManager();
export default trayManager;
