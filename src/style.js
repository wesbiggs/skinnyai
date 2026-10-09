import './config.js';

// *Italic text* doubles as narration in RP-style chats. Each speaker gets its own
// dialogue/narration pair so turns are visually distinct: user = yellow, assistant = green.
export const supportsColor = Boolean(process.stdout.isTTY);
export const ANSI = {
  reset: supportsColor ? '\x1b[0m' : '',
  user: {
    dialogue: supportsColor ? '\x1b[38;5;226m' : '',
    narration: supportsColor ? '\x1b[38;5;136m' : ''
  },
  assistant: {
    dialogue: supportsColor ? '\x1b[38;5;120m' : '',
    narration: supportsColor ? '\x1b[38;5;77m' : ''
  }
};

// Input prompt. Plain text for width math; styledPrompt() for display, read
// at call time so --user-italic-color applies to it.
export const PROMPT = '> ';
export function styledPrompt() {
  return ANSI.user.narration + PROMPT + ANSI.reset;
}

// Basic 16-color names, for --*-color flags. 'gray'/'grey' alias brightblack.
export const NAMED_COLORS = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  brightblack: 90, brightred: 91, brightgreen: 92, brightyellow: 93,
  brightblue: 94, brightmagenta: 95, brightcyan: 96, brightwhite: 97,
  gray: 90, grey: 90
};

// Parses a --*-color flag value into an SGR escape sequence. Accepts a hex
// triplet (#RRGGBB, truecolor), a 256-color palette index (0-255), or a
// basic color name (see NAMED_COLORS). Exits with an error on bad input.
export function parseColor(value, flagName) {
  const hexMatch = /^#?([0-9a-fA-F]{6})$/.exec(value);
  if (hexMatch) {
    const hex = hexMatch[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `\x1b[38;2;${r};${g};${b}m`;
  }

  if (/^\d+$/.test(value)) {
    const n = parseInt(value, 10);
    if (n >= 0 && n <= 255) {
      return `\x1b[38;5;${n}m`;
    }
  }

  const named = NAMED_COLORS[value.toLowerCase()];
  if (named !== undefined) {
    return `\x1b[${named}m`;
  }

  console.error(`❌ Error: invalid color '${value}' for ${flagName}`);
  console.error('   Use a hex code (#RRGGBB), a 256-color index (0-255), or a name like yellow, brightgreen, brightblack, etc.\n');
  process.exit(1);
}

// Applies parsed --*-color overrides onto the default palette. No-op when
// stdout isn't a TTY, since ANSI codes would just clutter redirected output.
export function applyColorOverrides(options) {
  if (!supportsColor) return;
  if (options.userNormalColor) ANSI.user.dialogue = parseColor(options.userNormalColor, '--user-normal-color');
  if (options.userEmphasisColor) ANSI.user.narration = parseColor(options.userEmphasisColor, '--user-emphasis-color');
  if (options.modelNormalColor) ANSI.assistant.dialogue = parseColor(options.modelNormalColor, '--model-normal-color');
  if (options.modelEmphasisColor) ANSI.assistant.narration = parseColor(options.modelEmphasisColor, '--model-emphasis-color');
}

// Inline code, code blocks, and fence/rule/quote chrome get fixed colors of
// their own, independent of the per-speaker palette.
export const CODE_COLOR = supportsColor ? '\x1b[38;5;117m' : '';
export const CODE_BG = supportsColor ? '\x1b[48;5;236m' : ''; // dark grey behind fenced code, across the whole width
export const CHROME_COLOR = supportsColor ? '\x1b[38;5;244m' : '';

// Text that came from a model, a web page, or a tool is data, never terminal
// commands: ESC (and the C1 controls some terminals read as ESC [ or ESC ])
// would let it set the title, write the clipboard (OSC 52), or clear the screen.
// Newlines and tabs stay; a carriage return only as part of CRLF.
export const stripControls = (text) => String(text).replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

export const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
// SGR styles plus OSC 8 hyperlink open/close - everything that takes no columns.
export const ESCAPE_PATTERN = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;

// OSC 8 hyperlinks: terminals that support them (iTerm2, WezTerm, kitty,
// GNOME Terminal, Windows Terminal, ...) make the text clickable; others
// ignore the sequence and just show the text.
export const linkOpen = (url) => `\x1b]8;;${url}\x1b\\`;
export const LINK_CLOSE = '\x1b]8;;\x1b\\';
// Markdown [text](url), for links that arrive whole (table cells).
// A leading '!' (an image) is dropped: cells show images as links.
export const LINK_PATTERN = /!?\[([^\]]*)\]\(([^)\s]+)\)/g;

