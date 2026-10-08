import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatIdOf, chatProjectOf, commitIds, messageCount, newMessageId, readChat, redactChat, setChatProject as setProject, verifyChat, writeChat } from '../src/chatdb.js';
import { chatKeys, openCommit, sealCommit } from '../src/seal.js';
import { adoptUnassigned, copyChat, deleteSyncedChat, describeSync, initProject, keyOpensProject, nameFromFile, pushChat, readProject, sessionFileName, suggestedName, syncProject, syncProjects } from '../src/sync.js';
import { decodeProjectKey, encodeProjectKey, generateProjectKey, projectId } from '../src/keys.js';
import { purgeHistory } from '../src/history.js';

// Two devices are two sessions directories and two device identities,
// syncing through one shared folder.
let tmp;
let folder;
let key;
let project;
const laptop = { id: 'laptop-id', name: 'laptop' };
const phone = { id: 'phone-id', name: 'phone' };
const dev = (name, device) => ({ name, device, dir: path.join(tmp, name) });
let a;
let b;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyai-sync-'));
  folder = path.join(tmp, 'cloud');
  key = generateProjectKey();
  initProject(folder, key, 'Shared stuff');
  project = { id: projectId(key), folder, name: 'Shared stuff' };
  a = dev('a', laptop);
  b = dev('b', phone);
  fs.mkdirSync(a.dir);
  fs.mkdirSync(b.dir);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const m = (role, content, extra = {}) => ({ id: newMessageId(), role, content, ...extra });
const png = { mime: 'image/png', data: Buffer.from('secret pixels').toString('base64') };
const fileOf = (d, name) => path.join(d.dir, sessionFileName(name));
const save = (d, name, messages, after = null) => writeChat(fileOf(d, name), { from: 'm', system: 'be brief', parameters: {}, settings: {}, messages, name, project: project.id }, { after, device: d.device });
const sync = (d) => syncProject({ project, key, sessionsDir: d.dir });
const contents = (file) => readChat(file).messages.map((x) => x.content);
const listChats = (d) => fs.readdirSync(d.dir).filter((f) => f.endsWith('.skinny')).sort();
const allFiles = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));

