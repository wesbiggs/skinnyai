import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { newMessageId, readChat, writeChat } from '../src/chatdb.js';
import { SYNC_CONFIG_FILE } from '../src/syncconfig.js';
import { syncChats } from '../src/sync.js';
import { VAULT_FILE, encodeRecoveryKey, loadVaultKey } from '../src/vault.js';
import { captureOutput, fakeTTY, stripAnsi } from './helpers/tty.js';
import { startMockServer } from './helpers/mock-server.js';

// /sync from inside a chat. The chat is this device; "the other device" is a
// second sessions directory synced through the same folder.
let skinnyai;
let server;
let capture;
let folder;
let other;
const otherDevice = { id: 'zzzz-other-device', name: 'phone' };

beforeAll(async () => {
  fakeTTY({ columns: 80 });
  skinnyai = await import('../src/skinnyai.js');
  server = await startMockServer();
});
afterAll(() => server.close());
beforeEach(() => {
  vi.stubEnv('SKINNY_VAULT_STORE', 'file');
  fs.rmSync(skinnyai.SESSION_DIR, { recursive: true, force: true });
  for (const file of [VAULT_FILE, SYNC_CONFIG_FILE]) fs.rmSync(file, { force: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyai-syncchat-'));
  folder = path.join(tmp, 'cloud');
  other = path.join(tmp, 'other');
  fs.mkdirSync(other);
  capture = captureOutput();
});
afterEach(() => {
  capture.stop();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const output = () => stripAnsi(capture.text);
const chatOf = (...contents) => {
  const chat = new skinnyai.OllamaChat('m', { api: 'openai', host: server.url, autosave: true });
  chat.history = contents.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content }));
  return chat;
};
const otherSync = () => syncChats({ folder, key: loadVaultKey(), sessionsDir: other });
const otherFile = (name) => path.join(other, `${name}.skinny`);
const otherAppend = (name, text) => {
  const read = readChat(otherFile(name));
  const added = { id: newMessageId(), role: 'user', content: text };
  writeChat(otherFile(name), { from: 'm', system: '', parameters: {}, settings: {}, name, messages: [...read.messages, added] }, { after: read.last, device: otherDevice });
};

describe('/sync setup', () => {
  it('makes a key, shows the recovery key once, syncs, and remembers the folder', async () => {
    const chat = chatOf('q', 'a');
    await chat.save('Trip');
    await chat.handleCommand(`/sync setup ${folder}`);
    expect(output()).toMatch(/Made a key for your chats, kept in .*vault\.key/);
    expect(output()).toContain(encodeRecoveryKey(loadVaultKey()));
    expect(output()).toContain('Synced: sent 1 change.');
    expect(JSON.parse(fs.readFileSync(SYNC_CONFIG_FILE, 'utf8'))).toEqual({ folder });
    expect(fs.statSync(VAULT_FILE).mode & 0o777).toBe(0o600);
    expect(otherSync().newChats).toEqual(['Trip']);
  });

  it('asks a second device for the recovery key, and checks it', async () => {
    await chatOf('q', 'a').save('Trip');
    await chatOf().handleCommand(`/sync setup ${folder}`);
    const recovery = encodeRecoveryKey(loadVaultKey());
    fs.rmSync(VAULT_FILE);
    fs.rmSync(SYNC_CONFIG_FILE);

    const wrong = chatOf();
    wrong.readTurnInput = async () => encodeRecoveryKey(Buffer.alloc(32, 1));
    await wrong.handleCommand(`/sync setup ${folder}`);
    expect(output()).toContain("That key doesn't open the chats in that folder.");
    expect(fs.existsSync(SYNC_CONFIG_FILE)).toBe(false);

    const typo = chatOf();
    typo.readTurnInput = async () => recovery.replace(/.$/, recovery.endsWith('0') ? '1' : '0');
    await typo.handleCommand(`/sync setup ${folder}`);
    expect(output()).toContain('typo');

    const right = chatOf();
    right.readTurnInput = async () => recovery.toLowerCase();
    await right.handleCommand(`/sync setup ${folder}`);
    expect(output()).toContain('Syncing through');
    expect(loadVaultKey()).not.toBeNull();
  });

  it('says what to do when sync is off or the key is missing', async () => {
    const chat = chatOf();
    await chat.handleCommand('/sync');
    expect(output()).toContain('Sync is off. /sync setup <folder>');
    fs.mkdirSync(path.dirname(SYNC_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(SYNC_CONFIG_FILE, JSON.stringify({ folder }));
    await chat.handleCommand('/sync');
    expect(output()).toContain('has no key for it');
    await chat.handleCommand('/sync key');
    expect(output()).toContain('no sync key yet');
  });

  it('shows status and the recovery key, and turns off', async () => {
    const chat = chatOf();
    await chat.handleCommand(`/sync setup ${folder}`);
    await chat.handleCommand('/sync status');
    expect(output()).toContain(`Sync folder: ${folder}`);
    expect(output()).toContain("This device's key: matches the folder");
    await chat.handleCommand('/sync key');
    expect(output().match(new RegExp(encodeRecoveryKey(loadVaultKey()), 'g'))).toHaveLength(2); // at setup and now
    await chat.handleCommand('/sync off');
    expect(fs.existsSync(SYNC_CONFIG_FILE)).toBe(false);
    expect(loadVaultKey()).not.toBeNull();
  });
});

describe('deleting a synced chat', () => {
  it('/delete removes it from the folder, and a chat open elsewhere is told', async () => {
    const chat = chatOf('q', 'a');
    await chat.handleCommand(`/sync setup ${folder}`);
    await chat.save('Trip');
    await chat.runSync();
    otherSync();
    chat.confirm = async () => true;
    await chat.handleCommand('/delete');
    expect(output()).toContain('Removed it from the sync folder too');
    const report = otherSync();
    expect(report.deleted.map((d) => d.name)).toEqual(['Trip']);

    const second = chatOf('x', 'y');
    await second.save('Plans');
    await second.runSync();
    otherSync();
    fs.rmSync(otherFile('Plans'));
    const chatId = readChat(path.join(skinnyai.SESSION_DIR, 'Plans.skinny')).chatId;
    const { deleteSyncedChat } = await import('../src/sync.js');
    deleteSyncedChat({ folder, key: loadVaultKey(), chatId });
    await second.runSync();
    expect(output()).toContain("'Plans' was deleted on another device");
    expect(second.sessionName).toBeNull();
    expect(second.history).toHaveLength(2);
  });
});

describe('syncing an open chat', () => {
  it('brings in changes made on the other device', async () => {
    const chat = chatOf('q', 'a');
    await chat.handleCommand(`/sync setup ${folder}`);
    await chat.save('Trip');
    await chat.runSync();
    otherSync();
    otherAppend('Trip', 'from the phone');
    otherSync();
    await chat.handleCommand('/sync');
    expect(output()).toContain('received 1 change');
    expect(output()).toContain("'Trip' now has the changes from your other device (3 messages)");
    expect(chat.history.map((m) => m.content)).toEqual(['q', 'a', 'from the phone']);
  });

  it('keeps both lines when each device added to the chat, and says where the user\'s went', async () => {
    const chat = chatOf('q', 'a');
    await chat.handleCommand(`/sync setup ${folder}`);
    await chat.save('Trip');
    await chat.runSync();
    otherSync();
    otherAppend('Trip', 'phone says hi');
    otherSync();
    chat.history.push({ role: 'user', content: 'laptop says hi' });
    await chat.handleCommand('/sync');
    expect(output()).toContain("'Trip' continued on two devices");
    expect(output()).toContain("Your latest messages are in 'Trip (from");
    expect(chat.history.map((m) => m.content)).toEqual(['q', 'a', 'phone says hi']);
    const copy = fs.readdirSync(skinnyai.SESSION_DIR).find((f) => f.startsWith('Trip (from'));
    expect(readChat(path.join(skinnyai.SESSION_DIR, copy)).messages.map((m) => m.content)).toEqual(['q', 'a', 'laptop says hi']);
  });

  it('syncs quietly at startup and says what arrived', async () => {
    const chat = chatOf('q', 'a');
    await chat.handleCommand(`/sync setup ${folder}`);
    await chat.save('Trip');
    await chat.runSync();
    otherSync();
    writeChat(otherFile('Made elsewhere'), { from: 'm', system: '', parameters: {}, settings: {}, name: 'Made elsewhere', messages: [{ id: newMessageId(), role: 'user', content: 'hello' }] }, { device: otherDevice });
    otherSync();
    capture.stop();
    capture = captureOutput();
    chatOf().syncAtStartup();
    expect(output()).toContain("Synced: received 1 change; new chat: 'Made elsewhere'.");
    expect(fs.existsSync(path.join(skinnyai.SESSION_DIR, 'Made elsewhere.skinny'))).toBe(true);
  });

  it('sends a chat\'s new messages after each autosave', async () => {
    const chat = chatOf();
    await chat.handleCommand(`/sync setup ${folder}`);
    chat.history.push({ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' });
    await chat.autosaveSession();
    const report = otherSync();
    expect(report.newChats).toHaveLength(1);
    expect(readChat(path.join(other, fs.readdirSync(other)[0])).messages.map((m) => m.content)).toEqual(['one', 'two']);
  });
});
