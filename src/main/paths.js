import { app } from 'electron';
import path from 'path';
import fs from 'fs';

/**
 * Get base path for read-only app resources (views, public, icons, CSVs).
 * Dev: project root. Packaged: resources/app-data/
 */
export function getResourcesPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app-data');
  }
  return path.resolve(import.meta.dirname, '../..');
}

/**
 * Get base path for writable user data (databases, logs, temp files).
 * Dev: project root. Packaged: %APPDATA%/Career Future/
 */
export function getWritablePath() {
  if (app.isPackaged) {
    return app.getPath('userData');
  }
  return path.resolve(import.meta.dirname, '../..');
}

/**
 * Resolve a relative path against the resources directory.
 */
export function resolveResourceFile(relativePath) {
  if (path.isAbsolute(relativePath)) return relativePath;
  return path.join(getResourcesPath(), relativePath);
}

/**
 * Resolve a relative path against the writable data directory.
 */
export function resolveWritableFile(relativePath) {
  if (path.isAbsolute(relativePath)) return relativePath;
  return path.join(getWritablePath(), relativePath);
}

/**
 * Copy a file from resources to writable path if it doesn't exist yet.
 * Used for first-run initialization of user-editable files (CSVs, etc).
 */
export function ensureWritableCopy(relativePath) {
  const src = resolveResourceFile(relativePath);
  const dest = resolveWritableFile(relativePath);

  if (!fs.existsSync(dest) && fs.existsSync(src)) {
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.copyFileSync(src, dest);
  }
  return dest;
}

/**
 * Find a system Chrome or Edge executable for puppeteer-core.
 */
export function findChromePath() {
  const candidates = [
    path.join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  return null;
}