describe('syncing two devices', () => {
  it('carries a chat, with its name and settings, to the other device', () => {
    const msgs = [m('user', 'hello there'), m('assistant', 'general kenobi')];
    save(a, 'Trip plans', msgs);
    const first = sync(a);
    expect(first.pushed).toBe(1);
    const second = sync(b);
    expect(second.newChats).toEqual(['Trip plans']);
    expect(listChats(b)).toEqual(['Trip plans.skinny']);
    const copy = readChat(fileOf(b, 'Trip plans'));
    expect(copy.messages.map((x) => x.id)).toEqual(msgs.map((x) => x.id));
    expect(copy).toMatchObject({ system: 'be brief', from: 'm', chatId: chatIdOf(fileOf(a, 'Trip plans')) });
    expect(verifyChat(fileOf(b, 'Trip plans'))).toEqual([]);
    expect(describeSync(second)).toBe("Synced: received 1 change; new chat: 'Trip plans'.");
  });

  it('keeps nothing readable in the folder', () => {
    save(a, 'Secret', [m('user', 'the launch codes are 0000', { images: [png] })]);
    sync(a);
    for (const file of allFiles(folder)) {
      const bytes = fs.readFileSync(file);
      expect(bytes.includes('launch codes')).toBe(false);
      expect(bytes.includes('secret pixels')).toBe(false);
      expect(bytes.includes('Secret')).toBe(false);
    }
    const names = allFiles(path.join(folder, 'skinnyai-sync', 'chats')).map((f) => path.basename(f));
    expect(names.some((n) => n.endsWith('.b'))).toBe(true);
    // a blob's file name is not the SHA-256 of its bytes
    const sha = createHash('sha256').update(Buffer.from(png.data, 'base64')).digest('hex');
    expect(names.some((n) => n.startsWith(sha))).toBe(false);
  });

  it('brings attachments across', () => {
    save(a, 'Pics', [m('user', 'look', { images: [png] })]);
    sync(a);
    sync(b);
    expect(readChat(fileOf(b, 'Pics')).messages[0].images).toEqual([png]);
  });

  it('passes later messages both ways and then has nothing left to do', () => {
    const first = [m('user', 'one'), m('assistant', 'two')];
    save(a, 'Chat', first);
    sync(a);
    sync(b);
    save(b, 'Chat', [...first, m('user', 'three')], first[1].id);
    expect(sync(b).pushed).toBe(1);
    const back = sync(a);
    expect(back.pulled).toBe(1);
    expect(back.updated).toEqual([fileOf(a, 'Chat')]);
    expect(contents(fileOf(a, 'Chat'))).toEqual(['one', 'two', 'three']);
    expect(sync(a)).toMatchObject({ pushed: 0, pulled: 0 });
    expect(sync(b)).toMatchObject({ pushed: 0, pulled: 0 });
  });

  it('splits a conversation continued on both devices into two chats, the same on each', () => {
    const base = [m('user', 'start'), m('assistant', 'ok')];
    save(a, 'Plans', base);
    sync(a);
    sync(b);
    save(a, 'Plans', [...base, m('user', 'from the laptop')], base[1].id);
    save(b, 'Plans', [...base, m('user', 'from the phone')], base[1].id);
    for (const d of [a, b, a, b]) sync(d);
    // each device ends with the same two chats; the later writer's line is the one shown
    // (equal counters: the larger device id), the other becomes "(from <device>)"
    for (const d of [a, b]) expect(listChats(d)).toEqual(['Plans (from laptop).skinny', 'Plans.skinny']);
    expect(contents(fileOf(a, 'Plans'))).toEqual(['start', 'ok', 'from the phone']);
    expect(contents(fileOf(b, 'Plans'))).toEqual(['start', 'ok', 'from the phone']);
    const copyA = fileOf(a, 'Plans (from laptop)');
    const copyB = fileOf(b, 'Plans (from laptop)');
    expect(contents(copyA)).toEqual(['start', 'ok', 'from the laptop']);
    expect(contents(copyB)).toEqual(contents(copyA));
    expect(chatIdOf(copyA)).toBe(chatIdOf(copyB));
    // and syncing again changes nothing
    expect(sync(a)).toMatchObject({ pushed: 0, pulled: 0, splits: [] });
    expect(sync(b)).toMatchObject({ pushed: 0, pulled: 0, splits: [] });
    expect(listChats(a)).toHaveLength(2);
  });

  it('repeats a purge on the messages that existed when it was made, not on later ones', () => {
    const first = [m('user', 'see', { images: [png] }), m('assistant', 'ok')];
    save(a, 'Purged', first);
    sync(a);
    sync(b);
    // the phone adds a message with a picture while the laptop purges pictures
    const later = m('user', 'another', { images: [png] });
    save(b, 'Purged', [...first, later], first[1].id);
    redactChat(fileOf(a, 'Purged'), 'blobs', purgeHistory(first, 'blobs').history, { device: laptop });
    for (const d of [a, b, a, b]) sync(d);
    for (const d of [a, b]) {
      const line = readChat(fileOf(d, 'Purged')).messages;
      expect(line.map((x) => x.content)).toEqual(['see\n\n[1 attached image removed]', 'ok', 'another']);
      expect(line[0].images).toBeUndefined();
      expect(line[2].images).toEqual([png]);
    }
  });

  it('applies a commit only once the one it follows has arrived', () => {
    const first = [m('user', 'one'), m('assistant', 'two')];
    save(a, 'Order', first);
    save(a, 'Order', [...first, m('user', 'three')], first[1].id);
    sync(a);
    const commits = path.join(folder, 'skinnyai-sync', 'chats', chatIdOf(fileOf(a, 'Order')), 'commits');
    const [genesis] = commitIds(fileOf(a, 'Order'));
    const oldest = [`${genesis}.c`];
    const held = fs.readFileSync(path.join(commits, oldest[0]));
    fs.rmSync(path.join(commits, oldest[0]));
    const early = sync(b);
    expect(early.pulled).toBe(0);
    expect(early.waiting).toBe(1);
    fs.writeFileSync(path.join(commits, oldest[0]), held);
    expect(sync(b).pulled).toBe(2);
    expect(contents(fileOf(b, 'Order'))).toEqual(['one', 'two', 'three']);
  });

  it('waits for an attachment that has not arrived, and applies the commit when it does', () => {
    save(a, 'Late', [m('user', 'pic', { images: [png] })]);
    sync(a);
    const blobs = allFiles(folder).filter((f) => f.endsWith('.b'));
    const held = fs.readFileSync(blobs[0]);
    fs.rmSync(blobs[0]);
    expect(sync(b)).toMatchObject({ pulled: 0, waiting: 1 });
    expect(listChats(b)).toEqual([]);
    fs.writeFileSync(blobs[0], held);
    expect(sync(b).newChats).toEqual(['Late']);
  });
});

