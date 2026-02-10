import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

// Detect Electron environment
let safeStorage = null;
let app = null;
let Store = null;
const isElectron = !!process.versions.electron;

if (isElectron) {
  try {
    const electron = await import('electron');
    safeStorage = electron.safeStorage;
    app = electron.app;
    const storeModule = await import('electron-store');
    Store = storeModule.default;
  } catch (e) {
    // Not in Electron main process
  }
}

/**
 * Simple JSON file-based config store for non-Electron (plain Node) usage.
 * Mirrors the electron-store API surface used by ConfigManager.
 */
class FileStore {
  constructor({ schema, name }) {
    this.filePath = path.join(PROJECT_ROOT, `${name}.json`);
    this.defaults = this._extractDefaults(schema);
    this.data = { ...this.defaults };
    this._load();
  }

  _extractDefaults(schema) {
    const defaults = {};
    for (const [key, def] of Object.entries(schema)) {
      if (def.default !== undefined) {
        defaults[key] = JSON.parse(JSON.stringify(def.default));
      }
    }
    return defaults;
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const saved = JSON.parse(raw);
        this.data = { ...this.defaults, ...saved };
      }
    } catch {
      // Use defaults on any read error
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.warn('FileStore: Failed to save config:', e.message);
    }
  }

  get(keyPath, defaultValue) {
    const keys = keyPath.split('.');
    let current = this.data;
    for (const key of keys) {
      if (current == null || typeof current !== 'object') {
        return defaultValue;
      }
      current = current[key];
    }
    return current !== undefined ? current : defaultValue;
  }

  set(keyPath, value) {
    const keys = keyPath.split('.');
    let current = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (current[keys[i]] == null || typeof current[keys[i]] !== 'object') {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
    this._save();
  }

  delete(keyPath) {
    const keys = keyPath.split('.');
    let current = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (current[keys[i]] == null) return;
      current = current[keys[i]];
    }
    delete current[keys[keys.length - 1]];
    this._save();
  }

  clear() {
    this.data = { ...this.defaults };
    this._save();
  }

  get store() {
    return { ...this.data };
  }

  get path() {
    return this.filePath;
  }
}

/**
 * Configuration Manager for Career Future
 * Centralizes all application configuration with encrypted storage for sensitive values.
 * Works in both Electron (electron-store + safeStorage) and plain Node (JSON file fallback).
 */

const schema = {
  firstRunComplete: {
    type: 'boolean',
    default: false
  },
  license: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      email: { type: 'string' },
      activatedAt: { type: 'string' },
      lastValidated: { type: 'string' },
      machineId: { type: 'string' }
    },
    default: {}
  },
  user: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      email: { type: 'string' }
    },
    default: {}
  },
  search: {
    type: 'object',
    properties: {
      keywords: {
        type: 'array',
        items: { type: 'string' },
        default: ['salesforce']
      },
      locations: {
        type: 'array',
        items: { type: 'string' },
        default: ['remote', 'greenville', 'south carolina', 'sc', 'charlotte', 'atlanta', 'hybrid']
      },
      schedule: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean', default: true },
          dailyTimes: {
            type: 'array',
            items: { type: 'string' },
            default: ['08:00', '17:00']
          },
          weeklyDay: { type: 'number', default: 0 },
          weeklyTime: { type: 'string', default: '10:00' }
        },
        default: {
          enabled: true,
          dailyTimes: ['08:00', '17:00'],
          weeklyDay: 0,
          weeklyTime: '10:00'
        }
      }
    },
    default: {
      keywords: ['salesforce'],
      locations: ['remote', 'greenville', 'south carolina', 'sc', 'charlotte', 'atlanta', 'hybrid'],
      schedule: {
        enabled: true,
        dailyTimes: ['08:00', '17:00'],
        weeklyDay: 0,
        weeklyTime: '10:00'
      }
    }
  },
  email: {
    type: 'object',
    properties: {
      user: { type: 'string' },
      service: { type: 'string', default: 'gmail' }
    },
    default: { service: 'gmail' }
  },
  anthropic: {
    type: 'object',
    properties: {},
    default: {}
  },
  resume: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      lastModified: { type: 'string' }
    },
    default: {}
  },
  companies: {
    type: 'object',
    properties: {
      dailyPath: { type: 'string', default: 'companies.csv' },
      weeklyPath: { type: 'string', default: 'companies-weekly.csv' }
    },
    default: {
      dailyPath: 'companies.csv',
      weeklyPath: 'companies-weekly.csv'
    }
  },
  database: {
    type: 'object',
    properties: {
      path: { type: 'string', default: 'jobs_database.json' },
      weeklyPath: { type: 'string', default: 'jobs_database_weekly.json' }
    },
    default: {
      path: 'jobs_database.json',
      weeklyPath: 'jobs_database_weekly.json'
    }
  },
  dashboard: {
    type: 'object',
    properties: {
      port: { type: 'number', default: 3000 },
      autoOpen: { type: 'boolean', default: true }
    },
    default: {
      port: 3000,
      autoOpen: true
    }
  },
  system: {
    type: 'object',
    properties: {
      autoStart: { type: 'boolean', default: false },
      minimizeToTray: { type: 'boolean', default: true },
      checkUpdates: { type: 'boolean', default: true }
    },
    default: {
      autoStart: false,
      minimizeToTray: true,
      checkUpdates: true
    }
  }
};

class ConfigManager {
  constructor() {
    this.store = null;
    this.isElectronReady = false;
    this._ensureStore();
  }

