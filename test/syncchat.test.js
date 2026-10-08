import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatIdOf, chatProjectOf, newMessageId, readChat, writeChat } from '../src/chatdb.js';
import { KEYS_FILE, encodeProjectKey, loadProjectKey } from '../src/keys.js';
import { deleteSyncedChat, syncProject } from '../src/sync.js';
import { SYNC_CONFIG_FILE, defaultProject, loadSyncConfig } from '../src/syncconfig.js';
import { captureOutput, fakeTTY, stripAnsi } from './helpers/tty.js';
import { startMockServer } from './helpers/mock-server.js';

// /sync and /project from inside a chat. The chat is this device; "the other
// device" is a second sessions directory synced through the same folder.
let skinnyai;
let server;
let capture;
let tmp;
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
  vi.stubEnv('SKINNY_KEY_STORE', 'file');
  fs.rmSync(skinnyai.SESSION_DIR, { recursive: true, force: true });
  for (const file of [KEYS_FILE, SYNC_CONFIG_FILE]) fs.rmSync(file, { force: true });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyai-syncchat-'));
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
const chatFile = (name) => path.join(skinnyai.SESSION_DIR, `${name}.skinny`);
const files = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.skinny')).sort();
// The other device syncing one of this device's projects.
const otherSync = (project = defaultProject(loadSyncConfig())) => syncProject({ project, key: loadProjectKey(project.id), sessionsDir: other });
const otherFile = (name) => path.join(other, `${name}.skinny`);
const otherAppend = (name, text) => {
  const read = readChat(otherFile(name));
  const added = { id: newMessageId(), role: 'user', content: text };
  writeChat(otherFile(name), { from: 'm', system: '', parameters: {}, settings: {}, name, messages: [...read.messages, added] }, { after: read.last, device: otherDevice });
};
const projectNamed = (name) => loadSyncConfig().projects.find((p) => p.name === name);

describe('/sync setup', () => {
  it('makes the default project, shows its key once, puts existing chats in it, and syncs', async () => {
    const chat = chatOf('q', 'a');
    await chat.save('Trip');
    await chat.handleCommand(`/sync setup ${folder}`);
    const project = defaultProject(loadSyncConfig());
    expect(project).toMatchObject({ name: 'Default', folder });
    expect(output()).toContain("Project 'Default' syncs through");
    expect(output()).toContain('and so did your 1 existing chat');
    expect(output()).toContain(encodeProjectKey(loadProjectKey(project.id)));
    expect(output()).toContain('Synced: sent 1 change.');
    expect(chatProjectOf(chatFile('Trip'))).toBe(project.id);
    expect(fs.statSync(KEYS_FILE).mode & 0o777).toBe(0o600);
    expect(otherSync().newChats).toEqual(['Trip']);
  });

  it('says it is already set up the second time', async () => {
    await chatOf().handleCommand(`/sync setup ${folder}`);
    await chatOf().handleCommand(`/sync setup ${path.join(tmp, 'again')}`);
    expect(output()).toContain("Sync is already set up: the default project is 'Default'.");
  });

  it('joins an existing project on another device: asks for the key, checks it, and uses the suggested name', async () => {
    await chatOf('q', 'a').save('Trip');
    await chatOf().handleCommand(`/sync setup ${folder}`);
    const text = encodeProjectKey(loadProjectKey(defaultProject(loadSyncConfig()).id));
    fs.rmSync(KEYS_FILE);
    fs.rmSync(SYNC_CONFIG_FILE);
    fs.rmSync(skinnyai.SESSION_DIR, { recursive: true });

    const wrong = chatOf();
    wrong.readTurnInput = async () => encodeProjectKey(Buffer.alloc(32, 1));
    await wrong.handleCommand(`/sync setup ${folder}`);
    expect(output()).toContain("That key doesn't open the project in that folder.");
    expect(loadSyncConfig().projects).toEqual([]);

    const typo = chatOf();
    typo.readTurnInput = async () => text.replace(/.$/, text.endsWith('0') ? '1' : '0');
    await typo.handleCommand(`/sync setup ${folder}`);
    expect(output()).toContain('typo');

    const right = chatOf();
    right.readTurnInput = async () => text.toLowerCase();
    await right.handleCommand(`/sync setup ${folder}`);
    expect(output()).toContain("Joined project 'Default'");
    expect(files(skinnyai.SESSION_DIR)).toEqual(['Trip.skinny']);
    expect(loadSyncConfig().default).toBe(loadSyncConfig().projects[0].id);
  });

  it('says what to do when sync is off', async () => {
    await chatOf().handleCommand('/sync');
    expect(output()).toContain('Sync is off. /sync setup <folder>');
    await chatOf().handleCommand('/project');
    expect(output()).toContain('No projects yet.');
  });

  it('shows status, and turns off without touching chats or keys', async () => {
    const chat = chatOf();
    await chat.handleCommand(`/sync setup ${folder}`);
    await chat.handleCommand('/sync status');
    expect(output()).toMatch(/Default \(default\)\n {4}.*cloud/);
    await chat.handleCommand('/sync off');
    expect(loadSyncConfig()).toEqual({ default: null, projects: [] });
    expect(fs.existsSync(KEYS_FILE)).toBe(true);
  });
});

