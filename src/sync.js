import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chatIdOf, chatProjectOf, chatState, commitIds, createChat, exportCommit, importCommit, losingLines, markSplit, readChat, setChatProject, splitIds, writeSplitChat } from './chatdb.js';
import { deviceInfo } from './device.js';
import { projectId } from './keys.js';
import { blobName, chatKeys, openBlob, openCommit, openProjectName, sealBlob, sealCommit, sealProjectName } from './seal.js';

// Keeps the chats of a project in step across devices through a folder that
// something else (iCloud Drive, Dropbox, Syncthing, a network share)
// carries around. The folder holds only encrypted, immutable files, each
// written once under a name of its own, so devices never write to the same
// file:
//
//   skinnyai-sync/project.json                      project id (a hash of the key), sealed_name (encrypted)
//   skinnyai-sync/chats/<chat id>/commits/<id>.c    one sealed commit
//   skinnyai-sync/chats/<chat id>/blobs/<name>.b    one sealed attachment
//   skinnyai-sync/chats/<chat id>/deleted           sealed marker: the chat was deleted
//
// A sync pushes the commits the folder lacks and applies the ones this
// device lacks, parents first (see seal.js for the formats). Commits that
// can't be applied yet, because a file they need hasn't arrived, wait for
// the next sync. A project is one folder and one key; a chat belongs to
// one project, and to read it you need that project's key.

export const SYNC_DIR = 'skinnyai-sync';
export const SESSION_SUFFIX = '.skinny';

const root = (folder) => path.join(folder, SYNC_DIR);
const projectFile = (folder) => path.join(root(folder), 'project.json');
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

// What the folder says about its project: { project: id, created_at,
// sealed_name } (the name is encrypted; see suggestedName), or null if it
// isn't one.
export function readProject(folder) {
  try {
    const info = JSON.parse(readFileSync(projectFile(folder), 'utf8'));
    return info && typeof info.project === 'string' ? info : null;
  } catch (error) {
    return null;
  }
}

