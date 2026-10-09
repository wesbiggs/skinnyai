import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import './config.js';
import os from 'node:os';
import { CONFIG, SKINNY_HOME } from './config.js';
import { commitCount, messageCount, readChat, redactChat, stampOf, verifyChat, writeChat } from './chatdb.js';

// Sessions saved on this machine, one SQLite file per name (see chatdb.js),
// so they work with any server and hold the whole conversation: tool calls,
// attachments, and which model said what. The Modelfile format (FROM, SYSTEM,
// PARAMETER, MESSAGE) is what /share sends to an Ollama server and what
// /export can write; sessions saved as .Modelfile by earlier versions still
// load, and are written as .skinny files the next time they're saved.
//
// Sessions can live on an encrypted volume mounted over the sessions folder
// (docs/encrypted-sessions.md). config.json then says so ("encryptedSessions":
// true, or { "mountPoint": "/path" } to put the folder elsewhere), and
// skinnyai refuses to read or write sessions unless the volume is mounted:
// the marker file only exists inside it. That keeps a locked volume from
// turning into chats quietly saved in plain text next to it.
const encrypted = CONFIG?.encryptedSessions;
export const SESSIONS_ENCRYPTED = Boolean(encrypted);
export const SESSION_DIR = typeof encrypted === 'object' && encrypted?.mountPoint
  ? path.resolve(String(encrypted.mountPoint).replace(/^~(?=\/|$)/, os.homedir()))
  : path.join(SKINNY_HOME, 'sessions');
export const VOLUME_MARKER = '.skinny-encrypted';
export const SESSION_SUFFIX = '.skinny';
export const LEGACY_SUFFIX = '.Modelfile';

export const LOCKED_MESSAGE = `Encrypted sessions are locked, so chats can't be saved, listed, or opened. Unlock them with the SkinnyAI app or scripts/sessions-volume.sh unlock (see docs/encrypted-sessions.md).`;

export class SessionsLockedError extends Error {
  constructor() {
    super(LOCKED_MESSAGE);
    this.name = 'SessionsLockedError';
  }
}

// Whether sessions are set up to be encrypted but the volume isn't mounted.
export const sessionsLocked = () => SESSIONS_ENCRYPTED && !existsSync(path.join(SESSION_DIR, VOLUME_MARKER));

function requireUnlocked() {
  if (sessionsLocked()) throw new SessionsLockedError();
}

// Names can hold anything a model name can (like 'me/chat:v2'), so they're
// URL-encoded into safe filenames, except that spaces stay spaces.
export function sessionPath(name) {
  return path.join(SESSION_DIR, encodeURIComponent(name).replace(/%20/g, ' ') + SESSION_SUFFIX);
}

// The Modelfile an earlier version saved under this name, if there is one.
// (Earlier versions also wrote spaces as %20; those files are still found.)
export function legacySessionPath(name) {
  const file = path.join(SESSION_DIR, encodeURIComponent(name).replace(/%20/g, ' ') + LEGACY_SUFFIX);
  const old = path.join(SESSION_DIR, encodeURIComponent(name) + LEGACY_SUFFIX);
  return old !== file && !existsSync(file) && existsSync(old) ? old : file;
}

// How to resume a saved session, for the message after saving: the app has a
// menu item; otherwise it's the command this process was started with (a
// symlink like ~/.local/bin/skinnyai shows as just 'skinnyai').
export function resumeHint(name, { termProgram = process.env.TERM_PROGRAM, script = process.argv[1] } = {}) {
  if (termProgram === 'SkinnyAI') return 'use File > Open Chat...';
  const command = (script && path.basename(script)) || 'skinnyai';
  return `start with: ${command} ${/[\s'"]/.test(name) ? `'${name.replace(/'/g, "'\\''")}'` : name}`;
}

// A triple-quoted Modelfile value. Ollama's format has no escape for a
// literal """ inside one, so it's written as ""\" and turned back on load.
export function quoteModelfile(text) {
  return `"""${text.replace(/"""/g, '""\\"')}"""`;
}

// The `# name: value` comments formatModelfile writes, read back by /load.
export const SAVED_SETTINGS = ['api', 'host', 'format', 'think', 'show thinking', 'tools', 'date', 'markdown', 'images', 'verbose', 'keep-alive', 'stop on exit'];

export function formatModelfile({ from, system, parameters, messages, settings = {} }) {
  const lines = [`# Saved by skinnyai on ${new Date().toISOString()}`];
  // Session settings that have no Modelfile instruction go in comments,
  // which Ollama and parseModelfile ignore.
  for (const [name, value] of Object.entries(settings)) {
    if (value !== undefined && value !== '') lines.push(`# ${name}: ${String(value).replace(/\s+/g, ' ')}`);
  }
  lines.push(`FROM ${from}`);
  for (const [name, value] of Object.entries(parameters)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      lines.push(`PARAMETER ${name} ${typeof v === 'string' && /\s|"/.test(v) ? JSON.stringify(v) : v}`);
    }
  }
  if (system) lines.push(`SYSTEM ${quoteModelfile(system)}`);
  for (const { role, content } of messages) lines.push(`MESSAGE ${role} ${quoteModelfile(content)}`);
  return lines.join('\n') + '\n';
}

