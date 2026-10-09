# Changelog

## Unreleased

### Added
- Encrypted chats on macOS: `scripts/sessions-volume.sh` (set up, unlock, lock, run, off) keeps saved chats on an encrypted sparse disk image mounted over `~/.skinny/sessions`, with a random passphrase in the Keychain. The app unlocks it at launch, ejects it on quit, and has a Settings section to turn it on and off. With `"encryptedSessions": true` in `config.json`, skinnyai refuses to read or write sessions (and the debug log goes inside the volume) while it is locked, so nothing is saved in plain text beside it. See `docs/encrypted-sessions.md`.
- `docs/security.md`: what the encryption protects and what it doesn't, including what model providers, search, and MCP servers can see.
- New chats are named from a short title the model suggests after the first reply (one small extra request; `--no-titles` or `SKINNY_TITLES=false` turns it off, and the date-and-time name is the fallback). A later `/save <name>` renames the file.
- The welcome box says whether sync is on and which project the chat is in.
- Sync chats across devices through folders your cloud drive carries, in projects: a project is a folder plus its own key, and each chat is in one. `/sync setup <folder>` makes the default project (or joins it on another device); `/project new|add|default|key|rename|forget` manage others; `/project move|copy <name>` put the open chat in another project as a new chat sealed under that project's key (a move leaves only a deletion marker behind). Each save becomes an encrypted commit file (AES-256-GCM under keys derived from the project key, which is kept in the macOS Keychain or a protected file and shown once for you to save); attachments are separate sealed files. Syncs at startup and after each autosave; a chat continued on two devices splits into two chats ("Name (from device)"), `/delete` and `/purge` propagate.
- Chat files are an append-only log: every save is a commit (new messages and changed settings) recording its device, a Lamport counter, and the commits it follows, and every message has an id and a parent, so changes from two devices can later be merged. `~/.skinny/device` holds this installation's id and an editable name. If two writers add to one message, the latest line is shown and the other is kept. `/purge` is recorded as an operation.
- Chats are saved as SQLite files (`<name>.skinny`, via `node:sqlite`) holding the whole conversation: tool calls and results, thinking blocks, attached images and PDFs (stored once each), and which model wrote each reply. `.Modelfile` sessions from earlier versions still load and are written as `.skinny` the next time they're saved.
- `/new [name]`, `/delete [name]` (asks first), `/export [path]` (`.md` transcript or `.Modelfile`), and `/purge thinking|tools|blobs`. `/clear` is replaced by `/new`, which keeps the old chat saved. `/delete` leaves old-format Modelfiles alone; the first save of one asks whether to delete it.
- `/set model <name>` switches model on the same server, keeping the conversation.
- Conversations are kept in a provider-neutral form (`src/history.js`) and adapted to each model when a request is sent: tool calls become text when the new model lacks the tools, thinking blocks replay only to the model that wrote them, and PDFs/images a model can't take are noted instead.

### Fixed and hardened
- Escape sequences in replies, fetched pages, and tool results are stripped before they reach the terminal (no more title changes, clipboard writes, or screen clears from model text).
- A saved session can no longer quietly send your API key to another server (it asks first), and only known sampling parameters are loaded from it.
- Ctrl+C while a reply streams stops that reply and keeps what arrived, instead of ending the chat.
- Local MCP servers no longer inherit skinnyai's API keys; the approval prompt shows the call's arguments.
- `fetch_page` and image fetches check the address actually connected to (DNS rebinding), and block more reserved ranges.
- `/purge` reaches the sync folder; deleted chats' late commits are cleaned up; malformed synced commits are skipped and reported.
- Unknown command-line options and missing values are errors (a typo no longer becomes the model name); one oddly named file no longer empties `/list`; empty assistant messages aren't sent to Anthropic; `/project move` swaps in one step; secrets go to the Keychain on stdin, not in arguments; exports and edited configs are written privately.

### Changed
- Chat files are created readable only by you (mode 600), and the folders skinnyai makes are mode 700; the default `~/.skinny` and its `sessions/` folder are tightened to 700 at startup if an earlier version made them world-readable.
- `/list` help no longer says "locally" available models.
- The README and `engines` say Node 22.13 or newer.
- Autosave is on by default when running in a terminal (piped input still doesn't autosave unless asked), and the app's "Autosave conversations" setting defaults to on. Autosave appends new messages instead of rewriting the file.
- `/share` and Modelfile `/export` are generated from the saved conversation text; Modelfile is no longer the storage format.
- Requires Node 22.13 or newer (for `node:sqlite`).
- `/set profile` keeps the conversation (use `--new` for a fresh one). Tool calls now always get ids and object arguments in history.
- Removed the DuckDuckGo HTML scraper and the `recency` argument. Without an `OLLAMA_API_KEY`, `web_search` returns only DuckDuckGo Instant Answers (with `t=skinnyai` and attribution, per the API's terms); full web search uses Ollama's hosted search.
- skinnyai identifies itself (`skinnyai/<version>`) instead of sending a browser User-Agent, for Instant Answers and `fetch_page`.
- README trimmed to an overview; details moved to `docs/*.md`, with corrections (requests go to `/api/chat`, the app's start window, the Anthropic API).
- `npm run release:app` signs, notarizes, and staples the DMG; `build-app.sh` reads `SIGN_IDENTITY` and `NOTARY_PROFILE` from a gitignored `.signing.env`.
- The app bundles `LICENSE.txt` and `THIRD_PARTY_NOTICES.txt` (Node.js and SwiftTerm licenses).
- `/show settings` separates settings you can change from those fixed for the session.
- Session names keep spaces in their filenames (files saved with `%20` still load).
- After `/save`, the resume hint matches how the program was launched (`skinnyai`, or File > Open Chat... in the app).
- A chat that finds another chat saved to its session file since it last did asks whether to reload, save under a new name, or skip (there is no overwrite: chat files only grow).
- `/set format json` also adds "Respond only with a valid JSON object." to the system message.

### Fixed
- Starting with a saved session's name now restores its model, API, and host before the welcome box (it showed the session name as the model, and ignored the saved API).

## 0.10.0

### Added
- Config profiles: top-level `"defaultProfile"` names the profile used when none is requested (no profile needs to be called "Default"), `"shared"` (profile-shaped) sits under every profile, and `"startupEnv"` holds launch-only settings (CA file, colors, trusted hosts, image dir).
- `/set profile [name]` lists or switches profiles, restarting MCP servers and starting a new conversation.
- Sessions also save verbose and stop-on-exit; `/load` reports the autosave state.
- macOS app: "Make Default" for profiles and a "Skip profile selection at start" option (off by default).

### Changed
- SwiftTerm is pinned to main commit `4d5eeea` (wide-character reflow fix) instead of tracking `main`.
- The SEA binary strips local symbols on macOS (~25 MB smaller).

### Fixed
- App build against current SwiftTerm main.

## 0.9.0

Initial tagged release.
