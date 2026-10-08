import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SKINNY_HOME } from './config.js';

// The vault key is the one secret behind synced chats: every chat key comes
// from it (see seal.js). It lives in the macOS Keychain, or elsewhere in a
// file only you can read, and is never written to the sync folder. The
// recovery key is the same 256 bits as text, to put on a second device and
// to keep somewhere safe: lose both and synced chats can't be read.

export const VAULT_FILE = path.join(SKINNY_HOME, 'vault.key');
const KEYCHAIN_SERVICE = 'skinnyai-vault';
const SECURITY = '/usr/bin/security';

export const generateVaultKey = () => randomBytes(32);

// What goes beside the synced files so a device can tell it has the right
// key without being able to derive it.
export const vaultCheck = (key) => createHmac('sha256', key).update('skinnyai vault check v1').digest('hex');

// --- Recovery key: Crockford base32, 32 bytes plus a 4-character check, in groups of four ---

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

export function encodeRecoveryKey(key) {
  return `${toBase32(key)}${checksum(key)}`.match(/.{1,4}/g).join('-');
}

// Returns the key, or throws if the text isn't a recovery key (a typo
// anywhere is caught by the check characters).
export function decodeRecoveryKey(text) {
  const clean = text.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (clean.length !== 56 || [...clean].some((c) => !ALPHABET.includes(c))) throw new Error("that doesn't look like a recovery key");
  const key = fromBase32(clean.slice(0, 52)).subarray(0, 32);
  if (checksum(key) !== clean.slice(52)) throw new Error("that recovery key has a typo (the check characters don't match)");
  return key;
}

// --- Where the key is kept ---

// SKINNY_VAULT_KEY (a recovery key) wins, for machines with no keychain;
// SKINNY_VAULT_STORE=file|keychain forces one store.
const useKeychain = () => (process.env.SKINNY_VAULT_STORE ? process.env.SKINNY_VAULT_STORE === 'keychain' : process.platform === 'darwin' && existsSync(SECURITY));
const account = () => os.userInfo().username;

export function loadVaultKey() {
  if (process.env.SKINNY_VAULT_KEY) return decodeRecoveryKey(process.env.SKINNY_VAULT_KEY);
  try {
    const text = useKeychain()
      ? execFileSync(SECURITY, ['find-generic-password', '-a', account(), '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      : readFileSync(VAULT_FILE, 'utf8');
    return decodeRecoveryKey(text.trim());
  } catch (error) {
    return null;
  }
}

export function saveVaultKey(key) {
  const text = encodeRecoveryKey(key);
  if (useKeychain()) {
    execFileSync(SECURITY, ['add-generic-password', '-U', '-a', account(), '-s', KEYCHAIN_SERVICE, '-w', text], { stdio: 'ignore' });
    return 'the macOS Keychain';
  }
  mkdirSync(path.dirname(VAULT_FILE), { recursive: true });
  writeFileSync(VAULT_FILE, `${text}\n`, { mode: 0o600 });
  chmodSync(VAULT_FILE, 0o600);
  return VAULT_FILE;
}

export function removeVaultKey() {
  if (useKeychain()) {
    try {
      execFileSync(SECURITY, ['delete-generic-password', '-a', account(), '-s', KEYCHAIN_SERVICE], { stdio: 'ignore' });
    } catch (error) {
      // Not there.
    }
  } else {
    rmSync(VAULT_FILE, { force: true });
  }
}
