import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SKINNY_HOME } from './config.js';

// Which folder this device syncs through. It's a property of the
// installation, not of a profile, so it has its own small file;
// SKINNY_SYNC_DIR overrides it (and turns sync on without /sync setup).
export const SYNC_CONFIG_FILE = path.join(SKINNY_HOME, 'sync.json');

export function syncFolder() {
  if (process.env.SKINNY_SYNC_DIR) return path.resolve(process.env.SKINNY_SYNC_DIR);
  try {
    const folder = JSON.parse(readFileSync(SYNC_CONFIG_FILE, 'utf8')).folder;
    return typeof folder === 'string' && folder ? folder : null;
  } catch (error) {
    return null;
  }
}

export function setSyncFolder(folder) {
  mkdirSync(path.dirname(SYNC_CONFIG_FILE), { recursive: true });
  writeFileSync(SYNC_CONFIG_FILE, `${JSON.stringify({ folder }, null, 2)}\n`);
}

export function clearSyncFolder() {
  rmSync(SYNC_CONFIG_FILE, { force: true });
}
