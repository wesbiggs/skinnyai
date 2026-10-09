import fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKINNY_HOME } from './config.js';
import { SESSIONS_ENCRYPTED, SESSION_DIR, sessionsLocked } from './sessions.js';

// --- Debug log (--debug / SKINNY_DEBUG=true) ---
//
// One JSON object per line in $SKINNY_HOME/debug.log (readable only by you):
// every chat request (URL, model, messages, and the tools offered), the HTTP
// status that came back, each tool call with its arguments and result, and
// the MCP servers' tools. API keys are never written, and big strings (images,
// PDFs, long tool output) are cut down to a size note.

// With encrypted sessions the log goes inside the volume, since it holds the
// text of your conversations.
export const DEBUG_LOG = SESSIONS_ENCRYPTED ? path.join(SESSION_DIR, '.debug.log') : path.join(SKINNY_HOME, 'debug.log');
// Where /saveimage puts an image when given no path.
export const IMAGE_DIR = process.env.SKINNY_IMAGE_DIR || path.join(os.homedir(), 'Pictures', 'skinnyai');
export let debugEnabled = false;
export function setDebugEnabled(value) {
  debugEnabled = value;
}

// Returns false (and logs nothing) if the log would be in a locked volume.
export async function enableDebugLog() {
  if (sessionsLocked()) return false;
  debugEnabled = true;
  await fs.mkdir(SKINNY_HOME, { recursive: true, mode: 0o700 });
  await fs.appendFile(DEBUG_LOG, '', { mode: 0o600 });
  await fs.chmod(DEBUG_LOG, 0o600);
  return true;
}

export function abbreviate(value) {
  if (typeof value === 'string') {
    if (/^data:/i.test(value) || /^[A-Za-z0-9+/=\s]{400,}$/.test(value)) return `<${value.length} characters of encoded data>`;
    return value.length > 4000 ? `${value.slice(0, 4000)}…[${value.length - 4000} more characters]` : value;
  }
  if (Array.isArray(value)) return value.map(abbreviate);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, abbreviate(v)]));
  return value;
}

export function debugLog(event, details = {}) {
  if (!debugEnabled) return;
  try {
    appendFileSync(DEBUG_LOG, `${JSON.stringify({ time: new Date().toISOString(), event, ...abbreviate(details) })}\n`);
  } catch (error) {
    debugEnabled = false; // can't write it; stop trying rather than fail the chat
  }
}
