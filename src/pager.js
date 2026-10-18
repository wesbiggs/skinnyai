import readline from 'node:readline';
import { visibleWidth, CHROME_COLOR, ANSI, supportsColor } from './style.js';

// Escape sequences that draw outside the text grid (inline images); their
// size can't be counted, so output holding one is never paged.
const UNCOUNTABLE = /\x1b\]1337;|\x1b_G/;

const RESET = supportsColor ? '\x1b[0m' : '';

// Waits for one key from a TTY: 'space', 'enter', 'back' (b), or 'quit'
// (q, Esc, Ctrl+C, anything else).
function readPagerKey() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once('keypress', (str, key = {}) => {
      stdin.setRawMode(false);
      stdin.pause();
      if (key.name === 'return' || key.name === 'enter') resolve('enter');
      else if (key.name === 'space' || key.name === 'pagedown') resolve('space');
      else if (key.name === 'b' || key.name === 'pageup') resolve('back');
      else resolve('quit');
    });
  });
}

// Text is fed in; a screenful at a time goes to `write`. When the screen is
// full and more is waiting, a `:` prompt (like less) asks for a key: Space for
// the next page, Enter for one more line, b for the page before, q to drop the
// rest. Going back redraws the screen from the lines already shown, so the
// colors in effect at the start of each line are remembered with it.
export function createPageView({ write, readKey = readPagerKey, rows, columns }) {
  const limit = rows - 1; // the last row holds the prompt
  const lines = []; // finished lines: { text, start (SGR in effect where it begins), rows }
  let end = 0; // lines[0..end) are on the screen, the last ones that fit
  let held = ''; // text that arrived after the screen filled
  let used = 0; // rows written since the last key
  let full = false;
  let skipping = false;
  let partial = ''; // the unfinished line
  let state = ''; // SGR sequences in effect after everything written so far
  let partialStart = '';

  const track = (text) => {
    for (const [sequence, params] of text.matchAll(/\x1b\[([0-9;]*)m/g)) {
      state = params === '' || /^0(;|$)/.test(params) ? sequence : state + sequence;
    }
  };

  // Writes up to the end of the screen; the rest of `text` is held.
  const emit = (text) => {
    while (text) {
      const newline = text.indexOf('\n');
      if (newline < 0) {
        write(text);
        partial += text;
        track(text);
        return;
      }
      const piece = text.slice(0, newline + 1);
      write(piece);
      const width = visibleWidth(partial + piece.slice(0, -1));
      const height = Math.max(1, Math.ceil(width / columns));
      lines.push({ text: partial + piece, start: partialStart, rows: height });
      track(piece);
      partial = '';
      partialStart = state;
      end = lines.length;
      used += height;
      text = text.slice(newline + 1);
      if (used >= limit) {
        full = true;
        held = text;
        return;
      }
    }
  };

  // Where the screen that ends at line `stop` begins.
  const windowStart = (stop) => {
    let start = stop;
    let sum = 0;
    while (start > 0 && sum + lines[start - 1].rows <= limit) sum += lines[--start].rows;
    return start;
  };
  // The end of the screen that begins at line `start`.
  const windowEnd = (start) => {
    let stop = start;
    let sum = 0;
    while (stop < lines.length && sum + lines[stop].rows <= limit) sum += lines[stop++].rows;
    return Math.max(stop, start + 1);
  };

  const redraw = (stop) => {
    write('\x1b[H\x1b[2J');
    for (let i = windowStart(stop); i < stop; i++) write(`${RESET}${lines[i].start}${lines[i].text}`);
    end = stop;
  };

  const wait = async () => {
    while (full && held) {
      write(':');
      const key = await readKey();
      write('\r\x1b[2K');
      if (key === 'quit') {
        skipping = true;
        held = '';
        return;
      }
      let redrawn = key === 'back';
      if (key === 'back') {
        const first = windowEnd(0);
        if (end > first) redraw(Math.max(windowStart(end), first));
      } else if (end < lines.length) {
        redraw(key === 'enter' ? end + 1 : windowEnd(end));
        redrawn = true;
      }
      write(`${RESET}${state}`); // the colors the text goes on in
      if (redrawn) continue; // looking at what was already shown, so ask again
      full = false;
      used = key === 'enter' ? limit - 1 : 0;
      const text = held;
      held = '';
      emit(text);
    }
  };

  return {
    feed(text) {
      if (skipping) return;
      if (full) held += text;
      else emit(text);
    },
    wait,
    get skipped() {
      return skipping;
    }
  };
}

// Writes `text` to the terminal, a screenful at a time when it is taller than
// the terminal. Anything that isn't an interactive terminal gets the text
// unchanged.
export async function pageText(text, { readKey = readPagerKey, rows = process.stdout.rows, columns = process.stdout.columns || 80 } = {}) {
  const interactive = process.stdin.isTTY && process.stdout.isTTY && rows > 3;
  if (!interactive || UNCOUNTABLE.test(text)) {
    process.stdout.write(text);
    return;
  }
  const view = createPageView({ write: (chunk) => process.stdout.write(chunk), readKey, rows, columns });
  view.feed(text);
  await view.wait();
}

// Runs `fn` with everything it prints held back, then pages it. Only for
// output that never asks a question, since a held prompt would never show.
export async function withPager(enabled, fn) {
  if (!enabled || !process.stdout.isTTY || !process.stdin.isTTY) return fn();
  const write = process.stdout.write;
  const held = [];
  process.stdout.write = (chunk, encoding, callback) => {
    held.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    for (const done of [encoding, callback]) if (typeof done === 'function') done();
    return true;
  };
  let result;
  try {
    result = await fn();
  } finally {
    process.stdout.write = write;
    await pageText(held.join(''));
  }
  return result;
}

// Pages a reply as it streams. While installed, everything written to stdout
// goes through a page view; the stream loop calls `wait()` after each chunk,
// which asks for a key when the screen is full. Backing up the loop this way
// also pauses reading from the server.
export function createReplyPager({ readKey = readPagerKey, rows = process.stdout.rows, columns = process.stdout.columns || 80 } = {}) {
  const write = process.stdout.write;
  const out = (text) => write.call(process.stdout, text);
  const view = createPageView({ write: out, readKey, rows, columns });

  process.stdout.write = (chunk, encoding, callback) => {
    view.feed(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    for (const done of [encoding, callback]) if (typeof done === 'function') done();
    return true;
  };

  return {
    wait: view.wait,
    // Shows what is still held and puts stdout back.
    async close() {
      try {
        await view.wait();
      } finally {
        process.stdout.write = write;
        if (view.skipped) out(`${ANSI.reset}\n${CHROME_COLOR}(the rest of the reply isn't shown; /page shows all of it)${ANSI.reset}\n`);
      }
    }
  };
}

// A reply pager when paging applies: on, in a terminal, and tall enough.
export function replyPager(enabled) {
  if (!enabled || !process.stdout.isTTY || !process.stdin.isTTY || !(process.stdout.rows > 3)) return null;
  return createReplyPager();
}