// Terminal column width of one code point: 0 for combining marks and
// zero-width joiners/variation selectors, 2 for East Asian wide characters,
// 1 otherwise. Rough, but covers what models commonly emit.
export function charWidth(cp) {
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) ||
      (cp >= 0x1f3fb && cp <= 0x1f3ff)) return 0; // last: skin tone modifiers
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

// Emoji are measured per grapheme cluster (what the terminal draws as one
// glyph), since one can span several code points: ⚠️ is ⚠ plus a variation
// selector, flags are two regional indicators, and 👩‍💻 is joined with a ZWJ.
// Anything drawn as a color emoji takes 2 columns: characters that default
// to emoji presentation (✅, ❌, 🚀, flags), and text-default ones like ⚠ or
// digits when followed by the U+FE0F emoji selector.
export const graphemes = new Intl.Segmenter();
export const EMOJI_GLYPH = /^\p{Emoji_Presentation}|^\p{Emoji}️|‍\p{Extended_Pictographic}/u;

export function graphemeWidth(cluster) {
  if (EMOJI_GLYPH.test(cluster)) return 2;
  let width = 0;
  for (const ch of cluster) width += charWidth(ch.codePointAt(0));
  return width;
}

// Printed width of a string, ignoring escape sequences.
export function visibleWidth(text) {
  let width = 0;
  for (const { segment } of graphemes.segment(text.replace(ESCAPE_PATTERN, ''))) width += graphemeWidth(segment);
  return width;
}

// LaTeX commands that have a plain Unicode equivalent, rendered inside $...$
// (models like gemma emit things like $\to$ for arrows). Anything not listed
// is left as written.
export const LATEX_SYMBOLS = (() => {
  const table = {
    to: '→', rightarrow: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔', uparrow: '↑', downarrow: '↓',
    Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', implies: '⟹', impliedby: '⟸', iff: '⟺',
    longrightarrow: '⟶', longleftarrow: '⟵', mapsto: '↦', rightleftharpoons: '⇌',
    times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', ast: '∗', circ: '∘', bullet: '•', star: '⋆',
    leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', sim: '∼', simeq: '≃', equiv: '≡',
    propto: '∝', ll: '≪', gg: '≫', cong: '≅',
    infty: '∞', partial: '∂', nabla: '∇', degree: '°', prime: '′', ldots: '…', dots: '…', cdots: '⋯',
    forall: '∀', exists: '∃', in: '∈', notin: '∉', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
    cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅', land: '∧', lor: '∨', neg: '¬', wedge: '∧', vee: '∨',
    sum: '∑', prod: '∏', int: '∫', sqrt: '√', angle: '∠', perp: '⊥', parallel: '∥', therefore: '∴', because: '∵',
    checkmark: '✓', ',': ' ', ';': ' ', ':': ' ', quad: ' ', qquad: '  ', '!': '', ' ': ' ',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
    theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
    rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    '{': '{', '}': '}', '%': '%', '&': '&', _: '_', $: '$', '#': '#'
  };
  return new Map(Object.entries(table));
})();
// Commands whose braced argument is just text: \text{km} shows as km.
export const LATEX_TEXT_COMMANDS = new Set(['text', 'textbf', 'textit', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'operatorname', 'mbox']);

