import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { deviceInfo } from './device.js';
import { purgeHistory } from './history.js';

// A saved chat is one SQLite file (.skinny): an append-only log of commits.
// Messages and state changes are immutable rows, each belonging to a commit;
// a commit names the commits it follows (`parents`), the device that wrote
// it, and a Lamport counter, so changes made on two devices can later be
// told apart and merged. The conversation is the chain of messages from a
// root to a tip (`parent_uid`); if two devices both add to the same tip,
// the chat has two tips (a fork) and the most recently active one is the
// conversation shown.
//
//   meta       chat_id, created_at, updated_at
//   commits    id (SHA-256 of the commit's identity), device, lamport, parents
//   state_log  the system message, model, parameters, and settings: each
//              change is a row; the latest by (lamport, device) is current
//   messages   uid, parent_uid, role, text, the api/model that wrote it, and
//              tool_call_id/tool_name (tool results) in `meta`
//   parts      what hangs off a message, in order: thinking blocks, tool
//              calls, attached images and PDFs (a blob each), and the
//              segments of a tool result that has images
//   blobs      attachment bytes, one per distinct SHA-256
//   redactions /purge operations, so another device can repeat them
//
// The commit id covers who, when, what it follows, and which messages and
// state keys it adds. It does not cover message text: /purge rewrites rows
// in place, so ids can't vouch for content here. That is the job of the
// encrypted commit files a sync would write.

export const SCHEMA_VERSION = 2;

const TABLES = `
CREATE TABLE commits (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  device_name TEXT,
  lamport INTEGER NOT NULL,
  parents TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE state_log (
  id INTEGER PRIMARY KEY,
  commit_id TEXT NOT NULL REFERENCES commits(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL
);
CREATE TABLE redactions (
  id INTEGER PRIMARY KEY,
  commit_id TEXT NOT NULL REFERENCES commits(id),
  kind TEXT NOT NULL
);
`;

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
${TABLES}
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  parent_uid TEXT,
  commit_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  api TEXT,
  model TEXT,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX messages_uid ON messages(uid);