describe('/project: operations on all projects', () => {
  it('makes another project, which is not the default, and lists them', async () => {
    const chat = chatOf();
    await chat.handleCommand(`/sync setup ${folder}`);
    await chat.handleCommand(`/project new Work ${path.join(tmp, 'work')}`);
    expect(output()).toContain("Project 'Work' syncs through");
    expect(output()).toContain('Keep a copy of this project key');
    expect(defaultProject(loadSyncConfig()).name).toBe('Default');
    await chat.handleCommand('/project');
    expect(output()).toMatch(/Default \(default\)[\s\S]*Work\n/);
    await chat.handleCommand(`/project new Work ${path.join(tmp, 'work2')}`);
    expect(output()).toContain("You already have a project called 'Work'.");
    await chat.handleCommand(`/project new Again ${folder}`);
    expect(output()).toContain('is already a project. /project add');
  });

  it('puts new chats in the default project, which can be changed', async () => {
    const chat = chatOf('q', 'a');
    await chat.handleCommand(`/sync setup ${folder}`);
    await chat.handleCommand(`/project new Work ${path.join(tmp, 'work')}`);
    await chat.save('Home');
    await chat.handleCommand('/project default work');
    expect(output()).toContain("'Work' is now the default project");
    const next = chatOf('x', 'y');
    await next.save('Office');
    expect(chatProjectOf(chatFile('Home'))).toBe(projectNamed('Default').id);
    expect(chatProjectOf(chatFile('Office'))).toBe(projectNamed('Work').id);
  });

  it('joins a project by folder, with a name of your own', async () => {
    const chat = chatOf();
    await chat.handleCommand(`/sync setup ${folder}`);
    await chat.handleCommand(`/project new Team ${path.join(tmp, 'team')}`);
    const team = projectNamed('Team');
    const keyText = encodeProjectKey(loadProjectKey(team.id));
    await chat.handleCommand('/project forget team');
    expect(output()).toContain("Stopped syncing 'Team' on this device.");
    expect(projectNamed('Team')).toBeUndefined();

    fs.rmSync(KEYS_FILE); // as if this were a different person's device
    const joiner = chatOf();
    joiner.readTurnInput = async () => keyText;
    await joiner.handleCommand(`/project add ${path.join(tmp, 'team')} "My team"`);
    expect(output()).toContain("Joined project 'My team' (its creator calls it 'Team')");
    expect(projectNamed('My team').id).toBe(team.id);
  });

  it('shows a key, renames a project locally, and forgets one', async () => {
    const chat = chatOf();
    await chat.handleCommand(`/sync setup ${folder}`);
    await chat.handleCommand('/project key');
    const id = defaultProject(loadSyncConfig()).id;
    expect(output()).toContain(encodeProjectKey(loadProjectKey(id)));
    await chat.handleCommand('/project rename Default Personal');
    expect(defaultProject(loadSyncConfig()).name).toBe('Personal');
    await chat.handleCommand('/project key Nope');
    expect(output()).toContain("No project called 'Nope'");
    await chat.handleCommand('/project forget personal');
    expect(loadSyncConfig().projects).toEqual([]);
    expect(loadProjectKey(id)).not.toBeNull(); // the key stays
  });
});