describe('deleting', () => {
  it('removes a chat from the folder and from other devices, and keeps it from coming back', () => {
    save(a, 'Gone', [m('user', 'bye', { images: [png] })]);
    save(a, 'Kept', [m('user', 'stay')]);
    sync(a);
    sync(b);
    expect(listChats(b)).toEqual(['Gone.skinny', 'Kept.skinny']);

    const chatId = chatIdOf(fileOf(a, 'Gone'));
    fs.rmSync(fileOf(a, 'Gone'));
    expect(deleteSyncedChat({ folder, key, chatId })).toBe(true);
    const left = allFiles(path.join(folder, 'skinnyai-sync', 'chats', chatId)).map((f) => path.basename(f));
    expect(left).toEqual(['deleted']);
    expect(fs.readFileSync(path.join(folder, 'skinnyai-sync', 'chats', chatId, 'deleted')).includes('Gone')).toBe(false);

    expect(sync(a)).toMatchObject({ pulled: 0, pushed: 0, newChats: [], deleted: [] });
    const report = sync(b);
    expect(report.deleted.map((d) => d.name)).toEqual(['Gone']);
    expect(describeSync(report)).toBe("Synced: deleted on another device: 'Gone'.");
    expect(listChats(b)).toEqual(['Kept.skinny']);
    expect(sync(b).deleted).toEqual([]);
    expect(listChats(a)).toEqual(['Kept.skinny']);
  });

  it('ignores a marker that is not sealed under the chat\'s key', () => {
    save(a, 'Safe', [m('user', 'here')]);
    sync(a);
    const chatId = chatIdOf(fileOf(a, 'Safe'));
    fs.writeFileSync(path.join(folder, 'skinnyai-sync', 'chats', chatId, 'deleted'), 'forged');
    const report = sync(a);
    expect(report.deleted).toEqual([]);
    expect(report.errors.join('\n')).toMatch(/not a skinnyai sync file/);
    expect(listChats(a)).toEqual(['Safe.skinny']);
  });
});

