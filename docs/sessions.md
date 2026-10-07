# Sessions

Each turn is sent with the full message history (not just the latest prompt), so the model remembers earlier turns, matching native `ollama run`.

## `/save [name]`

`/save` writes the session (model, API, host, system message, parameters, and conversation) to `~/.skinny/sessions/<name>.Modelfile` (`SKINNY_HOME` changes the directory). It works the same with every server: a local or cloud Ollama, OpenAI-compatible, or Anthropic.

```
> /save trip-planning
✅ Saved session 'trip-planning' to /Users/you/.skinny/sessions/trip-planning.Modelfile
   Resume it with /load trip-planning, or start with: skinnyai trip-planning
```

- `/save` with no name saves under the session's current name (the one it was last saved or loaded as) or, for a session that hasn't been saved yet, a new name from the date and time, like `chat-2026-09-30-154907`.
- `/save <new name>` is "save as": it writes a new file and leaves the old one as it was, and from then on `/save` (and autosave) update the new name. The exception is a session that still has a date-and-time name (from autosave or a bare `/save`): that file is renamed instead, so naming a session doesn't leave a stray copy behind.
- If the name belongs to a different saved session, `/save` asks before overwriting it (`[y/N]`).
- `/load <name>` or `skinnyai <name>` resumes a saved session: it switches to the session's `FROM` model (not the session's name), API, and host, and restores its system message, parameters, and conversation. A saved session takes precedence over a server model with the same name, and `/list` shows saved sessions below the server's models. Names may contain spaces.
- If another chat saves to the same session file after you last did, the next save (or autosave) notices and asks whether to reload their version, save yours under a new name, overwrite it, or skip.

The file uses Ollama's Modelfile format (`FROM`, `PARAMETER`, `SYSTEM`, and `MESSAGE` lines), so it's readable. The host, API, and other session settings are recorded as `#` comments, which Ollama ignores and `/load` restores. You can turn a session into a model with `ollama create <name> -f <file>`. Tool calls and their raw results aren't saved (the format has no place for them), but the answers the model gave from them are. Images and PDFs aren't saved either, only their text.

## `/share [name]`

`/share` is what `/save` does in `ollama run`: it creates a model on the Ollama server (via `/api/create`) from the current model, system message, parameters, and conversation, so `ollama run <name>` resumes the session from anywhere that uses the server. It defaults to the session's current name and asks before replacing an existing model. Only a self-hosted Ollama server supports it; with ollama.com or another API, `/share` says so and points you to `/save`.

## Autosave

With `--autosave` (or `/set autosave`, or `SKINNY_AUTOSAVE=true`), the session is saved after every reply, so nothing is lost if you close the terminal. It saves under the session's current name or, if it hasn't been saved yet, a date-and-time name. `/save <name>` renames that file and autosave carries on under the new name. Resuming a saved session with autosave on keeps updating that session's file, and `/clear` starts a new file for the new conversation.
