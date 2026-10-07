# Tools: web search, MCP, and the date

The model is offered two built-in tools by default. `--no-tools`, `SKINNY_TOOLS=false`, or `/set notools` turns them off; `/set tools` turns them back on.

- `web_search` searches the web and returns result titles and URLs with the start of each page's text (or, without an Ollama key, a short instant answer).
- `fetch_page` fetches a URL and returns the page's readable text, so the model can read a result instead of guessing from its snippet.

When the model calls a tool, skinnyai runs it, shows a dimmed line like `🔧 searching: "..."` or `🔧 fetching: <url>`, sends the result back, and streams the final answer. A reply can involve several tool calls; after 5 rounds, the model is asked to answer without tools. Tool calls and results stay in the conversation history, so follow-ups can refer to them.

This needs a model with the `tools` capability (check with `/show info`), such as `llama3.1`, `llama3.2`, `qwen3`, or `mistral-nemo`. Models without it make Ollama return an error; use `/set notools`. Small local models rarely chain the tools: in testing, `llama3.2:3b` never called `fetch_page`, and `llama3.1:8b` fetched a URL it was given but never read a page after its own search. Hosted search sidesteps this by returning page text with each result; larger models like `gemma4:31b` use the tools well either way. Tools work the same under `--api openai` (for servers that support OpenAI-style `tools`) and `--api anthropic`.

## Web search

Full web search uses Ollama's hosted API and needs an `OLLAMA_API_KEY` ([below](#hosted-search-with-an-ollama-account)). Without one, `web_search` falls back to DuckDuckGo's official Instant Answer API, which returns short encyclopedia-style summaries and direct answers, not web results, so many queries come back empty (the model is told so). skinnyai sends `t=skinnyai`, identifies itself in the User-Agent, and shows DuckDuckGo and the source with each answer, per the API's terms. Those terms limit it to non-commercial use unless DuckDuckGo approves otherwise.

skinnyai does not scrape any search engine's result pages.

## `fetch_page`

It extracts readable text from HTML: it drops scripts, styles, navigation, and footers, prefers `<main>` or `<article>`, removes long runs of menu-like links, and keeps headings and list items as lines. Plain text, JSON, and XML are returned as-is; other types (images, PDFs, ...) are refused. Pages that build their content with JavaScript come back mostly empty.

Only the first 6,000 characters (about 1,500 tokens) go to the model, with a note that it was truncated. Ollama's default context window is small, so if long conversations with several fetched pages lose earlier context, raise it with `/set parameter num_ctx 16384` (or whatever your memory allows).

Pages can contain text aimed at the model ("ignore your instructions and…"), and the model can't reliably tell that apart from yours. So `fetch_page` refuses URLs that point at this machine or the local network: `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, link-local and cloud-metadata addresses (`169.254.0.0/16`), carrier-grade NAT, and their IPv6 equivalents, checking the resolved address of every redirect too. Otherwise a malicious page could get the model to read your router's admin page or your Ollama server and send the contents to an attacker's URL. The check doesn't stop DNS rebinding, and nothing can stop a page from misleading the model about its content, so treat answers built from fetched pages with the same skepticism as the pages.

## Hosted search with an Ollama account

A free [ollama.com](https://ollama.com) account gives you an API key (`OLLAMA_API_KEY`) with usage-limited access to cloud models ([apis](apis.md#ollama-cloud)) and to Ollama's web search and fetch APIs. When the key is set, `web_search` and `fetch_page` use `/api/web_search` and `/api/web_fetch`, whichever model you're chatting with. Hosted search returns the text of each result page rather than a snippet, which matters for small models: in testing, local `llama3.1:8b` went from listing news sites' names (or inventing headlines) to summarizing that day's actual stories. Each result's text is tidied and cut to 1,500 characters, 5 results per search. A few notes:

- Searches and fetches count against your account's usage limits, and your queries and the URLs the model reads go to Ollama.
- The hosted fetch runs on Ollama's servers, so it can't reach your machine or local network.

If a hosted call fails (a usage limit, an outage, a page Ollama can't fetch), skinnyai prints a `⚠️` note and falls back to Instant Answers or the local fetcher for that call. The key is independent of the model and API: it works with local Ollama models, OpenAI-compatible servers, and Anthropic, and is only ever sent to ollama.com. To turn hosted search off for a run, unset the key: `OLLAMA_API_KEY= skinnyai ...`.

## MCP servers

skinnyai reads each server from the `mcpServers` block of the active profile in `~/.skinny/config.json`. The entries use the format Claude Desktop, Claude Code, and Cursor share, and each server's tools are offered to the model with any `--api`, alongside the built-in web tools:

```json
{
  "defaultProfile": "Main",
  "profiles": {
    "Main": {
      "mcpServers": {
        "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/notes"] },
        "docs":  { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }, "trust": true }
      }
    }
  }
}
```

- `command`/`args`/`env`/`cwd` start a local server over stdio; `url`/`headers` connect to a remote one over streamable HTTP. `${VAR}` expands from the environment. `"disabled": true` skips an entry. Only the user-level config is read.
- Tools appear as `server__tool`. Each call asks `Allow this tool call? [y/N/a(lways)]` first, because a web page the model read could try to steer it. Answering `a` trusts that tool from then on by adding it to its server's `"trust": ["tool", …]` list (the file is rewritten and pretty-printed, so custom formatting is lost); `"trust": true` trusts every tool on a server.
- A tool can return images (MCP `image` content), relayed to the model as returned: image blocks inside the tool result for Anthropic, `image_url` parts (a `data:` URL) in the tool message's content array for OpenAI-style servers, and `data:` URLs in the text for Ollama (whose tool messages are plain text). skinnyai doesn't draw them itself; a model that answers with `![alt](data:image/png;base64,…)` (or a file path) gets the image drawn when [images are on](display.md#inline-images). A large image is a lot of text for the model and is re-sent with every later turn.
- `/mcp` lists what's connected. A server that fails to start is reported and skipped. `--no-mcp` (or `SKINNY_MCP=false`) starts none. Only tools are supported: no resources, prompts, sampling, SSE transport, or OAuth.

## Today's date

Models only know their training cutoff and often assume it's still that date, so a search for "today's headlines" comes back years out of date. skinnyai tells the model the current date (e.g. `Today's date is Tuesday, September 29, 2026.`) at the start of the system message and in the `web_search` tool description. The date is added to each outgoing request, not stored in the conversation, so it's always current and `/save` and `/show system` contain only your own system message.

It's on by default whenever tools are on. `--date` or `/set date` turns it on without tools (it helps with "how long ago was X"); `--no-date` or `/set nodate` turns it off. Under `--api openai`, sending a system message can replace a system prompt the server would otherwise apply by default.
