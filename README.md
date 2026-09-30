# thinai: Thin Client for Ollama/OpenAI Interactive Chat

A terminal-based Node.js chat interface for Ollama and OpenAI-compatible endpoints with session-specific model keep-alive control.

## Features

- ✅ Interactive chat with streaming responses
- ✅ Session-specific `keep_alive` parameter (doesn't affect other apps)
- ✅ Configurable model, keep-alive duration, and host
- ✅ Full `ollama run` command parity (`/set`, `/show`, `/load`, `/save`, `/clear`, `/bye`, `/?`, `/list`, ...)
- ✅ Conversation history that's actually sent back to the model each turn (via `/api/chat`)
- ✅ `--api openai` mode for OpenAI-compatible servers (vLLM, llama.cpp server, LM Studio, ...) — see [OpenAI-compatible servers](#openai-compatible-servers)
- ✅ Opt-in tool calling with a built-in DuckDuckGo `web_search` tool — see [Tool calling and web search](#tool-calling-and-web-search)
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
| `/set tools` / `/set notools` | Let the model call tools (`web_search`), or disable |

`/set history`, `/set nohistory`, `/set wordwrap`, and `/set nowordwrap` are recognized but don't apply here — this client has no line-history recall and lets your terminal handle wrapping natively, so it prints a note instead of pretending to toggle something.

### Thinking output

For models with a `thinking` capability (check with `/show info`), reasoning is streamed as it's produced, wrapped in `Thinking...` / `...done thinking.` markers and dimmed, the same way `ollama run` displays it — then the final answer streams normally below it. It's on by default; pass `--hide-thinking` on the command line, or run `/set hidethinking` mid-session, to suppress it and only show the final answer. (Thinking is only requested from the model at all if `think` is enabled via `/set think`, per the model's default.)

If generation runs out of its token/context budget while the model is still mid-thought, Ollama reports `done_reason: "length"` and stops — the reasoning text you see really is cut off mid-sentence, not a display bug. In that case a `⚠️  cut off - ran out of tokens while still thinking` warning prints instead of `...done thinking.`; raise the budget with `/set parameter num_predict <n>` (or `num_ctx` if the prompt itself is long) and try again.

### Tool calling and web search

Pass `--tools` (or run `/set tools` mid-session) to offer the model a `web_search` tool:

```bash
./thinai.js qwen3 --tools
```

When the model decides to search, thinai runs the query itself, shows a dimmed `🔧 searching: "..."` line, sends the results back to the model, and streams its final answer. A single reply can involve several searches; after 5 rounds of tool calls, the model is asked to answer without tools. Tool calls and results are kept in the conversation history, so follow-up questions can refer to them.

This needs a model with the `tools` capability (check with `/show info`) — e.g. `llama3.1`, `llama3.2`, `qwen3`, `mistral-nemo`. Models without it make Ollama return an error; turn tools back off with `/set notools`. Small models like `llama3.2:3b` do call the tool, but they're unreliable at using the results well; 8B+ models do noticeably better. It works the same way under `--api openai`, for servers that support OpenAI-style `tools`.

Search is done by DuckDuckGo, with no API key:

1. The official [Instant Answer API](https://api.duckduckgo.com/api) is tried first. It returns encyclopedia-style summaries and direct answers, not web results, so many queries come back empty.
2. Otherwise, thinai falls back to scraping `html.duckduckgo.com` for the top 8 results (title, URL, snippet). That endpoint is unofficial: it can break if DuckDuckGo changes its markup, and rapid or heavy use gets blocked as automated traffic. When that happens, the model is told the search failed.

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
