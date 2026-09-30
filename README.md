# thinai: Thin Client for Ollama/OpenAI Interactive Chat

A terminal-based Node.js chat interface for Ollama and OpenAI-compatible endpoints with session-specific model keep-alive control.

## Features

- ✅ Interactive chat with streaming responses
- ✅ Session-specific `keep_alive` parameter (doesn't affect other apps)
- ✅ Configurable model, keep-alive duration, and host
- ✅ Full `ollama run` command parity (`/set`, `/show`, `/load`, `/save`, `/clear`, `/bye`, `/?`, `/list`, ...)
- ✅ Conversation history that's actually sent back to the model each turn (via `/api/chat`)
- ✅ `--api openai` mode for OpenAI-compatible servers (vLLM, llama.cpp server, LM Studio, ...) — see [OpenAI-compatible servers](#openai-compatible-servers)
- ✅ Opt-in tool calling with built-in `web_search` and `fetch_page` tools (DuckDuckGo, or Ollama's hosted search with an API key)
- ✅ Ollama cloud models via `--host https://ollama.com` and `OLLAMA_API_KEY` — see [Ollama account](#ollama-account-cloud-models-and-hosted-search) — see [Tool calling and web search](#tool-calling-and-web-search)
- ✅ Minimal dependencies (uses Node.js built-ins)

## Prerequisites

- **Node.js 18+** (for native `fetch` support)
- A server, such as **Ollama** running on your system with the `serve` daemon active

Check that Ollama is running:
```bash
curl http://localhost:11434/api/tags
```

## Setup

### 1. Make the script executable
```bash
chmod +x thinai.js
```

### 2. Optionally add to PATH
```bash
# Copy or link to somewhere in your PATH
cp thinai.js ~/.local/bin/
# or
ln -s $(pwd)/thinai.js ~/.local/bin/thinai
```

## Usage

### Basic usage (default: `http://localhost:11434`, keep-alive 1 hour)
```bash
node thinai.js llama2
./thinai.js neural-chat
```

Or via the `npm run` convenience scripts (note the `--` before your own args):
```bash
npm run ollama -- llama2
npm run openai -- my-model --host http://localhost:8000
```

### With custom keep-alive duration
```bash
# Keep model loaded for 30 minutes
node thinai.js llama2 --keep-alive 30m

# Keep model loaded for 6 hours
node thinai.js mistral -k 6h

# Keep model loaded for 5 minutes (minimal)
node thinai.js neural-chat --keep-alive 5m
```

### With custom host
```bash
# Connect to remote Ollama instance
node thinai.js llama2 --host http://192.168.1.100:11434
```

### Combine options
```bash
node thinai.js \
  --model mistral \
  --keep-alive 2h \
  --host http://localhost:11434
```

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
node thinai.js llama2 --stop-on-exit
```

This fires on every way the session can end — `/exit`, `/bye`, Ctrl+D, and Ctrl+C — and is best-effort: if the unload request fails (e.g. the server already went away), it's reported but won't block the process from exiting.

## Commands

This client mirrors the command set of the native `ollama run` interactive terminal:

| Command | Description |
|---------|-------------|
| `/set` | Set session variables (see below) |
| `/show` | Show model information (see below) |
| `/load <model>` | Switch to a different model, restoring its saved session/system message if any |
| `/save <model>` | Save your current session as a new model |
| `/clear` | Clear conversation history (keeps the system message, if one is set) |
| `/list` | List locally available models |
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

Pass `--tools` (or run `/set tools` mid-session) to offer the model two tools:

- `web_search` — searches the web with DuckDuckGo and returns result titles, URLs, and snippets.
- `fetch_page` — fetches a URL and returns the page's readable text, so the model can read a search result instead of guessing from its snippet.

```bash
./thinai.js qwen3 --tools
```

When the model calls a tool, thinai runs it, shows a dimmed line like `🔧 searching: "..."` or `🔧 fetching: <url>`, sends the result back to the model, and streams its final answer. A single reply can involve several tool calls; after 5 rounds of tool calls, the model is asked to answer without tools. Tool calls and results are kept in the conversation history, so follow-up questions can refer to them.

This needs a model with the `tools` capability (check with `/show info`) — e.g. `llama3.1`, `llama3.2`, `qwen3`, `mistral-nemo`. Models without it make Ollama return an error; turn tools back off with `/set notools`. Small local models rarely chain the tools: in testing, `llama3.2:3b` never called `fetch_page`, even when asked to read a specific URL, and `llama3.1:8b` fetched a URL it was given but never read a page after its own search, so both answered from snippets. Ollama's hosted search (below) sidesteps this by returning page text with each result; larger models like `gemma4:31b` use the tools well either way. It works the same way under `--api openai`, for servers that support OpenAI-style `tools`.

`web_search` takes an optional `recency` argument (`day`, `week`, `month`, or `year`), which limits results to that period via DuckDuckGo's date filter. The model decides when to use it, e.g. for news.

With `OLLAMA_API_KEY` set, both tools use Ollama's hosted APIs — see [Ollama account](#ollama-account-cloud-models-and-hosted-search). Without it, search is done by DuckDuckGo, with no API key:

1. The official [Instant Answer API](https://api.duckduckgo.com/api) is tried first. It returns encyclopedia-style summaries and direct answers, not web results, so many queries come back empty.
2. Otherwise, thinai falls back to scraping `html.duckduckgo.com` for the top 8 results (title, URL, snippet). That endpoint is unofficial: it can break if DuckDuckGo changes its markup, and rapid or heavy use gets blocked as automated traffic. When that happens, the model is told the search failed.

#### `fetch_page`

`fetch_page` extracts readable text from HTML: it drops scripts, styles, navigation, and footers, prefers the page's `<main>` or `<article>` when there is one, removes long runs of menu-like links (e.g. language pickers), and keeps headings and list items as lines of text. Plain text, JSON, and XML are returned as-is; other types (images, PDFs, ...) are refused. Pages that build their content with JavaScript come back mostly empty.

Only the first 6,000 characters of a page's text (about 1,500 tokens) are passed to the model, with a note saying it was truncated. Ollama's default context window is small, so if long conversations with several fetched pages start losing earlier context, raise it with `/set parameter num_ctx 16384` (or whatever your model and memory allow).

Pages can contain text aimed at the model ("ignore your instructions and…"), and the model can't reliably tell that apart from your instructions. So `fetch_page` refuses URLs that point at this machine or the local network — `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local and cloud-metadata addresses (`169.254.0.0/16`), carrier-grade NAT, and their IPv6 equivalents — checking the resolved address of every redirect too. Otherwise a malicious page could get the model to read, say, your router's admin page or your Ollama server and send the contents to an attacker's URL. This check doesn't stop DNS rebinding (a hostname that resolves differently between the check and the request), and nothing can stop a page from misleading the model about its content, so treat answers built from fetched pages with the same skepticism as the pages themselves.

### Today's date

Models only know their training cutoff, and many assume it's still that date — `llama3.2`'s template even tells it `Cutting Knowledge Date: December 2023` — so searches for "today's headlines" come back years out of date. To fix this, thinai tells the model the current date (e.g. `Today's date is Tuesday, September 29, 2026.`), both at the start of the system message and in the `web_search` tool description.

The date is added to each outgoing request, not stored in the conversation, so it's always current, and `/save` and `/show system` only ever contain your own system message.

It's on by default whenever tools are on. `--date` or `/set date` turns it on without tools (it also helps with questions like "how long ago was X"); `--no-date` or `/set nodate` turns it off. Under `--api openai`, sending the system message can replace a system prompt the server would otherwise apply by default.

### `/show`

`/show info`, `/show license`, `/show modelfile`, `/show parameters`, `/show system`, and `/show template` all query the current model via `/api/show` and print the relevant field.

### `/save {name}`

Matches the `/save` command in the native `ollama run` interactive terminal: it calls the Ollama `/api/create` endpoint with the current model as `from`, any system prompt as `system`, and the conversation history as `messages`, producing a new model that "remembers" this session's context. Run it mid-chat:

```
You: /save my-custom-model
✅ Saved session as model 'my-custom-model'
```

You can then start a new chat against it (`node thinai.js my-custom-model` or `ollama run my-custom-model`), and it will carry the saved conversation as its initial context. `/load <model>` does the same thing without leaving the current process — it switches models in place and restores whatever session that model has saved.

### Conversation memory

Each turn is sent via Ollama's `/api/chat` endpoint with the full message history (not just the latest prompt), so the model actually remembers earlier turns in the conversation — matching how native `ollama run` behaves.

## Multi-line input and RP-style formatting

Useful for role-play-style chats:

- **Pseudo-markdown**: text wrapped in `*single asterisks*` is treated as narration and rendered dimmer than dialogue. Each speaker gets its own color so turns are easy to tell apart at a glance: your messages are yellow (bright for dialogue, dim for `*narration*`), and the assistant's are green (same bright/dim split). Asterisks are stripped from the display; the raw text (asterisks included) is still what's stored in history and sent to the model. A `*` at the start of a line with no closing `*` on that same line is treated as a markdown list bullet instead (rendered as `•`), not narration.
- **Multi-line messages**: press **Ctrl+J** to insert a new line without sending the message; plain **Enter** sends it. (Shift+Enter is also detected if your terminal happens to send a distinguishable sequence for it, but most terminals — including the macOS Terminal.app/iTerm2 defaults — don't, so Ctrl+J is the reliable option.)
- This is a minimal line editor: no arrow-key cursor movement or history recall mid-line, only typing and backspace-from-the-end. Pasting multi-line text may submit early at each line break rather than pasting the whole block.
- **Word wrap**: streamed responses and redisplayed history wrap on word boundaries at your terminal width, instead of hard-wrapping mid-word. This doesn't apply to your own live input line, which your terminal wraps natively as you type.

### Customizing colors

Override any of the four colors on the command line:

| Flag | Default | Meaning |
|------|---------|---------|
| `--user-normal-color` | `226` (bright yellow) | Your dialogue |
| `--user-emphasis-color` | `136` (dim yellow) | Your `*narration*` |
| `--model-normal-color` | `83` (bright green) | Model dialogue |
| `--model-emphasis-color` | `28` (dim green) | Model `*narration*` |

Each accepts a hex code (`#RRGGBB`), a 256-color palette index (`0`-`255`), or a basic name (`red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `black`, a `bright`-prefixed variant like `brightgreen`, or `gray`/`grey`):

```bash
thinai.js llama2 --user-normal-color cyan --model-normal-color "#ff8800"
```

Colors are only applied on a real terminal; the flags are silently ignored when output is redirected to a file or pipe.

## Examples

### Quick chat session
```bash
$ ./thinai.js llama2
🚀 Ollama Interactive Chat
📦 Model: llama2
⏱️  Keep-alive: 1h
🌐 Host: http://localhost:11434

==================================================

You: What is machine learning?
Machine learning is a subset of artificial intelligence...

You: Tell me more about neural networks
Neural networks are inspired by biological neurons...

You: /exit
👋 Goodbye!
```

### Extended session
```bash
# Keep a large model loaded for 3 hours of work
node thinai.js mistral --keep-alive 3h
```

### Remote connection
```bash
# Chat with Ollama running on another machine
./thinai.js neural-chat --host http://192.168.1.50:11434
```

## Ollama account: cloud models and hosted search

A free [ollama.com](https://ollama.com) account gives you an API key with usage-limited access to cloud models (e.g. `gemma4:31b`) and to Ollama's web search and fetch APIs. thinai reads the key from the `OLLAMA_API_KEY` environment variable. Rather than putting the key in a plain-text file, you can keep it in the macOS Keychain and load it from `~/.zshrc`:

```bash
security add-generic-password -a "$USER" -s OLLAMA_API_KEY -w   # prompts for the key
echo 'export OLLAMA_API_KEY="$(security find-generic-password -a "$USER" -s OLLAMA_API_KEY -w 2>/dev/null)"' >> ~/.zshrc
```

**Cloud models:** point `--host` at ollama.com. `/list`, `/show`, and tool calling work the same as with a local server:

```bash
./thinai.js gemma4:31b --host https://ollama.com --tools
```

The key is only ever sent to `https://ollama.com`, never to other `--host` servers (a local or LAN Ollama, or an `--api openai` server).

**Hosted search:** when the key is set, `web_search` and `fetch_page` use Ollama's `/api/web_search` and `/api/web_fetch` — whichever model you're chatting with, local or cloud. The hosted search returns the text of each result page rather than a snippet, which makes a big difference for small models: they rarely think to call `fetch_page` after searching, but with the text included they don't need to. In testing, local `llama3.1:8b` went from listing news sites' names (or inventing headlines) to summarizing that day's actual stories. Each result's text is tidied (share buttons and menus removed) and cut to 1,500 characters, 5 results per search. Differences from the DuckDuckGo path:

- There's no date filter, so `web_search`'s `recency` argument isn't offered. Hosted search returned current news without one.
- Searches and fetches count against your account's usage limits, and your queries and the URLs the model reads go to Ollama.
- The hosted fetch runs on Ollama's servers, so it can't reach your machine or local network.

If a hosted call fails — a usage limit, an outage, or an occasional page Ollama can't fetch — thinai prints a `⚠️` note and falls back to DuckDuckGo or the local fetcher for that call. To use DuckDuckGo only, unset the key for that run: `OLLAMA_API_KEY= ./thinai.js ...`.

## OpenAI-compatible servers

Pass `--api openai` to talk to an OpenAI-compatible server (vLLM, llama.cpp's `server`, LM Studio, etc.) instead of Ollama:

```bash
./thinai.js my-model --api openai --host http://localhost:8000
```

`--host` should be the server's base URL (no `/v1` suffix); requests go to `/v1/chat/completions` and `/v1/models`. Streaming, history, thinking-output display (via a de facto `reasoning_content` delta some servers emit for reasoning models — there's no standard field for it), and `/set parameter`/`/set format json`/`/set verbose` all still work, with sampling parameters passed through as top-level OpenAI-style fields.

Several commands are Ollama-specific and have no OpenAI API equivalent, so they're disabled or degraded under `--api openai`:

- `/save` and `/show info|license|modelfile|parameters|template` — no equivalent to `/api/create`/`/api/show`; these print an error. `/show system` still works (it just echoes the session's own system message).
- `/load <model>` — switches the active model name and starts a fresh session, but can't restore saved context (nothing to fetch it from).
- `--keep-alive`/`-x`/`--stop-on-exit` — no equivalent concept; `--stop-on-exit` is a no-op.
- `/set verbose` stats — only shows token counts (from the `usage` field, if the server returns one), not timing, since OpenAI's API doesn't report duration breakdowns.

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

## Source

The full source code is in `thinai.js`. It's a single-file tool with minimal dependencies—just copy it wherever you work.
