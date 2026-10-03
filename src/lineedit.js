import './config.js';
import { PROMPT, graphemeWidth, graphemes, visibleWidth } from './style.js';

// Terminals that speak the kitty keyboard protocol (kitty, Ghostty, WezTerm,
// iTerm2 3.5+) report keys plain terminals can't tell apart, such as
// Shift+Enter, as CSI-u sequences: ESC [ code ; modifiers u. The editor asks
// for that mode while it's reading a line, and maps these back onto the
// key objects Node's readline makes (name, ctrl, meta, shift). Returns null
// for anything that isn't one.
export function decodeCsiU(sequence) {
  const match = /^\x1b\[(\d+)(?:;(\d+))?(?::\d+)*u$/.exec(sequence || '');
  if (!match) return null;
  const code = Number(match[1]);
  const mods = Math.max(0, Number(match[2] || 1) - 1);
  const key = { shift: Boolean(mods & 1), meta: Boolean(mods & 2), ctrl: Boolean(mods & 4), sequence };
  const special = { 13: 'return', 9: 'tab', 27: 'escape', 127: 'backspace' };
  if (special[code]) key.name = special[code];
  else if (code === 106 && key.ctrl && !key.meta) return { key: { name: 'enter', sequence }, text: undefined }; // Ctrl+J is a line feed
  else if (code >= 97 && code <= 122) key.name = String.fromCharCode(code);
  else return { key, text: undefined }; // some other key: let the editor ignore it
  return { key, text: key.name === 'return' ? '\r' : undefined };
}

// Where the terminal cursor ends up after printing PROMPT + text from the
// start of a row, as { row, col } relative to the prompt's row. Accounts for
// embedded newlines, soft wrapping at the terminal width, and wide
// characters. Text that exactly fills a row leaves the real cursor parked at
// the right edge ("pending wrap"); that's reported as the start of the next
// row, with `pending` set so the caller can nudge the cursor there.
export function inputPosition(text) {
  const columns = process.stdout.columns || 80;
  let row = 0;
  let col = visibleWidth(PROMPT);
  let pending = false;
  for (const { segment: ch } of graphemes.segment(text)) {
    if (ch === '\n') {
      row++;
      col = 0;
      pending = false;
      continue;
    }
    const width = graphemeWidth(ch);
    if (pending || col + width > columns) {
      row++;
      col = 0;
      pending = false;
    }
    col += width;
    if (col >= columns) pending = true;
  }
  return pending ? { row: row + 1, col: 0, pending } : { row, col, pending };
}
