// Test helpers for code that writes to a terminal.
import { PassThrough } from 'node:stream';
import { vi } from 'vitest';

// Makes process.stdout look like a terminal of the given size. Must run
// before thinai.js is imported, since it decides on colors at load time.
export function fakeTTY({ columns = 60, rows = 40 } = {}) {
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true, writable: true });
}

export function setColumns(columns) {
  process.stdout.columns = columns;
}

// Collects everything written to stdout (and console.log/error) until
// stop() is called, which restores normal output and returns the text.
export function captureOutput() {
  let output = '';
  const collect = (chunk) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(collect);
  const log = vi.spyOn(console, 'log').mockImplementation((...args) => collect(args.join(' ') + '\n'));
  const error = vi.spyOn(console, 'error').mockImplementation((...args) => collect(args.join(' ') + '\n'));
  return {
    get text() {
      return output;
    },
    stop() {
      write.mockRestore();
      log.mockRestore();
      error.mockRestore();
      return output;
    }
  };
}

const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;[^\x1b]*\x1b\\|\x1b\]1337;[^\x07]*\x07|\x1b_G[^\x1b]*\x1b\\/g;

export function stripAnsi(text) {
  return text.replace(ESCAPES, '');
}

// Renders markdown through a fresh renderer, fed in chunks of `chunk`
// characters, and returns the raw terminal output.
export async function render(thinai, markdown, { chunk = 3, role = 'assistant', ...options } = {}) {
  const capture = captureOutput();
  try {
    const renderer = thinai.createMarkdownRenderer(role, 0, options);
    for (let i = 0; i < markdown.length; i += chunk) await renderer.write(markdown.slice(i, i + chunk));
    await renderer.end();
  } finally {
    capture.stop();
  }
  return capture.text;
}

// A minimal terminal emulator: enough of VT100 to replay what thinai
// writes (cursor moves, erase, soft wrap with the right-margin "pending
// wrap" state, wide characters) and read back what's on screen. Escape
// sequences it doesn't need (colors, hyperlinks, images) are ignored.
// `onlcr` translates \n to \r\n, as a tty's output processing does outside
// raw mode.
export class Terminal {
  constructor(columns, { widthOf, onlcr = false } = {}) {
    this.columns = columns;
    this.widthOf = widthOf;
    this.onlcr = onlcr;
    this.lines = [[]];
    this.row = 0;
    this.col = 0;
    this.pending = false;
  }

  ensureRow(row) {
    while (this.lines.length <= row) this.lines.push([]);
  }

  write(data) {
    const tokens = data.match(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_G[^\x1b]*\x1b\\|\x1b[^[\]_]|[^\x1b]+/gu) || [];
    const graphemes = new Intl.Segmenter();
    for (const token of tokens) {
      if (token.startsWith('\x1b[')) {
        this.csi(token);
      } else if (token.startsWith('\x1b')) {
        continue;
      } else {
        for (const { segment } of graphemes.segment(token)) this.put(segment);
      }
    }
    return this;
  }

  csi(token) {
    const final = token.at(-1);
    if (token.includes('?')) return;
    const n = parseInt(token.slice(2, -1), 10) || 0;
    this.ensureRow(this.row);
    if (final === 'A') this.row = Math.max(0, this.row - (n || 1));
    else if (final === 'B') this.row += n || 1;
    else if (final === 'C') this.col = Math.min(this.columns - 1, this.col + (n || 1));
    else if (final === 'D') this.col = Math.max(0, this.col - (n || 1));
    else if (final === 'G') this.col = Math.max(0, (n || 1) - 1);
    else if (final === 'J') {
      this.lines[this.row] = this.lines[this.row].slice(0, this.col);
      this.lines.length = this.row + 1;
    } else if (final === 'K') {
      this.lines[this.row] = n === 2 ? [] : this.lines[this.row].slice(0, this.col);
    } else {
      return; // SGR and the like don't move the cursor
    }
    this.pending = false;
  }

  put(ch) {
    if (ch === '\r') {
      this.col = 0;
      this.pending = false;
    } else if (ch === '\n' || ch === '\r\n') {
      this.row++;
      if (this.onlcr || ch === '\r\n') this.col = 0;
      this.pending = false;
    } else if (ch === '\x07') {
      // bell: ignore
    } else {
      const width = this.widthOf(ch);
      if (this.pending || this.col + width > this.columns) {
        this.row++;
        this.col = 0;
        this.pending = false;
      }
      this.ensureRow(this.row);
      const line = this.lines[this.row];
      while (line.length < this.col) line.push(' ');
      line[this.col] = ch;
      for (let i = 1; i < width; i++) line[this.col + i] = '';
      this.col += width;
      if (this.col >= this.columns) {
        this.col = this.columns - 1;
        this.pending = true;
      }
    }
  }

  // Screen contents, one string per row, trailing spaces trimmed.
  get screen() {
    return this.lines.map((cells) => cells.map((c) => c ?? ' ').join('').replace(/\s+$/, ''));
  }

  get cursor() {
    return { row: this.row, col: this.pending ? this.columns : this.col };
  }
}

// A stand-in for process.stdin in raw TTY mode: install() swaps it in, and
// type() feeds it keystrokes one chunk at a time (letting each be handled
// before the next, as a person typing would).
export class FakeStdin extends PassThrough {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
  }

  setRawMode(mode) {
    this.isRaw = mode;
    return this;
  }

  install() {
    this.original = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { value: this, configurable: true, writable: true });
    return this;
  }

  uninstall() {
    Object.defineProperty(process, 'stdin', this.original);
  }

  async type(...chunks) {
    for (const chunk of chunks) {
      this.write(chunk);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

export const KEYS = {
  enter: '\r',
  ctrlJ: '\n',
  left: '\x1b[D',
  right: '\x1b[C',
  up: '\x1b[A',
  down: '\x1b[B',
  home: '\x1b[H',
  end: '\x1b[F',
  ctrlA: '\x01',
  ctrlE: '\x05',
  ctrlW: '\x17',
  ctrlU: '\x15',
  ctrlK: '\x0b',
  ctrlD: '\x04',
  backspace: '\x7f',
  delete: '\x1b[3~',
  ctrlLeft: '\x1b[1;5D',
  ctrlRight: '\x1b[1;5C',
  paste: (text) => `\x1b[200~${text}\x1b[201~`
};
