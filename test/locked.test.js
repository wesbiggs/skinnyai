import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureOutput, fakeTTY, stripAnsi } from './helpers/tty.js';
import { startMockServer } from './helpers/mock-server.js';

// Sessions set up to live on an encrypted volume ("encryptedSessions" in
// config.json). The mount point is a plain folder here; the marker file that
// appears inside the real volume is created and removed by hand.
let skinnyai;
let server;
let capture;
let mount;
const marker = () => path.join(mount, '.skinny-encrypted');

beforeAll(async () => {
  fakeTTY({ columns: 80 });
  mount = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyai-mount-'));
  fs.writeFileSync(path.join(process.env.SKINNY_HOME, 'config.json'), JSON.stringify({
    encryptedSessions: { mountPoint: mount },
    profiles: { Default: { env: {} } }
  }));
  skinnyai = await import('../src/skinnyai.js');
  server = await startMockServer();
});
afterAll(() => server.close());
beforeEach(() => {
  fs.rmSync(marker(), { force: true });
  for (const entry of fs.readdirSync(mount)) fs.rmSync(path.join(mount, entry), { recursive: true, force: true });
  capture = captureOutput();
});
afterEach(() => capture.stop());

const output = () => stripAnsi(capture.text);
const chatOf = (...contents) => {
  const chat = new skinnyai.OllamaChat('m', { api: 'openai', host: server.url, autosave: true });
  chat.history = contents.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content }));
  return chat;
};

describe('encrypted sessions that are locked', () => {
  it('use the mount point from config.json, and are locked until the volume\'s marker is there', () => {
    expect(skinnyai.SESSIONS_ENCRYPTED).toBe(true);
    expect(skinnyai.SESSION_DIR).toBe(mount);
    expect(skinnyai.sessionsLocked()).toBe(true);
    fs.writeFileSync(marker(), '');
    expect(skinnyai.sessionsLocked()).toBe(false);
  });

  it('refuse to save, read, or look for sessions, and write nothing', async () => {
    const message = /Encrypted sessions are locked/;
    await expect(skinnyai.saveLocalSession('x', { from: 'm', system: '', parameters: {}, messages: [] })).rejects.toThrow(message);
    await expect(skinnyai.readLocalSession('x')).rejects.toThrow(message);
    await expect(skinnyai.localSessionExists('x')).rejects.toThrow(message);
    await expect(skinnyai.autosaveName()).rejects.toThrow(message);
    expect(await skinnyai.listLocalSessions()).toEqual([]);
    expect(fs.readdirSync(mount)).toEqual([]);
  });

  it('say so for commands that need sessions, and do not autosave', async () => {
    const chat = chatOf('q', 'a');
    for (const command of ['/save trip', '/new', '/delete', '/sync', '/project', '/share', '/purge blobs']) {
      expect(await chat.handleCommand(command)).toBe(true);
    }
    expect(output().match(/Encrypted sessions are locked/g)).toHaveLength(7);
    await chat.autosaveSession();
    expect(fs.readdirSync(mount)).toEqual([]);
    expect(chat.sessionName).toBeNull();
  });

  it('say so in /list, which still lists models', async () => {
    await chatOf().list();
    expect(output()).toContain('Encrypted sessions are locked');
  });

  it('show in the welcome box whether the volume is locked', () => {
    chatOf().printWelcome();
    expect(output()).toContain('Chats: encrypted volume, locked');
    fs.writeFileSync(marker(), '');
    capture.stop();
    capture = captureOutput();
    chatOf().printWelcome();
    expect(output()).toContain('Chats: encrypted volume, unlocked');
  });

  it('keep the debug log out of the way', async () => {
    const { DEBUG_LOG, enableDebugLog } = await import('../src/debug.js');
    expect(DEBUG_LOG).toBe(path.join(mount, '.debug.log'));
    expect(await enableDebugLog()).toBe(false);
    expect(fs.readdirSync(mount)).toEqual([]);
  });
});

describe('encrypted sessions once the volume is mounted', () => {
  it('work as sessions always do, inside the mount point', async () => {
    fs.writeFileSync(marker(), '');
    const chat = chatOf('q', 'a');
    await chat.handleCommand('/save trip');
    expect(output()).not.toContain('locked');
    expect(fs.readdirSync(mount).sort()).toEqual(['.skinny-encrypted', 'trip.skinny']);
    expect(await skinnyai.listLocalSessions()).toEqual(['trip']);
    const { DEBUG_LOG, enableDebugLog } = await import('../src/debug.js');
    expect(await enableDebugLog()).toBe(true);
    expect(fs.existsSync(DEBUG_LOG)).toBe(true);
  });
});
