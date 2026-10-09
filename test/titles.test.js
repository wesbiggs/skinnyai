import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatProjectOf } from '../src/chatdb.js';
import { SYNC_CONFIG_FILE, addProject } from '../src/syncconfig.js';
import { captureOutput, fakeTTY, stripAnsi } from './helpers/tty.js';
import { startMockServer } from './helpers/mock-server.js';

let skinnyai;
let server;
let silent;
let capture;

beforeAll(async () => {
  fakeTTY({ columns: 80 });
  skinnyai = await import('../src/skinnyai.js');
  server = await startMockServer({ titleReply: 'Title: "Planning a Lisbon trip."' });
  silent = await startMockServer(); // answers title requests with an error
});
afterAll(() => Promise.all([server.close(), silent.close()]));
beforeEach(() => {
  fs.rmSync(skinnyai.SESSION_DIR, { recursive: true, force: true });
  fs.rmSync(SYNC_CONFIG_FILE, { force: true });
  server.titleRequests.length = 0;
  silent.titleRequests.length = 0;
  vi.stubEnv('ANTHROPIC_API_KEY', 'k');
  capture = captureOutput();
});
afterEach(() => {
  capture.stop();
  vi.unstubAllEnvs();
});

const output = () => stripAnsi(capture.text);
const chatFor = (options = {}, host = server) => {
  const chat = new skinnyai.OllamaChat('m', { api: 'openai', host: host.url, autosave: true, ...options });
  chat.history = [{ role: 'user', content: 'Where should I eat in Lisbon?' }, { role: 'assistant', content: 'Try a tasca in Alfama.' }];
  return chat;
};

describe('naming a chat from a title', () => {
  it.each([
    ['ollama', '/api/chat'],
    ['openai', '/v1/chat/completions'],
    ['anthropic', '/v1/messages']
  ])('asks the model once after the first reply (%s) and names the file from it', async (api, url) => {
    const chat = chatFor({ api });
    await chat.autosaveSession();
    expect(server.titleRequests).toHaveLength(1);
    expect(server.titleRequests[0].url).toBe(url);
    expect(JSON.stringify(server.titleRequests[0].body)).toContain('Where should I eat in Lisbon?');
    expect(chat.sessionName).toBe('Planning a Lisbon trip');
    expect(fs.existsSync(skinnyai.sessionPath('Planning a Lisbon trip'))).toBe(true);
    expect(output()).toContain("Autosaving to 'Planning a Lisbon trip.skinny' (/save <name> renames it)");
    chat.history.push({ role: 'user', content: 'more' });
    await chat.autosaveSession();
    expect(server.titleRequests).toHaveLength(1); // only the first time
  });

  it('keeps titles apart: a second chat with the same title gets a number', async () => {
    await chatFor().autosaveSession();
    const second = chatFor();
    await second.autosaveSession();
    expect(second.sessionName).toBe('Planning a Lisbon trip (2)');
  });

  it('falls back to the date and time when the model gives no usable title', async () => {
    const chat = chatFor({}, silent);
    await chat.autosaveSession();
    expect(chat.sessionName).toMatch(/^chat-\d{4}-\d{2}-\d{2}-\d{6}$/);
    expect(output()).toContain(`Autosaving as '${chat.sessionName}'`);
    const unreachable = new skinnyai.OllamaChat('m', { api: 'openai', host: 'http://127.0.0.1:1', autosave: true });
    unreachable.history = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
    await unreachable.autosaveSession();
    expect(unreachable.sessionName).toMatch(/^chat-/);
  });

  it('asks nothing when titles are off', async () => {
    const chat = chatFor({ titles: false });
    await chat.autosaveSession();
    expect(server.titleRequests).toHaveLength(0);
    expect(chat.sessionName).toMatch(/^chat-/);
  });

  it('is renamed, not copied, by a later /save <name>', async () => {
    const chat = chatFor();
    await chat.autosaveSession();
    await chat.save('Lisbon');
    expect(fs.readdirSync(skinnyai.SESSION_DIR)).toEqual(['Lisbon.skinny']);
    expect(output()).toContain("Renamed session 'Planning a Lisbon trip' to 'Lisbon'");
    // once the user chose the name, saving under another name makes a copy as usual
    await chat.save('Lisbon again');
    expect(fs.readdirSync(skinnyai.SESSION_DIR).sort()).toEqual(['Lisbon again.skinny', 'Lisbon.skinny']);
  });

  it('tidies what models send back', () => {
    expect(skinnyai.tidyTitle('Title: "Planning a Lisbon trip."')).toBe('Planning a Lisbon trip');
    expect(skinnyai.tidyTitle('<think>hm</think>\n**Weekend in Porto**')).toBe('Weekend in Porto');
    expect(skinnyai.tidyTitle('# Sourdough starter tips!\nHere is why')).toBe('Sourdough starter tips');
    expect(skinnyai.tidyTitle('x'.repeat(30) + ' ' + 'y'.repeat(40))).toBe('x'.repeat(30));
    expect(skinnyai.tidyTitle('')).toBeNull();
    expect(skinnyai.tidyTitle(undefined)).toBeNull();
    expect(skinnyai.tidyTitle('"."')).toBeNull();
  });
});

describe('welcome box', () => {
  it('says sync is off, and how to turn it on', () => {
    chatFor().printWelcome();
    expect(output()).toContain('Sync: off (/sync setup <folder> turns it on)');
  });

  it('says which project a new chat goes in, and which a saved chat is in', async () => {
    addProject({ id: 'p1', folder: '/tmp/p1', name: 'Default' });
    addProject({ id: 'p2', folder: '/tmp/p2', name: 'Work' });
    const fresh = chatFor();
    fresh.printWelcome();
    expect(output()).toContain("Sync: on, project 'Default'");

    const saved = chatFor({ titles: false });
    await saved.save('Office');
    const { setChatProject } = await import('../src/chatdb.js');
    setChatProject(skinnyai.sessionPath('Office'), 'p2');
    expect(chatProjectOf(skinnyai.sessionPath('Office'))).toBe('p2');
    capture.stop();
    capture = captureOutput();
    saved.printWelcome();
    expect(output()).toContain("Sync: on, project 'Work'");

    setChatProject(skinnyai.sessionPath('Office'), 'gone');
    capture.stop();
    capture = captureOutput();
    saved.printWelcome();
    expect(output()).toContain('Sync: on, project not set up on this device');
  });
});
