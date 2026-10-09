import readline from 'readline';
import { extractAttachments } from './attachments.js';
import { decodeCsiU, inputPosition } from './lineedit.js';
import { ANSI, CHROME_COLOR, graphemeWidth, graphemes, styleLine, styledPrompt, supportsColor, visibleWidth } from './style.js';

// The line editor (editLine) and the redraw of a submitted line: methods of
// OllamaChat (chat.js adds them to its prototype).
export const lineEditor = {
  // A small line editor. Enter submits; Ctrl+J (and Shift+Enter, if the
  // terminal sends a distinguishable sequence for it - most don't) inserts a
  // newline. Supports cursor movement (arrows, Home/End, Ctrl+A/E, word jumps
  // with Ctrl/Alt+arrows or Alt+B/F), deletion (Backspace, Delete, Ctrl+W,
  // Ctrl+U, Ctrl+K), history recall with Up/Down (from the first/last line of
  // a multi-line message), and bracketed paste, so pasted line breaks become
  // part of the message instead of submitting it. The whole input is redrawn
  // after each change, which keeps wrapping and wide characters simple.
  async editLine() {
    return new Promise((resolve) => {
      const stdin = process.stdin;
      const history = this.inputHistory;
      let buffer = '';
      let cursor = 0; // UTF-16 index into buffer, always on a grapheme boundary
      let cursorRow = 0; // terminal row the cursor is on, relative to the prompt's
      let historyIndex = history.length;
      let draft = ''; // unsent input, kept while browsing history
      let pasting = false;
      // Files dragged in (their paths are recognized as they arrive) are
      // taken out of the text and shown as chips on a line above the prompt.
      const attached = [];

      const chipLine = () => {
        let text = attached.map((file) => `📎 ${file.name}`).join('  ');
        const room = (process.stdout.columns || 80) - 1;
        if (visibleWidth(text) > room) {
          const kept = [];
          let used = 1;
          for (const { segment } of graphemes.segment(text)) {
            used += graphemeWidth(segment);
            if (used > room) break;
            kept.push(segment);
          }
          text = kept.join('') + '…';
        }
        return `${CHROME_COLOR}${text}${ANSI.reset}\r\n`;
      };

      const render = () => {
        const end = inputPosition(buffer);
        const target = inputPosition(buffer.slice(0, cursor));
        const chips = attached.length > 0;
        let out = cursorRow > 0 ? `\x1b[${cursorRow}A` : '';
        // Raw mode disables automatic CR-on-LF, so embedded newlines need an explicit \r.
        out += '\r\x1b[J' + (chips ? chipLine() : '') + styledPrompt() + buffer.replace(/\n/g, '\r\n');
        if (end.pending) out += ' \r'; // move off the right edge onto the next row
        if (end.row > target.row) out += `\x1b[${end.row - target.row}A`;
        out += '\r' + (target.col > 0 ? `\x1b[${target.col}C` : '');
        cursorRow = target.row + (chips ? 1 : 0);
        process.stdout.write(out);
      };

      // Moves any complete file path in the text into `attached`. Run when a
      // paste ends (a drag-and-drop arrives like one) and after each space, so
      // a path typed or dropped without bracketed paste is caught too.
      // Any kind of file counts when it came in as a paste, since that's what
      // a drop is; typed text only attaches images.
      const attachImages = (pasted) => {
        if (!buffer.includes('/')) return;
        const found = extractAttachments(buffer, { complete: false, allowEnd: pasted, anyFile: pasted });
        if (found.attachments.length === 0) return;
        const atEnd = cursor >= buffer.length;
        attached.push(...found.attachments);
        buffer = found.text;
        cursor = atEnd ? buffer.length : Math.min(cursor, buffer.length);
      };

      // Cursor steps and deletes whole grapheme clusters, so an emoji like ⚠️
      // or 👩‍💻 behaves as the single character it looks like.
      const boundaries = () => [...Array.from(graphemes.segment(buffer), (g) => g.index), buffer.length];
      const prev = (i) => boundaries().filter((b) => b < i).pop() ?? 0;
      const next = (i) => boundaries().find((b) => b > i) ?? buffer.length;
      const snap = (i) => boundaries().filter((b) => b <= i).pop() ?? 0;
      const lineStart = (i) => buffer.lastIndexOf('\n', i - 1) + 1;
      const lineEnd = (i) => (buffer.indexOf('\n', i) === -1 ? buffer.length : buffer.indexOf('\n', i));
      const wordLeft = (i) => {
        while (i > 0 && /\s/.test(buffer[i - 1])) i--;
        while (i > 0 && !/\s/.test(buffer[i - 1])) i--;
        return i;
      };
      const wordRight = (i) => {
        while (i < buffer.length && /\s/.test(buffer[i])) i++;
        while (i < buffer.length && !/\s/.test(buffer[i])) i++;
        return i;
      };

      const insert = (text) => {
        buffer = buffer.slice(0, cursor) + text + buffer.slice(cursor);
        cursor += text.length;
      };
      const remove = (from, to) => {
        buffer = buffer.slice(0, from) + buffer.slice(to);
        cursor = from;
      };
      const recall = (index) => {
        if (historyIndex === history.length) draft = buffer;
        historyIndex = index;
        buffer = index === history.length ? draft : history[index];
        cursor = buffer.length;
      };

      const cleanup = () => {
        process.stdout.write('\x1b[?2004l\x1b[<u'); // bracketed paste off; back to the usual key reporting
        stdin.removeListener('keypress', onKeypress);
        stdin.setRawMode(false);
        stdin.pause();
      };

      const onKeypress = async (str, key) => {
        key = key || {};
        const decoded = decodeCsiU(key.sequence ?? str);
        if (decoded) {
          key = decoded.key;
          str = decoded.text;
        }

        if (key.name === 'paste-start') {
          pasting = true;
          return;
        }
        if (key.name === 'paste-end') {
          pasting = false;
          attachImages(true);
          render();
          return;
        }
        if (pasting) {
          // Terminals send pasted line breaks as \r; keep them as newlines.
          if (key.name === 'return' || key.name === 'enter') insert('\n');
          else if (str && !/[\x00-\x08\x0b-\x1f\x7f]/.test(str)) insert(str);
          return;
        }

        if (key.ctrl && key.name === 'c') {
          cleanup();
          process.stdout.write('\n');
          if (this.stopOnExit) {
            await this.stopModel();
          }
          this.mcp?.close();
          process.exit(0);
          return;
        }

        if (key.ctrl && key.name === 'd' && buffer.length === 0) {
          cleanup();
          process.stdout.write('\n');
          resolve(null);
          return;
        }

        // Enter sends \r ('return'); Ctrl+J sends a bare \n, which Node names 'enter'.
        const isNewlineInsert =
          key.name === 'enter' ||
          (key.name === 'return' && (key.shift || key.meta)); // Shift+Enter, where the terminal reports it
        if (isNewlineInsert) {
          insert('\n');
        } else if (key.name === 'return') {
          cursor = buffer.length;
          render();
          cleanup();
          process.stdout.write('\r\n');
          if (buffer.trim() && buffer !== history[history.length - 1]) history.push(buffer);
          this.pendingFiles = attached;
          resolve(buffer);
          return;
        } else if (key.name === 'backspace') {
          if (key.meta) remove(wordLeft(cursor), cursor);
          else if (cursor > 0) remove(prev(cursor), cursor);
          else if (buffer.length === 0) attached.pop(); // nothing left to delete: drop the last image
        } else if (key.name === 'delete' || (key.ctrl && key.name === 'd')) {
          if (cursor < buffer.length) remove(cursor, next(cursor));
        } else if (key.ctrl && key.name === 'w') {
          remove(wordLeft(cursor), cursor);
        } else if (key.ctrl && key.name === 'u') {
          remove(lineStart(cursor), cursor);
        } else if (key.ctrl && key.name === 'k') {
          const end = lineEnd(cursor);
          buffer = buffer.slice(0, cursor) + buffer.slice(end === cursor && end < buffer.length ? end + 1 : end);
        } else if ((key.name === 'left' && (key.ctrl || key.meta)) || (key.meta && key.name === 'b')) {
          cursor = wordLeft(cursor);
        } else if ((key.name === 'right' && (key.ctrl || key.meta)) || (key.meta && key.name === 'f')) {
          cursor = wordRight(cursor);
        } else if (key.name === 'left' || (key.ctrl && key.name === 'b')) {
          cursor = prev(cursor);
        } else if (key.name === 'right' || (key.ctrl && key.name === 'f')) {
          cursor = next(cursor);
        } else if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
          cursor = lineStart(cursor);
        } else if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
          cursor = lineEnd(cursor);
        } else if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
          const start = lineStart(cursor);
          if (start > 0) {
            const above = lineStart(start - 1);
            cursor = snap(Math.min(above + (cursor - start), start - 1));
          } else if (historyIndex > 0) {
            recall(historyIndex - 1);
          }
        } else if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
          const end = lineEnd(cursor);
          if (end < buffer.length) {
            const below = end + 1;
            cursor = snap(Math.min(below + (cursor - lineStart(cursor)), lineEnd(below)));
          } else if (historyIndex < history.length) {
            recall(historyIndex + 1);
          }
        } else if (str && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str)) {
          insert(str);
          if (/\s/.test(str)) attachImages(false);
        } else {
          return; // Unhandled key (Tab, Escape, function keys, ...)
        }
        render();
      };

      // Bracketed paste on, and (where supported) Shift+Enter reported as such;
      // other terminals ignore the second sequence.
      process.stdout.write(styledPrompt() + '\x1b[?2004h\x1b[>1u');
      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', onKeypress);
    });
  },

  // Overwrites the raw (unstyled) lines the user just typed with the styled
  // version. Handles input that spans multiple terminal rows, whether from
  // wrapping or embedded newlines (Ctrl+J), by erasing the whole block and
  // rewriting it rather than assuming a single row.
  rewriteInputLine(input) {
    if (!supportsColor || !process.stdin.isTTY || !process.stdout.isTTY) return;

    const rows = inputPosition(input).row + 1;

    process.stdout.moveCursor(0, -rows);
    process.stdout.cursorTo(0);
    process.stdout.clearScreenDown();
    process.stdout.write(`${styledPrompt()}${styleLine('user', input)}`.replace(/\n/g, '\r\n') + '\r\n');
  }
};
