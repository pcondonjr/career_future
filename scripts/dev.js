#!/usr/bin/env node
/**
 * Dev launcher for Career Future.
 * Ensures ELECTRON_RUN_AS_NODE is unset before launching electron-vite dev.
 * (VSCode/IDE terminals may set this, which breaks Electron's module system.)
 */
import { execSync } from 'child_process';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

try {
  execSync('npx electron-vite dev', { stdio: 'inherit', env });
} catch (e) {
  process.exit(e.status ?? 1);
}

child.on('exit', (code) => process.exit(code ?? 1));
