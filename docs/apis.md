# Servers and APIs

`--api` picks the protocol: `ollama` (default), `openai`, or `anthropic`. `--model default` (or `SKINNY_MODEL=default`) looks up `/v1/models` at startup and picks the newest plain `gpt-N` for OpenAI or the newest Opus for Anthropic.

## Ollama

The default: `http://localhost:11434`. Each turn goes to `/api/chat` with the full history and, on a self-hosted server, `"keep_alive"` set from `--keep-alive` (default `1h`). Because keep-alive is per request, only this model is held in memory for that long and other apps keep the server's usual timeout; each turn resets the timer. See [keep-alive](configuration.md#keep-alive).

```bash
skinnyai llama2 --keep-alive 30m --host http://192.168.1.100:11434
```

### Ollama cloud

Point `--host` at ollama.com with an `OLLAMA_API_KEY` ([where to get one](tools.md#hosted-search-with-an-ollama-account)). `/list`, `/show`, and tool calling work as with a local server; `/save` and `/load` use local files as always, but `/share` isn't available:

```bash
skinnyai gemma4:31b --host https://ollama.com
```

The key is only ever sent to `https://ollama.com`, never to other `--host` servers. Rather than putting it in a plain-text file, you can keep it in the macOS Keychain and load it from `~/.zshrc`:

```bash
security add-generic-password -a "$USER" -s OLLAMA_API_KEY -w   # prompts for the key
echo 'export OLLAMA_API_KEY="$(security find-generic-password -a "$USER" -s OLLAMA_API_KEY -w 2>/dev/null)"' >> ~/.zshrc
```

## OpenAI-compatible servers

`--api openai` talks to vLLM, llama.cpp's `server`, LM Studio, or OpenAI itself. `--host` is the server's base URL with no `/v1` suffix; requests go to `/v1/chat/completions` and `/v1/models`:

```bash
skinnyai my-model --api openai --host http://localhost:8000
```

There's no default host: a stray `OPENAI_API_KEY` must never silently redirect your prompts to OpenAI, so for OpenAI itself pass `--host https://api.openai.com`. `OPENAI_API_KEY`, if set, is sent as a Bearer token to whatever `--host` is.

Streaming, history, thinking display (via the de facto `reasoning_content` delta some servers emit; there's no standard field), and `/set parameter`/`format json`/`verbose` all work, with sampling parameters passed as top-level OpenAI-style fields. Ollama-specific features are disabled or degraded:

- `/share`: no equivalent to `/api/create`; use `/save`.
- `/show info|license|modelfile|parameters|template`: no equivalent to `/api/show`, so these print an error. `/show system` and `/show settings` still work.
- `/load <name>` restores a saved session by that name; otherwise it switches the model name and starts a fresh session.
- `--keep-alive`/`--stop-on-exit`: no such concept (`--stop-on-exit` is a no-op).
- `/set verbose` shows token counts only (from `usage`, if the server returns it), not timing.

## Anthropic

`--api anthropic` talks to Claude through the Messages API (default host `https://api.anthropic.com`). Set `ANTHROPIC_API_KEY` in the environment or a profile:

```bash
ANTHROPIC_API_KEY=sk-ant-... skinnyai claude-sonnet-5-5 --api anthropic
```

Streaming, history, images, PDFs, `/set system`, tools (web search and MCP), and `/list` (from `/v1/models`) work. `/set think [low|medium|high|xhigh|max]` turns on adaptive thinking at that effort level; `nothink` just stops sending the field, since newer models can't have thinking switched off. `/set parameter temperature|top_p|top_k|stop|max_tokens` are passed through (`num_predict` also sets `max_tokens`; the default is 16000). Prompt caching isn't used. Like `--api openai`, it has no `/share`, `/show info`, or keep-alive.

Anthropic support has only been tested against the project's mock server, not a live key.
