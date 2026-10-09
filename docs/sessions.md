# Sessions

Each turn is sent with the full message history (not just the latest prompt), so the model remembers earlier turns, matching native `ollama run`. A saved session is a file you own, and the conversation in it can be continued with any model: see [switching models](commands.md#switching-models-mid-conversation).

## Saved chats

A chat is saved as one SQLite file, `~/.skinny/sessions/<name>.skinny` (`SKINNY_HOME` changes the directory). It works the same with every server: a local or cloud Ollama, OpenAI-compatible, or Anthropic. The file holds:

- the model, API, host, system message, parameters, and the settings that came with the session;
- every message, with the API and model that wrote each reply, each with an id and the id of the message it follows;
- tool calls and their results, thinking blocks, and attached images and PDFs (stored once each, as bytes).

Because it holds the whole conversation, a chat can move to another model without losing its tool calls, and old attachments are still there.

A chat file is an append-only log: each save adds a *commit* (the new messages, and any change to the model, system message, parameters, or settings) that records which device wrote it, a counter, and the commits it follows. The device is identified by `~/.skinny/device`, which holds a generated id and a name you can edit (it starts as the machine's name). This is what lets chats be [synced across devices](sync.md). If two writers ever add to the same message, the chat has two lines of conversation; the one with the latest activity is shown, and the other stays in the file. Nothing is encrypted yet, so treat these files like the conversations they contain: fetched page text and attachments are in them too. Names may contain any characters (they're URL-encoded into the filename, except spaces), and you can rename or move a file freely.

```
> /save trip-planning
✅ Saved session 'trip-planning' to /Users/you/.skinny/sessions/trip-planning.skinny
   Resume it with /load trip-planning, or start with: skinnyai trip-planning
```

- `/save` with no name saves under the session's current name (the one it was last saved or loaded as) or, for a session that hasn't been saved yet, a new name from the date and time, like `chat-2026-09-30-154907`.
- `/save <new name>` is "save as": it writes a new file and leaves the old one as it was, and from then on `/save` (and autosave) update the new name. The exception is a session that still has a date-and-time name (from autosave or a bare `/save`): that file is renamed instead, so naming a session doesn't leave a stray copy behind.
- If the name belongs to a different saved session, `/save` asks before overwriting it (`[y/N]`).
- `/load <name>` or `skinnyai <name>` resumes a saved session: it switches to the session's model (not the session's name), API, and host, and restores its system message, parameters, and conversation. A saved session takes precedence over a server model with the same name, and `/list` shows saved sessions below the server's models.
- If another chat saves to the same file after you last did, the next save (or autosave) notices and asks whether to reload their version, save yours under a new name, or skip. (There's no "overwrite": a chat file only grows.)

## Autosave

Autosave is **on by default in a terminal**: the session is saved after every reply, so nothing is lost if you close the window. After the first reply skinnyai asks the model, in one short extra request, for a title of at most six words, and names the file from it ("💾 Autosaving to 'Planning a Lisbon trip.skinny'"). If the model gives no usable title within a few seconds, or titles are off (`--no-titles`, `SKINNY_TITLES=false`), the file gets a date-and-time name like `chat-2026-09-30-154907`. The file is created at the first reply, and only new messages are appended after that. The title request counts as a small extra use of the model, on paid APIs too. Piped input and scripts don't autosave unless you ask. Turn it off with `--no-autosave`, `SKINNY_AUTOSAVE=false`, or `/set noautosave`, and on elsewhere with `--autosave` or `/set autosave`. `/save <name>` renames a file that autosave named (by title or by time) and autosave carries on under the new name.

## Starting over and cleaning up

- `/new [name]` starts a new conversation (the system message stays), optionally named. The old chat stays on disk under its name, and a name already in use isn't accepted.
- `/delete [name]` deletes a saved chat file (the current one by default) after asking. Deleting the current chat starts a new one. It never touches old-format Modelfiles.
- `/purge thinking|tools|blobs` shrinks the current chat and its file (the purge is recorded in the file's log): `thinking` drops saved thinking blocks, `tools` turns tool calls and results into text, and `blobs` removes attached images and PDFs and images in tool results, leaving a note where each was.

## Exporting and sharing

- `/export [path]` writes the conversation to a file. A `.md` path (the default, named after the session) gets a readable transcript, with tool calls as one line each and attachments as a note; thinking is left out. A `.Modelfile` path gets the text of the conversation in Ollama's Modelfile format (`FROM`, `PARAMETER`, `SYSTEM`, and `MESSAGE` lines, with the host, API, and other settings as `#` comments that Ollama ignores and `/load` restores), which `ollama create <name> -f <file>` turns into a model.
- `/share [name]` does that for you: it creates a model on a self-hosted Ollama server (via `/api/create`) from the current model, system message, parameters, and conversation text, so `ollama run <name>` resumes the session from anywhere that uses the server. It defaults to the session's current name and asks before replacing an existing model. With ollama.com or another API, `/share` says it isn't available and points you to `/save`. Tool calls, thinking, and attachments aren't part of a Modelfile.

## Sessions from earlier versions

Versions before 0.11 saved sessions as `<name>.Modelfile` text files. Those still load and show up in `/list`. The first time you save one, the chat is written as a `.skinny` file next to it and you're asked whether to delete the old Modelfile (the default is to keep it, as a point-in-time copy). `/delete` leaves Modelfiles alone.
