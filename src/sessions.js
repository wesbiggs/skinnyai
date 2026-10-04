import fs from 'node:fs/promises';
import path from 'node:path';
import './config.js';
import { SKINNY_HOME } from './config.js';

// Sessions saved on this machine, for servers that can't store them: only
// a self-hosted Ollama has /api/create, not ollama.com or OpenAI-compatible
// servers. They use the same Modelfile format /save creates on an Ollama
// server (FROM, SYSTEM, PARAMETER, MESSAGE), one file per name, so a saved
// session can also be turned into a real model with `ollama create -f`.
export const SESSION_DIR = path.join(SKINNY_HOME, 'sessions');
export const SESSION_SUFFIX = '.Modelfile';

// Names can hold anything a model name can (like 'me/chat:v2'), so they're
// URL-encoded into safe filenames.
export function sessionPath(name) {
  return path.join(SESSION_DIR, encodeURIComponent(name) + SESSION_SUFFIX);
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

export async function saveLocalSession(name, session) {
  await fs.mkdir(SESSION_DIR, { recursive: true });
  const file = sessionPath(name);
  await fs.writeFile(file, formatModelfile(session));
  return file;
}

// Returns the parsed session, or null if none is saved under that name.
export async function readLocalSession(name) {
  try {
    return parseModelfile(await fs.readFile(sessionPath(name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function localSessionExists(name) {
  try {
    await fs.access(sessionPath(name));
    return true;
  } catch (error) {
    return false;
  }
}

export async function deleteLocalSession(name) {
  await fs.rm(sessionPath(name), { force: true });
}

// Whether a session still has the name autosave gave it (see autosaveName).
export function isAutosaveName(name) {
  return /^chat-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/.test(name);
}

// Name for a new autosaved session, from the local date and time, e.g.
// 'chat-2026-09-30-154907', with a -2, -3, ... suffix if that's taken (say,
// two conversations started within a second of each other via /clear).
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
  try {
    const files = await fs.readdir(SESSION_DIR);
    return files.filter((f) => f.endsWith(SESSION_SUFFIX)).map((f) => decodeURIComponent(f.slice(0, -SESSION_SUFFIX.length))).sort();
  } catch (error) {
    return [];
  }
}
