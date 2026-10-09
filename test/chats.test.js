import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitCount, messageCount, newMessageId, readChat, redactChat, verifyChat, writeChat } from '../src/chatdb.js';
import { DEVICE_FILE, deviceInfo } from '../src/device.js';
import { formatMarkdown } from '../src/export.js';
import { purgeHistory } from '../src/history.js';
import { captureOutput, fakeTTY, stripAnsi } from './helpers/tty.js';
import { startMockServer } from './helpers/mock-server.js';

let skinnyai;
let server;
let capture;

beforeAll(async () => {
  fakeTTY({ columns: 80 });
  skinnyai = await import('../src/skinnyai.js');
  server = await startMockServer();
});
afterAll(() => server.close());
beforeEach(() => {
  fs.rmSync(skinnyai.SESSION_DIR, { recursive: true, force: true });
  capture = captureOutput();
});
afterEach(() => {
  capture.stop();
  vi.restoreAllMocks();
});

const output = () => stripAnsi(capture.text);
const files = () => (fs.existsSync(skinnyai.SESSION_DIR) ? fs.readdirSync(skinnyai.SESSION_DIR).sort() : []);
const chatOf = (...contents) => {
  const chat = new skinnyai.OllamaChat('m', { api: 'openai', host: server.url, autosave: false });
  chat.history = contents.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content }));
  return chat;
};
const withTwo = (name) => chatOf('old', 'older').save(name);
const png = { mime: 'image/png', data: Buffer.from('pixels').toString('base64') };
const session = (messages) => ({ from: 'm', system: 's', parameters: { temperature: '0.5', stop: ['a', 'b'] }, messages, settings: { api: 'openai', tools: true, format: undefined } });

