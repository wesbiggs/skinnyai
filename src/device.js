import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { SKINNY_HOME } from './config.js';

// Who is writing: an id that stays with this installation (chat files record
// it on every commit, so changes made on two machines can be told apart) and
// a human-readable name, taken from the machine's name the first time and
// free to edit afterwards. It lives beside the chats, not in them, so a chat
// file copied to another machine doesn't bring its device along.
export const DEVICE_FILE = path.join(SKINNY_HOME, 'device');

let cached = null;

export function deviceInfo() {
  if (cached) return cached;
  try {
    const saved = JSON.parse(readFileSync(DEVICE_FILE, 'utf8'));
    if (typeof saved.id === 'string' && saved.id) {
      cached = { id: saved.id, name: typeof saved.name === 'string' && saved.name ? saved.name : os.hostname() };
      return cached;
    }
  } catch (error) {
    // Missing or unreadable: make a new one below.
  }
  cached = { id: randomUUID(), name: os.hostname().replace(/\.local$/, '') || 'this device' };
  try {
    mkdirSync(SKINNY_HOME, { recursive: true, mode: 0o700 });
    writeFileSync(DEVICE_FILE, `${JSON.stringify(cached, null, 2)}\n`);
  } catch (error) {
    // Read-only home: the id lasts for this run.
  }
  return cached;
}
