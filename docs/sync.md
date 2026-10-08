# Syncing chats across devices

skinnyai can keep your chats in step across your devices through a folder that something else already carries around: iCloud Drive, Dropbox, Syncthing, a network share. It doesn't talk to any server of its own. Everything in the folder is encrypted before it's written, so the service that syncs the folder sees ciphertext only.

## Setting it up

On the first device, inside a chat:

```
/sync setup ~/Library/Mobile Documents/com~apple~CloudDocs/skinnyai
```

(any folder your cloud drive syncs). skinnyai makes a key for your chats, keeps it in the macOS Keychain (elsewhere, in `~/.skinny/vault.key`, readable only by you), and prints a **recovery key** once. Write it down somewhere safe: it is the only way to add another device, and if you lose both it and every device that has the key, the synced chats can't be read by anyone.

On each further device, install skinnyai, wait for the folder to sync, then run the same `/sync setup <folder>`. It finds the existing chats, asks for the recovery key (`/sync key` shows it on a device that has it), checks it against the folder, and stores it.

After that:

- **At startup**, skinnyai syncs quietly and says only what changed ("received 2 changes; new chat: 'Trip plans'").
- **After each autosave**, the chat's new messages are sent.
- **`/sync`** syncs everything now and brings the open chat up to date. `/sync status` shows the folder and whether this device's key fits it, `/sync key` shows the recovery key, and `/sync off` stops syncing on this device (nothing is deleted).

Sync follows autosave: a chat is sent as it's saved, so keep autosave on (the default in a terminal) for chats you want on every device.

## When two devices change the same chat

Each device adds its changes to the chat as separate steps, so two devices can both continue a chat and nothing is lost or overwritten. If both added to the same message while apart, the chat continues on one line and the other becomes a chat of its own, named like `Trip plans (from laptop)`. Every device makes the same split, so you end up with the same two chats everywhere. `/sync` tells you when it happens, and where your own latest messages went.

## Deleting

`/delete` removes a chat from the folder and leaves a small encrypted marker, so your other devices delete their copies the next time they sync. `/purge` is repeated on other devices for the messages that existed when it was run. Renaming a chat is local to the device. Nothing can promise that no one kept a copy of data they already synced.

## What is protected

Chats are sealed with AES-256-GCM under keys derived from your vault key and each chat's random id, so a file moved to another chat or renamed fails to open. Attachments are separate sealed files whose names don't reveal what they hold. The folder's owner can see: how many chats there are, a random id for each, how many files each has and how big, and when files were added. Message text, titles, model names, device names, and attachments are inside the encrypted files.

Not covered yet: sharing a chat with another person, rotating the key if a device is lost, and Windows or Linux key storage beyond a protected file. The macOS Keychain path has only been checked in a scratch keychain.

## For the curious

The folder holds `skinnyai-sync/vault.json` (a random id and a check value, not the key), and under `chats/<chat id>/` one `commits/<commit id>.c` per save and one `blobs/<name>.b` per attachment. Each file is written once, under its own name, so devices never write to the same file. Commits form a chain by the commits they follow, and a device applies a commit only after the ones before it have arrived; ones that depend on files still syncing wait for the next `/sync`.

Environment: `SKINNY_SYNC_DIR` sets the folder without `/sync setup` (overriding `~/.skinny/sync.json`); `SKINNY_VAULT_KEY` supplies the recovery key directly, for machines with no keychain; `SKINNY_VAULT_STORE=file|keychain` forces where the key is kept.