CREATE INDEX messages_parent ON messages(parent_uid);
CREATE TABLE blobs (
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL
);
CREATE TABLE parts (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT,
  json TEXT,
  blob_id INTEGER REFERENCES blobs(id)
);
CREATE INDEX parts_by_message ON parts(message_id, idx);
PRAGMA user_version = ${SCHEMA_VERSION};
`;

export const newMessageId = () => randomUUID();

function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const getMeta = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
const setMeta = (db, key, value) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

// The identity of a commit; see the note at the top about what it covers.
function commitId({ deviceId, lamport, parents, createdAt, messages, state, redactions }) {
  const canonical = JSON.stringify({ d: deviceId, l: lamport, p: [...parents].sort(), t: createdAt, m: messages, s: state, r: redactions });
  return createHash('sha256').update(canonical).digest('hex');
}

function heads(db) {
  const commits = db.prepare('SELECT id, lamport, parents FROM commits').all();
  const followed = new Set(commits.flatMap((c) => JSON.parse(c.parents)));
  return commits.filter((c) => !followed.has(c.id));
}

// Adds a commit that follows every current head, returning its id.
function addCommit(db, { messages = [], state = [], redactions = [] }, device = deviceInfo()) {
  const tips = heads(db);
  const lamport = tips.reduce((max, c) => Math.max(max, c.lamport), 0) + 1;
  const createdAt = new Date().toISOString();
  const parents = tips.map((c) => c.id);
  const id = commitId({ deviceId: device.id, lamport, parents, createdAt, messages, state, redactions });
  db.prepare('INSERT INTO commits (id, device_id, device_name, lamport, parents, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, device.id, device.name, lamport, JSON.stringify(parents), createdAt);
  for (const [key, value] of state) db.prepare('INSERT INTO state_log (commit_id, key, value) VALUES (?, ?, ?)').run(id, key, value);
  for (const kind of redactions) db.prepare('INSERT INTO redactions (commit_id, kind) VALUES (?, ?)').run(id, kind);
  setMeta(db, 'updated_at', createdAt);
  return id;
}

// A chat file written by the first version (a revision counter, no commits)
// becomes one genesis commit holding its messages, chained in order.
function migrateV1(db) {
  inTransaction(db, () => {
    db.exec(`
      ALTER TABLE messages ADD COLUMN uid TEXT;
      ALTER TABLE messages ADD COLUMN parent_uid TEXT;
      ALTER TABLE messages ADD COLUMN commit_id TEXT;
      ${TABLES}
    `);
    const uids = db.prepare('SELECT id FROM messages ORDER BY id').all().map((row) => [row.id, randomUUID()]);
    uids.forEach(([id, uid], i) => db.prepare('UPDATE messages SET uid = ?, parent_uid = ? WHERE id = ?').run(uid, i ? uids[i - 1][1] : null, id));
    db.exec('CREATE UNIQUE INDEX messages_uid ON messages(uid); CREATE INDEX messages_parent ON messages(parent_uid)');
    const state = [];
    for (const key of ['system', 'model', 'options', 'settings']) {
      const value = getMeta(db, key);
      if (value !== undefined) state.push([key, value]);
      db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    }
    db.prepare('DELETE FROM meta WHERE key = ?').run('revision');
    const device = deviceInfo();
    const createdAt = getMeta(db, 'created_at') ?? new Date().toISOString();
    const id = commitId({ deviceId: device.id, lamport: 1, parents: [], createdAt, messages: uids.map(([, uid]) => uid), state, redactions: [] });
    db.prepare('INSERT INTO commits (id, device_id, device_name, lamport, parents, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, device.id, device.name, 1, '[]', createdAt);
    for (const [key, value] of state) db.prepare('INSERT INTO state_log (commit_id, key, value) VALUES (?, ?, ?)').run(id, key, value);
    db.prepare('UPDATE messages SET commit_id = ?').run(id);
    db.exec('PRAGMA user_version = 2');
  });
}

function open(file, { create = false } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  let version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 0 && create) {
    db.exec(SCHEMA);
    version = SCHEMA_VERSION;
  }
  if (version === 1) {
    migrateV1(db);
    version = SCHEMA_VERSION;
  }
  if (version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(version === 0 ? `${file} is not a skinnyai chat` : `${file} was saved by a newer skinnyai (chat format ${version})`);
  }
  return db;
}

function withDb(file, fn) {
  const db = open(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// What identifies this version of the chat on disk: the commits nothing
// follows yet. It changes when any device adds to the chat.
export function stampOf(file) {
  return withDb(file, (db) => `chat:${createHash('sha256').update(heads(db).map((c) => c.id).sort().join(',')).digest('hex').slice(0, 16)}`);
}

export function messageCount(file) {
  return withDb(file, (db) => db.prepare('SELECT COUNT(*) AS n FROM messages').get().n);
}

export function commitCount(file) {
  return withDb(file, (db) => db.prepare('SELECT COUNT(*) AS n FROM commits').get().n);
}

function blobId(db, base64, mime) {
  const bytes = Buffer.from(base64, 'base64');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const found = db.prepare('SELECT id FROM blobs WHERE sha256 = ?').get(sha);
  if (found) return found.id;
  return Number(db.prepare('INSERT INTO blobs (sha256, mime, bytes) VALUES (?, ?, ?)').run(sha, mime, bytes).lastInsertRowid);
}

function insertParts(db, rowId, message) {
  let idx = 0;
  const addPart = (kind, { text = null, json = null, blob = null } = {}) =>
    db.prepare('INSERT INTO parts (message_id, idx, kind, text, json, blob_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(rowId, idx++, kind, text, json === null ? null : JSON.stringify(json), blob);
  for (const block of message.thinkingBlocks ?? []) addPart('thinking', { json: block });
  for (const call of message.tool_calls ?? []) {
    addPart('tool_call', { json: { id: call.id, name: call.function?.name, arguments: call.function?.arguments } });
  }
  if (!message.parts) for (const image of message.images ?? []) addPart('image', { blob: blobId(db, image.data, image.mime) });
  for (const doc of message.documents ?? []) addPart('document', { json: { name: doc.name }, blob: blobId(db, doc.data, doc.mime) });
  // A tool result that came with images keeps its segments in order, since
  // that order is what gets relayed to the model.
  for (const part of message.parts ?? []) {
    if (part.type === 'image') addPart('result_image', { blob: blobId(db, part.data, part.mime) });
    else addPart('result_text', { text: part.text });
  }
}

const messageMeta = (message) => {
  const meta = {};
  if (message.tool_call_id) meta.tool_call_id = message.tool_call_id;
  if (message.tool_name) meta.tool_name = message.tool_name;
  return Object.keys(meta).length ? JSON.stringify(meta) : null;
};

const contentOf = (message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''));

function insertMessage(db, message, { commit, parent }) {
  const rowId = Number(db.prepare('INSERT INTO messages (uid, parent_uid, commit_id, role, content, api, model, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(message.id, parent, commit, message.role, contentOf(message), message.origin?.api ?? null, message.origin?.model ?? null, messageMeta(message), new Date().toISOString()).lastInsertRowid);
  insertParts(db, rowId, message);
}

function dropUnusedBlobs(db) {
  db.exec('DELETE FROM blobs WHERE id NOT IN (SELECT blob_id FROM parts WHERE blob_id IS NOT NULL)');
}

// The state keys and their current values, the latest change winning (by
// Lamport counter, then device id, then order written).
function currentState(db) {
  const state = new Map();
  const rows = db.prepare('SELECT s.key, s.value FROM state_log s JOIN commits c ON c.id = s.commit_id ORDER BY c.lamport, c.device_id, s.id').all();
  for (const row of rows) state.set(row.key, row.value);
  return state;
}

function sessionState(session) {
  const named = session.name ? [['name', session.name]] : [];
  const settings = Object.fromEntries(Object.entries(session.settings ?? {})
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([name, value]) => [name, String(value).replace(/\s+/g, ' ')]));
  return [
    ...named,
    ['system', session.system ?? ''],
    ['model', session.from ?? ''],
    ['options', JSON.stringify(session.parameters ?? {})],
    ['settings', JSON.stringify(settings)]
  ];
}

// Adds what `session` ({ from, system, parameters, messages, settings })
// has beyond the file as one commit, and returns { commit, chatId, last }
// (commit is null when there was nothing to add). The messages must carry
// ids. `after` is the id of the last message the file already has from this
// conversation (null for none; the file must then have no messages): only the
// messages after it are added. `replace` first deletes any existing file.
export function writeChat(file, session, { after = null, replace = false, device = deviceInfo() } = {}) {
  if (replace) for (const path of [file, `${file}-journal`]) rmSync(path, { force: true });
  const db = open(file, { create: true });
  try {
    return inTransaction(db, () => {
      const existing = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
      if (after === null && existing > 0) throw new Error('this chat file already has messages; save under another name or replace it');
      if (after !== null && !db.prepare('SELECT 1 FROM messages WHERE uid = ?').get(after)) throw new Error('this chat file no longer has the last message saved from it');
      const at = after === null ? 0 : session.messages.findIndex((m) => m.id === after) + 1;
      if (after !== null && at === 0) throw new Error('the last message saved from this chat file is not in the conversation');
      const fresh = session.messages.slice(at);

      const stored = currentState(db);
      const state = sessionState(session).filter(([key, value]) => stored.get(key) !== value);
      let commit = null;
      if (fresh.length || state.length || !getMeta(db, 'chat_id')) {
        commit = addCommit(db, { messages: fresh.map((m) => m.id), state }, device);
        let parent = after;
        for (const message of fresh) {
          insertMessage(db, message, { commit, parent });
          parent = message.id;
        }
      }
      const now = new Date().toISOString();
      if (!getMeta(db, 'chat_id')) setMeta(db, 'chat_id', randomUUID());
      if (!getMeta(db, 'created_at')) setMeta(db, 'created_at', now);
      return { commit, chatId: getMeta(db, 'chat_id'), last: session.messages.at(-1)?.id ?? null };
    });
  } finally {
    db.close();
  }
}

function readMessages(db) {
  const parts = new Map();
  for (const row of db.prepare('SELECT p.message_id, p.kind, p.text, p.json, b.mime, b.bytes FROM parts p LEFT JOIN blobs b ON b.id = p.blob_id ORDER BY p.message_id, p.idx').all()) {
    if (!parts.has(row.message_id)) parts.set(row.message_id, []);
    parts.get(row.message_id).push(row);
  }
  return db.prepare('SELECT id, uid, parent_uid, commit_id, role, content, api, model, meta FROM messages ORDER BY id').all().map((row) => {
    const message = { id: row.uid, role: row.role, content: row.content };
    if (row.api || row.model) message.origin = { api: row.api, model: row.model };
    Object.assign(message, row.meta ? JSON.parse(row.meta) : {});
    const own = parts.get(row.id) ?? [];
    const of = (kind) => own.filter((p) => p.kind === kind);
    const base64 = (p) => ({ mime: p.mime, data: Buffer.from(p.bytes).toString('base64') });
    if (of('thinking').length) message.thinkingBlocks = of('thinking').map((p) => JSON.parse(p.json));
    if (of('tool_call').length) {
      message.tool_calls = of('tool_call').map((p) => {
        const { id, name, arguments: args } = JSON.parse(p.json);
        return { id, function: { name, arguments: args } };
      });
    }
    if (of('image').length) message.images = of('image').map(base64);
    if (of('document').length) message.documents = of('document').map((p) => ({ name: JSON.parse(p.json).name, ...base64(p) }));
    const result = own.filter((p) => p.kind === 'result_image' || p.kind === 'result_text');
    if (result.length) {
      message.parts = result.map((p) => (p.kind === 'result_image' ? { type: 'image', ...base64(p) } : { type: 'text', text: p.text }));
      message.images = message.parts.filter((p) => p.type === 'image').map(({ mime, data }) => ({ mime, data }));
    }
    Object.defineProperty(message, 'link', { value: { parent: row.parent_uid, commit: row.commit_id }, enumerable: false });
    return message;
  });
}

// The messages from a root to the conversation's tip: the tip whose commit
// is latest by (lamport, device). Also says how many other tips there are.
function mainLine(db, all) {
  if (!all.length) return { line: [], forks: 0 };
  const commits = new Map(db.prepare('SELECT id, lamport, device_id FROM commits').all().map((c) => [c.id, c]));
  const byUid = new Map(all.map((m) => [m.id, m]));
  const parents = new Set(all.map((m) => m.link.parent).filter(Boolean));
  const tips = all.filter((m) => !parents.has(m.id));
  const rank = (m) => commits.get(m.link.commit) ?? { lamport: 0, device_id: '' };
  tips.sort((a, b) => rank(b).lamport - rank(a).lamport || (rank(b).device_id > rank(a).device_id ? 1 : -1) || (b.id > a.id ? 1 : -1));
  const line = [];
  for (let m = tips[0]; m; m = byUid.get(m.link.parent)) line.unshift(m);
  return { line, forks: tips.length - 1 };
}

// Reads a chat file back into { from, system, parameters: [[name, value]],
// messages (the main line, each with its id), settings, chatId, forks,
// last (the id of the last message) }.
export function readChat(file) {
  return withDb(file, (db) => {
    const { line, forks } = mainLine(db, readMessages(db));
    const state = currentState(db);
    const options = JSON.parse(state.get('options') ?? '{}');
    const parameters = Object.entries(options).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((v) => [name, String(v)]));
    return {
      name: state.get('name') ?? null,
      from: state.get('model') ?? '',
      system: state.get('system') ?? '',
      parameters,
      messages: line,
      settings: JSON.parse(state.get('settings') ?? '{}'),
      chatId: getMeta(db, 'chat_id'),
      forks,
      last: line.at(-1)?.id ?? null
    };
  });
}

// Makes the file's main line match `newLine`: rows for messages not in it
// are deleted and the others rewritten (text, parts, parent). With
// `onlyChanged`, a message that is the very object read from the file, with
// the same parent, is left alone.
function rewriteLine(db, oldLine, newLine, { onlyChanged = false } = {}) {
  const keep = new Set(newLine.map((m) => m.id));
  const before = new Map(oldLine.map((m) => [m.id, m]));
  for (const old of oldLine) if (!keep.has(old.id)) db.prepare('DELETE FROM messages WHERE uid = ?').run(old.id);
  let parent = null;
  for (const message of newLine) {
    const same = onlyChanged && before.get(message.id) === message && message.link.parent === parent;
    if (!same) {
      const row = db.prepare('SELECT id FROM messages WHERE uid = ?').get(message.id);
      if (!row) throw new Error('the conversation has a message this chat file does not');
      db.prepare('UPDATE messages SET content = ?, parent_uid = ? WHERE id = ?').run(contentOf(message), parent, row.id);
      if (!(onlyChanged && before.get(message.id) === message)) {
        db.prepare('DELETE FROM parts WHERE message_id = ?').run(row.id);
        insertParts(db, row.id, message);
      }
    }
    parent = message.id;
  }
  dropUnusedBlobs(db);
}

// /purge: `messages` is the conversation after the purge (same ids, minus
// what was dropped). The file's rows for those messages are rewritten to
// match, and a commit records the operation.
export function redactChat(file, kind, messages, { device = deviceInfo() } = {}) {
  const db = open(file);
  try {
    inTransaction(db, () => {
      rewriteLine(db, mainLine(db, readMessages(db)).line, messages);
      addCommit(db, { redactions: [kind] }, device);
    });
    db.exec('VACUUM');
  } finally {
    db.close();
  }
}

// Repeats a purge made elsewhere: it applies to the messages that were in
// the chat when the purge was made (the commit's ancestors), not to ones
// added since.
function applyRedaction(db, kind, commitId) {
  const parents = new Map(db.prepare('SELECT id, parents FROM commits').all().map((c) => [c.id, JSON.parse(c.parents)]));
  const before = new Set();
  const pending = [commitId];
  while (pending.length) {
    const id = pending.pop();
    if (before.has(id) || !parents.has(id)) continue;
    before.add(id);
    pending.push(...parents.get(id));
  }
  const { line } = mainLine(db, readMessages(db));
  const subset = line.filter((m) => before.has(m.link.commit));
  if (!subset.length) return;
  const purged = new Map(purgeHistory(subset, kind).history.map((m) => [m.id, m]));
  const newLine = [];
  for (const m of line) {
    if (!before.has(m.link.commit)) newLine.push(m);
    else if (purged.has(m.id)) newLine.push(purged.get(m.id));
  }
  rewriteLine(db, line, newLine, { onlyChanged: true });
}

// Checks the log's structure: every commit's parents exist and come
// earlier, and every message has a commit and a parent that exists.
// Returns a list of problems (empty if the file is sound).
export function verifyChat(file) {
  return withDb(file, (db) => {
    const problems = [];
    const commits = new Map(db.prepare('SELECT id, lamport, parents FROM commits').all().map((c) => [c.id, c]));
    for (const commit of commits.values()) {
      for (const parent of JSON.parse(commit.parents)) {
        if (!commits.has(parent)) problems.push(`commit ${commit.id.slice(0, 8)} follows ${parent.slice(0, 8)}, which is missing`);
        else if (commits.get(parent).lamport >= commit.lamport) problems.push(`commit ${commit.id.slice(0, 8)} is not later than the one it follows`);
      }
    }
    const uids = new Set();
    const rows = db.prepare('SELECT uid, parent_uid, commit_id FROM messages').all();
    for (const row of rows) uids.add(row.uid);
    for (const row of rows) {
      if (!commits.has(row.commit_id)) problems.push(`message ${row.uid} has no commit`);
      if (row.parent_uid && !uids.has(row.parent_uid)) problems.push(`message ${row.uid} follows a message that is missing`);
    }
    return problems;
  });
}

// --- Syncing: chats as commits that can be exported, and applied elsewhere ---

export function chatIdOf(file) {
  return withDb(file, (db) => getMeta(db, 'chat_id') ?? null);
}

export function commitIds(file) {
  return withDb(file, (db) => db.prepare('SELECT id FROM commits ORDER BY lamport, created_at, id').all().map((c) => c.id));
}

// A commit as a plain object, for sealing: its messages and parts as they
// stand now (after any purge), with each attachment named by `nameBlob(sha256)`.
// Returns { payload, blobs: [{ name, mime, bytes }] }.
export function exportCommit(file, id, nameBlob) {
  return withDb(file, (db) => {
    const commit = db.prepare('SELECT * FROM commits WHERE id = ?').get(id);
    if (!commit) throw new Error(`no commit ${id}`);
    const blobs = new Map();
    const messages = db.prepare('SELECT id, uid, parent_uid, role, content, api, model, meta, created_at FROM messages WHERE commit_id = ? ORDER BY id').all(id).map((row) => ({
      uid: row.uid,
      parent_uid: row.parent_uid,
      role: row.role,
      content: row.content,
      api: row.api,
      model: row.model,
      meta: row.meta ? JSON.parse(row.meta) : null,
      created_at: row.created_at,
      parts: db.prepare('SELECT p.kind, p.text, p.json, b.sha256, b.mime, b.bytes FROM parts p LEFT JOIN blobs b ON b.id = p.blob_id WHERE p.message_id = ? ORDER BY p.idx').all(row.id).map((p) => {
        let blob = null;
        if (p.sha256) {
          blob = { name: nameBlob(p.sha256), mime: p.mime };
          blobs.set(blob.name, { ...blob, bytes: Buffer.from(p.bytes) });
        }
        return { kind: p.kind, text: p.text, json: p.json, blob };
      })
    }));
    return {
      payload: {
        v: 1,
        id: commit.id,
        chat_id: getMeta(db, 'chat_id'),
        chat_created_at: getMeta(db, 'created_at'),
        device: { id: commit.device_id, name: commit.device_name },
        lamport: commit.lamport,
        parents: JSON.parse(commit.parents),
        created_at: commit.created_at,
        state: db.prepare('SELECT key, value FROM state_log WHERE commit_id = ? ORDER BY id').all(id).map((s) => [s.key, s.value]),
        messages,
        redactions: db.prepare('SELECT kind FROM redactions WHERE commit_id = ? ORDER BY id').all(id).map((r) => r.kind)
      },
      blobs: [...blobs.values()]
    };
  });
}

// Starts an empty chat file that is the chat `chatId` (for commits to be
// imported into).
export function createChat(file, chatId, createdAt) {
  const db = open(file, { create: true });
  try {
    inTransaction(db, () => {
      setMeta(db, 'chat_id', chatId);
      setMeta(db, 'created_at', createdAt ?? new Date().toISOString());
    });
  } finally {
    db.close();
  }
}

// Applies a commit made elsewhere. `getBlob(ref)` returns an attachment's
// bytes, or null if they haven't arrived. Returns 'applied', 'present' (it's
// already here), or 'waiting' (a commit it follows, or an attachment, is
// missing; try again after more has arrived).
export function importCommit(file, payload, getBlob) {
  const db = open(file);
  try {
    return inTransaction(db, () => {
      if (db.prepare('SELECT 1 FROM commits WHERE id = ?').get(payload.id)) return 'present';
      for (const parent of payload.parents) if (!db.prepare('SELECT 1 FROM commits WHERE id = ?').get(parent)) return 'waiting';
      const bytes = new Map();
      for (const message of payload.messages) {
        for (const part of message.parts) {
          if (!part.blob || bytes.has(part.blob.name)) continue;
          const found = getBlob(part.blob);
          if (!found) return 'waiting';
          bytes.set(part.blob.name, found);
        }
      }
      db.prepare('INSERT INTO commits (id, device_id, device_name, lamport, parents, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(payload.id, payload.device.id, payload.device.name, payload.lamport, JSON.stringify(payload.parents), payload.created_at);
      for (const [key, value] of payload.state) db.prepare('INSERT INTO state_log (commit_id, key, value) VALUES (?, ?, ?)').run(payload.id, key, value);
      for (const message of payload.messages) {
        if (db.prepare('SELECT 1 FROM messages WHERE uid = ?').get(message.uid)) continue;
        const rowId = Number(db.prepare('INSERT INTO messages (uid, parent_uid, commit_id, role, content, api, model, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(message.uid, message.parent_uid, payload.id, message.role, message.content, message.api, message.model, message.meta ? JSON.stringify(message.meta) : null, message.created_at).lastInsertRowid);
        message.parts.forEach((part, idx) => {
          let blob = null;
          if (part.blob) {
            const data = bytes.get(part.blob.name);
            const sha = createHash('sha256').update(data).digest('hex');
            blob = db.prepare('SELECT id FROM blobs WHERE sha256 = ?').get(sha)?.id
              ?? Number(db.prepare('INSERT INTO blobs (sha256, mime, bytes) VALUES (?, ?, ?)').run(sha, part.blob.mime, data).lastInsertRowid);
          }
          db.prepare('INSERT INTO parts (message_id, idx, kind, text, json, blob_id) VALUES (?, ?, ?, ?, ?, ?)').run(rowId, idx, part.kind, part.text, part.json, blob);
        });
      }
      for (const kind of payload.redactions) {
        db.prepare('INSERT INTO redactions (commit_id, kind) VALUES (?, ?)').run(payload.id, kind);
        applyRedaction(db, kind, payload.id);
      }
      setMeta(db, 'updated_at', new Date().toISOString());
      return 'applied';
    });
  } finally {
    db.close();
  }
}

// The lines of conversation that lost out to the one readChat shows (two
// writers added to the same message), not yet split off. Each has its
// tip's id, the device that wrote it, and the messages from the root.
export function losingLines(file) {
  return withDb(file, (db) => {
    const all = readMessages(db);
    if (!all.length) return { name: null, state: [], lines: [] };
    const commits = new Map(db.prepare('SELECT id, lamport, device_id, device_name, created_at FROM commits').all().map((c) => [c.id, c]));
    const byUid = new Map(all.map((m) => [m.id, m]));
    const parents = new Set(all.map((m) => m.link.parent).filter(Boolean));
    const rank = (m) => commits.get(m.link.commit) ?? { lamport: 0, device_id: '' };
    const tips = all.filter((m) => !parents.has(m.id)).sort((a, b) => rank(b).lamport - rank(a).lamport || (rank(b).device_id > rank(a).device_id ? 1 : -1) || (b.id > a.id ? 1 : -1));
    const handled = new Set(JSON.parse(getMeta(db, 'split_tips') ?? '[]'));
    const state = currentState(db);
    return {
      name: state.get('name') ?? null,
      state: [...state],
      lines: tips.slice(1).filter((tip) => !handled.has(tip.id)).map((tip) => {
        const line = [];
        for (let m = tip; m; m = byUid.get(m.link.parent)) line.unshift(m);
        const commit = commits.get(tip.link.commit);
        return { tip: tip.id, deviceName: commit?.device_name ?? 'another device', createdAt: commit?.created_at ?? new Date(0).toISOString(), line };
      })
    };
  });
}

export function markSplit(file, tipUid) {
  const db = open(file);
  try {
    inTransaction(db, () => setMeta(db, 'split_tips', JSON.stringify([...new Set([...JSON.parse(getMeta(db, 'split_tips') ?? '[]'), tipUid])])));
  } finally {
    db.close();
  }
}

// The chat id and commit id a split-off line always gets, so every device
// that splits the same fork makes the same chat with the same commit, and
// syncing them together adds nothing twice.
export function splitIds(chatId, tipUid) {
  const hash = createHash('sha256').update(`split\0${chatId}\0${tipUid}`).digest('hex');
  return { chatId: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`, commitId: hash };
}

// Writes a new chat file holding one line of conversation as a single commit,
// from fixed values (see splitIds) so it comes out the same everywhere.
export function writeSplitChat(file, { chatId, commitId, createdAt, state, line }) {
  const db = open(file, { create: true });
  try {
    inTransaction(db, () => {
      setMeta(db, 'chat_id', chatId);
      setMeta(db, 'created_at', createdAt);
      db.prepare('INSERT INTO commits (id, device_id, device_name, lamport, parents, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(commitId, 'split', 'split', 1, '[]', createdAt);
      for (const [key, value] of state) db.prepare('INSERT INTO state_log (commit_id, key, value) VALUES (?, ?, ?)').run(commitId, key, value);
      let parent = null;
      for (const message of line) {
        const rowId = Number(db.prepare('INSERT INTO messages (uid, parent_uid, commit_id, role, content, api, model, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(message.id, parent, commitId, message.role, contentOf(message), message.origin?.api ?? null, message.origin?.model ?? null, messageMeta(message), createdAt).lastInsertRowid);
        insertParts(db, rowId, message);
        parent = message.id;
      }
    });
  } finally {
    db.close();
  }
}
