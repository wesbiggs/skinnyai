# Troubleshooting

## Connection refused
- Make sure the server is running (for Ollama: `ollama serve`).
- Check the host: `--host http://localhost:11434`.
- Verify it's listening: `curl http://localhost:11434/api/tags`.

## Model not found
- Check what's installed: `ollama list`, and pull it if needed: `ollama pull llama2`.

## Model unloads between requests
- Raise `--keep-alive` (e.g. `6h` instead of `1h`). This only applies to a self-hosted Ollama; see [keep-alive](configuration.md#keep-alive).
- Larger models (7B+) are worth keeping loaded for an hour or more to avoid reload time; on limited RAM use something short like `10m`.

## A model can't call tools
- Models without the `tools` capability make Ollama return an error. Use `--no-tools` or `/set notools`.

## Debug log

`--debug` (or `SKINNY_DEBUG=true`, or `/set debug`) writes `~/.skinny/debug.log`, one JSON object per line: each chat request (URL, model, messages, and `offeredTools`, the names of the tools sent), the response status, each tool call (name, whether it was one of the offered tools, arguments, result), and which MCP servers started with what tools. API keys aren't written, and encoded data (images, PDFs) is replaced by a size note. The file is readable only by you and grows until you delete it.
