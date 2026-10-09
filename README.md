# skinnyai: Get the Skinny, from a Thin Client for LLM Chat

[![CI](https://github.com/wesbiggs/skinnyai/actions/workflows/ci.yml/badge.svg)](https://github.com/wesbiggs/skinnyai/actions/workflows/ci.yml)

A thin terminal chat client for Ollama, OpenAI-compatible servers, and Anthropic, plus a small native macOS app that wraps it. Node 22.13+, no runtime dependencies (raw HTTPS, no SDKs).

## Features

- Streaming chat with the full history sent each turn, and `ollama run` command parity (`/set`, `/show`, `/load`, `/save`, `/bye`, `/?`, `/list`, ...), with `/new` in place of `/clear`
- Three APIs: Ollama (local or [cloud](docs/apis.md#ollama-cloud)), [OpenAI-compatible](docs/apis.md#openai-compatible-servers) servers, and [Anthropic](docs/apis.md#anthropic)
- Per-session `keep_alive` for a self-hosted Ollama, without changing the server's behavior for other apps
- [Web search and page fetching](docs/tools.md) on by default (full web search needs an Ollama API key; without one you get DuckDuckGo instant answers) and [MCP servers](docs/tools.md#mcp-servers) in the standard `mcpServers` format
- Drag in [images, PDFs, or text files](docs/display.md#attaching-files)
- [Markdown rendering](docs/display.md), inline images, thinking output, and multi-line input
- [Sessions](docs/sessions.md): every chat autosaves to one file you own (tool calls and attachments included), and continues with any model
- [Sync across devices](docs/sync.md) through any cloud folder, end-to-end encrypted, with projects that have a key each
- Named [profiles](docs/configuration.md) in `~/.skinny/config.json`

## Setup

You need **Node.js 22.13+** and a server, such as Ollama running on your system (check with `curl http://localhost:11434/api/tags`).

Download `skinnyai.js` from the latest [release](../../releases/latest) (one minified file, about 90 KB), or build it from a checkout:

```bash
npm install && npm run build   # writes bin/skinnyai.js
chmod +x bin/skinnyai.js
```

Optionally put it on your PATH:

```bash
ln -s $(pwd)/bin/skinnyai.js ~/.local/bin/skinnyai   # or cp, or `npm link`
```

## Usage

```bash
skinnyai llama2                                             # Ollama at http://localhost:11434
skinnyai llama2 --keep-alive 30m --host http://192.168.1.100:11434
skinnyai my-model --api openai --host http://localhost:8000
skinnyai claude-sonnet-5-5 --api anthropic                  # with ANTHROPIC_API_KEY set
skinnyai trip-planning                                      # resume a saved session
```

From a checkout, `npm run ollama -- llama2` and `npm run openai -- my-model --host ...` run the source directly (note the `--`).

| Flag | Meaning |
|------|---------|
| `-m`, `--model` | Model name, or `default` for OpenAI/Anthropic to pick the newest flagship |
| `--api` | `ollama` (default), `openai`, or `anthropic` |
| `-h`, `--host` | Server base URL |
| `-k`, `--keep-alive` | How long Ollama keeps the model loaded (`30s`, `5m`, `1h` default, ...) |
| `-x`, `--stop-on-exit` | Unload the model when the session ends |
| `--profile` | Config profile to use |
| `--no-tools`, `--no-mcp`, `--no-markdown`, `--hide-thinking` | Turn features off (each has a positive form) |
| `--autosave`, `--images`, `--debug` | Turn features on |

Every flag has a matching `SKINNY_*` environment variable or `config.json` setting; see [configuration](docs/configuration.md) for the full table, profiles, and precedence. Inside a chat, `/?` lists commands; the main ones:

| Command | Description |
|---------|-------------|
| `/set ...` | Change settings (system prompt, parameters, thinking, tools, profile, ...) |
| `/show ...` | Model info, or `/show settings` for this session's state |
| `/save [name]`, `/load <name>`, `/new`, `/export`, `/share` | [Sessions](docs/sessions.md) |
| `/attach <file>` | Send a file with your next message |
| `/list`, `/mcp`, `/exit` | Models and sessions, MCP servers, quit |

Enter sends; Ctrl+J or Shift+Enter adds a new line. See [commands](docs/commands.md) for everything else.

## Configuration

Put defaults in `~/.skinny/config.json` (or `$SKINNY_HOME/config.json`) as named profiles. [`config.json.example`](config.json.example) is a starter with a profile for each API:

```json
{
  "defaultProfile": "Local",
  "profiles": {
    "Local": { "env": { "SKINNY_MODEL": "gemma4:31b" } },
    "Cloud": { "env": { "SKINNY_HOST": "https://ollama.com", "SKINNY_MODEL": "gpt-oss:120b-cloud", "OLLAMA_API_KEY": "..." } }
  }
}
```

The file may hold API keys, so `chmod 600` it. [Configuration](docs/configuration.md) covers `shared` and `startupEnv` blocks, precedence, and keep-alive.

## macOS app

`npm run build:app` builds `dist/SkinnyAI.app`, a native shell with its own terminal windows, a profile picker, and a Settings window that edits `config.json`. Node is embedded, so nothing needs installing. Signing, notarizing, and the rest are in [docs/macos-app.md](docs/macos-app.md).

## More

- [Configuration](docs/configuration.md): profiles, environment variables, keep-alive
- [Commands](docs/commands.md): `/set`, `/show`, thinking output
- [Sessions](docs/sessions.md): saved chats, autosave, `/new`, `/export`, `/share`
- [Sync](docs/sync.md): the same chats on every device, end-to-end encrypted
- [Security](docs/security.md): what the encryption protects and what it doesn't
- [Tools](docs/tools.md): web search, `fetch_page`, MCP, hosted search, the date line
- [Servers and APIs](docs/apis.md): Ollama, Ollama cloud, OpenAI-compatible, Anthropic
- [Display, input, and attachments](docs/display.md): markdown, images, colors, shortcuts
- [macOS app](docs/macos-app.md)
- [Troubleshooting](docs/troubleshooting.md) and the debug log
- [Development](docs/development.md): source layout, tests, CI

## License

Apache-2.0. See [LICENSE](LICENSE); third-party notices for the bundled app are in [docs/macos-app.md](docs/macos-app.md#building).