// Renders inline markdown within one word (or one whole table cell) at a
// time: **bold**, *italic* / _italic_, ~~strike~~, `code`, \-escapes, and
// the symbols in $...$ math (see LATEX_SYMBOLS).
// Italic also switches to the role's narration color, so RP-style
// '*narration*' keeps its distinct look. State carries across calls, so a
// span can cover several words; endLine() drops it, so an unclosed marker
// can't bleed into the next paragraph. Every SGR it emits is a full reset
// plus the current state, so any emitted sequence alone restores the style.
export function createInlineStyler(role) {
  const colors = ANSI[role];
  let bold = false;
  let italic = false;
  let strike = false;
  let codeRun = 0; // length of the backtick run that opened the current code span
  let lineBold = false; // headings/table headers
  let link = false; // underlined while inside a [link](url)
  let math = false; // inside $...$
  let mathBraces = []; // open { in math; true when the brace belongs to \text{...} and is dropped

  function sgr() {
    if (!supportsColor) return '';
    const color = codeRun ? CODE_COLOR : italic ? colors.narration : colors.dialogue;
    const params = ['0', color.slice(2, -1)];
    if (bold || lineBold) params.push('1');
    if (italic) params.push('3');
    if (strike) params.push('9');
    if (link) params.push('4');
    return `\x1b[${params.join(';')}m`;
  }

  const isSpace = (ch) => ch === undefined || /\s/.test(ch);
  const isWordChar = (ch) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

  function style(text) {
    const chars = Array.from(text);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      let run = 1;
      while (chars[i + run] === ch) run++;

      if (codeRun) {
        if (ch === '`' && run === codeRun) {
          codeRun = 0;
          out += sgr();
          i += run - 1;
        } else {
          out += ch;
        }
        continue;
      }

      if (ch === '$') {
        const next = chars[i + run];
        // A closing $ needs a non-space before it and no digit after it. An
        // opening $ is only taken when the span is surely math, since it can't
        // be put back once dropped: a closing $ later in this same word
        // ($\\to$, $x$), or a backslash right after it ($\\text{...} ...$). So
        // "$5" and "costs $USD" stay literal.
        const closes = (at) => chars[at] === '$' && !isSpace(chars[at - 1]) && !/\d/.test(chars[at + 1] ?? '');
        const opens = run <= 2 && !isSpace(next) && (next === '\\' || chars.slice(i + run + 1).some((_, k) => closes(i + run + 1 + k)));
        if (math ? closes(i) : opens) {
          math = !math;
          mathBraces = [];
          i += run - 1;
          continue;
        }
      }

      if (math) {
        if (ch === '\\' && i + 1 < chars.length) {
          let end = i + 1;
          while (end < chars.length && /[A-Za-z]/.test(chars[end])) end++;
          const name = end > i + 1 ? chars.slice(i + 1, end).join('') : chars[i + 1];
          if (end === i + 1) end++;
          if (LATEX_TEXT_COMMANDS.has(name) && chars[end] === '{') {
            mathBraces.push(true);
            i = end;
            continue;
          }
          if (LATEX_SYMBOLS.has(name)) {
            out += LATEX_SYMBOLS.get(name);
            i = end - 1;
            continue;
          }
        } else if (ch === '{') {
          mathBraces.push(false);
        } else if (ch === '}' && mathBraces.pop()) {
          continue;
        }
        out += ch;
        continue;
      }

      if (ch === '\\' && i + 1 < chars.length && /[\\`*_~|#[\]()<>$-]/.test(chars[i + 1])) {
        out += chars[++i];
        continue;
      }

      if (ch === '`') {
        codeRun = run;
        out += sgr();
        i += run - 1;
        continue;
      }

      if (ch === '*' || ch === '_' || (ch === '~' && run === 2)) {
        const prev = chars[i - 1];
        const next = chars[i + run];
        let canOpen = !isSpace(next);
        let canClose = !isSpace(prev);
        if (ch === '_') {
          // snake_case and the like: underscores inside a word are literal.
          canOpen = canOpen && !isWordChar(prev);
          canClose = canClose && !isWordChar(next);
        }
        // A marker closes a span that's on, or opens one that's off.
        const toggle = (on) => (on ? canClose : canOpen);

        let remaining = run;
        let consumed = 0;
        if (ch === '~') {
          if (toggle(strike)) {
            strike = !strike;
            consumed = 2;
          }
        } else {
          if (remaining >= 2 && toggle(bold)) {
            bold = !bold;
            remaining -= 2;
            consumed += 2;
          }
          if (remaining >= 1 && toggle(italic)) {
            italic = !italic;
            consumed += 1;
          }
        }
        if (consumed > 0) out += sgr();
        out += ch.repeat(run - consumed);
        i += run - 1;
        continue;
      }

      out += ch;
    }
    return out;
  }

  return {
    style,
    sgr,
    setLink(on) {
      link = on;
    },
    setLineBold(on) {
      lineBold = on;
    },
    endLine() {
      bold = italic = strike = lineBold = link = math = false;
      codeRun = 0;
      mathBraces = [];
    }
  };
}

// Styles a line (or several, split on '\n') of user input for echoing back.
export function styleLine(role, text) {
  return text.split('\n').map((line) => {
    const styler = createInlineStyler(role);
    return styler.sgr() + styler.style(line);
  }).join('\n') + ANSI.reset;
}