describe('what it refuses', () => {
  it('will not sync with a different key', () => {
    save(a, 'Mine', [m('user', 'hi')]);
    expect(() => syncProject({ project, key: generateProjectKey(), sessionsDir: a.dir })).toThrow(/doesn't open/);
    expect(keyOpensProject(folder, key)).toBe(true);
    expect(keyOpensProject(folder, generateProjectKey())).toBe(false);
    expect(() => initProject(folder, generateProjectKey(), 'Other')).toThrow(/different project/);
    expect(() => syncProject({ project: { ...project, folder: path.join(tmp, 'empty') }, key, sessionsDir: a.dir })).toThrow(/isn't a project folder/);
  });

  it('skips a damaged file, says so, and carries on with the rest', () => {
    save(a, 'Good', [m('user', 'fine')]);
    save(a, 'Bad', [m('user', 'broken')]);
    sync(a);
    const badId = chatIdOf(fileOf(a, 'Bad'));
    const dir = path.join(folder, 'skinnyai-sync', 'chats', badId, 'commits');
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    const bytes = fs.readFileSync(file);
    bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(file, bytes);
    const report = sync(b);
    expect(report.newChats).toEqual(['Good']);
    expect(report.errors.join('\n')).toMatch(/couldn't decrypt/);
  });

  it('does not accept a commit moved to another chat or another name', () => {
    save(a, 'One', [m('user', 'first')]);
    sync(a);
    const id = chatIdOf(fileOf(a, 'One'));
    const keys = chatKeys(key, id);
    const dir = path.join(folder, 'skinnyai-sync', 'chats', id, 'commits');
    const [name] = fs.readdirSync(dir);
    const sealed = fs.readFileSync(path.join(dir, name));
    expect(() => openCommit(keys, id, name.slice(0, -2), sealed)).not.toThrow();
    expect(() => openCommit(keys, id, 'another-name', sealed)).toThrow(/couldn't decrypt/);
    expect(() => openCommit(chatKeys(key, 'other-chat'), 'other-chat', name.slice(0, -2), sealed)).toThrow(/couldn't decrypt/);
    expect(sealCommit(keys, id, 'x', { a: 1 }).equals(sealCommit(keys, id, 'x', { a: 1 }))).toBe(false); // fresh nonce each time
  });

  it('names a chat that already exists here, without overwriting it', () => {
    save(b, 'Same name', [m('user', 'local only')]);
    save(a, 'Same name', [m('user', 'from elsewhere')]);
    sync(a);
    sync(b);
    expect(listChats(b)).toEqual(['Same name (2).skinny', 'Same name.skinny']);
    expect(contents(fileOf(b, 'Same name'))).toEqual(['local only']);
    expect(contents(fileOf(b, 'Same name (2)'))).toEqual(['from elsewhere']);
    expect(messageCount(fileOf(b, 'Same name'))).toBe(1);
  });
});

describe('project keys and files', () => {
  it('writes a project key as text that comes back as the same key, despite case and spacing', () => {
    const text = encodeProjectKey(key);
    expect(text).toMatch(/^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
    expect(decodeProjectKey(text.toLowerCase().replaceAll('-', ' ')).equals(key)).toBe(true);
    expect(() => decodeProjectKey(text.replace(/.$/, text.endsWith('0') ? '1' : '0'))).toThrow(/typo/);
    expect(() => decodeProjectKey('abc')).toThrow(/project key/);
  });

  it('names the project by a hash of its key and seals the suggested name', () => {
    const info = readProject(folder);
    expect(info.project).toBe(projectId(key));
    expect(info.project).toMatch(/^[0-9a-f]{32}$/);
    const raw = fs.readFileSync(path.join(folder, 'skinnyai-sync', 'project.json'), 'utf8');
    expect(raw).not.toContain(key.toString('hex'));
    expect(raw).not.toContain('Shared stuff');
    expect(suggestedName(folder, key)).toBe('Shared stuff');
    expect(suggestedName(folder, generateProjectKey())).toBeNull();
    expect(nameFromFile('/x/Trip%2F1.skinny')).toBe('Trip/1');
  });
});

describe('projects', () => {
  const other = () => {
    const otherKey = generateProjectKey();
    const otherFolder = path.join(tmp, 'cloud2');
    initProject(otherFolder, otherKey, 'Work');
    return { key: otherKey, project: { id: projectId(otherKey), folder: otherFolder, name: 'Work' } };
  };

  it('keeps each project\'s chats in its own folder, under its own key', () => {
    const work = other();
    save(a, 'Home chat', [m('user', 'at home')]);
    const workFile = fileOf(a, 'Work chat');
    writeChat(workFile, { from: 'm', system: '', parameters: {}, settings: {}, name: 'Work chat', project: work.project.id, messages: [m('user', 'at work')] }, { device: laptop });
    const report = syncProjects({ config: { default: project.id, projects: [project, work.project] }, sessionsDir: a.dir, keyFor: (id) => (id === project.id ? key : work.key) });
    expect(report.pushed).toBe(2);
    const inHome = fs.readdirSync(path.join(folder, 'skinnyai-sync', 'chats'));
    const inWork = fs.readdirSync(path.join(work.project.folder, 'skinnyai-sync', 'chats'));
    expect(inHome).toEqual([chatIdOf(fileOf(a, 'Home chat'))]);
    expect(inWork).toEqual([chatIdOf(workFile)]);
    // a device with only the home key gets only the home chat, and says why
    const partial = syncProjects({ config: { default: project.id, projects: [project, work.project] }, sessionsDir: b.dir, keyFor: (id) => (id === project.id ? key : null) });
    expect(listChats(b)).toEqual(['Home chat.skinny']);
    expect(partial.errors.join('\n')).toMatch(/no key for it/);
  });

  it('refuses a chat that was moved by hand into a project with another key', () => {
    const work = other();
    save(a, 'Wandered', [m('user', 'oops')]);
    sync(a);
    const id = chatIdOf(fileOf(a, 'Wandered'));
    fs.cpSync(path.join(folder, 'skinnyai-sync', 'chats', id), path.join(work.project.folder, 'skinnyai-sync', 'chats', id), { recursive: true });
    const report = syncProject({ project: work.project, key: work.key, sessionsDir: b.dir });
    expect(report.errors.join('\n')).toMatch(/couldn't decrypt/);
    expect(listChats(b)).toEqual([]);
  });

  it('skips a remote chat whose id is already in another project on this device', () => {
    const work = other();
    save(a, 'Same id', [m('user', 'here')]);
    sync(a);
    const id = chatIdOf(fileOf(a, 'Same id'));
    setProject(fileOf(a, 'Same id'), work.project.id);
    const report = sync(a);
    expect(report.errors.join('\n')).toMatch(/in another project on this device/);
    expect(chatProjectOf(fileOf(a, 'Same id'))).toBe(work.project.id);
    expect(id).toBeTruthy();
  });

  it('puts chats that have no project into one when asked', () => {
    writeChat(fileOf(a, 'Loose'), { from: 'm', system: '', parameters: {}, settings: {}, name: 'Loose', messages: [m('user', 'x')] }, { device: laptop });
    expect(chatProjectOf(fileOf(a, 'Loose'))).toBeNull();
    expect(adoptUnassigned(a.dir, project.id)).toBe(1);
    expect(chatProjectOf(fileOf(a, 'Loose'))).toBe(project.id);
    expect(adoptUnassigned(a.dir, 'someone-else')).toBe(0);
  });

  it('copies a chat into another project as a new chat, and a move leaves only a deletion marker', () => {
    const work = other();
    const msgs = [m('user', 'q', { images: [png] }), m('assistant', 'a')];
    save(a, 'Travelling', msgs);
    sync(a);
    const oldId = chatIdOf(fileOf(a, 'Travelling'));

    const copy = copyChat({ file: fileOf(a, 'Travelling'), sessionsDir: a.dir, project: work.project.id });
    expect(copy.name).toBe('Travelling (2)');
    expect(chatIdOf(copy.file)).not.toBe(oldId);
    expect(chatProjectOf(copy.file)).toBe(work.project.id);
    expect(readChat(copy.file).messages.map((x) => x.content)).toEqual(['q', 'a']);
    expect(readChat(copy.file).messages[0].images).toEqual([png]);
    expect(pushChat({ folder: work.project.folder, key: work.key, file: copy.file })).toBe(1);
    expect(syncProject({ project: work.project, key: work.key, sessionsDir: b.dir }).newChats).toEqual(['Travelling (2)']);

    // a move: the original goes, with a marker that says nothing about where
    deleteSyncedChat({ folder, key, chatId: oldId });
    const marker = path.join(folder, 'skinnyai-sync', 'chats', oldId);
    expect(fs.readdirSync(marker)).toEqual(['deleted']);
    expect(fs.readFileSync(path.join(marker, 'deleted')).includes('Work')).toBe(false);
    const gone = sync(b);
    expect(gone.deleted).toEqual([]); // b never had the home chat: nothing to delete there
  });
});
