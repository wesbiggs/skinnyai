import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chatIdOf, commitIds, createChat, exportCommit, importCommit, losingLines, markSplit, readChat, splitIds, writeSplitChat } from './chatdb.js';
import { blobName, chatKeys, openBlob, openCommit, sealBlob, sealCommit } from './seal.js';
import { vaultCheck } from './vault.js';

// Keeps chats in step across devices through a folder that something else
// (iCloud Drive, Dropbox, Syncthing, a network share) carries around. The
// folder holds only encrypted, immutable files, each written once under a
// name of its own, so devices never write to the same file:
//
//   skinnyai-sync/vault.json                        vault id and a key check
//   skinnyai-sync/chats/<chat id>/commits/<id>.c    one sealed commit
//   skinnyai-sync/chats/<chat id>/blobs/<name>.b    one sealed attachment
//
// A sync pushes the commits the folder lacks and applies the ones this
// device lacks, parents first (see seal.js for the formats). Commits that
// can't be applied yet, because a file they need hasn't arrived, wait for
// the next sync.

export const SYNC_DIR = 'skinnyai-sync';
export const SESSION_SUFFIX = '.skinny';

const root = (folder) => path.join(folder, SYNC_DIR);
const vaultFile = (folder) => path.join(root(folder), 'vault.json');
const chatDir = (folder, chatId) => path.join(root(folder), 'chats', chatId);

// Written beside the final name and renamed, so a syncing folder never
// shows another device half a file.
function writeOnce(file, data) {
  if (existsSync(file)) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(temp, data);
  renameSync(temp, file);
  return true;
}

const names = (dir, suffix) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(suffix)).map((f) => f.slice(0, -suffix.length)) : []);
const subdirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);

export function readVaultInfo(folder) {
  try {
    return JSON.parse(readFileSync(vaultFile(folder), 'utf8'));
  } catch (error) {
    return null;
  }
}