// Word-wraps text at the terminal width as it's written, so long lines break
// on a space instead of relying on the terminal's own mid-word hard wrap.
// `style` is a stateful styler (see createInlineStyler) applied to each whole
// word; its width is measured after styling, so markup characters don't count.
// raw() writes a prefix (list marker, indentation) that isn't wrapped, and
// setHang() sets what continuation lines start with, for hanging indents.
// setLink() makes each following word a hyperlink: `link.open()` is written
// just before each word is styled (so it can capture the style state going
// in) and `link.close` just after.
// Only wraps on a real TTY - piped/redirected output is left unwrapped.
export function createWordWrapper(style, startColumn = 0, emit = (text) => process.stdout.write(text)) {
  if (!process.stdout.isTTY) {
    return { write: (text) => emit(style(text)), raw: emit, setHang() {}, setLink() {}, end() {} };
  }

  const columns = process.stdout.columns || 80;
  let column = startColumn;
  let pending = '';
  let spaceBefore = false;
  let hang = '';
  let link = null;

  function flushWord() {
    if (!pending) return;
    const open = link ? link.open() : '';
    const styled = style(pending);
    const width = visibleWidth(styled);
    const hangWidth = visibleWidth(hang);
    if (column > 0 && spaceBefore) {
      if (column + 1 + width > columns && column > hangWidth) {
        emit('\n' + hang);
        column = hangWidth;
      } else {
        emit(' ');
        column += 1;
      }
    }
    emit(link ? open + styled + link.close : styled);
    column += width;
    // A word wider than the terminal gets hard-wrapped by the terminal itself.
    if (column > columns) column %= columns;
    pending = '';
    spaceBefore = false;
  }

  return {
    write(text) {
      for (const ch of text) {
        if (ch === '\n') {
          flushWord();
          emit('\n');
          column = 0;
          spaceBefore = false;
          hang = '';
        } else if (ch === ' ' || ch === '\t') {
          flushWord();
          spaceBefore = true;
        } else {
          pending += ch;
        }
      }
    },
    raw(text) {
      flushWord();
      emit(text);
      const width = visibleWidth(text);
      if (width > 0) {
        column += width;
        spaceBefore = false;
      }
    },
    setHang(prefix) {
      hang = prefix;
    },
    setLink(value) {
      flushWord();
      link = value;
    },
    end() {
      flushWord();
    }
  };
}