describe('/project: operations on the open chat', () => {
  it('copies the chat into another project as a chat of its own', async () => {
    const chat = chatOf('q', 'a');
    await chat.handleCommand(`/sync setup ${folder}`);
    await chat.handleCommand(`/project new Work ${path.join(tmp, 'work')}`);
    await chat.save('Report');
    await chat.handleCommand('/project copy Work');
    expect(output()).toContain("Copied to 'Work' as 'Report (2)'. This chat is unchanged.");
    expect(files(skinnyai.SESSION_DIR)).toEqual(['Report (2).skinny', 'Report.skinny']);
    expect(chatProjectOf(chatFile('Report'))).toBe(projectNamed('Default').id);
    expect(chatProjectOf(chatFile('Report (2)'))).toBe(projectNamed('Work').id);
    expect(chatIdOf(chatFile('Report (2)'))).not.toBe(chatIdOf(chatFile('Report')));
    expect(otherSync(projectNamed('Work')).newChats).toEqual(['Report (2)']);
  });

  it('moves the chat: it keeps its name, changes project, and leaves only a marker behind', async () => {
    const chat = chatOf('q', 'a');
    await chat.handleCommand(`/sync setup ${folder}`);
    await chat.handleCommand(`/project new Work ${path.join(tmp, 'work')}`);
    await chat.save('Report');
    await chat.runSync();
    otherSync(); // the other device has it in Default
    const oldId = chatIdOf(chatFile('Report'));

    await chat.handleCommand('/project move Work');
    expect(output()).toContain("Moved to 'Work'. Other devices in 'Default' remove it at their next sync.");
    expect(files(skinnyai.SESSION_DIR)).toEqual(['Report.skinny']);
    expect(chatProjectOf(chatFile('Report'))).toBe(projectNamed('Work').id);
    expect(chatIdOf(chatFile('Report'))).not.toBe(oldId);
    expect(chat.sessionName).toBe('Report');
    // the old project has only a marker, which says nothing about where the chat went
    const left = path.join(folder, 'skinnyai-sync', 'chats', oldId);
    expect(fs.readdirSync(left)).toEqual(['deleted']);
    expect(fs.readFileSync(path.join(left, 'deleted')).includes('Work')).toBe(false);
    expect(otherSync().deleted.map((d) => d.name)).toEqual(['Report']);
    expect(files(other)).toEqual([]);
    expect(otherSync(projectNamed('Work')).newChats).toEqual(['Report']);

    // and the chat carries on in its new project
    chat.history.push({ role: 'user', content: 'more' });
    await chat.autosaveSession();
    expect(readChat(chatFile('Report')).messages.map((m) => m.content)).toEqual(['q', 'a', 'more']);
    expect(otherSync(projectNamed('Work')).pulled).toBe(1);
  });

  it('says so when the chat is already there, has no messages, or the project is unknown', async () => {
    const chat = chatOf('q', 'a');
    await chat.handleCommand(`/sync setup ${folder}`);
    await chat.save('Report');
    await chat.handleCommand('/project move Default');
    expect(output()).toContain("This chat is already in 'Default'.");
    await chat.handleCommand('/project move Nowhere');
    expect(output()).toContain("No project called 'Nowhere'");
    await chatOf().handleCommand('/project copy Default');
    expect(output()).toContain('This chat has no messages yet.');
  });
});

describe('deleting a synced chat', () => {
  it('/delete removes it from its project\'s folder, and a chat open elsewhere is told', async () => {
    const chat = chatOf('q', 'a');
    await chat.handleCommand(`/sync setup ${folder}`);
    await chat.save('Trip');
    await chat.runSync();
    otherSync();
    chat.confirm = async () => true;
    await chat.handleCommand('/delete');
    expect(output()).toContain("Removed it from the project's sync folder too");
    expect(otherSync().deleted.map((d) => d.name)).toEqual(['Trip']);

    const second = chatOf('x', 'y');
    await second.save('Plans');
    await second.runSync();
    otherSync();
    const project = defaultProject(loadSyncConfig());
    deleteSyncedChat({ folder, key: loadProjectKey(project.id), chatId: chatIdOf(chatFile('Plans')) });
    await second.runSync();
    expect(output()).toContain("'Plans' was deleted or moved on another device");
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
    expect(chatProjectOf(path.join(skinnyai.SESSION_DIR, copy))).toBe(defaultProject(loadSyncConfig()).id);
  });

  it('syncs quietly at startup and says what arrived', async () => {
    const chat = chatOf('q', 'a');
    await chat.handleCommand(`/sync setup ${folder}`);
    await chat.save('Trip');
    await chat.runSync();
    otherSync();
    writeChat(otherFile('Made elsewhere'), { from: 'm', system: '', parameters: {}, settings: {}, name: 'Made elsewhere', project: defaultProject(loadSyncConfig()).id, messages: [{ id: newMessageId(), role: 'user', content: 'hello' }] }, { device: otherDevice });
    otherSync();
    capture.stop();
    capture = captureOutput();
    chatOf().syncAtStartup();
    expect(output()).toContain("Synced: received 1 change; new chat: 'Made elsewhere'.");
    expect(fs.existsSync(chatFile('Made elsewhere'))).toBe(true);
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
