# Changelog

## Unreleased

### Added
- Chats are saved as SQLite files (`<name>.skinny`, via `node:sqlite`) holding the whole conversation: tool calls and results, thinking blocks, attached images and PDFs (stored once each), and which model wrote each reply. `.Modelfile` sessions from earlier versions still load and are written as `.skinny` the next time they're saved.
- `/new [name]`, `/delete [name]` (asks first), `/export [path]` (`.md` transcript or `.Modelfile`), and `/purge thinking|tools|blobs`. `/clear` is replaced by `/new`, which keeps the old chat saved. `/delete` leaves old-format Modelfiles alone; the first save of one asks whether to delete it.
- `/set model <name>` switches model on the same server, keeping the conversation.
- Conversations are kept in a provider-neutral form (`src/history.js`) and adapted to each model when a request is sent: tool calls become text when the new model lacks the tools, thinking blocks replay only to the model that wrote them, and PDFs/images a model can't take are noted instead.

### Changed
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
- A chat that finds another chat saved to its session file since it last did asks whether to reload, save under a new name, overwrite, or skip.
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
