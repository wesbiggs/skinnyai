import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// A saved chat is one SQLite file (.skinny). The conversation is stored in
// the provider-neutral shape src/history.js describes:
//
//   meta      key/value: chat_id, created_at, revision, system, model, options, settings
//   messages  one row per message: role, text, the api/model that wrote it, and
//             tool_call_id/tool_name (tool results) in `meta`
//   parts     what hangs off a message, in order: thinking blocks, tool calls,
//             attached images and PDFs (a blob each), and the segments of a
//             tool result that has images
//   blobs     attachment bytes, one per distinct SHA-256
//
// `revision` goes up on every write, so a chat can tell that another process
// wrote to the file since it last did.

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  api TEXT,
  model TEXT,
  meta TEXT,
  created_at TEXT NOT NULL
);
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

function open(file, { create = false } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 0 && create) {
    db.exec(SCHEMA);
  } else if (version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(version === 0 ? `${file} is not a skinnyai chat` : `${file} was saved by a newer skinnyai (chat format ${version})`);
  }
  return db;
}

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

export function revisionOf(file) {
  const db = open(file);
  try {
    return Number(getMeta(db, 'revision') ?? 0);
  } finally {
    db.close();
  }
}

// How many messages (not counting the system message, which is in `meta`)
// a chat file holds.
export function messageCount(file) {
  const db = open(file);
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  } finally {
    db.close();
  }
}

function blobId(db, base64, mime) {
  const bytes = Buffer.from(base64, 'base64');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const found = db.prepare('SELECT id FROM blobs WHERE sha256 = ?').get(sha);
  if (found) return found.id;
  return Number(db.prepare('INSERT INTO blobs (sha256, mime, bytes) VALUES (?, ?, ?)').run(sha, mime, bytes).lastInsertRowid);
}

function insertMessage(db, message) {
  const meta = {};
  if (message.tool_call_id) meta.tool_call_id = message.tool_call_id;
  if (message.tool_name) meta.tool_name = message.tool_name;
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
  const id = Number(db.prepare('INSERT INTO messages (role, content, api, model, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(message.role, content, message.origin?.api ?? null, message.origin?.model ?? null, Object.keys(meta).length ? JSON.stringify(meta) : null, new Date().toISOString()).lastInsertRowid);
  let idx = 0;
  const addPart = (kind, { text = null, json = null, blob = null } = {}) =>
    db.prepare('INSERT INTO parts (message_id, idx, kind, text, json, blob_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, idx++, kind, text, json === null ? null : JSON.stringify(json), blob);
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

// Writes `session` ({ from, system, parameters, messages, settings }) to the
// chat file. With `append` (how many messages the file should already hold,
// as far as the caller knows), only the messages after those are added, if
// the file really has that many; otherwise the file's messages are replaced.
// Returns { revision, chatId }.
export function writeChat(file, session, { append = null } = {}) {
  const db = open(file, { create: true });
  try {
    return inTransaction(db, () => {
      const existing = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
      const from = append !== null && append === existing && append <= session.messages.length ? append : 0;
      if (from === 0) {
        db.exec('DELETE FROM parts; DELETE FROM messages');
      }
      for (const message of session.messages.slice(from)) insertMessage(db, message);
      db.exec('DELETE FROM blobs WHERE id NOT IN (SELECT blob_id FROM parts WHERE blob_id IS NOT NULL)');

      const now = new Date().toISOString();
      if (!getMeta(db, 'chat_id')) setMeta(db, 'chat_id', randomUUID());
      if (!getMeta(db, 'created_at')) setMeta(db, 'created_at', now);
      setMeta(db, 'updated_at', now);
      setMeta(db, 'system', session.system ?? '');
      setMeta(db, 'model', session.from ?? '');
      setMeta(db, 'options', JSON.stringify(session.parameters ?? {}));
      const settings = Object.fromEntries(Object.entries(session.settings ?? {})
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([name, value]) => [name, String(value).replace(/\s+/g, ' ')]));
      setMeta(db, 'settings', JSON.stringify(settings));
      const revision = Number(getMeta(db, 'revision') ?? 0) + 1;
      setMeta(db, 'revision', String(revision));
      return { revision, chatId: getMeta(db, 'chat_id') };
    });
  } finally {
    db.close();
  }
}

// Reads a chat file back into { from, system, parameters: [[name, value]],
// messages, settings, revision, chatId }.
export function readChat(file) {
  const db = open(file);
  try {
    const parts = new Map();
    for (const row of db.prepare('SELECT p.message_id, p.kind, p.text, p.json, b.mime, b.bytes FROM parts p LEFT JOIN blobs b ON b.id = p.blob_id ORDER BY p.message_id, p.idx').all()) {
      if (!parts.has(row.message_id)) parts.set(row.message_id, []);
      parts.get(row.message_id).push(row);
    }
    const messages = db.prepare('SELECT id, role, content, api, model, meta FROM messages ORDER BY id').all().map((row) => {
      const message = { role: row.role, content: row.content };
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
      return message;
    });
    const options = JSON.parse(getMeta(db, 'options') ?? '{}');
    const parameters = Object.entries(options).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((v) => [name, String(v)]));
    return {
      from: getMeta(db, 'model') ?? '',
      system: getMeta(db, 'system') ?? '',
      parameters,
      messages,
      settings: JSON.parse(getMeta(db, 'settings') ?? '{}'),
      revision: Number(getMeta(db, 'revision') ?? 0),
      chatId: getMeta(db, 'chat_id')
    };
  } finally {
    db.close();
  }
}

// /purge: shrinks a chat file after its messages were rewritten.
export function vacuum(file) {
  const db = open(file);
  try {
    db.exec('VACUUM');
  } finally {
    db.close();
  }
}
