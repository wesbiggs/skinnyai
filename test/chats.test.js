import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { messageCount, readChat, revisionOf, writeChat } from '../src/chatdb.js';
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
const png = { mime: 'image/png', data: Buffer.from('pixels').toString('base64') };
const session = (messages) => ({ from: 'm', system: 's', parameters: { temperature: '0.5', stop: ['a', 'b'] }, messages, settings: { api: 'openai', tools: true, format: undefined } });

describe('chat files', () => {
  const file = () => path.join(skinnyai.SESSION_DIR, 'x.skinny');
  beforeEach(() => fs.mkdirSync(skinnyai.SESSION_DIR, { recursive: true }));

  it('round-trips settings and parameters', () => {
    writeChat(file(), session([{ role: 'user', content: 'hi' }]));
    const read = readChat(file());
    expect(read).toMatchObject({ from: 'm', system: 's', settings: { api: 'openai', tools: 'true' } });
    expect(read.parameters).toEqual([['temperature', '0.5'], ['stop', 'a'], ['stop', 'b']]);
    expect(read.chatId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('appends only new messages when the file holds what the caller expects', () => {
    const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    writeChat(file(), session(messages));
    const db = new DatabaseSync(file());
    const firstId = db.prepare('SELECT MIN(id) AS id FROM messages').get().id;
    db.close();
    writeChat(file(), session([...messages, { role: 'user', content: 'c' }]), { append: 2 });
    expect(messageCount(file())).toBe(3);
    expect(revisionOf(file())).toBe(2);
    const after = new DatabaseSync(file());
    expect(after.prepare('SELECT MIN(id) AS id FROM messages').get().id).toBe(firstId); // earlier rows were left alone
    after.close();
  });

  it('rewrites when the file does not hold what the caller expects', () => {
    writeChat(file(), session([{ role: 'user', content: 'a' }]));
    writeChat(file(), session([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }, { role: 'user', content: 'z' }]), { append: 2 });
    expect(readChat(file()).messages.map((m) => m.content)).toEqual(['x', 'y', 'z']);
  });

  it('stores identical attachments once and removes ones no message uses', () => {
    writeChat(file(), session([{ role: 'user', content: 'a', images: [png] }, { role: 'user', content: 'b', images: [png] }]));
    const db = new DatabaseSync(file());
    expect(db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n).toBe(1);
    db.close();
    writeChat(file(), session([{ role: 'user', content: 'a' }]));
    const again = new DatabaseSync(file());
    expect(again.prepare('SELECT COUNT(*) AS n FROM blobs').get().n).toBe(0);
    again.close();
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

describe('sessions from earlier versions', () => {
  const legacy = (name) => path.join(skinnyai.SESSION_DIR, `${name}.Modelfile`);
  beforeEach(() => {
    fs.mkdirSync(skinnyai.SESSION_DIR, { recursive: true });
    fs.writeFileSync(legacy('old'), skinnyai.formatModelfile({ from: 'legacy-model', system: '', parameters: {}, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] }));
  });

  it('load, list once, and are saved as .skinny files the next time', async () => {
    const chat = chatOf();
    await chat.load('old');
    expect(chat.model).toBe('legacy-model');
    expect(chat.history.map((m) => m.content)).toEqual(['hi', 'hello']);
    chat.history.push({ role: 'user', content: 'more' });
    await chat.save('');
    expect(files()).toEqual(['old.Modelfile', 'old.skinny']);
    expect(await skinnyai.listLocalSessions()).toEqual(['old']);
    expect(readChat(path.join(skinnyai.SESSION_DIR, 'old.skinny')).messages).toHaveLength(3);
    const next = chatOf();
    await next.load('old');
    expect(next.history).toHaveLength(3); // the .skinny file wins
  });

  it('are removed along with the chat file by /delete', async () => {
    const chat = chatOf();
    await chat.load('old');
    await chat.save('');
    chat.confirm = async () => true;
    await chat.deleteSession('old');
    expect(files()).toEqual([]);
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
    expect(revisionOf(path.join(skinnyai.SESSION_DIR, name))).toBe(2);
    expect(new skinnyai.OllamaChat('m', { autosave: false }).autosave).toBe(false);
  });
});

describe('/clear, /new, and /delete', () => {
  it('/clear NAME saves the conversation under that name, then starts a new one', async () => {
    const chat = chatOf('q', 'a');
    await chat.handleCommand('/clear Keeper');
    expect(files()).toEqual(['Keeper.skinny']);
    expect(chat.history).toEqual([]);
    expect(chat.sessionName).toBeNull();
    expect(output()).toContain("Saved as 'Keeper' and started a new conversation.");
  });

  it('/clear NAME keeps the conversation when the save is declined', async () => {
    await chatOf('old', 'a').save('Taken');
    const chat = chatOf('q', 'a');
    chat.confirm = async () => false;
    await chat.handleCommand('/clear Taken');
    expect(chat.history).toHaveLength(2);
  });

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
