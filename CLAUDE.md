# skinnyai

A thin terminal chat client for Ollama, OpenAI-compatible servers, and Anthropic, plus a small native macOS app that wraps it. Node >= 22, no runtime dependencies by design (raw HTTPS, no SDKs). README.md is the user-facing reference; this file is for orientation and the non-obvious decisions.

## Layout

- `bin/skinnyai.js`: the entire CLI (one large file): line editor, markdown renderer, API clients, tools, MCP, sessions, config/profiles.
- `macos/main.swift`: the whole app (AppKit + SwiftUI + SwiftTerm): start window, Settings, built-in chat windows. `Package.swift` builds it.
- `scripts/`: `build-sea.mjs` (single-executable CLI, bundled into the app as `skinnyai-cli`), `build-app.sh` (builds, signs, bundles the app), `make-icon.swift` (regenerates the icon).
- `test/`: vitest. Tests use a temporary `SKINNY_HOME` and a mock server speaking the Ollama, OpenAI, and Anthropic APIs; they never touch the real `~/.skinny`.

## Commands

- `npm test`: run the suite (keep it green; add tests with behavior changes).
- `npm run build:sea` / `npm run build:app`: build the CLI binary / the app.
- `swift build`: quick compile check of the app. The app's UI and terminal behavior can't be exercised by tests; say so when unverified.

## Configuration

- State lives in `~/.skinny` (override with `SKINNY_HOME`): `config.json` (named profiles, each with an `env` block and optional `mcpServers`; non-Default profiles inherit from Default, see `resolveProfile`), `mcp.json`, `sessions/<name>.Modelfile`, `app-chat.pid`.
- The app edits `config.json` through `ConfigFile`, preserving anything it doesn't manage, and stores only values that differ from Default (and from the program's own defaults). Which profile the app uses is `UserDefaults` key `profile`; where chats open is `chatIn` (`builtin` | `auto` | `terminal` | `iterm`).
- Providers in Settings are derived from `SKINNY_API` + `SKINNY_HOST` (ollama.com host => Ollama Cloud, api.openai.com => OpenAI Cloud); nothing extra is stored. Changing provider fills in its host and clears the model. Anthropic and OpenAI Cloud use `SKINNY_MODEL=default`.
- `--model default` looks up `/v1/models` at startup: newest plain `gpt-N` for OpenAI, newest **Opus** for Anthropic (change `pickDefaultModel` for another family).

## Behavior decisions worth keeping

- Web search/tools are on by default (`--no-tools`, `SKINNY_TOOLS=false`, `/set notools` to disable); the date line goes into the system message by default.
- `keep_alive` and unload-on-exit only apply to a self-hosted Ollama (`managesModelLifetime`: api is ollama and host isn't ollama.com); elsewhere they're not sent and their UI is hidden.
- `--api openai` does not default its host to api.openai.com when a key is set: a stray key must never silently redirect prompts. `OPENAI_API_KEY` is sent as a Bearer token on any host.
- Anthropic: Anthropic stream events are translated into the OpenAI-style chunk handling so streaming/thinking/tools share code. `/set think` => adaptive thinking; `nothink` omits the field. `max_tokens` 16000. No prompt caching. Only tested against the mock server, never a real key.
- MCP: stdio and streamable-HTTP, tools only (no resources/prompts/sampling/SSE/OAuth). Every call asks `[y/N/a(lways)]` unless the server has `"trust": true`; `a` writes the tool into `"trust": [...]` in mcp.json (re-serialized, so formatting is lost). Only the user-level config is read.
- Images: dropped files arrive as pasted paths, so attachment is path detection (escaped, quoted, `file://`, `~/`) for real PNG/JPEG/GIF/WebP files up to 20 MB, live as the paste ends. PDFs and text files (<= 300 KB, inlined) attach only via paste or `/attach`, never from typed prose. A line starting with `/` that contains an image path is a message, not a command. Images aren't saved in sessions or `/share`.
- Inline image rendering is off by default (`/set images`); it draws `http(s):`, `data:`, and local paths/`file://` from markdown image syntax (local reads send nothing anywhere).
- The `=====` divider in the welcome screen is relied on by tests and scripts.
- Shift+Enter uses the kitty keyboard protocol (`ESC[>1u` while reading a line); Ctrl+J is the universal newline. The decoder must map kitty reports (e.g. `ESC[106;5u`) back to keys.

## macOS app

- Launch shows a start window (profile picker pre-selected to the last used, summary line, New Chat / Settings... / Open Chat...); it does not open a chat directly. Dock click focuses the running chat, else shows the start window; File > New Chat shows it too. File > Save / Save As… type `/save [name]` into the front built-in chat; the program announces its session name in the window title (`SkinnyAI: <name>`, set by the `sessionName` setter when `TERM_PROGRAM=SkinnyAI`), which the app reads to know if Save needs a name (autosave-style names don't count). Open Chat resumes a file from `~/.skinny/sessions` via `skinnyai-cli <name>`.
- Built-in chats are SwiftTerm views running `skinnyai-cli` with `TERM_PROGRAM=SkinnyAI` (treated as an iTerm-protocol image terminal). Closing a window kills its chat; a clean exit closes the window; a failed exit stays open with the code in the title. Terminal/iTerm launching (via a `.command` file plus the pid file, to avoid an Automation permission prompt) remains as an option.
- SwiftTerm is tracked from git `main` (`Package.swift`, pinned in `Package.resolved`) for the wide-character reflow fix; go back to `from:` once a release includes it.
- Settings' model drop-down queries `/api/tags` (Ollama), `/v1/models` (OpenAI), `/v1/models?limit=100` (Anthropic) shortly after server/provider/key edits, falling back to a text field with the reason.
- Icon: white SKINNY over green AI; regenerate with `scripts/make-icon.swift`.
