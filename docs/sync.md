# Syncing chats across devices

skinnyai can keep your chats in step across your devices through a folder that something else already carries around: iCloud Drive, Dropbox, Syncthing, a network share. It doesn't talk to any server of its own. Everything in the folder is encrypted before it's written, so the service that syncs the folder sees ciphertext only.

## Projects

A **project** is a group of chats that share one folder and one key, like a project in Claude. You can have several: one for personal chats, one for work, one you share with a colleague. Each chat belongs to exactly one project, and to read a project's chats a device needs that project's key.

The **default project** is where new chats go. If you set up only one project, it's the default and everything syncs through it. Chats that are in no project yet (made before you turned sync on) join the first project you set up.

## Setting it up

On the first device, inside a chat:

```
/sync setup ~/Library/Mobile Documents/com~apple~CloudDocs/skinnyai
```

(any folder your cloud drive syncs). This makes a project called Default in that folder, with a new key. skinnyai keeps the key on this device and prints it once. **Save a copy in your password manager:** it's how you add another device, and if you lose it and every device that has it, the project's chats can't be read by anyone. skinnyai stores the key in the macOS Keychain (this Mac's login keychain, which isn't guaranteed to follow you to other devices), or elsewhere in `~/.skinny/project-keys`, a file only you can read.

On each further device, install skinnyai, wait for the folder to sync, then run the same `/sync setup <folder>`. It finds the project, asks for its key, checks it against the folder, and offers the project's own suggested name (which you're free to change: names are local labels).

## Commands

**Global** (act on all your projects, not on the open chat):

| Command | What it does |
|---------|--------------|
| `/sync` | Syncs every project now, and brings the open chat up to date. |
| `/sync setup <folder>` | Turns sync on with a default project in that folder (makes it, or joins it if another device already did). |
| `/sync status` | Lists the projects, their folders, and whether this device has each key. |
| `/sync off` | Stops syncing on this device. Chats, keys, and the folders are untouched. |
| `/project` | Lists the projects. |
| `/project new <name> <folder>` | Makes another project, with a new key shown once. |
| `/project add <folder> ["name"]` | Joins a project that's already in a folder, asking for its key if needed. |
| `/project default <name>` | Makes new chats go in that project. |
| `/project key [name]` | Shows a project's key (the default project's if no name), to give to someone you're sharing with. |
| `/project rename <name> <new name>` | Changes the local label. |
| `/project forget <name>` | Stops syncing the project on this device. Its chats stay here, unsynced. |

**On the open chat:**

| Command | What it does |
|---------|--------------|
| `/project move <name>` | Moves this chat to another project. |
| `/project copy <name>` | Puts a copy in another project; this chat is unchanged. |

Syncing also happens on its own: at startup (quietly, saying only what changed) and after each autosave or `/save`. Sync follows saving, so keep autosave on (the default in a terminal) for chats you want on every device.

## Moving and copying

Chats in different projects are sealed under different keys, so moving a chat's files by hand from one project's folder to another's makes them unreadable. `/project move` and `/project copy` do it properly: they make a new chat (with a new identity) in the other project, sealed under that project's key. A move then deletes the original, leaving only a deletion marker in the old project, which says nothing about where the chat went.

## Sharing a project with other people

skinnyai doesn't manage people. To share a project, share the folder using your cloud service's own sharing, and give each person the project key by some other route than the folder (not in the same shared drive). They run `/project add <folder>` and enter it. Every member is fully trusted: anyone with the key and the folder can read, change, and delete every chat in the project, and chats don't record who wrote what beyond a device name. To remove someone, make a new project, copy the chats you want to it, and share that one instead (deleting the old project's files is up to you and your cloud service).

## When two devices change the same chat

Each device adds its changes to the chat as separate steps, so two devices can both continue a chat and nothing is lost or overwritten. If both added to the same message while apart, the chat continues on one line and the other becomes a chat of its own, named like `Trip plans (from laptop)`. Every device makes the same split, so you end up with the same two chats everywhere. `/sync` tells you when it happens, and where your own latest messages went.

## Deleting

`/delete` removes a chat from its project's folder and leaves a small encrypted marker, so your other devices delete their copies the next time they sync. `/purge` is repeated on other devices for the messages that existed when it was run. Renaming a chat is local to the device. Nothing can promise that no one kept a copy of data they already synced.

## What is protected

Chats are sealed with AES-256-GCM under keys derived from the project key and each chat's random id, so a file moved to another chat or renamed fails to open. Attachments are separate sealed files whose names don't reveal what they hold. A project's name is sealed in its folder, and the project id in `project.json` is a keyed hash that doesn't reveal the key. The folder's owner can see: how many chats there are, a random id for each, how many files each has and how big, and when files were added. Message text, titles, model names, device names, and attachments are inside the encrypted files.

Not covered yet: attributing changes to people, removing a member's access to what they already have, and Windows or Linux key storage beyond a protected file. The macOS Keychain path has only been checked in a scratch keychain.

## For the curious

A project folder holds `skinnyai-sync/project.json` (the project id, when it was made, and `sealed_name`, the project's suggested name encrypted under its key, so it looks like random text), and under `chats/<chat id>/` one `commits/<commit id>.c` per save, one `blobs/<name>.b` per attachment, and a `deleted` marker if the chat was deleted. Each file is written once, under its own name, so devices never write to the same file. Commits form a chain by the commits they follow, and a device applies a commit only after the ones before it have arrived; ones that depend on files still syncing wait for the next `/sync`.

Environment: `SKINNY_PROJECT_KEYS` supplies project keys (comma-separated, as text), for machines with no keychain; `SKINNY_KEY_STORE=file|keychain` forces where keys are kept. Which projects this device syncs, and where their folders are, is in `~/.skinny/sync.json`.
