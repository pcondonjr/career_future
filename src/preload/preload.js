import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload script for Career Future
 * Creates a secure bridge between renderer and main process
 *
 * This script runs in a special context that has access to both Node.js and the renderer.
 * It exposes safe IPC methods to the renderer via contextBridge.
 */

// Expose safe APIs to renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Platform info
  platform: process.platform,

  // App version
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Configuration
  getConfig: (key) => ipcRenderer.invoke('config:get', key),
  setConfig: (key, value) => ipcRenderer.invoke('config:set', key, value),

  // Scraper controls
  runScraper: (mode) => ipcRenderer.invoke('scraper:run', mode),

  // Scheduler controls
  startScheduler: () => ipcRenderer.invoke('scheduler:start'),
  stopScheduler: () => ipcRenderer.invoke('scheduler:stop'),
  getSchedulerStatus: () => ipcRenderer.invoke('scheduler:status'),

  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  // Notifications
  showNotification: (title, body) => ipcRenderer.send('notification:show', title, body),

  // File operations
  selectFile: (options) => ipcRenderer.invoke('dialog:selectFile', options),
  selectFolder: (options) => ipcRenderer.invoke('dialog:selectFolder', options),

  // Setup wizard (for future implementation)
  wizardNext: (data) => ipcRenderer.send('wizard:next', data),
  wizardBack: () => ipcRenderer.send('wizard:back'),
  wizardComplete: (data) => ipcRenderer.send('wizard:complete', data),

  // License validation (for future implementation)
  validateLicense: (email, key) => ipcRenderer.invoke('license:validate', email, key),

  // Event listeners
  on: (channel, callback) => {
    const validChannels = [
      'scraper:progress',
      'scraper:complete',
      'scraper:error',
      'scheduler:status-changed',
      'config:changed'
    ];

    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },

  removeListener: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  }
});

// Log that preload script loaded successfully
console.log('✅ Career Future preload script loaded');
