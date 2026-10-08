# Commands

The command set mirrors the native `ollama run` terminal, plus a few extras.

| Command | Description |
|---------|-------------|
| `/set` | Set session variables (below) |
| `/show` | Show model or session information (below) |
| `/load` | With no name, shows the same list as `/list` |
| `/load <name>` | Restore a saved session, or switch to a different model (restoring its saved session/system message if any) |
| `/save [name]` | Save the session to a local file ([sessions](sessions.md)) |
| `/share [name]` | Save the session as a model on a self-hosted Ollama server |
| `/clear` | Clear conversation history (keeps the system message, if one is set) |
| `/list` | List available models, then saved sessions |
| `/saveimage [path]` | Save the latest image in the conversation (a `data:` URL in a reply, or an image a tool returned). No path means `~/Pictures/skinnyai/` (or `SKINNY_IMAGE_DIR`) under a date-and-time name; a folder gets that name too |
| `/attach <file>` | Send a file with your next message ([attaching files](display.md#attaching-files)) |
| `/mcp` | Show connected MCP servers and their tools |
| `/model` | Show current model, keep-alive, and host (a bonus command) |
| `/bye`, `/exit` | Exit |
| `/?`, `/help` | Help for a command (`/? set`, `/? show`, `/? shortcuts`) |

## `/set`

| Command | Description |
|---------|-------------|
| `/set system <text>` | Set the system prompt for the rest of the session |
| `/set parameter <name> <value...>` | Override a model parameter, e.g. `/set parameter temperature 0.9` |
| `/set format json` / `/set noformat` | Force JSON-formatted responses, or disable (also asked for in the system message, since not every server honors the format field) |
| `/set verbose` / `/set quiet` | Show/hide token-count and timing stats after each response |
| `/set profile [name] [--new]` | List the profiles in `config.json`, or switch to one: its server, model, and settings replace the current ones and MCP servers restart. The conversation carries over, adapted to the new model ([below](#switching-models-mid-conversation)); `--new` starts a fresh one instead (the system message stays). Command-line flags applied only to the launch |
| `/set model <name>` | Switch to another model on the current server, keeping the conversation and parameters |
| `/set think [level]` / `/set nothink` | Enable/disable extended thinking, for models that support it |
| `/set showthinking` / `/set hidethinking` | Show/hide a thinking model's reasoning as it streams |
| `/set tools` / `/set notools` | Let the model call tools ([tools](tools.md)), or disable |
| `/set date` / `/set nodate` | Tell the model today's date, or don't (default: only when tools are on) |
| `/set markdown` / `/set nomarkdown` | Render markdown, or show raw text |
| `/set images` / `/set noimages` | Draw inline images ([display](display.md#inline-images)) |
| `/set autosave` / `/set noautosave` | Save after every reply ([sessions](sessions.md#autosave)) |
| `/set debug` / `/set nodebug` | Start or stop writing the [debug log](troubleshooting.md#debug-log) |

`/set history`, `/set nohistory`, `/set wordwrap`, and `/set nowordwrap` are recognized but don't apply here (this client lets your terminal handle wrapping, and recalls earlier messages with Up/Down), so a note is printed instead.

## `/show`

`/show info`, `license`, `modelfile`, `parameters`, `system`, and `template` query the current model via `/api/show` and print the relevant field.

`/show settings` (not in `ollama run`) lists this session's own state instead, in two groups: what can be changed during the session (model, system message, parameters, format, think, thinking display, verbose, tools, date, markdown, images, autosave, profile) and what is fixed for it (API, host, keep-alive, stop-on-exit, extra CA file, defaults file). It works with every `--api`, since it doesn't ask the server.

## Thinking output

For models with a `thinking` capability (check with `/show info`), reasoning is streamed as it's produced, wrapped in `Thinking...` / `...done thinking.` markers and dimmed, as `ollama run` does, and then the answer streams below it. It's shown by default; `--hide-thinking` or `/set hidethinking` suppresses it. Thinking is only requested from the model if `think` is enabled via `/set think`, per the model's default.

If generation runs out of its token/context budget mid-thought, Ollama reports `done_reason: "length"` and stops, so the reasoning really is cut off mid-sentence. A `⚠️  cut off - ran out of tokens while still thinking` warning prints instead of `...done thinking.`; raise the budget with `/set parameter num_predict <n>` (or `num_ctx` if the prompt is long) and try again.

## Switching models mid-conversation

`/set profile` and `/set model` keep the conversation, so you can start with one model (say Claude) and continue with another (a local Ollama model) or compare answers on the same history. The history is stored in a provider-neutral form and shaped for each model when a request is sent; your stored copy is never rewritten. After a switch, skinnyai says how much came along and what the new model won't get as it was:

- **Tool calls** stay structured when the new model is offered the same tools; otherwise each call and its result become a line of text in the assistant's message. Results without a matching call are dropped.
- **Thinking blocks** are kept in the history but replayed only to the model that wrote them.
- **Attachments:** PDFs aren't sent to Ollama, and images aren't sent to a model known to lack vision (an image on the message you're sending is still sent, with a warning).
- **Context window:** on Ollama, if you've set `num_ctx`, the oldest whole turns are left out to fit it. Elsewhere the server decides what to do with a long conversation. The estimate is about four characters per token.
