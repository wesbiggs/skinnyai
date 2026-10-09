# Security: what is protected, and what isn't

skinnyai is a chat client. It keeps your conversations on your machine, can keep them in step across your devices through a cloud folder, and sends what you type to whichever model server you chose. Encryption covers only some of that. This page says which part, and what stays visible to whom.

The sync encryption is built from standard parts (AES-256-GCM, HKDF, and HMAC from Node's OpenSSL, with random nonces) in a design of our own. **It has not been reviewed by an independent cryptographer.**

## At a glance

| Where your chats are | Encrypted? | Who can read it |
|----------------------|------------|-----------------|
| In a synced cloud folder | Yes, end to end | People with the project key |
| On this machine, in `~/.skinny/sessions` | No (see [at rest](#on-this-machine-at-rest)) | You, and anything running as you or with access to the disk |
| In the model server you chat with | Up to that server | Its operator, whatever its privacy policy says |
| In files you export, in terminal scrollback | No | Whoever can see them |

## What sync encryption protects

Chats in a project folder are sealed before they're written: each save is an AES-256-GCM file under keys derived from the project's key and the chat's random id, and attachments are separate sealed files. The service that syncs the folder, and anyone who gets into your cloud account, see ciphertext. A file that's damaged, edited, renamed, or moved to another chat or project fails to open instead of being read wrongly.

**What the folder still shows:** how many chats a project has, a random id for each, how many files each has and how big, when they were added, and the project id (a keyed hash that doesn't reveal the key). Message text, chat names, model names, device names, and attachments are inside the encrypted files. The name of the folder itself is whatever you called it.

**What it doesn't stop:**
- **Anyone with the project key and the folder** can read, change, and delete every chat in that project. There are no per-person identities; changes are attributed only to a device name. Give the key to people by some route other than the shared folder.
- **Removing someone** doesn't take back what they already have. To cut someone off, make a new project, copy the chats you want into it, and share that.
- **Losing the key** loses the project's chats from the folder for good. Save a copy in a password manager. skinnyai keeps the key in the macOS Keychain (this Mac's login keychain), or in `~/.skinny/project-keys` readable only by you.
- **Deleting** removes a chat's files from the folder, but your cloud service may keep older versions or a trash for a while, and any device that already synced it may have kept a copy (backups included). Nothing can prove that no one kept a copy.

## On this machine (at rest)

Chats you haven't synced, and the local copy of ones you have, are ordinary files under `~/.skinny`: chats in `sessions/` (SQLite), `config.json` (which can hold API keys), `debug.log` if you turned debugging on, and the files you export or save images to. They are **not encrypted by skinnyai**. skinnyai makes its folders and chat files readable only by you (mode 700 and 600), so other accounts on the Mac can't open them, but anyone who gets at the disk can.

To protect them if the machine is lost or stolen, turn on FileVault (System Settings → Privacy & Security). To keep them encrypted even while you're logged in and the Mac is on, you can store `~/.skinny` on an encrypted disk image you mount yourself (Disk Utility → File → New Image → Blank Image, with 256-bit AES encryption and a sparse bundle format), then start skinnyai with `SKINNY_HOME` pointing into the mounted volume. Keep the image's password in your password manager.

That kind of protection is encryption at rest. While the volume is mounted, or the Mac is unlocked, anything running as you can read the files, and a copy that was made before you encrypted them (a backup, a Time Machine snapshot) is still readable.

## What no encryption here can protect

- **The model you talk to.** What you send goes to the server you chose, in the clear as far as that server is concerned. With OpenAI, Anthropic, Ollama's cloud models, or any other hosted model, that company receives your messages, attachments, and the tool results you send back, and its privacy policy decides what happens next. A server reached over plain `http://` also exposes them on the network between you and it. Only a model running on your own machine, such as local Ollama, keeps your conversation off the network. (Some hosted services run models inside hardware-protected enclaves that the operator can't read. skinnyai doesn't check for that; it treats every server the same.)
- **Titles.** When a new chat gets a title, the first exchange is sent to the same model in one more request. `--no-titles` turns it off.
- **Web search and pages.** With an Ollama API key, search queries and fetched URLs go to Ollama's hosted search. Without one, searches go to DuckDuckGo's Instant Answer API. `fetch_page` contacts whichever site the model asks for.
- **MCP servers.** Tools you connect receive the arguments the model passes them, and a remote (HTTP) server receives them over the network.
- **Someone on your unlocked Mac.** A program running as you can read your files and may be able to ask the Keychain for your keys.
- **Your screen and terminal.** Scrollback, screenshots, and recordings keep what was on screen. The macOS app and the command line behave the same.
- **Exports.** `/export` writes a readable file; `/saveimage` writes images to your Pictures folder.

## Keys, in short

| Secret | Kept in | Shown |
|--------|---------|-------|
| Project key (one per project) | macOS Keychain, or `~/.skinny/project-keys` (mode 600) | When you create the project, and by `/project key` |
| API keys | Your environment or `~/.skinny/config.json` (mode 600) | Never by skinnyai |