  _ensureStore() {
    if (!this.store) {
      try {
        if (Store) {
          // Electron environment: use electron-store
          this.store = new Store({
            schema,
            name: 'career-future-config',
            projectName: 'CareerFuture'
          });
        } else {
          // Plain Node: use file-based store
          this.store = new FileStore({
            schema,
            name: 'career-future-config'
          });
        }
      } catch (error) {
        console.warn('ConfigManager: Failed to create primary store, using file fallback:', error.message);
        this.store = new FileStore({
          schema,
          name: 'career-future-config'
        });
      }
    }
    return this.store;
  }

  init() {
    if (app) {
      this.isElectronReady = app.isReady();
    }
    this._ensureStore();
    if (isElectron && !this.isElectronReady) {
      console.warn('ConfigManager: Electron app not ready yet. Encrypted storage unavailable.');
    }
  }

  setSecure(key, value) {
    if (!value) {
      this.store.delete(key);
      return;
    }

    if (this.isElectronReady && safeStorage && safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(value);
      this.store.set(key, encrypted.toString('base64'));
    } else {
      this.store.set(key, value);
    }
  }

  getSecure(key) {
    const value = this.store.get(key);
    if (!value) return null;

    if (this.isElectronReady && safeStorage && safeStorage.isEncryptionAvailable()) {
      try {
        const encrypted = Buffer.from(value, 'base64');
        return safeStorage.decryptString(encrypted);
      } catch {
        return value;
      }
    } else {
      return value;
    }
  }

  // ===== Search Configuration =====

  getKeywords() {
    return this.store.get('search.keywords', ['salesforce']);
  }

  setKeywords(keywords) {
    if (!Array.isArray(keywords)) {
      throw new Error('Keywords must be an array');
    }
    this.store.set('search.keywords', keywords);
  }

  getLocations() {
    return this.store.get('search.locations', ['remote']);
  }

  setLocations(locations) {
    if (!Array.isArray(locations)) {
      throw new Error('Locations must be an array');
    }
    this.store.set('search.locations', locations);
  }

  // ===== Schedule Configuration =====

  getSchedule() {
    return this.store.get('search.schedule', {
      enabled: true,
      dailyTimes: ['08:00', '17:00'],
      weeklyDay: 0,
      weeklyTime: '10:00'
    });
  }

  setSchedule(schedule) {
    this.store.set('search.schedule', schedule);
  }

  // ===== Email Configuration =====

  getEmailConfig() {
    return {
      user: this.store.get('email.user'),
      appPassword: this.getSecure('email.appPassword'),
      service: this.store.get('email.service', 'gmail')
    };
  }

  setEmailConfig(user, appPassword, service = 'gmail') {
    this.store.set('email.user', user);
    this.setSecure('email.appPassword', appPassword);
    this.store.set('email.service', service);
  }

  // ===== Anthropic API Configuration =====

  getAnthropicApiKey() {
    return this.getSecure('anthropic.apiKey');
  }

  setAnthropicApiKey(apiKey) {
    this.setSecure('anthropic.apiKey', apiKey);
  }

  // ===== Resume Configuration =====

  getResumePath() {
    return this.store.get('resume.path');
  }

  setResumePath(path) {
    this.store.set('resume.path', path);
    this.store.set('resume.lastModified', new Date().toISOString());
  }

  // ===== Companies CSV Paths =====

  getCompaniesPaths() {
    return {
      daily: this.store.get('companies.dailyPath', 'companies.csv'),
      weekly: this.store.get('companies.weeklyPath', 'companies-weekly.csv')
    };
  }

  setCompaniesPaths(dailyPath, weeklyPath) {
    this.store.set('companies.dailyPath', dailyPath);
    this.store.set('companies.weeklyPath', weeklyPath);
  }

  // ===== Database Paths =====

  getDatabasePaths() {
    return {
      daily: this.store.get('database.path', 'jobs_database.json'),
      weekly: this.store.get('database.weeklyPath', 'jobs_database_weekly.json')
    };
  }

  setDatabasePaths(dailyPath, weeklyPath) {
    this.store.set('database.path', dailyPath);
    this.store.set('database.weeklyPath', weeklyPath);
  }

  // ===== Dashboard Configuration =====

  getDashboardPort() {
    return this.store.get('dashboard.port', 3000);
  }

  setDashboardPort(port) {
    this.store.set('dashboard.port', port);
  }

  getDashboardAutoOpen() {
    return this.store.get('dashboard.autoOpen', true);
  }

  // ===== System Configuration =====

  getSystemConfig() {
    return this.store.get('system', {
      autoStart: false,
      minimizeToTray: true,
      checkUpdates: true
    });
  }

  setSystemConfig(config) {
    this.store.set('system', config);
  }

  // ===== License Configuration =====

  getLicenseInfo() {
    return this.store.get('license', {});
  }

  setLicenseInfo(licenseInfo) {
    this.store.set('license', licenseInfo);
  }

  // ===== First Run =====

  isFirstRun() {
    return !this.store.get('firstRunComplete', false);
  }

  markFirstRunComplete() {
    this.store.set('firstRunComplete', true);
  }

  // ===== Utility Methods =====

  reset() {
    this.store.clear();
  }

  exportConfig() {
    const config = this.store.store;
    const safe = { ...config };
    delete safe.email?.appPassword;
    delete safe.anthropic?.apiKey;
    delete safe.license;
    return safe;
  }

  importConfig(config) {
    const { email, anthropic, license, ...safeConfig } = config;
    Object.keys(safeConfig).forEach(key => {
      this.store.set(key, safeConfig[key]);
    });
  }

  getConfigPath() {
    return this.store.path;
  }
}

// Export singleton instance
const configManager = new ConfigManager();
export default configManager;
