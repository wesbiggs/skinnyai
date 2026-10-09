import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chatIdOf, chatProjectOf } from './chatdb.js';
import { decodeProjectKey, encodeProjectKey, generateProjectKey, loadProjectKey, projectId, saveProjectKey } from './keys.js';
import { SESSION_DIR, autosaveName, readLocalSession, sessionPath, sessionStamp } from './sessions.js';
import { adoptUnassigned, copyChat, deleteSyncedChat, describeSync, initProject, keyOpensProject, pushChat, readProject, resealChat, suggestedName, syncProjects } from './sync.js';
import { addProject, defaultProject, findProject, loadSyncConfig, removeProject, renameProject, saveSyncConfig, setDefaultProject } from './syncconfig.js';
import { ANSI, CHROME_COLOR } from './style.js';

// The /sync and /project commands and the sync that follows each save: methods
// of OllamaChat (chat.js adds them to its prototype), on top of sync.js.

// A folder argument as an absolute path (quotes and ~ handled).
const resolveFolder = (text) => path.resolve(text.replace(/^~(?=\/|$)/, os.homedir()));
const unquote = (text) => text.trim().replace(/^(['"])(.*)\1$/, '$2');

export const syncCommands = {
  // A project from the sync config with its key, or null (no such project
  // here, or no key for it on this device).
  projectFor(id) {
    const project = loadSyncConfig().projects.find((p) => p.id === id);
    const key = project ? loadProjectKey(id) : null;
    return project && key ? { project, key } : null;
  },

  // The project the open chat is in, as { project, key }, or null.
  currentProject() {
    if (!this.sessionName || !existsSync(sessionPath(this.sessionName))) return null;
    const id = chatProjectOf(sessionPath(this.sessionName));
    return id ? this.projectFor(id) : null;
  },

  printSyncResult(report, { quiet = false } = {}) {
    const line = describeSync(report);
    const dim = (text) => (quiet ? `${CHROME_COLOR}${text}${ANSI.reset}` : text);
    if (line) console.log(dim(`🔄 ${line}`));
    else if (!quiet) console.log('🔄 Already in sync.');
    for (const split of report.splits) console.log(dim(`   '${split.chat}' continued on two devices; the other line is now '${split.copy}'.`));
    for (const error of report.errors) console.log(dim(`⚠️  Sync: ${error}`));
  },

  // At startup, before any chat is resumed: a quiet sync that says only what changed.
  syncAtStartup() {
    const config = loadSyncConfig();
    if (!config.projects.length) return;
    try {
      this.printSyncResult(syncProjects({ config, sessionsDir: SESSION_DIR, keyFor: loadProjectKey }), { quiet: true });
    } catch (error) {
      console.log(`${CHROME_COLOR}⚠️  Sync failed: ${error.message}${ANSI.reset}`);
    }
  },

  // After a save: send the chat's new commits to its project, quietly.
  pushToSync() {
    const home = this.currentProject();
    if (!home) return;
    try {
      pushChat({ folder: home.project.folder, key: home.key, file: sessionPath(this.sessionName) });
    } catch (error) {
      console.log(`${CHROME_COLOR}⚠️  Sync failed: ${error.message}${ANSI.reset}`);
    }
  },

  // /sync: syncs every project. (Global.)
  async sync(arg) {
    const [sub] = arg.split(/\s+/).filter(Boolean);
    switch ((sub ?? '').toLowerCase()) {
      case '':
        return this.runSync();
      case 'setup':
        return this.syncSetup(unquote(arg.replace(/^\S+\s*/, '')));
      case 'status':
        return this.printProjects();
      case 'off':
        saveSyncConfig({ default: null, projects: [] });
        console.log("\nSync is off on this device. Chats and keys are untouched, and the folders keep what was synced. /sync setup or /project add turns it back on.\n");
        return undefined;
      default:
        console.log(`\nUnknown /sync option '${sub}'. Use /sync, /sync setup <folder>, /sync status, or /sync off.\n`);
        return undefined;
    }
  },

  // Saves the open chat, syncs every project, and brings the open chat up
  // to date with what arrived.
  async runSync() {
    const config = loadSyncConfig();
    if (!config.projects.length) {
      console.log('\nSync is off. /sync setup <folder> turns it on: a folder your cloud drive (iCloud Drive, Dropbox, ...) already syncs.\n');
      return;
    }
    try {
      if (this.autosave && this.sessionName) await this.autosaveSession({ push: false });
      const before = this.sessionName && existsSync(sessionPath(this.sessionName)) ? await sessionStamp(this.sessionName) : null;
      console.log('');
      const report = syncProjects({ config, sessionsDir: SESSION_DIR, keyFor: loadProjectKey });
      this.printSyncResult(report);
      const after = this.sessionName && existsSync(sessionPath(this.sessionName)) ? await sessionStamp(this.sessionName) : null;
      if (before && !after) {
        console.log(`   '${this.sessionName}' was deleted or moved on another device. This conversation is kept here, unsaved.`);
        this.sessionName = null;
      } else if (before && after && before !== after) await this.refreshFromSync(report);
      console.log('');
    } catch (error) {
      console.log(`\n❌ Sync failed: ${error.message}\n`);
    }
  },

  // The open chat changed in the folder: show the new state of it, and say
  // where our own last messages went if the chat split.
  async refreshFromSync(report) {
    const name = this.sessionName;
    const ours = this.conversation().at(-1)?.id ?? null;
    const session = await readLocalSession(name);
    if (!session) return;
    this.applySessionState(name, session);
    await this.confirmSessionTarget();
    const split = report.splits.find((s) => s.chat === name);
    if (split && ours && !session.messages.some((m) => m.id === ours)) {
      console.log(`   Your latest messages are in '${split.copy}'; '${name}' now shows the other device's.`);
    } else {
      console.log(`   '${name}' now has the changes from your other device (${session.messages.length} messages).`);
    }
  },

  // /sync setup <folder>: turns sync on with a default project in that folder.
  async syncSetup(arg) {
    if (!arg) {
      console.log('\nUsage: /sync setup <folder>   (a folder inside iCloud Drive, Dropbox, or similar, on every device)\n');
      return;
    }
    const config = loadSyncConfig();
    if (config.default) {
      console.log(`\nSync is already set up: the default project is '${defaultProject(config).name}'. /project add <folder> or /project new <name> <folder> adds more.\n`);
      return;
    }
    const folder = resolveFolder(arg);
    if (readProject(folder)) await this.joinProject(folder);
    else await this.createProject('Default', folder);
  },

  // Makes a project: a folder, and a new key that is kept here and shown once.
  async createProject(name, folder) {
    const config = loadSyncConfig();
    if (findProject(config, name)) {
      console.log(`\nYou already have a project called '${name}'.\n`);
      return;
    }
    if (readProject(folder)) {
      console.log(`\n${folder} is already a project. /project add ${folder} joins it.\n`);
      return;
    }
    try {
      await fs.mkdir(folder, { recursive: true });
      const key = generateProjectKey();
      const where = saveProjectKey(key);
      initProject(folder, key, name);
      const first = !config.default;
      addProject({ id: projectId(key), folder, name });
      console.log(`\n✅ Project '${name}' syncs through ${folder}. Its key is kept in ${where}.`);
      if (first) {
        const adopted = adoptUnassigned(SESSION_DIR, projectId(key));
        console.log(`   It's the default project: new chats go in it${adopted ? `, and so did your ${adopted} existing chat${adopted === 1 ? '' : 's'}` : ''}.`);
      }
      console.log(`\nKeep a copy of this project key somewhere safe, such as your password manager. You need it to add another device, and without it (or a device that has it) the project's chats can't be read:\n\n  ${encodeProjectKey(key)}\n`);
      await this.runSync();
    } catch (error) {
      console.log(`\n❌ Couldn't make the project: ${error.message}\n`);
    }
  },

  // Joins the project in a folder, asking for its key if this device doesn't have it.
  async joinProject(folder, alias) {
    const info = readProject(folder);
    if (!info) {
      console.log(`\n${folder} isn't a project folder (no ${path.join('skinnyai-sync', 'project.json')}). If another device just set it up, wait for the folder to finish syncing.\n`);
      return;
    }
    const config = loadSyncConfig();
    const existing = config.projects.find((p) => p.id === info.project);
    if (existing) {
      console.log(`\nThat folder is already your project '${existing.name}'.\n`);
      return;
    }
    try {
      let key = loadProjectKey(info.project);
      if (!key) {
        console.log(`\nThis project's key isn't on this device. Enter the project key (/project key on a device that has it shows it):`);
        try {
          key = decodeProjectKey((await this.readTurnInput()) || '');
        } catch (error) {
          console.log(`\n❌ ${error.message}\n`);
          return;
        }
        if (!keyOpensProject(folder, key)) {
          console.log("\n❌ That key doesn't open the project in that folder.\n");
          return;
        }
        console.log(`\nKey kept in ${saveProjectKey(key)}.`);
      }
      const suggested = suggestedName(folder, key);
      let name = alias || suggested || path.basename(folder);
      for (let n = 2; findProject(config, name); n++) name = `${alias || suggested || path.basename(folder)} (${n})`;
      addProject({ id: info.project, folder, name });
      console.log(`✅ Joined project '${name}'${suggested && suggested !== name ? ` (its creator calls it '${suggested}')` : ''}.`);
      if (!config.default) {
        const adopted = adoptUnassigned(SESSION_DIR, info.project);
        console.log(`   It's the default project: new chats go in it${adopted ? `, and so did your ${adopted} existing chat${adopted === 1 ? '' : 's'}` : ''}.`);
      }
      await this.runSync();
    } catch (error) {
      console.log(`\n❌ Couldn't join the project: ${error.message}\n`);
    }
  },

  printProjects() {
    const config = loadSyncConfig();
    if (!config.projects.length) {
      console.log('\nNo projects yet. /sync setup <folder> makes the default one; /project new <name> <folder> makes another.\n');
      return;
    }
    const current = this.sessionName && existsSync(sessionPath(this.sessionName)) ? chatProjectOf(sessionPath(this.sessionName)) : null;
    console.log('\nProjects:');
    for (const project of config.projects) {
      const marks = [project.id === config.default ? 'default' : '', project.id === current ? 'this chat' : '', loadProjectKey(project.id) ? '' : 'no key on this device', existsSync(project.folder) ? '' : 'folder not found'].filter(Boolean);
      console.log(`  ${project.name}${marks.length ? ` (${marks.join(', ')})` : ''}\n    ${project.folder}`);
    }
    console.log('');
  },

  // /project: global operations (list, new, add, default, key, rename,
  // forget) and operations on the open chat (move, copy).
  async project(arg) {
    const [sub, ...rest] = arg.split(/\s+/).filter(Boolean);
    const config = loadSyncConfig();
    const named = (text) => {
      const found = findProject(config, text);
      if (!found) console.log(`\nNo project called '${text}'. /project lists them.\n`);
      return found;
    };
    switch ((sub ?? '').toLowerCase()) {
      case '':
        return this.printProjects();
      case 'new': {
        const match = /^new\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(.+)$/.exec(arg);
        if (!match) {
          console.log('\nUsage: /project new <name> <folder>\n');
          return undefined;
        }
        return this.createProject(match[1] ?? match[2] ?? match[3], resolveFolder(unquote(match[4])));
      }
      case 'add':
        if (!rest.length) {
          console.log('\nUsage: /project add <folder> [name]   (name: what you want to call it here)\n');
          return undefined;
        }
        return this.joinFolderArg(arg.replace(/^\S+\s*/, ''));
      case 'default': {
        const found = named(rest.join(' '));
        if (found) {
          setDefaultProject(found.id);
          console.log(`\n'${found.name}' is now the default project: new chats go in it.\n`);
        }
        return undefined;
      }
      case 'key': {
        const found = rest.length ? named(rest.join(' ')) : defaultProject(config);
        if (!found) {
          if (!rest.length) console.log('\nNo default project yet. /sync setup <folder> makes one.\n');
          return undefined;
        }
        const key = loadProjectKey(found.id);
        console.log(key
          ? `\nProject key for '${found.name}'. Anyone who has this and can open the folder can read and change every chat in the project; give it to people only by some route other than the folder:\n\n  ${encodeProjectKey(key)}\n`
          : `\nThis device has no key for '${found.name}'.\n`);
        return undefined;
      }
      case 'rename': {
        const match = /^rename\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(.+)$/.exec(arg);
        const found = match && findProject(config, match[1] ?? match[2] ?? match[3]);
        if (!found) {
          console.log('\nUsage: /project rename <project> <new name>   (a local label; the folder keeps its own suggestion)\n');
          return undefined;
        }
        if (findProject(config, unquote(match[4]))) {
          console.log(`\nYou already have a project called '${unquote(match[4])}'.\n`);
          return undefined;
        }
        renameProject(found.id, unquote(match[4]));
        console.log(`\nRenamed '${found.name}' to '${unquote(match[4])}'.\n`);
        return undefined;
      }
      case 'forget': {
        const found = named(rest.join(' '));
        if (found) {
          removeProject(found.id);
          console.log(`\nStopped syncing '${found.name}' on this device. Its chats stay here, unsynced, and the folder and key are untouched.\n`);
        }
        return undefined;
      }
      case 'move':
      case 'copy': {
        const found = named(rest.join(' '));
        return found ? this.moveOrCopyChat(found, sub.toLowerCase() === 'move') : undefined;
      }
      default:
        console.log(`\nUnknown /project option '${sub}'. Global: /project, new, add, default, key, rename, forget. This chat: move, copy.\n`);
        return undefined;
    }
  },

  // "/project add <folder> [name]": the folder may contain spaces, so a
  // trailing quoted name is the only way to give one.
  async joinFolderArg(text) {
    const quoted = /^(.*\S)\s+(?:"([^"]+)"|'([^']+)')$/.exec(text);
    const folder = resolveFolder(unquote(quoted ? quoted[1] : text));
    return this.joinProject(folder, quoted ? (quoted[2] ?? quoted[3]) : undefined);
  },

  // /project move|copy <project>: puts this chat in another project as a
  // chat of its own (new id, sealed under that project's key). A move
  // removes it from the old project, leaving only a deletion marker there.
  async moveOrCopyChat(target, move) {
    const targetKey = loadProjectKey(target.id);
    if (!targetKey) {
      console.log(`\nThis device has no key for '${target.name}'.\n`);
      return;
    }
    try {
      if (this.conversation().length === 0) {
        console.log('\nThis chat has no messages yet.\n');
        return;
      }
      const name = this.sessionName ?? await autosaveName();
      if (!await this.writeSession(name)) return; // a conflict was skipped
      const file = sessionPath(name);
      const fromId = chatProjectOf(file);
      if (fromId === target.id) {
        console.log(`\nThis chat is already in '${target.name}'.\n`);
        return;
      }
      const previous = fromId ? this.projectFor(fromId) : null;
      const oldChatId = chatIdOf(file);
      if (!move) {
        const copy = copyChat({ file, sessionsDir: SESSION_DIR, project: target.id });
        pushChat({ folder: target.folder, key: targetKey, file: copy.file });
        console.log(`\n✅ Copied to '${target.name}' as '${copy.name}'. This chat is unchanged.\n`);
        return;
      }
      // Build the copy beside the original, then swap, so nothing is lost if this stops half way.
      const copy = copyChat({ file, sessionsDir: SESSION_DIR, project: target.id, name, to: path.join(SESSION_DIR, `${randomUUID()}.incoming`) });
      pushChat({ folder: target.folder, key: targetKey, file: copy.file });
      await fs.rename(copy.file, file); // replaces the original in one step
      if (previous) deleteSyncedChat({ folder: previous.project.folder, key: previous.key, chatId: oldChatId });
      this.sessionName = name;
      this.sessionStamp = await sessionStamp(name);
      this.savedHead = this.conversation().at(-1)?.id ?? null;
      console.log(`\n✅ Moved to '${target.name}'.${previous ? ` Other devices in '${previous.project.name}' remove it at their next sync.` : ''}\n`);
    } catch (error) {
      console.log(`\n❌ Couldn't ${move ? 'move' : 'copy'} the chat: ${error.message}\n`);
    }
  },

  // A purge in a synced chat also has to reach the folder, which still holds
  // the commits (and attachments) from before it.
  purgeSyncFolder(name) {
    const home = this.currentProject();
    if (!home) return;
    try {
      resealChat({ folder: home.project.folder, key: home.key, file: sessionPath(name) });
      this.pushToSync();
    } catch (error) {
      console.log(`⚠️  Purged here, but couldn't update the sync folder: ${error.message}`);
    }
  }
};
