import { Tray, Menu, nativeImage, app, Notification, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import scheduler from '../backend/scheduler.js';
import { getLicenseStatus } from './license.js';
import config from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class TrayManager {
  constructor() {
    this.tray = null;
    this.mainWindow = null;
  }

  /**
   * Create the system tray icon and menu
   * @param {BrowserWindow} mainWindow
   */
  create(mainWindow) {
    this.mainWindow = mainWindow;

    const icon = this._loadIcon();
    if (!icon) {
      console.warn('TrayManager: No icon available, skipping tray creation');
      return;
    }

    // Resize for tray
    const trayIcon = icon.resize({
      width: process.platform === 'darwin' ? 22 : 16,
      height: process.platform === 'darwin' ? 22 : 16
    });

    this.tray = new Tray(trayIcon);
    this.tray.setToolTip('Career Future - Job Search Assistant');
    this.updateMenu();

    this.tray.on('double-click', () => {
      this.toggleWindow();
    });

    console.log('System tray icon created');
  }

  /**
   * Load tray icon with fallback to a generated icon if files are missing
   */
  _loadIcon() {
    const iconsDir = path.join(__dirname, '../../assets/icons');

    // Try platform-specific icon first
    const candidates = process.platform === 'win32'
      ? ['tray-icon.ico', 'tray-icon.png', 'icon.png']
      : process.platform === 'darwin'
        ? ['tray-iconTemplate.png', 'tray-icon.png', 'icon.png']
        : ['tray-icon.png', 'icon.png'];

    for (const name of candidates) {
      const filePath = path.join(iconsDir, name);
      if (fs.existsSync(filePath)) {
        try {
          const img = nativeImage.createFromPath(filePath);
          if (!img.isEmpty()) return img;
        } catch {
          // try next candidate
        }
      }
    }

    // Fallback: create a simple 16x16 colored square in memory
    // This is a minimal 16x16 RGBA PNG (blue square)
    return this._createFallbackIcon();
  }

  /**
   * Generate a tiny in-memory icon as fallback
   */
  _createFallbackIcon() {
    // 16x16 RGBA buffer - solid blue (#4361ee)
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      buf[i * 4] = 0x43;     // R
      buf[i * 4 + 1] = 0x61; // G
      buf[i * 4 + 2] = 0xee; // B
      buf[i * 4 + 3] = 0xff; // A
    }
    return nativeImage.createFromBuffer(buf, { width: size, height: size });
  }

  _getLicenseLabel() {
    const status = getLicenseStatus(config);
    if (status.licensed) return `Licensed to: ${status.email}`;
    if (status.trial) return `Trial: ${status.daysRemaining} day${status.daysRemaining !== 1 ? 's' : ''} remaining`;
    return 'Trial Expired';
  }

  updateMenu() {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: this._getLicenseLabel(),
        enabled: false
      },
      { type: 'separator' },
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
            label: scheduler.isRunning ? 'Running' : 'Stopped',
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

    this.tray?.setContextMenu(contextMenu);
  }

  toggleWindow() {
    if (this.mainWindow?.isVisible()) {
      this.mainWindow.hide();
    } else {
      this.mainWindow?.show();
      this.mainWindow?.focus();
    }
  }

  showWindow() {
    this.mainWindow?.show();
    this.mainWindow?.focus();
  }

  hideWindow() {
    this.mainWindow?.hide();
  }

  async runScraper(mode) {
    console.log(`Running ${mode} scraper from tray menu...`);
    this.showNotification('Career Future', `Starting ${mode} job scraper...`);

    try {
      await scheduler.runNow(mode);
      this.updateMenu();
    } catch (error) {
      console.error(`Failed to run ${mode} scraper:`, error);
      this.showNotification('Career Future - Error', `Failed to run ${mode} scraper.`);
    }
  }

  startScheduler() {
    scheduler.start();
    this.updateMenu();
    this.showNotification('Career Future', 'Job scheduler started');
  }

  stopScheduler() {
    scheduler.stop();
    this.updateMenu();
    this.showNotification('Career Future', 'Job scheduler stopped');
  }

  openSettings() {
    if (this.mainWindow) {
      this.mainWindow.show();
      this.mainWindow.focus();
      this.mainWindow.webContents.executeJavaScript(
        `window.location.hash = '#settings';`
      );
    }
  }

  showAbout() {
    if (this.mainWindow) {
      dialog.showMessageBox(this.mainWindow, {
        type: 'info',
        title: 'About Career Future',
        message: 'Career Future',
        detail: `Version: ${app.getVersion()}\n\nAutomated job search assistant for career-focused professionals.\n\n© 2026 Career Future`,
        buttons: ['OK']
      });
    }
  }

  showNotification(title, body) {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

const trayManager = new TrayManager();
export default trayManager;
