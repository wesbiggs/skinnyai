# Encrypted chats on this Mac

Chats you save are files in `~/.skinny/sessions`. This feature keeps them on an **encrypted disk image** instead, mounted over that folder only while you're using skinnyai. With the volume locked, the chats are unreadable on disk: to malware that isn't running as you, to other accounts, to backups that capture the image, and to anyone holding the disk. It's macOS only. [Security](security.md) explains what this does and doesn't protect.

Everything else stays where it was, so you can edit `~/.skinny/config.json` as you like.

## Turning it on

**In the app:** Settings → Encrypted chats → *Encrypt Saved Chats…*. Close any open chats first. The app:

1. makes an encrypted sparse disk image (`~/.skinny/sessions.sparsebundle`, growing as needed up to 20 GB) with a random passphrase kept in your login Keychain;
2. copies your existing chats into it and checks the copy, file by file;
3. shows you the passphrase once. **Save a copy in a password manager**; without it and the Keychain item the chats can't be read;
4. offers to delete the unencrypted originals (they were moved to `~/.skinny/sessions.plain-<time>`). Deleting a file doesn't guarantee its contents are gone from the disk, backups, or snapshots; FileVault covers that.

**From a terminal:** run `scripts/sessions-volume.sh setup` (add `--delete-originals` or `--keep-originals` to skip the question, `--size 50g` for a larger image), then put `"encryptedSessions": true` in `config.json` so skinnyai refuses to save chats while the volume is locked.

## Day to day

- **The app** unlocks the volume when it starts, and ejects it when you quit. Settings has *Lock Now*, *Show Passphrase…*, and *Turn Off Encryption…*.
- **The command line** can wrap skinnyai: `scripts/sessions-volume.sh run -- skinnyai`. That unlocks, runs the command, and ejects afterwards if no other wrapped run is still going (`--keep-mounted` leaves it mounted). Or use `unlock` and `lock` yourself; `lock --if-idle` ejects only when nothing wrapped is running.
- **While it's locked,** skinnyai still starts, but says so, saves nothing, and `/save`, `/new`, `/sync`, and the other commands that use saved chats explain why they can't. Nothing is ever written in plain text beside the locked volume: the folder it mounts over is empty and read-only until the volume is mounted, and skinnyai also checks for a marker file that only exists inside the volume.
- **Debug logs** go inside the volume too, since they contain your conversations.

## Mounting it by hand

You don't need the script. The image is an ordinary encrypted sparse bundle:

```bash
# unlock (the passphrase comes from the Keychain; --stdinpass keeps macOS from opening a password dialog)
security find-generic-password -a ~/.skinny/sessions.sparsebundle -s skinnyai-sessions-volume -w \
  | tr -d '\n-' | diskutil image --stdinpass attach --nobrowse --mountPoint ~/.skinny/sessions ~/.skinny/sessions.sparsebundle

# lock
diskutil eject ~/.skinny/sessions
```

If you've copied the passphrase out of the Keychain, type it without the dashes (any case). Older versions of macOS without `diskutil image` can use `hdiutil attach -stdinpass -nobrowse -mountpoint ~/.skinny/sessions ~/.skinny/sessions.sparsebundle` and `hdiutil detach`. Disk Utility can also open the image if you give it the passphrase.

## Changing where it is

In `config.json`, `"encryptedSessions": { "mountPoint": "/path/to/chats" }` puts the mounted folder somewhere else; set `SKINNY_SESSIONS_MOUNT` and `SKINNY_SESSIONS_IMAGE` to match when you run the script (the app passes the mount point itself). Mount it somewhere inside a folder only you can open: the volume is mounted without per-user ownership, so its privacy comes from the folder around it, which is `~/.skinny` (mode 700) by default.

## Turning it off

*Turn Off Encryption…* in Settings, or `scripts/sessions-volume.sh off`, copies the chats back out to the sessions folder, unencrypted. The old image is renamed `sessions.sparsebundle.disabled`, and its passphrase stays in the Keychain under that name, for you to keep or delete (`security delete-generic-password -a <path to the .disabled image> -s skinnyai-sessions-volume`). Remove `"encryptedSessions"` from `config.json` afterwards (the app does). You can turn encryption on again later; that makes a new image and passphrase.

## What isn't inside it

Only the chats (with their attachments), old Modelfile sessions, and the debug log. `config.json` (API keys; MCP server tokens), `mcp.json`, `sync.json`, and files you export or save images to stay outside, readable only by you but not encrypted. Synced chats in a cloud folder are encrypted separately ([sync](sync.md)).

## Limits

- While the volume is mounted, anything running as you can read the chats. If the passphrase is in your Keychain, a program running as you may be able to ask for it and mount the volume too.
- A backup made while it was mounted contains the mounted chats; whether a backup tool copies the image consistently while it's mounted hasn't been checked.
- This protects the files at rest. It doesn't change what the model you chat with receives.
