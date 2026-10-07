# Display, input, and attachments

## Markdown

Responses (and your own messages) are rendered as they stream, with no third-party library. `/set nomarkdown` (or `--no-markdown`) shows raw text instead; `/set markdown` turns rendering back on. When output is redirected to a file or pipe, text is always written raw, so it stays valid markdown.

- `**bold**`, `*italic*` / `_italic_`, `~~strikethrough~~`, and `` `inline code` `` use ANSI styles. Underscores inside words (`snake_case`) and a lone `*` surrounded by spaces (`5 * 3`) stay literal, and `\*` escapes a marker.
- `# Headings` are bold; `- ` / `* ` / `+ ` bullets become `•` (or `◦` when indented); numbered lists and bullets get a hanging indent so wrapped lines line up.
- `> quotes` get a `│` bar, `---` becomes a full-width rule, and fenced code blocks are shown in a code color on a dark grey bar spanning the window width, unwrapped so they copy cleanly.
- `[links](https://...)` become clickable [OSC 8 hyperlinks](https://gist.github.com/egmontkob/eb114294efbcd5adb1944c9f3cb5feda) in terminals that support them (iTerm2, WezTerm, kitty, GNOME Terminal, Windows Terminal, ...); elsewhere you see the link text.
- Tables are drawn with box-drawing borders, honoring `:---:` / `---:` alignment. Columns shrink to fit the terminal, wrapping cell text. Emoji are measured as the two columns terminals draw them in, so borders stay aligned. A table is drawn once complete; until then a `⋯ receiving table (N rows)` placeholder shows progress.
- Streamed responses and redisplayed history wrap on word boundaries at your terminal width. Your own live input line is wrapped natively by your terminal.

**RP-style narration:** `*single asterisks*` are italic *and* switch to a dimmer narration color, so role-play narration stays distinct from dialogue. Your messages are yellow (bright for dialogue, dim for narration) and the assistant's are green (same split). Markup is stripped from the display; the raw text is what's stored and sent.

### Inline images

`![images](https://...)` show as a clickable `🖼️ caption`. With `--images` (or `/set images`), terminals with an inline image protocol (iTerm2 and WezTerm, and kitty and Ghostty with PNG only) also draw the image below the line that mentions it, scaled to fit. Inside tmux or screen, which don't pass image sequences through, images stay links.

It's off by default because it downloads whatever image URL the model writes: a prompt injection (say, in a page `fetch_page` read) could smuggle conversation details out in that URL. Like `fetch_page`, it refuses local/private network addresses unless the host is listed in `SKINNY_TRUSTED_HOSTS` (a comma-separated list in the config's `startupEnv`, each entry covering its subdomains, e.g. `"SKINNY_TRUSTED_HOSTS": "mfluxible.test"`), and it caps the download size.

A local file works too (`![](/Users/me/pic.png)`, `~/pic.png`, or a `file://` URL, with `%20` for spaces). Nothing is fetched or sent for it, so that's how to see images a tool such as an image generator saved on your machine.

## Input

- **Multi-line messages:** **Ctrl+J** inserts a new line without sending; plain **Enter** sends. **Shift+Enter** does the same in terminals that implement the kitty keyboard protocol (kitty, Ghostty, WezTerm, iTerm2 3.5+); skinnyai asks for that mode while you type and restores it afterwards. Terminal.app can't tell Shift+Enter from Enter, so use Ctrl+J there.
- **Line editing:** Left/Right move the cursor (Ctrl/Alt+arrows or Alt+B/F by word), Home/End or Ctrl+A/E jump to the line's start/end, and Ctrl+W, Ctrl+U, and Ctrl+K delete the previous word, to the start, and to the end. Up/Down move between lines of a multi-line message and, past its first/last line, recall earlier messages from this session. `/? shortcuts` lists them all.
- **Pasting:** multi-line pastes are kept whole (bracketed paste) instead of sending at the first line break.

## Colors

Override any of the four colors with flags (or the matching `SKINNY_*_COLOR` variables in `startupEnv`):

| Flag | Default | Meaning |
|------|---------|---------|
| `--user-normal-color` | `226` (bright yellow) | Your dialogue |
| `--user-italic-color` | `136` (dim yellow) | Your `*italic*` / narration |
| `--model-normal-color` | `120` (bright green) | Model dialogue |
| `--model-italic-color` | `77` (medium green) | Model `*italic*` / narration |

(`--user-emphasis-color` and `--model-emphasis-color` are aliases for the italic flags.) Each accepts a hex code (`#RRGGBB`), a 256-color palette index (`0`-`255`), or a basic name (`red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `black`, a `bright`-prefixed variant like `brightgreen`, or `gray`/`grey`):

```bash
skinnyai llama2 --user-normal-color cyan --model-normal-color "#ff8800"
```

Colors are applied only on a real terminal; they're ignored when output is redirected.

## Attaching files

Drag a file from Finder into the terminal. Its path is recognized as it arrives and replaced by a `📎 name` line above the prompt (Backspace on an empty prompt removes the last one). What happens next depends on the file:

| File | Sent as |
|------|---------|
| Image (PNG, JPEG, GIF, WebP) | An image, to any API that takes them. Ollama is checked for the `vision` capability first, with a warning (but still sent) if it's missing |
| PDF | A document block (Anthropic) or a file part (OpenAI). Ollama can't take PDFs, so they're refused there |
| Text (any UTF-8 file up to 300 KB: code, notes, CSV, ...) | Pasted into your message in a fenced block under `[attached file: name]`, so it works with every API and is kept in saved sessions |
| Anything else | Refused: these APIs have no way to take it |

Files are capped at 20 MB. Only a *paste* (which is what a drop is) attaches PDFs and text files; a path typed into a message attaches only images, so mentioning `~/.ssh/config` in a question doesn't upload it. When a drop doesn't register in your terminal, `/attach <path>` queues a file for your next message. A line starting with `/` that contains an image path is treated as a message, not a command. PDFs and images aren't kept in saved sessions or shared models, only their text.