// Splits a markdown table row into trimmed cell strings, honoring \| escapes
// and pipes inside `code`.
export function splitTableRow(line) {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells = [];
  let cell = '';
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (ch === '`') {
      inCode = !inCode;
      cell += ch;
    } else if (ch === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

// Wraps an already-styled string to `width` columns, returning its lines.
// Each line starts with the SGR state in effect where it begins, so it can be
// printed on its own (e.g. between table borders). Words wider than `width`
// are hard-broken.
export function wrapStyled(styled, width) {
  const lines = [];
  let line = '';
  let lineWidth = 0;
  let state = '';

  const place = (piece, pieceWidth, pieceState) => {
    if (lineWidth > 0 && lineWidth + 1 + pieceWidth > width) {
      lines.push(line);
      line = '';
      lineWidth = 0;
    }
    if (lineWidth > 0) {
      line += ' ';
      lineWidth += 1;
    } else {
      line = pieceState;
    }
    line += piece;
    lineWidth += pieceWidth;
  };

  for (const word of styled.split(' ')) {
    if (visibleWidth(word) <= width) {
      const wordState = state;
      for (const m of word.matchAll(SGR_PATTERN)) state = m[0];
      if (word.replace(ESCAPE_PATTERN, '')) place(word, visibleWidth(word), wordState);
      else line += word;
      continue;
    }
    // Hard-break an overlong word, one code point or SGR sequence at a time.
    let piece = '';
    let pieceWidth = 0;
    let pieceState = state;
    const tokens = word.split(/(\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\)/)
      .flatMap((part) => (part.startsWith('\x1b') ? [part] : Array.from(graphemes.segment(part), (g) => g.segment)));
    for (const token of tokens) {
      if (token.startsWith('\x1b')) {
        piece += token;
        if (token.startsWith('\x1b[')) state = token;
        continue;
      }
      const w = graphemeWidth(token);
      if (pieceWidth + w > width && pieceWidth > 0) {
        place(piece, pieceWidth, pieceState);
        piece = '';
        pieceWidth = 0;
        pieceState = state;
      }
      piece += token;
      pieceWidth += w;
    }
    if (pieceWidth > 0) place(piece, pieceWidth, pieceState);
  }
  lines.push(line);
  return lines;
}

// Draws buffered markdown table rows with box-drawing borders. Columns are
// sized to their content, shrinking the widest ones (and wrapping their
// cells) when the table would be wider than the terminal.
export function renderTable(rows, role) {
  const parsed = rows.map(splitTableRow);
  const isSeparator = (cells) => cells.every((c) => /^:?-+:?$/.test(c));
  let header = null;
  let aligns = [];
  if (parsed.length >= 2 && isSeparator(parsed[1])) {
    header = parsed[0];
    aligns = parsed[1].map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
  }
  const body = (header ? parsed.slice(2) : parsed).filter((cells) => !isSeparator(cells));
  const allRows = header ? [header, ...body] : body;
  const count = Math.max(...allRows.map((cells) => cells.length));

  // Each word of a link's text is its own hyperlink, so a cell that wraps
  // never leaves one open across the borders drawn between its lines.
  const styleCell = (text, bold) => {
    const styler = createInlineStyler(role);
    styler.setLineBold(bold);
    let out = styler.sgr();
    let last = 0;
    for (const m of text.matchAll(LINK_PATTERN)) {
      out += styler.style(text.slice(last, m.index));
      styler.setLink(true);
      out += m[1].split(' ').map((word) => linkOpen(m[2]) + styler.sgr() + styler.style(word) + LINK_CLOSE).join(' ');
      styler.setLink(false);
      out += styler.sgr();
      last = m.index + m[0].length;
    }
    return out + styler.style(text.slice(last));
  };
  const styledRows = allRows.map((cells, r) =>
    Array.from({ length: count }, (_, c) => styleCell(cells[c] ?? '', header !== null && r === 0)));

  const widths = Array.from({ length: count }, (_, c) =>
    Math.max(1, ...styledRows.map((cells) => visibleWidth(cells[c]))));
  const available = (process.stdout.columns || 80) - (3 * count + 1);
  const MIN_WIDTH = 3;
  while (widths.reduce((a, b) => a + b, 0) > available) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= MIN_WIDTH) break;
    widths[widest]--;
  }

  const border = CHROME_COLOR || ANSI[role].dialogue;
  const edge = (left, mid, right) =>
    ANSI.reset + border + left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right + ANSI.reset + '\n';
  const pad = (text, width, align) => {
    const gap = width - visibleWidth(text);
    const left = align === 'right' ? gap : align === 'center' ? Math.floor(gap / 2) : 0;
    return ' '.repeat(left) + text + ANSI.reset + ' '.repeat(gap - left);
  };
  const row = (cells) => {
    const wrapped = cells.map((cell, c) => wrapStyled(cell, widths[c]));
    const height = Math.max(...wrapped.map((lines) => lines.length));
    let out = '';
    for (let i = 0; i < height; i++) {
      out += ANSI.reset + border + '│';
      wrapped.forEach((lines, c) => {
        out += ' ' + pad(lines[i] ?? '', widths[c], aligns[c]) + border + ' │';
      });
      out += ANSI.reset + '\n';
    }
    return out;
  };

  let out = edge('┌', '┬', '┐');
  styledRows.forEach((cells, r) => {
    out += row(cells);
    if (header && r === 0 && styledRows.length > 1) out += edge('├', '┼', '┤');
  });
  out += edge('└', '┴', '┘');
  return out;
}

// Cuts `text` to at most `width` terminal columns, ending in an ellipsis if it had to.
export function truncateToWidth(text, width) {
  if (visibleWidth(text) <= width) return text;
  let out = '';
  let used = 1; // room for the ellipsis
  for (const { segment } of graphemes.segment(text)) {
    used += graphemeWidth(segment);
    if (used > width) break;
    out += segment;
  }
  return `${out}…`;
}

// Text in a thin-line box, the border in `color`. The box is as wide as the
// longest line, or the terminal if that's narrower (longer lines are cut).
export function drawBox(lines, color = '') {
  const reset = color ? ANSI.reset : '';
  const inner = Math.max(10, Math.min(Math.max(...lines.map(visibleWidth)), (process.stdout.columns || 80) - 4));
  const edge = (left, right) => `${color}${left}${'─'.repeat(inner + 2)}${right}${reset}`;
  const row = (line) => {
    const fitted = truncateToWidth(line, inner);
    return `${color}│${reset} ${fitted}${' '.repeat(inner - visibleWidth(fitted))} ${color}│${reset}`;
  };
  return [edge('┌', '┐'), ...lines.map(row), edge('└', '┘')].join('\n');
}