// Marks the folder as the project whose key is `key`, with `name` sealed in
// it as a suggestion. Throws if the folder already belongs to another project.
export function initProject(folder, key, name) {
  const id = projectId(key);
  const existing = readProject(folder);
  if (existing) {
    if (existing.project !== id) throw new Error(`${folder} already belongs to a different project`);
    return existing;
  }
  const info = { format: 2, project: id, created_at: new Date().toISOString(), sealed_name: sealProjectName(key, id, name).toString('base64') };
  mkdirSync(root(folder), { recursive: true });
  writeFileSync(projectFile(folder), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

export const keyOpensProject = (folder, key) => readProject(folder)?.project === projectId(key);

// The name its creator gave the project, or null if the key doesn't open it.
export function suggestedName(folder, key) {
  const info = readProject(folder);
  const sealed = info?.sealed_name ?? info?.name; // `name` is what the first builds called it
  if (!info || info.project !== projectId(key) || !sealed) return null;
  try {
    return openProjectName(key, info.project, Buffer.from(sealed, 'base64'));
  } catch (error) {
    return null;
  }
}

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
function pull(folder, project, chatId, file, keys, sessionsDir, report) {
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
    createChat(incoming, chatId, [...pending.values()][0].chat_created_at, project);
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
function splitForks(file, project, chatId, sessionsDir, known, report) {
  const { name: stored, state, lines } = losingLines(file);
  const name = stored || nameFromFile(file);
  const copies = [];
  for (const { tip, deviceName, createdAt, line } of lines) {
    const ids = splitIds(chatId, tip);
    if (!known.has(ids.chatId)) {
      const target = uniqueFile(sessionsDir, `${name} (from ${deviceName})`);
      const copyState = state.filter(([key]) => key !== 'name').concat([['name', target.name]]);
      writeSplitChat(target.file, { ...ids, createdAt, state: copyState, line, project });
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
// stays so that other devices delete their copies at their next sync. (A
// chat moved to another project leaves the same marker, and nothing about
// where it went.)
export function deleteSyncedChat({ folder, key, chatId }) {
  if (!keyOpensProject(folder, key)) return false;
  for (const dir of ['commits', 'blobs']) rmSync(path.join(chatDir(folder, chatId), dir), { recursive: true, force: true });
  writeOnce(tombstone(folder, chatId), sealCommit(chatKeys(key, chatId), chatId, 'deleted', { deleted_at: new Date().toISOString() }));
  return true;
}

// Sends one chat's new commits (what happens after each save).
export function pushChat({ folder, key, file }) {
  if (!keyOpensProject(folder, key)) return 0;
  const chatId = chatIdOf(file);
  if (!chatId) return 0;
  const report = { pushed: 0 };
  push(folder, chatId, file, chatKeys(key, chatId), report);
  return report.pushed;
}

// Puts every chat that has no project yet into `project`.
export function adoptUnassigned(sessionsDir, project) {
  let adopted = 0;
  for (const entry of existsSync(sessionsDir) ? readdirSync(sessionsDir) : []) {
    if (!entry.endsWith(SESSION_SUFFIX)) continue;
    try {
      if (!chatProjectOf(path.join(sessionsDir, entry))) {
        setChatProject(path.join(sessionsDir, entry), project);
        adopted++;
      }
    } catch (error) {
      // A file that isn't a readable chat is left alone.
    }
  }
  return adopted;
}

// A copy of a chat as a new chat of its own (new id, one commit) in another
// project. By default it gets a free name beside the original; `name` and `to`
// set both, for a move that takes the original's place. Returns { file, name }.
export function copyChat({ file, sessionsDir, project, name = null, to = null }) {
  const read = readChat(file);
  const target = to ? { name: name ?? read.name ?? nameFromFile(file), file: to } : uniqueFile(sessionsDir, name ?? (read.name || nameFromFile(file)));
  const state = chatState(file).filter(([key]) => key !== 'name').concat([['name', target.name]]);
  writeSplitChat(target.file, {
    chatId: randomUUID(),
    commitId: randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
    state,
    line: read.messages,
    project,
    device: deviceInfo()
  });
  return { file: target.file, name: target.name };
}

const emptyReport = () => ({ pushed: 0, pulled: 0, newChats: [], updated: [], splits: [], deleted: [], waiting: 0, errors: [] });

// One sync of a project's chats in `sessionsDir` with its folder, adding to
// `report` (see describeSync); `report.updated` lists the existing chats
// that received commits (by file).
export function syncProject({ project, key, sessionsDir, report = emptyReport() }) {
  if (!readProject(project.folder)) throw new Error(`${project.folder} isn't a project folder (no project.json; is the folder still syncing down?)`);
  if (!keyOpensProject(project.folder, key)) throw new Error("this device's key doesn't open the project in that folder");
  const folder = project.folder;
  const everywhere = localChats(sessionsDir, report.errors); // chat id -> file, in any project
  const local = new Map([...everywhere].filter(([, file]) => chatProjectOf(file) === project.id));
  const remote = subdirs(path.join(root(folder), 'chats'));
  for (const chatId of new Set([...local.keys(), ...remote])) {
    if (!local.has(chatId) && everywhere.has(chatId)) {
      report.errors.push(`${chatId.slice(0, 8)}: this chat is in another project on this device, so the copy in '${project.name}' was skipped`);
      continue;
    }
    const keys = chatKeys(key, chatId);
    let file = local.get(chatId) ?? null;
    try {
      if (existsSync(tombstone(folder, chatId))) {
        openCommit(keys, chatId, 'deleted', readFileSync(tombstone(folder, chatId)));
        if (file) {
          report.deleted.push({ name: nameFromFile(file), file });
          rmSync(file, { force: true });
          local.delete(chatId);
          everywhere.delete(chatId);
        }
        continue;
      }
      if (file) push(folder, chatId, file, keys, report);
      const pulled = pull(folder, project.id, chatId, file, keys, sessionsDir, report);
      if (pulled && file) report.updated.push(file);
      file = pulled ?? file;
      if (file) {
        local.set(chatId, file);
        everywhere.set(chatId, file);
        for (const [copyId, copyFile] of splitForks(file, project.id, chatId, sessionsDir, everywhere, report)) push(folder, copyId, copyFile, chatKeys(key, copyId), report);
      }
    } catch (error) {
      report.errors.push(`${chatId.slice(0, 8)}: ${error.message}`);
    }
  }
  return report;
}

// Syncs every project in `config` (see syncconfig.js); `keyFor(id)` finds a
// project's key. A project that can't be synced is reported and skipped.
export function syncProjects({ config, sessionsDir, keyFor }) {
  const report = emptyReport();
  for (const project of config.projects) {
    const key = keyFor(project.id);
    if (!key) {
      report.errors.push(`project '${project.name}': this device has no key for it (/project add ${project.folder} asks for it)`);
      continue;
    }
    try {
      syncProject({ project, key, sessionsDir, report });
    } catch (error) {
      report.errors.push(`project '${project.name}': ${error.message}`);
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