// Marks the folder as holding chats sealed under `key` (a no-op if it
// already does). Throws if it holds some other vault's.
export function initVault(folder, key) {
  const existing = readVaultInfo(folder);
  if (existing) {
    if (existing.check !== vaultCheck(key)) throw new Error(`${folder} holds chats sealed under a different key`);
    return existing;
  }
  const info = { format: 1, vault: randomUUID(), check: vaultCheck(key), created_at: new Date().toISOString() };
  mkdirSync(root(folder), { recursive: true });
  writeFileSync(vaultFile(folder), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

export const keyMatches = (folder, key) => readVaultInfo(folder)?.check === vaultCheck(key);

export const sessionFileName = (name) => encodeURIComponent(name).replace(/%20/g, ' ') + SESSION_SUFFIX;
export const nameFromFile = (file) => decodeURIComponent(path.basename(file).slice(0, -SESSION_SUFFIX.length));

function uniqueFile(sessionsDir, name) {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name} (${n})`;
    const file = path.join(sessionsDir, sessionFileName(candidate));
    if (!existsSync(file)) return { name: candidate, file };
  }
}

// The chat files in a sessions directory, by chat id. Files that can't be
// read are reported, not fatal.
function localChats(sessionsDir, errors) {
  const chats = new Map();
  if (!existsSync(sessionsDir)) return chats;
  for (const entry of readdirSync(sessionsDir)) {
    if (!entry.endsWith(SESSION_SUFFIX)) continue;
    const file = path.join(sessionsDir, entry);
    try {
      const id = chatIdOf(file);
      if (id) chats.set(id, file);
    } catch (error) {
      errors.push(`${entry}: ${error.message}`);
    }
  }
  return chats;
}

function push(folder, chatId, file, keys, report) {
  const have = new Set(names(path.join(chatDir(folder, chatId), 'commits'), '.c'));
  for (const id of commitIds(file)) {
    if (have.has(id)) continue;
    const { payload, blobs } = exportCommit(file, id, (sha) => blobName(keys, sha));
    // Attachments first, so nobody sees a commit whose files aren't there.
    for (const blob of blobs) writeOnce(path.join(chatDir(folder, chatId), 'blobs', `${blob.name}.b`), sealBlob(keys, chatId, blob.name, blob.bytes));
    writeOnce(path.join(chatDir(folder, chatId), 'commits', `${id}.c`), sealCommit(keys, chatId, id, payload));
    report.pushed++;
  }
}

// Applies the commits this device lacks, returning the file (made if the chat
// is new here) or null if there was nothing to apply.
function pull(folder, chatId, file, keys, sessionsDir, report) {
  const dir = path.join(chatDir(folder, chatId), 'commits');
  const local = file ? new Set(commitIds(file)) : new Set();
  const pending = new Map();
  for (const id of names(dir, '.c')) {
    if (local.has(id)) continue;
    try {
      pending.set(id, openCommit(keys, chatId, id, readFileSync(path.join(dir, `${id}.c`))));
    } catch (error) {
      report.errors.push(`commit ${id.slice(0, 8)} of ${chatId.slice(0, 8)}: ${error.message}`);
    }
  }
  if (!pending.size) return null;

  const incoming = file ?? path.join(sessionsDir, `${chatId}.incoming`);
  if (!file) {
    mkdirSync(sessionsDir, { recursive: true });
    rmSync(incoming, { force: true });
    createChat(incoming, chatId, [...pending.values()][0].chat_created_at);
  }
  const getBlob = (ref) => {
    const blobFile = path.join(chatDir(folder, chatId), 'blobs', `${ref.name}.b`);
    if (!existsSync(blobFile)) return null;
    try {
      return openBlob(keys, chatId, ref.name, readFileSync(blobFile));
    } catch (error) {
      report.errors.push(`attachment ${ref.name.slice(0, 8)} of ${chatId.slice(0, 8)}: ${error.message}`);
      return null;
    }
  };
  let progress = true;
  let applied = 0;
  while (pending.size && progress) {
    progress = false;
    for (const [id, payload] of [...pending].sort((a, b) => a[1].lamport - b[1].lamport)) {
      if (importCommit(incoming, payload, getBlob) !== 'waiting') {
        pending.delete(id);
        applied++;
        progress = true;
      }
    }
  }
  report.pulled += applied;
  report.waiting += pending.size;
  if (file) return applied ? file : null;
  if (!applied) {
    rmSync(incoming, { force: true });
    return null;
  }
  const named = readChat(incoming).name || `chat-${chatId.slice(0, 8)}`;
  const target = uniqueFile(sessionsDir, named);
  renameSync(incoming, target.file);
  report.newChats.push(target.name);
  return target.file;
}

// Two devices added to the same message: the line that lost (see readChat)
// becomes a chat of its own, "<name> (from <device>)". Its ids are fixed by
// the fork, so every device that splits it makes the same chat.
function splitForks(file, chatId, sessionsDir, known, report) {
  const { name: stored, state, lines } = losingLines(file);
  const name = stored || nameFromFile(file);
  const copies = [];
  for (const { tip, deviceName, createdAt, line } of lines) {
    const ids = splitIds(chatId, tip);
    if (!known.has(ids.chatId)) {
      const target = uniqueFile(sessionsDir, `${name} (from ${deviceName})`);
      const copyState = state.filter(([key]) => key !== 'name').concat([['name', target.name]]);
      writeSplitChat(target.file, { ...ids, createdAt, state: copyState, line });
      known.set(ids.chatId, target.file);
      copies.push([ids.chatId, target.file]);
      report.splits.push({ chat: name, copy: target.name, device: deviceName });
    }
    markSplit(file, tip);
  }
  return copies;
}

const tombstone = (folder, chatId) => path.join(chatDir(folder, chatId), 'deleted');

// /delete on a synced chat: its files leave the folder, and a sealed marker
// stays so that other devices delete their copies at their next sync.
export function deleteSyncedChat({ folder, key, chatId }) {
  const info = readVaultInfo(folder);
  if (!info || info.check !== vaultCheck(key)) return false;
  for (const dir of ['commits', 'blobs']) rmSync(path.join(chatDir(folder, chatId), dir), { recursive: true, force: true });
  writeOnce(tombstone(folder, chatId), sealCommit(chatKeys(key, chatId), chatId, 'deleted', { deleted_at: new Date().toISOString() }));
  return true;
}

// Sends one chat's new commits (what happens after each save).
export function pushChat({ folder, key, file }) {
  const info = readVaultInfo(folder);
  if (!info || info.check !== vaultCheck(key)) return 0;
  const chatId = chatIdOf(file);
  if (!chatId) return 0;
  const report = { pushed: 0 };
  push(folder, chatId, file, chatKeys(key, chatId), report);
  return report.pushed;
}

// One sync of every chat in `sessionsDir` with the folder. Returns
// { pushed, pulled, newChats, updated, splits, waiting, errors }; `updated`
// lists the existing chats that received commits (by file).
export function syncChats({ folder, key, sessionsDir }) {
  const info = readVaultInfo(folder);
  if (!info) throw new Error(`${folder} has no synced chats yet (run /sync setup)`);
  if (info.check !== vaultCheck(key)) throw new Error("this device's key doesn't open the chats in that folder");
  const report = { pushed: 0, pulled: 0, newChats: [], updated: [], splits: [], deleted: [], waiting: 0, errors: [] };
  const local = localChats(sessionsDir, report.errors);
  const remote = subdirs(path.join(root(folder), 'chats'));
  for (const chatId of new Set([...local.keys(), ...remote])) {
    const keys = chatKeys(key, chatId);
    let file = local.get(chatId) ?? null;
    try {
      if (existsSync(tombstone(folder, chatId))) {
        openCommit(keys, chatId, 'deleted', readFileSync(tombstone(folder, chatId)));
        if (file) {
          report.deleted.push({ name: nameFromFile(file), file });
          rmSync(file, { force: true });
          local.delete(chatId);
        }
        continue;
      }
      if (file) push(folder, chatId, file, keys, report);
      const pulled = pull(folder, chatId, file, keys, sessionsDir, report);
      if (pulled && file) report.updated.push(file);
      file = pulled ?? file;
      if (file) local.set(chatId, file);
      if (file) {
        for (const [copyId, copyFile] of splitForks(file, chatId, sessionsDir, local, report)) push(folder, copyId, copyFile, chatKeys(key, copyId), report);
      }
    } catch (error) {
      report.errors.push(`${chatId.slice(0, 8)}: ${error.message}`);
    }
  }
  return report;
}

// A line for the user about what a sync did, or '' if nothing changed.
export function describeSync(report) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts = [];
  if (report.pulled) parts.push(`received ${plural(report.pulled, 'change')}`);
  if (report.pushed) parts.push(`sent ${plural(report.pushed, 'change')}`);
  if (report.newChats.length) parts.push(`new ${report.newChats.length === 1 ? 'chat' : 'chats'}: ${report.newChats.map((n) => `'${n}'`).join(', ')}`);
  if (report.deleted.length) parts.push(`deleted on another device: ${report.deleted.map((d) => `'${d.name}'`).join(', ')}`);
  if (report.waiting) parts.push(`${plural(report.waiting, 'change')} waiting for files that haven't arrived`);
  return parts.length ? `Synced: ${parts.join('; ')}.` : '';
}
