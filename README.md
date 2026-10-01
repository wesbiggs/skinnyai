# skinnyai: Get the Skinny, from a Thin Client for Ollama/OpenAI Chat

[![CI](https://github.com/wesbiggs/skinnyai/actions/workflows/ci.yml/badge.svg)](https://github.com/wesbiggs/skinnyai/actions/workflows/ci.yml)

A terminal-based Node.js chat interface for Ollama and OpenAI-compatible endpoints with session-specific model keep-alive control.

## Features

- ✅ Interactive chat with streaming responses
- ✅ Session-specific `keep_alive` parameter (doesn't affect other apps)
- ✅ Configurable model, keep-alive duration, and host
- ✅ Full `ollama run` command parity (`/set`, `/show`, `/load`, `/save`, `/clear`, `/bye`, `/?`, `/list`, ...)
- ✅ Conversation history that's actually sent back to the model each turn (via `/api/chat`)
- ✅ `--api openai` mode for OpenAI-compatible servers (vLLM, llama.cpp server, LM Studio, ...) — see [OpenAI-compatible servers](#openai-compatible-servers)
- ✅ Tool calling, on by default, with built-in `web_search` and `fetch_page` tools (DuckDuckGo, or Ollama's hosted search with an API key)
- ✅ Ollama cloud models via `--host https://ollama.com` and `OLLAMA_API_KEY` — see [Ollama account](#ollama-account-cloud-models-and-hosted-search) — see [Tool calling and web search](#tool-calling-and-web-search)
- ✅ Drag a file (image, PDF, or text) into the prompt, or `/attach` it — see [Attaching files](#attaching-files)
- ✅ `--api anthropic` for Claude — see [Anthropic API](#anthropic-api)
- ✅ MCP servers from a standard `mcp.json` — see [MCP servers](#mcp-servers)
- ✅ Session saving to local Modelfiles (works with any server), optional autosave, and `/share` to an Ollama server
- ✅ Defaults in `~/.skinny/.env`
- ✅ Minimal dependencies (uses Node.js built-ins)

## Prerequisites

- **Node.js 22+**
- A server, such as **Ollama** running on your system with the `serve` daemon active

Check that Ollama is running:
```bash
curl http://localhost:11434/api/tags
```

## Setup

### 1. Make the script executable
```bash
chmod +x bin/skinnyai.js
```

### 2. Optionally add to PATH
```bash
# Copy or link to somewhere in your PATH
cp bin/skinnyai.js ~/.local/bin/skinnyai
# or
ln -s $(pwd)/bin/skinnyai.js ~/.local/bin/skinnyai
# or, from this directory, link it as `skinnyai` via npm
npm link
```

## Usage

### Basic usage (default: `http://localhost:11434`, keep-alive 1 hour)
```bash
node bin/skinnyai.js llama2
./bin/skinnyai.js neural-chat
```

Or via the `npm run` convenience scripts (note the `--` before your own args):
```bash
npm run ollama -- llama2
npm run openai -- my-model --host http://localhost:8000
```

### With custom keep-alive duration
```bash
# Keep model loaded for 30 minutes
node bin/skinnyai.js llama2 --keep-alive 30m

# Keep model loaded for 6 hours
node bin/skinnyai.js mistral -k 6h

# Keep model loaded for 5 minutes (minimal)
node bin/skinnyai.js neural-chat --keep-alive 5m
```

### With custom host
```bash
# Connect to remote Ollama instance
node bin/skinnyai.js llama2 --host http://192.168.1.100:11434
```

### Combine options
```bash
node bin/skinnyai.js \
  --model mistral \
  --keep-alive 2h \
  --host http://localhost:11434
```

### Default settings (`.env`)

Put defaults in `~/.skinny/.env` (or `$SKINNY_HOME/.env`) as `KEY=value` lines, so you don't have to repeat flags. Every flag has a variable:

```bash
# ~/.skinny/.env
SKINNY_MODEL=gemma4:31b
SKINNY_HOST=https://ollama.com
OLLAMA_API_KEY=...
SKINNY_TOOLS=true
SKINNY_AUTOSAVE=true
SKINNY_MODEL_NORMAL_COLOR=#ff8800
```

| Variable | Flag |
|----------|------|
| `SKINNY_MODEL` | model argument / `--model` |
| `SKINNY_HOST` | `--host` |
| `SKINNY_API` | `--api` |
| `SKINNY_KEEP_ALIVE` | `--keep-alive` |
| `SKINNY_TOOLS` | `--tools` / `--no-tools` |
| `SKINNY_DATE` | `--date` / `--no-date` |
| `SKINNY_MARKDOWN` | `--markdown` / `--no-markdown` |
| `SKINNY_IMAGES` | `--images` / `--no-images` |
| `SKINNY_AUTOSAVE` | `--autosave` / `--no-autosave` |
| `SKINNY_HIDE_THINKING` | `--hide-thinking` / `--show-thinking` |
| `SKINNY_STOP_ON_EXIT` | `--stop-on-exit` / `--no-stop-on-exit` |
| `SKINNY_USER_NORMAL_COLOR`, `SKINNY_USER_ITALIC_COLOR`, `SKINNY_MODEL_NORMAL_COLOR`, `SKINNY_MODEL_ITALIC_COLOR` | the `--*-color` flags |

On/off values accept `true`/`false`, `yes`/`no`, `on`/`off`, or `1`/`0`. Values can be quoted, lines can start with `export`, and `#` starts a comment (at the start of a line, or after a space). Variables already set in your environment take precedence over the file, and command-line flags take precedence over both — that's what the `--no-…` forms are for. `/show settings` shows which file was loaded.

## Keep-Alive Duration Formats

Use any of these formats in the `--keep-alive` parameter:

- `30s` - 30 seconds
- `5m` - 5 minutes
- `1h` - 1 hour (default)
- `24h` - 24 hours
- Any other Go duration format

## Unloading the model on exit

By default the model stays loaded for its `--keep-alive` duration after you quit, same as `ollama run`. Pass `-x`/`--stop-on-exit` to unload it immediately when the session ends instead (same effect as running `ollama stop <model>`):

```bash
node bin/skinnyai.js llama2 --stop-on-exit
```

Keep-alive and unloading only exist on a self-hosted Ollama, so they aren't shown (and `--stop-on-exit` does nothing) with `--api openai`, `--api anthropic`, or `--host https://ollama.com`.

This fires on every way the session can end — `/exit`, `/bye`, Ctrl+D, and Ctrl+C — and is best-effort: if the unload request fails (e.g. the server already went away), it's reported but won't block the process from exiting.

## Commands

This client mirrors the command set of the native `ollama run` interactive terminal:

| Command | Description |
|---------|-------------|
| `/set` | Set session variables (see below) |
| `/show` | Show model information (see below) |
| `/load` | With no name, shows the same list as `/list` |
| `/load <name>` | Restore a saved session, or switch to a different model (restoring its saved session/system message if any) |
| `/save [name]` | Save your current session to a local file (see below) |
| `/share [name]` | Save your current session as a model on a self-hosted Ollama server |
| `/clear` | Clear conversation history (keeps the system message, if one is set) |
| `/list` | List locally available models |
| `/attach <file>` | Send a file with your next message (see below) |
| `/mcp` | Show connected MCP servers and their tools |
| `/model` | Show current model, keep-alive, and host (not in native `ollama`; a bonus command) |
| `/bye`, `/exit` | Exit |
| `/?`, `/help` | Help for a command (`/? set`, `/? show`, `/? shortcuts`) |

### `/set`

| Command | Description |
|---------|-------------|
| `/set system <text>` | Set the system prompt for the rest of the session |
| `/set parameter <name> <value...>` | Override a model parameter, e.g. `/set parameter temperature 0.9` |
| `/set format json` / `/set noformat` | Force JSON-formatted responses, or disable |
| `/set verbose` / `/set quiet` | Show/hide token-count and timing stats after each response |
| `/set think [level]` / `/set nothink` | Enable/disable extended thinking, for models that support it |
| `/set showthinking` / `/set hidethinking` | Show/hide a thinking model's reasoning as it streams |
| `/set tools` / `/set notools` | Let the model call tools (`web_search`, `fetch_page`), or disable |
| `/set date` / `/set nodate` | Tell the model today's date, or don't (default: only when tools are on) |

`/set history`, `/set nohistory`, `/set wordwrap`, and `/set nowordwrap` are recognized but don't apply here — this client has no line-history recall and lets your terminal handle wrapping natively, so it prints a note instead of pretending to toggle something.

### Thinking output

For models with a `thinking` capability (check with `/show info`), reasoning is streamed as it's produced, wrapped in `Thinking...` / `...done thinking.` markers and dimmed, the same way `ollama run` displays it — then the final answer streams normally below it. It's on by default; pass `--hide-thinking` on the command line, or run `/set hidethinking` mid-session, to suppress it and only show the final answer. (Thinking is only requested from the model at all if `think` is enabled via `/set think`, per the model's default.)

If generation runs out of its token/context budget while the model is still mid-thought, Ollama reports `done_reason: "length"` and stops — the reasoning text you see really is cut off mid-sentence, not a display bug. In that case a `⚠️  cut off - ran out of tokens while still thinking` warning prints instead of `...done thinking.`; raise the budget with `/set parameter num_predict <n>` (or `num_ctx` if the prompt itself is long) and try again.

### Tool calling and web search

The model is offered two tools by default (`--no-tools`, `SKINNY_TOOLS=false`, or `/set notools` turns them off; `/set tools` turns them back on):

- `web_search` — searches the web with DuckDuckGo and returns result titles, URLs, and snippets.
- `fetch_page` — fetches a URL and returns the page's readable text, so the model can read a search result instead of guessing from its snippet.

```bash
./bin/skinnyai.js qwen3 --no-tools   # for a model that can't call tools
```

When the model calls a tool, skinnyai runs it, shows a dimmed line like `🔧 searching: "..."` or `🔧 fetching: <url>`, sends the result back to the model, and streams its final answer. A single reply can involve several tool calls; after 5 rounds of tool calls, the model is asked to answer without tools. Tool calls and results are kept in the conversation history, so follow-up questions can refer to them.

This needs a model with the `tools` capability (check with `/show info`) — e.g. `llama3.1`, `llama3.2`, `qwen3`, `mistral-nemo`. Models without it make Ollama return an error; turn tools back off with `/set notools`. Small local models rarely chain the tools: in testing, `llama3.2:3b` never called `fetch_page`, even when asked to read a specific URL, and `llama3.1:8b` fetched a URL it was given but never read a page after its own search, so both answered from snippets. Ollama's hosted search (below) sidesteps this by returning page text with each result; larger models like `gemma4:31b` use the tools well either way. It works the same way under `--api openai`, for servers that support OpenAI-style `tools`.

`web_search` takes an optional `recency` argument (`day`, `week`, `month`, or `year`), which limits results to that period via DuckDuckGo's date filter. The model decides when to use it, e.g. for news.

With `OLLAMA_API_KEY` set, both tools use Ollama's hosted APIs — see [Ollama account](#ollama-account-cloud-models-and-hosted-search). Without it, search is done by DuckDuckGo, with no API key:

1. The official [Instant Answer API](https://api.duckduckgo.com/api) is tried first. It returns encyclopedia-style summaries and direct answers, not web results, so many queries come back empty.
2. Otherwise, skinnyai falls back to scraping `html.duckduckgo.com` for the top 8 results (title, URL, snippet). That endpoint is unofficial: it can break if DuckDuckGo changes its markup, and rapid or heavy use gets blocked as automated traffic. When that happens, the model is told the search failed.

#### `fetch_page`

`fetch_page` extracts readable text from HTML: it drops scripts, styles, navigation, and footers, prefers the page's `<main>` or `<article>` when there is one, removes long runs of menu-like links (e.g. language pickers), and keeps headings and list items as lines of text. Plain text, JSON, and XML are returned as-is; other types (images, PDFs, ...) are refused. Pages that build their content with JavaScript come back mostly empty.

Only the first 6,000 characters of a page's text (about 1,500 tokens) are passed to the model, with a note saying it was truncated. Ollama's default context window is small, so if long conversations with several fetched pages start losing earlier context, raise it with `/set parameter num_ctx 16384` (or whatever your model and memory allow).

Pages can contain text aimed at the model ("ignore your instructions and…"), and the model can't reliably tell that apart from your instructions. So `fetch_page` refuses URLs that point at this machine or the local network — `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local and cloud-metadata addresses (`169.254.0.0/16`), carrier-grade NAT, and their IPv6 equivalents — checking the resolved address of every redirect too. Otherwise a malicious page could get the model to read, say, your router's admin page or your Ollama server and send the contents to an attacker's URL. This check doesn't stop DNS rebinding (a hostname that resolves differently between the check and the request), and nothing can stop a page from misleading the model about its content, so treat answers built from fetched pages with the same skepticism as the pages themselves.

### Today's date

Models only know their training cutoff, and many assume it's still that date — `llama3.2`'s template even tells it `Cutting Knowledge Date: December 2023` — so searches for "today's headlines" come back years out of date. To fix this, skinnyai tells the model the current date (e.g. `Today's date is Tuesday, September 29, 2026.`), both at the start of the system message and in the `web_search` tool description.

The date is added to each outgoing request, not stored in the conversation, so it's always current, and `/save` and `/show system` only ever contain your own system message.

It's on by default whenever tools are on (which they are by default). `--date` or `/set date` turns it on without tools (it also helps with questions like "how long ago was X"); `--no-date` or `/set nodate` turns it off. Under `--api openai`, sending the system message can replace a system prompt the server would otherwise apply by default.

### `/show`

`/show info`, `/show license`, `/show modelfile`, `/show parameters`, `/show system`, and `/show template` all query the current model via `/api/show` and print the relevant field.

`/show settings` (not in `ollama run`) lists this session's own state instead — everything `/set` and the command-line flags control: host, keep-alive, system message, parameter overrides, format, think, thinking display, verbose, tools, date, markdown, images, and stop-on-exit. It works with `--api openai` too, since it doesn't ask the server.

### `/save [name]` and `/share [name]`

`/save` writes the session — model, system message, parameters, and conversation — to `~/.skinny/sessions/<name>.Modelfile` (set `SKINNY_HOME` to use another directory than `~/.skinny`). It works the same with every server: a local or cloud Ollama, or `--api openai`.

```
> /save trip-planning
✅ Saved session 'trip-planning' to /Users/you/.skinny/sessions/trip-planning.Modelfile
   Resume it with /load trip-planning, or start with: skinnyai.js trip-planning
```

- `/save` with no name saves under the session's current name — the one it was last saved or loaded as — or, for a session that hasn't been saved yet, a new name from the date and time, like `chat-2026-09-30-154907`.
- `/save <new name>` is "save as": it writes a new file and leaves the old one as it was, and from then on `/save` (and autosave) update the new name. The exception is a session that still has a date-and-time name (from autosave or a bare `/save`): that file is renamed instead, so naming a session doesn't leave a stray copy behind.
- If the name belongs to a different saved session, `/save` asks before overwriting it (`[y/N]`; anything but `y` keeps the existing file).
- `/load <name>` or `skinnyai.js <name>` resumes a saved session: it switches to the session's `FROM` model and restores its system message, parameters, and conversation. `/list` shows saved sessions below the server's models. A saved session takes precedence over a server model with the same name.

The file uses Ollama's Modelfile format — `FROM`, `PARAMETER`, `SYSTEM`, and `MESSAGE` lines — so it's readable, and can be turned into a model with `ollama create <name> -f <file>`. Tool calls and their raw results aren't saved (the format has no place for them), but the answers the model gave from them are.

`/share` is what `/save` does in `ollama run`: it creates a model on the Ollama server (via `/api/create`) from the current model, system message, parameters, and conversation, so `ollama run <name>` resumes the session from anywhere that uses the server. It defaults to the session's current name, the same way `/save` does, and asks before replacing a model that already exists on the server. Only a self-hosted Ollama server supports this; with ollama.com or `--api openai`, `/share` explains that and points you to `/save`.

#### Autosave

With `--autosave` (or `/set autosave`, or `SKINNY_AUTOSAVE=true`), the session is saved to a local file after every reply, so nothing is lost if you close the terminal. It saves under the session's current name, or — if it hasn't been saved yet — a new one from the date and time, like `chat-2026-09-30-154907`. `/save <name>` renames that file, and autosave carries on under the new name. Resuming a saved session with autosave on keeps updating that session's file, and `/clear` starts a new file for the new conversation.

### Conversation memory

Each turn is sent via Ollama's `/api/chat` endpoint with the full message history (not just the latest prompt), so the model actually remembers earlier turns in the conversation — matching how native `ollama run` behaves.

## Markdown rendering, multi-line input, and RP-style formatting

- **Markdown**: responses (and your own messages) are rendered as they stream, with no third-party library:
  - `**bold**`, `*italic*` / `_italic_`, `~~strikethrough~~`, and `` `inline code` `` use ANSI styles. Underscores inside words (`snake_case`) and a lone `*` surrounded by spaces (`5 * 3`) stay literal, and `\*` escapes a marker.
  - `# Headings` are bold; `- ` / `* ` / `+ ` bullets become `•` (or `◦` when indented); numbered lists (`1.` / `1)`) and bullets get a hanging indent so wrapped lines line up with the item text.
  - `> quotes` get a `│` bar, `---` becomes a full-width rule, and fenced code blocks are shown in a code color, unwrapped, so they copy cleanly.
  - `[links](https://...)` become clickable [OSC 8 hyperlinks](https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda) (underlined) in terminals that support them — iTerm2, WezTerm, kitty, GNOME Terminal, Windows Terminal, and others; elsewhere you just see the link text.
  - `![images](https://...)` show as a clickable `🖼️ caption`. With `--images` (or `/set images`), terminals with an inline image protocol — iTerm2 and WezTerm (the protocol `imgcat` uses), kitty and Ghostty (kitty's graphics protocol; PNG only) — also draw the image below the line that mentions it, scaled to fit. It's off by default because it downloads whatever image URL the model writes: a prompt injection (say, in a page `fetch_page` read) could smuggle conversation details out in that URL. Like `fetch_page`, it refuses local/private network addresses and caps the download size. Inside tmux or screen, which don't pass image sequences through, images stay links. A local file works too — `![](/Users/me/pic.png)`, `~/pic.png`, or a `file://` URL (written with `%20` for spaces) — and nothing is fetched or sent for it, so that's how to see images a tool such as an image generator saved on your machine.
  - Tables are drawn with box-drawing borders, honoring `:---:` / `---:` alignment. Columns shrink to fit the terminal, wrapping cell text as needed. Emoji (✅, ⚠️, flags, 👩‍💻) are measured as the two columns terminals draw them in, so they don't push borders out of line. Since column widths depend on every row, a table is drawn once it's complete; until then a `⋯ receiving table (N rows)` placeholder shows progress.
  - `/set nomarkdown` (or `--no-markdown`) shows responses as raw text instead; `/set markdown` turns rendering back on. When output is redirected to a file or pipe, text is always written raw, so it stays valid markdown.
- **RP-style narration**: `*single asterisks*` are italic *and* switch to a dimmer narration color, so role-play narration stays visually distinct from dialogue. Each speaker gets its own color so turns are easy to tell apart at a glance: your messages are yellow (bright for dialogue, dim for `*narration*`), and the assistant's are green (same bright/dim split). Markup is stripped from the display; the raw text is still what's stored in history and sent to the model.
- **Multi-line messages**: press **Ctrl+J** to insert a new line without sending the message; plain **Enter** sends it. **Shift+Enter** does the same in terminals that implement the kitty keyboard protocol (kitty, Ghostty, WezTerm, iTerm2 3.5+); skinnyai asks for that mode while you're typing and restores it afterwards. Terminal.app can't tell Shift+Enter from Enter, so use Ctrl+J there.
- **Line editing**: Left/Right move the cursor (Ctrl/Alt+arrows or Alt+B/F by word), Home/End or Ctrl+A/E jump to the start/end of the line, and Ctrl+W, Ctrl+U, and Ctrl+K delete the previous word, to the start of the line, and to the end of the line. Up/Down move between lines of a multi-line message, and past its first/last line recall earlier messages from this session. `/? shortcuts` lists them all.
- **Pasting**: multi-line pastes are kept whole (via bracketed paste) rather than sending at the first line break — supported by essentially all modern terminals.
- **Word wrap**: streamed responses and redisplayed history wrap on word boundaries at your terminal width, instead of hard-wrapping mid-word. This doesn't apply to your own live input line, which your terminal wraps natively as you type.

### Customizing colors

Override any of the four colors on the command line:

| Flag | Default | Meaning |
|------|---------|---------|
| `--user-normal-color` | `226` (bright yellow) | Your dialogue |
| `--user-italic-color` | `136` (dim yellow) | Your `*italic*` / narration |
| `--model-normal-color` | `83` (bright green) | Model dialogue |
| `--model-italic-color` | `28` (dim green) | Model `*italic*` / narration |

(`--user-emphasis-color` and `--model-emphasis-color` still work as aliases for the italic flags.) Each accepts a hex code (`#RRGGBB`), a 256-color palette index (`0`-`255`), or a basic name (`red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `black`, a `bright`-prefixed variant like `brightgreen`, or `gray`/`grey`):

```bash
./bin/skinnyai.js llama2 --user-normal-color cyan --model-normal-color "#ff8800"
```

Colors are only applied on a real terminal; the flags are silently ignored when output is redirected to a file or pipe.

## Examples

### Quick chat session
```bash
$ ./bin/skinnyai.js llama2
┌───────────────────────────────────────────────────────┐
│ 🚀 SkinnyAI v0.9.0                                    │
│ 📦 Model: llama2                                      │
│ ⏳ Keep-alive: 1h                                     │
│ 🌐 Host: http://localhost:11434                       │
│ 🔧 Tools: web_search, fetch_page (DuckDuckGo)         │
│                                                       │
│ Type /help for commands.                              │
│ Enter sends; Ctrl+J or Shift+Enter adds a new line.   │
└───────────────────────────────────────────────────────┘

> What is machine learning?
Machine learning is a subset of artificial intelligence...

> Tell me more about neural networks
Neural networks are inspired by biological neurons...

> /exit
👋 Goodbye!
```

### Extended session
```bash
# Keep a large model loaded for 3 hours of work
node bin/skinnyai.js mistral --keep-alive 3h
```

### Remote connection
```bash
# Chat with Ollama running on another machine
./bin/skinnyai.js neural-chat --host http://192.168.1.50:11434
```

## Ollama account: cloud models and hosted search

A free [ollama.com](https://ollama.com) account gives you an API key with usage-limited access to cloud models (e.g. `gemma4:31b`) and to Ollama's web search and fetch APIs. skinnyai reads the key from the `OLLAMA_API_KEY` environment variable. Rather than putting the key in a plain-text file, you can keep it in the macOS Keychain and load it from `~/.zshrc`:

```bash
security add-generic-password -a "$USER" -s OLLAMA_API_KEY -w   # prompts for the key
echo 'export OLLAMA_API_KEY="$(security find-generic-password -a "$USER" -s OLLAMA_API_KEY -w 2>/dev/null)"' >> ~/.zshrc
```

**Cloud models:** point `--host` at ollama.com. `/list`, `/show`, and tool calling work the same as with a local server; `/save` and `/load` use local files as always, but `/share` isn't available:

```bash
./bin/skinnyai.js gemma4:31b --host https://ollama.com --tools
```

The key is only ever sent to `https://ollama.com`, never to other `--host` servers (a local or LAN Ollama, or an `--api openai` server).

**Hosted search:** when the key is set, `web_search` and `fetch_page` use Ollama's `/api/web_search` and `/api/web_fetch` — whichever model you're chatting with, local or cloud. The hosted search returns the text of each result page rather than a snippet, which makes a big difference for small models: they rarely think to call `fetch_page` after searching, but with the text included they don't need to. In testing, local `llama3.1:8b` went from listing news sites' names (or inventing headlines) to summarizing that day's actual stories. Each result's text is tidied (share buttons and menus removed) and cut to 1,500 characters, 5 results per search. Differences from the DuckDuckGo path:

- There's no date filter, so `web_search`'s `recency` argument isn't offered. Hosted search returned current news without one.
- Searches and fetches count against your account's usage limits, and your queries and the URLs the model reads go to Ollama.
- The hosted fetch runs on Ollama's servers, so it can't reach your machine or local network.

If a hosted call fails — a usage limit, an outage, or an occasional page Ollama can't fetch — skinnyai prints a `⚠️` note and falls back to DuckDuckGo or the local fetcher for that call. To use DuckDuckGo only, unset the key for that run: `OLLAMA_API_KEY= ./skinnyai.js ...`.

## OpenAI-compatible servers

Pass `--api openai` to talk to an OpenAI-compatible server (vLLM, llama.cpp's `server`, LM Studio, etc.) instead of Ollama. If it wants a key (including OpenAI itself: `--host https://api.openai.com`), set `OPENAI_API_KEY`; it's sent as a bearer token to whatever `--host` is:

```bash
./bin/skinnyai.js my-model --api openai --host http://localhost:8000
```

`--host` should be the server's base URL (no `/v1` suffix); requests go to `/v1/chat/completions` and `/v1/models`. Streaming, history, thinking-output display (via a de facto `reasoning_content` delta some servers emit for reasoning models — there's no standard field for it), and `/set parameter`/`/set format json`/`/set verbose` all still work, with sampling parameters passed through as top-level OpenAI-style fields.

Several commands are Ollama-specific and have no OpenAI API equivalent, so they're disabled or degraded under `--api openai`:

- `/share` — no equivalent to `/api/create`; use `/save`, which works the same as with Ollama.
- `/show info|license|modelfile|parameters|template` — no equivalent to `/api/show`; these print an error. `/show system` and `/show settings` still work (they only report the session's own state).
- `/load <name>` — restores a saved session by that name; otherwise it switches the active model name and starts a fresh session.
- `--keep-alive`/`-x`/`--stop-on-exit` — no equivalent concept; `--stop-on-exit` is a no-op.
- `/set verbose` stats — only shows token counts (from the `usage` field, if the server returns one), not timing, since OpenAI's API doesn't report duration breakdowns.

## Attaching files

Drag a file from Finder into the terminal. Its path is recognized as it arrives and replaced by a `📎 name` line above the prompt (Backspace on an empty prompt removes the last one). What happens next depends on the file:

| File | Sent as |
|------|---------|
| Image (PNG, JPEG, GIF, WebP) | An image, to any API that takes them. Ollama is checked for the `vision` capability first, with a warning (but still sent) if it's missing |
| PDF | A document block (Anthropic) or a file part (OpenAI). Ollama can't take PDFs, so they're refused there |
| Text (any UTF-8 file up to 300 KB: code, notes, CSV, ...) | Pasted into your message in a fenced block under `[attached file: name]`, so it works with every API and is kept in saved sessions |
| Anything else | Refused: these APIs have no way to take it |

Files are capped at 20 MB. Only a *paste* (which is what a drop is) attaches PDFs and text files; a path typed into a message only attaches images, so mentioning `~/.ssh/config` in a question doesn't upload it. When a drop doesn't register in your terminal, `/attach <path>` queues a file for your next message. PDFs and images aren't kept in saved sessions or shared models, only their text.

## Anthropic API

`--api anthropic` talks to Claude through the Messages API (default host `https://api.anthropic.com`). Set `ANTHROPIC_API_KEY` in the environment or `~/.skinny/.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-... ./bin/skinnyai.js claude-sonnet-5-5 --api anthropic
```

Streaming, history, images, `/set system`, tools (web search and MCP), and `/list` (from `/v1/models`) work. `/set think [low|medium|high|xhigh|max]` turns on adaptive thinking (with that effort level); `nothink` just stops sending it, since newer models can't have thinking switched off. `/set parameter temperature|top_p|top_k|stop|max_tokens` are passed through (`num_predict` also sets `max_tokens`; the default is 16000). Like `--api openai`, it has no `/share`, `/show info`, or keep-alive.

## MCP servers

skinnyai reads `~/.skinny/mcp.json` (or the file named by `SKINNY_MCP_CONFIG`) in the format Claude Desktop, Claude Code, and Cursor share, and offers each server's tools to the model — with any `--api`, alongside the built-in web tools:

```json
{
  "mcpServers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/notes"] },
    "docs":  { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }, "trust": true }
  }
}
```

- `command`/`args`/`env`/`cwd` start a local server over stdio; `url`/`headers` connect to a remote one over streamable HTTP. `${VAR}` expands from the environment. `"disabled": true` skips an entry.
- Tools appear as `server__tool`. Each call asks `Allow this tool call? [y/N/a(lways)]` first, because a web page the model read could try to steer it. Answering `a` trusts that one tool from then on by adding it to its server's `"trust": ["tool", …]` list in `mcp.json` (the file is rewritten, pretty-printed); `"trust": true` trusts every tool on a server.
- `/mcp` lists what's connected. A server that fails to start is reported and skipped. `--no-mcp` (or `SKINNY_MCP=false`) ignores the file. Only tools are supported — not resources, prompts, sampling, or the legacy SSE transport.

## How It Works

This tool uses the **Ollama REST API** with the `keep_alive` parameter:

1. Each request to `/api/generate` includes `"keep_alive": "1h"` (or your specified duration)
2. This tells the Ollama daemon to keep **only this model** loaded for the specified time
3. Other applications/requests still get the default 5-minute timeout
4. The keep-alive is per-request, so each turn resets the timer

This is much cleaner than globally changing Ollama's behavior—your session gets the behavior you want, without affecting other tools.

## Troubleshooting

### "Connection refused" error
- Ensure Ollama daemon is running: `ollama serve`
- Check the host is correct: `--host http://localhost:11434`
- Verify Ollama is listening: `curl http://localhost:11434/api/tags`

### Model not found
- Verify the model is installed: `ollama list`
- Pull the model if needed: `ollama pull llama2`

### Model unloads between requests
- Increase `--keep-alive` duration (e.g., `6h` instead of `1h`)
- This extends how long the model stays in memory after each request

## Performance Tips

- **Large models (7B+)**: Use `--keep-alive 1h` or longer to avoid reload overhead
- **Small models (3B)**: `--keep-alive 30m` is usually fine
- **Long sessions**: Use `--keep-alive 6h` or `24h` to keep the model hot throughout
- **Limited RAM**: Use shorter durations like `--keep-alive 10m`

## Tests

The script itself has no dependencies; the tests use [Vitest](https://vitest.dev) as a dev dependency:

```bash
npm install
npm test            # or: npm run test:watch
```

They cover markdown rendering (checked against a small terminal emulator, so wrapping and table borders are tested as they'd appear on screen), emoji widths, inline images, the line editor (driven with simulated keystrokes), the Modelfile format, `.env` and flag handling, and `/save`, `/load`, `/share`, and autosave. `test/cli.test.js` runs `bin/skinnyai.js` end to end against a mock server that speaks both the Ollama and OpenAI APIs. Tests use a temporary `SKINNY_HOME`, so they never read or write your real `~/.skinny`.

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the suite on Node 22 and 24 for every push to `main` and every pull request. No real terminal is needed: the tests fake one, including the iTerm2 and kitty image support, so everything runs headless on Linux.

## Source

The whole tool is the single file `bin/skinnyai.js`, with no runtime dependencies beyond Node.js itself — copy it wherever you work (esbuild and postject are only used to build the standalone binary). Tests live in `test/`.

## macOS app

`npm run build:app` builds `dist/SkinnyAI.app`: a small native shell around a standalone `skinnyai` binary (Node is embedded, so nothing needs installing). Opening it starts a chat in its own terminal window (built on [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm), with inline images and Shift+Enter); ⌘N opens another, and clicking the Dock icon brings the open chat forward. **Option+=** and **Option+-** make the text bigger or smaller (**Option+0** resets it; also under the View menu), and Settings has a font size too. **Settings… → Open chats in** can send chats to Terminal or iTerm instead. **SkinnyAI → Settings…** (⌘,) edits `~/.skinny/.env`: API key, server, model, and the on/off options. It keeps comments and any variables it doesn't know about, and writes the file readable only by you. On first launch, with no model set, Settings opens automatically (choosing an API fills in its usual server address; web search and markdown are on by default). The Model field is a drop-down of what the server offers, refreshed when you change the server, API, or key. Clicking the Dock icon while a chat is open brings its terminal forward instead of starting another; **File → New Chat** (⌘N) always starts one.

Building it needs Xcode with its Metal Toolchain (`xcodebuild -downloadComponent MetalToolchain`); the Swift part is built with SwiftPM (`Package.swift`).

```bash
npm run build:app          # ad-hoc signed: runs on this Mac only
scripts/build-app.sh --dmg # also dist/SkinnyAI-<version>.dmg
```

To distribute it, sign and notarize with an Apple Developer ID (Gatekeeper blocks unsigned apps on other Macs):

```bash
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" NOTARY_PROFILE=skinnyai scripts/build-app.sh --dmg
```

`npm run build:sea` builds just the standalone binary (`build/skinnyai`). Both builds are for the architecture of the Mac they run on; an Intel build needs an x64 Node binary.
