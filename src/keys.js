import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SKINNY_HOME } from './config.js';

// A project is a group of chats that share one key, and a folder that
// carries them (see sync.js). The key is random, never goes in the folder,
// and is kept here: in the macOS Keychain (one item per project), or
// otherwise in a file only you can read. The project id is a hash of it,
// so a folder can say which key it needs without revealing the key. To
// share a project, give the other person the key as text, by some other
// route than the folder.

export const KEYS_FILE = path.join(SKINNY_HOME, 'project-keys');
const KEYCHAIN_SERVICE = 'skinnyai-project-key';
const SECURITY = '/usr/bin/security';

export const generateProjectKey = () => randomBytes(32);

// The id a project's folder carries: a keyed, domain-separated hash of the key.
export const projectId = (key) => createHmac('sha256', key).update('skinnyai project id v1').digest('hex').slice(0, 32);

// --- Project key as text: Crockford base32, 32 bytes plus a 4-character check, in groups of four ---

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function toBase32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of text) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const checksum = (key) => toBase32(createHash('sha256').update(key).digest().subarray(0, 3)).slice(0, 4);

export function encodeProjectKey(key) {
  return `${toBase32(key)}${checksum(key)}`.match(/.{1,4}/g).join('-');
}

// Returns the key, or throws if the text isn't a project key (a typo
// anywhere is caught by the check characters).
export function decodeProjectKey(text) {
  const clean = text.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (clean.length !== 56 || [...clean].some((c) => !ALPHABET.includes(c))) throw new Error("that doesn't look like a project key");
  const key = fromBase32(clean.slice(0, 52)).subarray(0, 32);
  if (checksum(key) !== clean.slice(52)) throw new Error("that project key has a typo (the check characters don't match)");
  return key;
}

// --- Where the keys are kept ---

// SKINNY_PROJECT_KEYS (project keys as text, comma-separated) adds keys for
// machines with no keychain; SKINNY_KEY_STORE=file|keychain forces one store.
const useKeychain = () => (process.env.SKINNY_KEY_STORE ? process.env.SKINNY_KEY_STORE === 'keychain' : process.platform === 'darwin' && existsSync(SECURITY));
const account = (id) => id;

function readKeyFile() {
  try {
    return JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
  } catch (error) {
    return {};
  }
}

function writeKeyFile(keys) {
  mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
  const temp = `${KEYS_FILE}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(temp, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, KEYS_FILE);
}

export function loadProjectKey(id) {
  for (const text of (process.env.SKINNY_PROJECT_KEYS || '').split(',').map((t) => t.trim()).filter(Boolean)) {
    try {
      const key = decodeProjectKey(text);
      if (projectId(key) === id) return key;
    } catch (error) {
      // Not a key; ignore it.
    }
  }
  try {
    const text = useKeychain()
      ? execFileSync(SECURITY, ['find-generic-password', '-a', account(id), '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      : readKeyFile()[id];
    const key = decodeProjectKey((text ?? '').trim());
    return projectId(key) === id ? key : null;
  } catch (error) {
    return null;
  }
}

// Stores the key under its own id, returning where it went.
export function saveProjectKey(key) {
  const id = projectId(key);
  if (useKeychain()) {
    execFileSync(SECURITY, ['add-generic-password', '-U', '-a', account(id), '-s', KEYCHAIN_SERVICE, '-w', encodeProjectKey(key)], { stdio: 'ignore' });
    return 'the macOS Keychain';
  }
  writeKeyFile({ ...readKeyFile(), [id]: encodeProjectKey(key) });
  return KEYS_FILE;
}

export function removeProjectKey(id) {
  if (useKeychain()) {
    try {
      execFileSync(SECURITY, ['delete-generic-password', '-a', account(id), '-s', KEYCHAIN_SERVICE], { stdio: 'ignore' });
    } catch (error) {
      // Not there.
    }
  } else {
    const keys = readKeyFile();
    delete keys[id];
    if (Object.keys(keys).length) writeKeyFile(keys);
    else rmSync(KEYS_FILE, { force: true });
  }
}