describe('chat files', () => {
  const file = () => path.join(skinnyai.SESSION_DIR, 'x.skinny');
  const m = (role, content, extra = {}) => ({ id: newMessageId(), role, content, ...extra });
  beforeEach(() => fs.mkdirSync(skinnyai.SESSION_DIR, { recursive: true }));

  it('round-trips ids, settings, and parameters', () => {
    const hi = m('user', 'hi');
    writeChat(file(), session([hi]));
    const read = readChat(file());
    expect(read).toMatchObject({ from: 'm', system: 's', settings: { api: 'openai', tools: 'true' }, forks: 0, last: hi.id });
    expect(read.messages.map((x) => x.id)).toEqual([hi.id]);
    expect(read.parameters).toEqual([['temperature', '0.5'], ['stop', 'a'], ['stop', 'b']]);
    expect(read.chatId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('adds only the messages after the one it already has, and nothing when there is nothing new', () => {
    const [a, b, c] = [m('user', 'a'), m('assistant', 'b'), m('user', 'c')];
    writeChat(file(), session([a, b]));
    const db = new DatabaseSync(file());
    const firstRow = db.prepare('SELECT MIN(id) AS id FROM messages').get().id;
    db.close();
    expect(writeChat(file(), session([a, b, c]), { after: b.id }).commit).toMatch(/^[0-9a-f]{64}$/);
    expect(messageCount(file())).toBe(3);
    expect(commitCount(file())).toBe(2);
    const after = new DatabaseSync(file());
    expect(after.prepare('SELECT MIN(id) AS id FROM messages').get().id).toBe(firstRow); // earlier rows were left alone
    expect(after.prepare('SELECT parent_uid FROM messages WHERE uid = ?').get(c.id).parent_uid).toBe(b.id);
    after.close();
    expect(writeChat(file(), session([a, b, c]), { after: c.id }).commit).toBeNull();
    expect(commitCount(file())).toBe(2);
    expect(verifyChat(file())).toEqual([]);
  });

  it('records a change of settings as its own commit', () => {
    const a = m('user', 'a');
    writeChat(file(), session([a]));
    writeChat(file(), { ...session([a]), system: 'new system' }, { after: a.id });
    expect(commitCount(file())).toBe(2);
    expect(readChat(file()).system).toBe('new system');
  });

  it('refuses to write over messages it does not know, unless told to replace', () => {
    const [a, b] = [m('user', 'a'), m('user', 'b')];
    writeChat(file(), session([a]));
    expect(() => writeChat(file(), session([b]))).toThrow(/already has messages/);
    expect(() => writeChat(file(), session([b]), { after: 'nope' })).toThrow(/no longer has/);
    expect(() => writeChat(file(), session([b]), { after: a.id })).toThrow(/not in the conversation/);
    writeChat(file(), session([b]), { replace: true });
    expect(readChat(file()).messages.map((x) => x.content)).toEqual(['b']);
  });

  it('shows the most recent line when two writers add to the same message', () => {
    const [a, b, c, d] = [m('user', 'a'), m('assistant', 'b'), m('user', 'c'), m('user', 'd')];
    writeChat(file(), session([a, b]));
    writeChat(file(), session([a, b, c]), { after: b.id });
    writeChat(file(), session([a, b, d]), { after: b.id });
    const read = readChat(file());
    expect(read.messages.map((x) => x.content)).toEqual(['a', 'b', 'd']);
    expect(read.forks).toBe(1);
    expect(messageCount(file())).toBe(4); // c is still there
    expect(verifyChat(file())).toEqual([]);
  });

  it('numbers commits so each follows the ones before it', () => {
    const a = m('user', 'a');
    writeChat(file(), session([a]));
    writeChat(file(), session([a, m('user', 'b')]), { after: a.id });
    const db = new DatabaseSync(file());
    const commits = db.prepare('SELECT id, lamport, parents, device_id FROM commits ORDER BY lamport').all();
    db.close();
    expect(commits.map((c) => c.lamport)).toEqual([1, 2]);
    expect(JSON.parse(commits[1].parents)).toEqual([commits[0].id]);
    expect(commits[0].device_id).toBe(deviceInfo().id);
  });

  it('reports a broken log', () => {
    const [a, b] = [m('user', 'a'), m('user', 'b')];
    writeChat(file(), session([a]));
    writeChat(file(), session([a, b]), { after: a.id });
    const db = new DatabaseSync(file());
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('DELETE FROM commits WHERE lamport = 1').run();
    db.close();
    expect(verifyChat(file()).join('\n')).toMatch(/is missing|has no commit/);
  });

  it('stores identical attachments once and drops ones no message uses after a purge', () => {
    const [a, b] = [m('user', 'a', { images: [png] }), m('user', 'b', { images: [png] })];
    writeChat(file(), session([a, b]));
    const db = new DatabaseSync(file());
    expect(db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n).toBe(1);
    db.close();
    redactChat(file(), 'blobs', [{ ...a, images: undefined }, { ...b, images: undefined }]);
    const again = new DatabaseSync(file());
    expect(again.prepare('SELECT COUNT(*) AS n FROM blobs').get().n).toBe(0);
    expect(again.prepare('SELECT kind FROM redactions').all()).toEqual([{ kind: 'blobs' }]);
    again.close();
  });

  it('relinks the conversation when a purge drops messages', () => {
    const messages = [m('user', 'q'), m('assistant', '', { tool_calls: [{ id: 'c1', function: { name: 't', arguments: {} } }] }), m('tool', 'r', { tool_call_id: 'c1', tool_name: 't' }), m('assistant', 'done')];
    writeChat(file(), session(messages));
    const { history } = purgeHistory(messages, 'tools');
    redactChat(file(), 'tools', history);
    const read = readChat(file());
    expect(read.messages.map((x) => x.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(read.messages[1].content).toContain('[Tool call: t({}) -> r]');
    expect(read.forks).toBe(0);
    expect(verifyChat(file())).toEqual([]);
  });

  it('upgrades a file from the first version in place', () => {
    const db = new DatabaseSync(file());
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', api TEXT, model TEXT, meta TEXT, created_at TEXT NOT NULL);
      CREATE TABLE blobs (id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, bytes BLOB NOT NULL);
      CREATE TABLE parts (id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE, idx INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT, json TEXT, blob_id INTEGER REFERENCES blobs(id));
      INSERT INTO meta VALUES ('chat_id', 'abc'), ('created_at', '2026-10-01T00:00:00.000Z'), ('revision', '3'), ('system', 'old system'), ('model', 'old-model'), ('options', '{"temperature":"0.1"}'), ('settings', '{"api":"openai"}');
      INSERT INTO messages (role, content, created_at) VALUES ('user', 'hi', 'x'), ('assistant', 'hello', 'x');
      PRAGMA user_version = 1;
    `);
    db.close();
    const read = readChat(file());
    expect(read).toMatchObject({ from: 'old-model', system: 'old system', parameters: [['temperature', '0.1']], settings: { api: 'openai' }, chatId: 'abc', forks: 0 });
    expect(read.messages.map((x) => x.content)).toEqual(['hi', 'hello']);
    expect(commitCount(file())).toBe(1);
    expect(verifyChat(file())).toEqual([]);
    const upgraded = new DatabaseSync(file());
    expect(upgraded.prepare('PRAGMA user_version').get().user_version).toBe(2);
    expect(upgraded.prepare("SELECT COUNT(*) AS n FROM meta WHERE key IN ('revision', 'system')").get().n).toBe(0);
    upgraded.close();
    // and it takes new messages afterwards
    writeChat(file(), { ...session([...read.messages, m('user', 'more')]), from: 'old-model' }, { after: read.last });
    expect(readChat(file()).messages).toHaveLength(3);
  });

  it('refuses files that are not chats or come from a newer version', () => {
    fs.writeFileSync(file(), 'not a database');
    expect(() => readChat(file())).toThrow();
    fs.rmSync(file());
    const db = new DatabaseSync(file());
    db.exec('CREATE TABLE t (a); PRAGMA user_version = 99');
    db.close();
    expect(() => readChat(file())).toThrow(/newer skinnyai/);
  });
});

describe('device identity', () => {
  it('is made once, kept beside the chats, and has an editable name', () => {
    const info = deviceInfo();
    expect(info.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(info.name).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8'))).toEqual(info);
  });
});

describe('sessions from earlier versions', () => {
  const legacy = (name) => path.join(skinnyai.SESSION_DIR, `${name}.Modelfile`);
  beforeEach(() => {
    fs.mkdirSync(skinnyai.SESSION_DIR, { recursive: true });
    fs.writeFileSync(legacy('old'), skinnyai.formatModelfile({ from: 'legacy-model', system: '', parameters: {}, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] }));
  });

  it('load, list once, and are saved as .skinny files the next time, keeping the Modelfile if asked to', async () => {
    const chat = chatOf();
    await chat.load('old');
    expect(chat.model).toBe('legacy-model');
    expect(chat.history.map((m) => m.content)).toEqual(['hi', 'hello']);
    chat.history.push({ role: 'user', content: 'more' });
    let asked = '';
    chat.confirm = async (question) => ((asked = question), false);
    await chat.save('');
    expect(asked).toContain('Converted \'old\' to the new chat format. Delete the old file');
    expect(output()).toContain('Kept old.Modelfile as it was.');
    expect(files()).toEqual(['old.Modelfile', 'old.skinny']);
    expect(await skinnyai.listLocalSessions()).toEqual(['old']);
    expect(readChat(path.join(skinnyai.SESSION_DIR, 'old.skinny')).messages).toHaveLength(3);
    asked = '';
    await chat.save(''); // already converted: no second question
    expect(asked).toBe('');
    const next = chatOf();
    await next.load('old');
    expect(next.history).toHaveLength(3); // the .skinny file wins
  });

  it('deletes the old Modelfile when told to', async () => {
    const chat = chatOf();
    await chat.load('old');
    chat.confirm = async () => true;
    await chat.save('');
    expect(files()).toEqual(['old.skinny']);
    expect(output()).toContain('Deleted old.Modelfile.');
  });

  it('/delete removes the chat file but leaves a Modelfile alone', async () => {
    const chat = chatOf();
    await chat.load('old');
    chat.confirm = async () => false;
    await chat.save('');
    chat.confirm = async () => true;
    await chat.deleteSession('old');
    expect(files()).toEqual(['old.Modelfile']);
  });

  it('/delete says so for a session that is only a Modelfile', async () => {
    const chat = chatOf();
    chat.confirm = async () => { throw new Error('should not ask'); };
    await chat.deleteSession('old');
    expect(output()).toContain("'old' is an old-format Modelfile");
    expect(files()).toEqual(['old.Modelfile']);
  });
});

describe('autosave', () => {
  it('is on by default in a terminal and appends to the same file', async () => {
    const wasTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    const chat = new skinnyai.OllamaChat('m', { api: 'openai', host: server.url });
    process.stdin.isTTY = wasTTY;
    expect(chat.autosave).toBe(true);
    chat.history.push({ role: 'user', content: 'one' }, { role: 'assistant', content: 'a' });
    await chat.autosaveSession();
    chat.history.push({ role: 'user', content: 'two' }, { role: 'assistant', content: 'b' });
    await chat.autosaveSession();
    const [name] = files();
    expect(messageCount(path.join(skinnyai.SESSION_DIR, name))).toBe(4);
    expect(commitCount(path.join(skinnyai.SESSION_DIR, name))).toBe(2);
    expect(new skinnyai.OllamaChat('m', { autosave: false }).autosave).toBe(false);
  });
});

describe('/new and /delete', () => {
  it('/new starts a conversation, optionally named, but never takes a name in use', async () => {
    const chat = chatOf('q', 'a');
    chat.setSystemMessage('Be brief.');
    await chat.handleCommand('/new Fresh');
    expect(chat.history).toEqual([{ role: 'system', content: 'Be brief.' }]);
    expect(chat.sessionName).toBe('Fresh');
    await chatOf('q', 'a').save('Used');
    await chat.handleCommand('/new Used');
    expect(chat.sessionName).toBe('Fresh');
    expect(output()).toContain("A saved session named 'Used' already exists");
    await chat.handleCommand('/new');
    expect(chat.sessionName).toBeNull();
  });

  it('/clear is gone, with a pointer to /new', async () => {
    expect(await chatOf('q', 'a').handleCommand('/clear')).toBeNull();
  });

  it('/delete asks first, and deleting the current chat starts a new one', async () => {
    const chat = chatOf('q', 'a');
    await chat.save('Doomed');
    chat.confirm = async () => false;
    await chat.handleCommand('/delete');
    expect(files()).toEqual(['Doomed.skinny']);
    chat.confirm = async () => true;
    await chat.handleCommand('/delete');
    expect(files()).toEqual([]);
    expect(chat.history).toEqual([]);
    expect(chat.sessionName).toBeNull();
    await chat.handleCommand('/delete Nope');
    expect(output()).toContain("No saved session named 'Nope'");
  });
});

describe('ids and the log, from a chat', () => {
  it('keeps message ids off the wire for every API', () => {
    for (const api of ['ollama', 'openai', 'anthropic']) {
      const chat = new skinnyai.OllamaChat('m', { api, host: server.url, autosave: false });
      chat.history = [
        { id: 'u1', role: 'user', content: 'q' },
        { id: 'a1', role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'web_search', arguments: { query: 'x' } } }], origin: { api, model: 'm' } },
        { id: 't1', role: 'tool', tool_call_id: 'c1', tool_name: 'web_search', content: 'r' },
        { id: 'a2', role: 'assistant', content: 'done' }
      ];
      const sent = chat.requestMessages('');
      expect(sent.map((m) => 'id' in m)).toEqual([false, false, false, false]);
    }
  });

  it('keeps adding to the same file after a purge, with the purge recorded', async () => {
    const chat = chatOf();
    chat.history = [{ role: 'user', content: 'see', images: [png] }, { role: 'assistant', content: 'ok' }];
    await chat.save('keep');
    await chat.handleCommand('/purge blobs');
    chat.history.push({ role: 'user', content: 'more' });
    chat.autosave = true;
    await chat.autosaveSession();
    const read = readChat(skinnyai.sessionPath('keep'));
    expect(read.messages.map((m) => m.content)).toEqual(['see\n\n[1 attached image removed]', 'ok', 'more']);
    expect(read.forks).toBe(0);
    expect(verifyChat(skinnyai.sessionPath('keep'))).toEqual([]);
  });

  it('writes a purge to the file first when the chat had unsaved messages', async () => {
    const chat = chatOf();
    chat.history = [{ role: 'user', content: 'a', images: [png] }];
    await chat.save('late');
    chat.history.push({ role: 'assistant', content: 'unsaved reply' });
    await chat.handleCommand('/purge blobs');
    expect(readChat(skinnyai.sessionPath('late')).messages.map((m) => m.content)).toEqual(['a\n\n[1 attached image removed]', 'unsaved reply']);
  });

  it('/save over a different session replaces it, after asking', async () => {
    await withTwo('Target');
    const chat = chatOf('mine', 'reply');
    chat.confirm = async () => true;
    await chat.save('Target');
    expect(readChat(skinnyai.sessionPath('Target')).messages.map((m) => m.content)).toEqual(['mine', 'reply']);
  });
});

describe('/export', () => {
  const out = (name) => path.join(skinnyai.SESSION_DIR, '..', name);

  it('writes a markdown transcript with tool calls but not thinking', async () => {
    const chat = chatOf();
    chat.history = [
      { role: 'user', content: 'weather?', images: [png] },
      { role: 'assistant', content: 'checking', thinkingBlocks: [{ type: 'thinking', thinking: 'secret thoughts' }], tool_calls: [{ id: 'c1', function: { name: 'web_search', arguments: { query: 'weather' } } }], origin: { api: 'openai', model: 'm' } },
      { role: 'tool', tool_call_id: 'c1', tool_name: 'web_search', content: 'sunny' },
      { role: 'assistant', content: "It's sunny.", origin: { api: 'openai', model: 'm' } }
    ];
    await chat.exportChat(out('t.md'));
    const text = fs.readFileSync(out('t.md'), 'utf8');
    expect(text).toContain('### You\n\nweather?\n\n📎 image (image/png)');
    expect(text).toContain('### Assistant (m)\n\nchecking\n\n🔧 `web_search({"query":"weather"})`');
    expect(text).toContain('> Result: sunny');
    expect(text).not.toContain('secret thoughts');
  });

  it('writes a Modelfile of the conversation text', async () => {
    const chat = chatOf('q', 'a');
    await chat.exportChat(out('t.Modelfile'));
    const parsed = skinnyai.parseModelfile(fs.readFileSync(out('t.Modelfile'), 'utf8'));
    expect(parsed.messages).toEqual([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);
  });

  it('asks before overwriting, and refuses other extensions', async () => {
    fs.writeFileSync(out('t.md'), 'keep');
    const chat = chatOf('q', 'a');
    chat.confirm = async () => false;
    await chat.exportChat(out('t.md'));
    expect(fs.readFileSync(out('t.md'), 'utf8')).toBe('keep');
    await chat.exportChat(out('t.pdf'));
    expect(output()).toContain('Export as a .md transcript or a .Modelfile');
  });

  it('formats a title, system message, and models', () => {
    const text = formatMarkdown({ title: 'Trip', system: 'Be brief.', messages: [{ role: 'assistant', content: 'hi', origin: { model: 'a' } }], exportedAt: new Date('2026-10-08T00:00:00Z') });
    expect(text).toBe('# Trip\n\n*Exported from skinnyai on 2026-10-08. Models: a.*\n\n**System message:**\n\n> Be brief.\n\n### Assistant (a)\n\nhi\n');
  });
});

describe('/purge', () => {
  const rich = () => [
    { role: 'user', content: 'see', images: [png], documents: [{ name: 'a.pdf', mime: 'application/pdf', data: 'AA' }] },
    { role: 'assistant', content: 'ok', thinkingBlocks: [{ type: 'thinking' }], tool_calls: [{ id: 'c1', function: { name: 'draw', arguments: {} } }] },
    { role: 'tool', tool_call_id: 'c1', tool_name: 'draw', content: 'saved', images: [png], parts: [{ type: 'image', ...png }, { type: 'text', text: 'saved' }] },
    { role: 'assistant', content: 'done' }
  ];

  it('drops thinking, flattens tools, or removes blobs, each on its own', () => {
    expect(purgeHistory(rich(), 'thinking')).toMatchObject({ removed: 1 });
    expect(purgeHistory(rich(), 'thinking').history[1].thinkingBlocks).toBeUndefined();
    const tools = purgeHistory(rich(), 'tools');
    expect(tools.removed).toBe(1);
    expect(tools.history.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(tools.history[1].thinkingBlocks).toHaveLength(1); // kept: only tools were asked for
    const blobs = purgeHistory(rich(), 'blobs');
    expect(blobs.removed).toBe(3);
    expect(blobs.history[0].content).toBe('see\n\n[1 attached image removed]\n\n[attached file a.pdf removed]');
    expect(blobs.history[2].images).toBeUndefined();
    expect(blobs.history[2].parts).toBeUndefined();
    expect(() => purgeHistory(rich(), 'nope')).toThrow();
  });

  it('rewrites the saved chat and shrinks it', async () => {
    const chat = chatOf();
    chat.history = rich();
    chat.history[0].images = [{ mime: 'image/png', data: Buffer.alloc(300000, 7).toString('base64') }];
    await chat.save('big');
    const file = skinnyai.sessionPath('big');
    const before = fs.statSync(file).size;
    await chat.handleCommand('/purge blobs');
    expect(output()).toContain('Purged 3 attachments.');
    expect(fs.statSync(file).size).toBeLessThan(before);
    const saved = readChat(file).messages;
    expect(saved[0].images).toBeUndefined();
    await chat.handleCommand('/purge thinking');
    await chat.handleCommand('/purge thinking');
    expect(output()).toContain('Nothing to purge');
    await chat.handleCommand('/purge');
    expect(output()).toContain('Usage: /purge');
  });
});

describe('who can read the files', () => {
  it('makes chat files and the folders around them private to you', async () => {
    fs.rmSync(skinnyai.SESSION_DIR, { recursive: true, force: true });
    await chatOf('q', 'a').save('Private');
    expect(fs.statSync(skinnyai.sessionPath('Private')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(skinnyai.SESSION_DIR).mode & 0o777).toBe(0o700);
  });

  it('tightens a folder that was made looser, and leaves a private one alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyai-perm-'));
    fs.chmodSync(dir, 0o755);
    expect(skinnyai.tightenDir(dir)).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    fs.chmodSync(dir, 0o500);
    skinnyai.tightenDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o500); // no group/other bits, so untouched
    expect(skinnyai.tightenDir(path.join(dir, 'nope'))).toBe(false);
    fs.chmodSync(dir, 0o700);
  });
});
