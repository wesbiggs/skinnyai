# Configuration

Defaults live in `~/.skinny/config.json` (or `$SKINNY_HOME/config.json`) so you don't have to repeat flags. The file holds named **profiles**; each has an `env` block of settings and, optionally, `mcpServers` (see [MCP servers](tools.md#mcp-servers)). [`config.json.example`](../config.json.example) is a starter with a profile for each supported API: copy it to `~/.skinny/config.json` and edit.

```json
{
  "defaultProfile": "Local",
  "profiles": {
    "Local": {
      "env": { "SKINNY_MODEL": "gemma4:31b", "SKINNY_TOOLS": true, "SKINNY_AUTOSAVE": true }
    },
    "My Profile": {
      "env": { "SKINNY_HOST": "https://ollama.com", "SKINNY_MODEL": "gpt-oss:120b-cloud", "OLLAMA_API_KEY": "..." }
    }
  }
}
```

The top-level `"defaultProfile"` names the profile used unless you pick another with `--profile "My Profile"` or `SKINNY_PROFILE="My Profile"` (names are matched ignoring case), or switch during a chat with `/set profile "My Profile"` (`/set profile` alone lists them). Without a `"defaultProfile"`, the first profile is used.

The file may hold API keys, so keep it readable only by you (`chmod 600`).

## `shared` and `startupEnv`

Two more top-level blocks keep profiles short:

- **`shared`** has the same shape as a profile (`env`, `mcpServers`) and is what every profile starts from; a profile only needs what differs. Put things like `SKINNY_TOOLS`, `SKINNY_MARKDOWN`, and `SKINNY_AUTOSAVE` there. A same-named MCP server in a profile replaces the shared one (`"disabled": true` turns one off).
- **`startupEnv`** is a flat block of settings that apply once, as skinnyai starts, and that `/set profile` never changes: `NODE_EXTRA_CA_CERTS` (a path to a PEM file, for a server behind a private CA such as Caddy's local one; skinnyai adds it to the trusted certificates, and MCP servers it launches inherit the variable), `SKINNY_TRUSTED_HOSTS`, `SKINNY_IMAGE_DIR`, and the four `SKINNY_*_COLOR` variables.

```json
{
  "defaultProfile": "Local",
  "startupEnv": { "NODE_EXTRA_CA_CERTS": "/Users/me/caddy-root.pem", "SKINNY_MODEL_NORMAL_COLOR": "120" },
  "shared": { "env": { "SKINNY_TOOLS": true, "SKINNY_AUTOSAVE": true } },
  "profiles": { "Local": { "env": { "SKINNY_MODEL": "gemma4:31b" } } }
}
```

## Precedence and variables

Highest first: the command line, your shell's environment, the profile, `shared`. `/show settings` shows the active profile. Each variable maps to a flag:

| Variable | Flag |
|----------|------|
| `SKINNY_MODEL` | model argument / `--model` (`-m`) |
| `SKINNY_HOST` | `--host` (`-h`) |
| `SKINNY_API` | `--api` |
| `SKINNY_KEEP_ALIVE` | `--keep-alive` (`-k`) |
| `SKINNY_TOOLS` | `--tools` / `--no-tools` |
| `SKINNY_DATE` | `--date` / `--no-date` |
| `SKINNY_MARKDOWN` | `--markdown` / `--no-markdown` |
| `SKINNY_IMAGES` | `--images` / `--no-images` |
| `SKINNY_AUTOSAVE` | `--autosave` / `--no-autosave` (on by default in a terminal) |
| `SKINNY_HIDE_THINKING` | `--hide-thinking` / `--show-thinking` |
| `SKINNY_STOP_ON_EXIT` | `--stop-on-exit` (`-x`) / `--no-stop-on-exit` |
| `SKINNY_MCP` | `--mcp` / `--no-mcp` |
| `SKINNY_DEBUG` | `--debug` / `--no-debug` |
| `SKINNY_PROFILE` | `--profile` |
| `SKINNY_USER_NORMAL_COLOR`, `SKINNY_USER_ITALIC_COLOR`, `SKINNY_MODEL_NORMAL_COLOR`, `SKINNY_MODEL_ITALIC_COLOR` | the `--*-color` flags ([colors](display.md#colors)) |

`SKINNY_HOME` moves the whole `~/.skinny` directory. Besides `config.json`, it holds `sessions/`, `device` (this installation's id and a name you can edit), and, with [sync](sync.md) on, `sync.json` and possibly `project-keys`. `SKINNY_PROJECT_KEYS` and `SKINNY_KEY_STORE` are described there. API keys (`OLLAMA_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) are read from the environment or a profile's `env`.

On/off values can be JSON `true`/`false` or the strings `true`/`false`, `yes`/`no`, `on`/`off`, `1`/`0`. Variables already set in your environment take precedence over the file, and command-line flags take precedence over both; that's what the `--no-…` forms are for. Settings that only make sense at launch (`NODE_EXTRA_CA_CERTS`, colors, `SKINNY_TRUSTED_HOSTS`, `SKINNY_IMAGE_DIR`) go in `startupEnv`.

## Keep-alive

On a self-hosted Ollama, `--keep-alive` sets how long the model stays loaded after each request (default `1h`). Use `30s`, `5m`, `1h`, `24h`, or any other Go duration. It's sent per request, so it affects only this session, not other apps using the same server.

By default the model stays loaded for that duration after you quit, same as `ollama run`. Pass `-x`/`--stop-on-exit` to unload it immediately when the session ends (like `ollama stop <model>`). This fires on `/exit`, `/bye`, Ctrl+D, and Ctrl+C, and is best-effort: if the unload request fails, it's reported but doesn't block exit.

Keep-alive and unloading only exist on a self-hosted Ollama, so they aren't shown (and `--stop-on-exit` does nothing) with `--api openai`, `--api anthropic`, or `--host https://ollama.com`.