// Reads the Modelfile subset formatModelfile writes (plus comments and
// single-line values), returning { from, system, parameters: [[name, value]],
// messages }. Other instructions (TEMPLATE, LICENSE, ...) are skipped.
export function parseModelfile(text) {
  const session = { from: '', system: '', parameters: [], messages: [], settings: {} };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const setting = /^#\s*([a-z][a-z-]*(?: [a-z]+)*):\s*(.*?)\s*$/.exec(lines[i]);
    if (setting && SAVED_SETTINGS.includes(setting[1])) {
      session.settings[setting[1]] = setting[2];
      continue;
    }
    const match = /^\s*([A-Za-z]+)\s+(.*)$/.exec(lines[i]);
    if (!match || lines[i].trimStart().startsWith('#')) continue;
    const instruction = match[1].toUpperCase();
    let args = match[2];
    let role = '';
    if (instruction === 'MESSAGE') {
      [, role, args] = /^(\S+)\s*(.*)$/.exec(args) || ['', '', ''];
    }

    // A value is either the rest of the line (optionally "quoted") or a
    // """block""" that runs until a line ending in """.
    let value = args.trim();
    if (value.startsWith('"""')) {
      const body = [value.slice(3)];
      while (!/"""\s*$/.test(body[body.length - 1]) && i + 1 < lines.length) body.push(lines[++i]);
      value = body.join('\n').replace(/"""\s*$/, '').replace(/""\\"/g, '"""');
    } else if (/^".*"$/.test(value)) {
      try {
        value = JSON.parse(value);
      } catch (e) {
        value = value.slice(1, -1);
      }
    }

    if (instruction === 'FROM') session.from = value;
    else if (instruction === 'SYSTEM') session.system = value;
    else if (instruction === 'PARAMETER') {
      const [, name, rest] = /^(\S+)\s+(.*)$/s.exec(args.trim()) || [];
      if (name) session.parameters.push([name, /^".*"$/.test(rest) ? JSON.parse(rest) : rest]);
    } else if (instruction === 'MESSAGE' && role) session.messages.push({ role: role.toLowerCase(), content: value });
  }
  return session;
}

// Identifies the version of a session on disk (null if there's none), so a
// chat can tell whether another process saved over it: the chat file's
// revision, or for a Modelfile from an earlier version its mtime and size.
export async function sessionStamp(name) {
  requireUnlocked();
  if (existsSync(sessionPath(name))) return stampOf(sessionPath(name));
  try {
    const { mtimeMs, size } = await fs.stat(legacySessionPath(name));
    return `${mtimeMs}:${size}`;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Saves a session ({ from, system, parameters, messages, settings }) and
// returns the path written. `after` is the id of the last message the file
// already has from this conversation, so only the ones after it are added;
// `replace` discards an existing chat file of that name first (see writeChat).
export async function saveLocalSession(name, session, { after = null, replace = false } = {}) {
  requireUnlocked();
  await fs.mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
  const file = sessionPath(name);
  writeChat(file, session, { after, replace });
  return file;
}

// Returns the session (with the `stamp` it had just before it was read, and
// `persistedHead`, the id of its last message), or null if none is saved
// under that name. A Modelfile from an earlier version is read as text only.
export async function readLocalSession(name) {
  requireUnlocked();
  try {
    const stamp = await sessionStamp(name);
    if (existsSync(sessionPath(name))) {
      const session = readChat(sessionPath(name));
      return { ...session, stamp, persistedHead: session.last };
    }
    const session = parseModelfile(await fs.readFile(legacySessionPath(name), 'utf8'));
    return { ...session, stamp, persistedHead: null };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Whether the name is taken, by a chat file or an old Modelfile.
export async function localSessionExists(name) {
  requireUnlocked();
  return existsSync(sessionPath(name)) || existsSync(legacySessionPath(name));
}

// Whether there is a chat file by that name (what /delete can remove).
export async function chatFileExists(name) {
  requireUnlocked();
  return existsSync(sessionPath(name));
}

// Removes the chat file only: a Modelfile from an earlier version is left
// alone, like any exported copy.
export async function deleteLocalSession(name) {
  requireUnlocked();
  await fs.rm(sessionPath(name), { force: true });
}

// /purge in a saved chat: `messages` is the conversation after the purge.
export function redactLocalSession(name, kind, messages) {
  requireUnlocked();
  redactChat(sessionPath(name), kind, messages);
}

export { commitCount, messageCount, verifyChat };

// Whether a session still has the name autosave gave it (see autosaveName).
export function isAutosaveName(name) {
  return /^chat-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/.test(name);
}

// Name for a new autosaved session, from the local date and time, e.g.
// 'chat-2026-09-30-154907', with a -2, -3, ... suffix if that's taken (say,
// two conversations started within a second of each other via /new).
export async function autosaveName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const base = `chat-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!await localSessionExists(name)) return name;
  }
}

export async function listLocalSessions() {
  if (sessionsLocked()) return [];
  try {
    const files = await fs.readdir(SESSION_DIR);
    const names = files
      .filter((f) => f.endsWith(SESSION_SUFFIX) || f.endsWith(LEGACY_SUFFIX))
      .map((f) => decodeURIComponent(f.slice(0, f.endsWith(SESSION_SUFFIX) ? -SESSION_SUFFIX.length : -LEGACY_SUFFIX.length)));
    return [...new Set(names)].sort();
  } catch (error) {
    return [];
  }
}

// Turns a model's reply to "give a short title" into a name for a chat, or
// null if it isn't usable: thinking text, a "Title:" label, quotes, markup
// and closing punctuation are dropped, and it's kept short.
export function tidyTitle(text) {
  let title = String(text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  title = title.replace(/^(#+\s*|title\s*:\s*)/i, '').replace(/^["'`*_\s]+|["'`*_\s]+$/g, '').replace(/[.!?:;,\s]+$/, '').replace(/\s+/g, ' ');
  if (title.length > 60) title = title.slice(0, 60).replace(/\s+\S*$/, '');
  return title.length >= 2 ? title : null;
}

// `base` if no saved session has that name, otherwise 'base (2)', 'base (3)', ...
export async function uniqueSessionName(base) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} (${n})`;
    if (!await localSessionExists(name)) return name;
  }
}
