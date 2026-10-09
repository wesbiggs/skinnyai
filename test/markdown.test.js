import { beforeAll, describe, expect, it } from 'vitest';
import { captureOutput, fakeTTY, render, setColumns, stripAnsi, Terminal } from './helpers/tty.js';

let skinnyai;

beforeAll(async () => {
  fakeTTY({ columns: 60 });
  skinnyai = await import('./helpers/skinny.js');
});

// What a 60-column terminal shows after `markdown` is rendered.
async function screen(markdown, options = {}) {
  setColumns(options.columns ?? 60);
  const output = await render(skinnyai, markdown, options);
  return new Terminal(options.columns ?? 60, { widthOf: skinnyai.graphemeWidth, onlcr: true }).write(output).screen;
}

describe('inline styles', () => {
  it('renders bold, italic, strike, and code with SGR codes and hides the markers', async () => {
    const output = await render(skinnyai, 'Some **bold**, *italic*, ~~gone~~, and `code`.');
    expect(stripAnsi(output)).toBe('Some bold, italic, gone, and code.');
    expect(output).toMatch(/\x1b\[0;38;5;120;1mbold/);
    expect(output).toMatch(/\x1b\[0;38;5;77;3mitalic/); // italic uses the narration color
    expect(output).toMatch(/\x1b\[0;38;5;120;9mgone/);
    expect(output).toMatch(/\x1b\[0;38;5;117mcode/);
  });

  it('keeps a span going across words', async () => {
    const output = await render(skinnyai, '*italic narration spanning words* then plain');
    expect(stripAnsi(output)).toBe('italic narration spanning words then plain');
    expect(output).toMatch(/3mitalic narration spanning words\x1b\[0;38;5;120m then/);
  });

  it('leaves snake_case, a lone asterisk, and escaped markers literal', async () => {
    const output = await render(skinnyai, 'snake_case_name and 5 * 3 = 15 and \\*not italic\\*');
    expect(stripAnsi(output)).toBe('snake_case_name and 5 * 3 = 15 and *not italic*');
    expect(output).not.toMatch(/;3m/);
  });

  it('turns common LaTeX in $...$ into Unicode and leaves prices, unclosed $, and unknown commands alone', async () => {
    const output = await render(skinnyai, 'Go $\\to$ there, $\\alpha \\times 2$ $USD $x$, $\\text{km}/\\mathrm{h}$, $\\frac{a}{b}$. $5, \\$7.');
    expect(stripAnsi(output)).toBe('Go → there, α × 2 $USD x, km/h, \\frac{a}{b}. $5, $7.');
  });

  it('treats __dunder__ as bold, like CommonMark', async () => {
    const output = await render(skinnyai, 'and __dunder__ is bold');
    expect(stripAnsi(output)).toBe('and dunder is bold');
    expect(output).toMatch(/1mdunder/);
  });

  it("doesn't style markers inside inline code", async () => {
    const output = await render(skinnyai, 'run `a *b* c` now');
    expect(stripAnsi(output)).toBe('run a *b* c now');
  });

  it("doesn't let an unclosed marker bleed into the next line", async () => {
    const output = await render(skinnyai, '*unclosed\nnext line');
    expect(output).toMatch(/\n\x1b\[0;38;5;120mnext line/);
  });
});

describe('blocks', () => {
  it('renders headings bold without the #s', async () => {
    const output = await render(skinnyai, '## Getting started\nbody');
    expect(stripAnsi(output)).toBe('Getting started\nbody');
    expect(output).toMatch(/1mGetting/);
  });

  it('gives numbered lists a hanging indent matched to the marker width', async () => {
    const lines = await screen(
      '1. First item that is long enough to wrap onto a second line so we can check the hanging indent.\n' +
      '10. Tenth item, also quite long so that it wraps around the terminal edge and shows alignment.'
    );
    expect(lines).toEqual([
      '1. First item that is long enough to wrap onto a second line',
      '   so we can check the hanging indent.',
      '10. Tenth item, also quite long so that it wraps around the',
      '    terminal edge and shows alignment.'
    ]);
  });

  it('turns -, *, and + bullets into • (◦ when indented) with a hanging indent', async () => {
    const lines = await screen(
      '- A bullet point that is also long enough to wrap onto the next line with a clean margin.\n' +
      '  - Nested bullet here.\n* Star bullet\n+ Plus bullet'
    );
    expect(lines).toEqual([
      '• A bullet point that is also long enough to wrap onto the',
      '  next line with a clean margin.',
      '  ◦ Nested bullet here.',
      '• Star bullet',
      '• Plus bullet'
    ]);
  });

  it('draws block quotes with a bar that continues onto wrapped lines', async () => {
    const lines = await screen('> A block quote that goes on for a while so that it will need to wrap to a second line.');
    expect(lines).toEqual([
      '│ A block quote that goes on for a while so that it will',
      '│ need to wrap to a second line.'
    ]);
  });

  it('draws a full-width rule for ---, and a rule with no content does not crash', async () => {
    const lines = await screen('before\n\n---\n\nafter');
    expect(lines).toEqual(['before', '', '─'.repeat(60), '', 'after']);
  });

  it('shows fenced code unwrapped on a full-width background, hiding the fences', async () => {
    const code = '```python\ndef hello():\n    print("hi *not italic*")\n```\nDone.';
    const output = await render(skinnyai, code);
    expect(stripAnsi(output)).toBe(' python\ndef hello():\n    print("hi *not italic*")\n\nDone.');
    expect(output).toMatch(/\x1b\[48;5;236m\x1b\[38;5;117m {4}print\("hi \*not italic\*"\)\x1b\[K\x1b\[0m\n/);
    expect(output).toMatch(/\x1b\[48;5;236m\x1b\[38;5;244m python\x1b\[K\x1b\[0m\n/);
  });

  it('wraps plain text at word boundaries', async () => {
    const lines = await screen('word '.repeat(20).trim());
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(lines.join(' ')).toBe('word '.repeat(20).trim());
  });

  it('keeps counting columns correctly after a word wider than the terminal', async () => {
    // Regression: the terminal hard-wraps the long word, and the next word
    // should still fit on the line after it.
    const lines = await screen(`START ${'b'.repeat(100)} END`);
    expect(lines).toEqual(['START', 'b'.repeat(60), `${'b'.repeat(40)} END`]);
  });
});

describe('links', () => {
  it('turns [text](url) into an underlined OSC 8 hyperlink per word', async () => {
    const output = await render(skinnyai, 'See [the Node docs](https://nodejs.org/api/). Done.');
    expect(stripAnsi(output)).toBe('See the Node docs. Done.');
    for (const word of ['the', 'Node', 'docs']) {
      expect(output).toContain(`\x1b]8;;https://nodejs.org/api/\x1b\\\x1b[0;38;5;120;4m${word}\x1b]8;;\x1b\\`);
    }
  });

  it('leaves [brackets] without a URL, and links inside code, alone', async () => {
    const output = await render(skinnyai, 'Also [not a link] here and `[x](y)` in code.');
    expect(stripAnsi(output)).toBe('Also [not a link] here and [x](y) in code.');
    expect(output).not.toContain('\x1b]8;;');
  });

  it('shows links with other schemes as plain text', async () => {
    const output = await render(skinnyai, '[bad](javascript:alert) text');
    expect(stripAnsi(output)).toBe('bad text');
    expect(output).not.toContain('\x1b]8;;');
  });
});

describe('streaming', () => {
  const sample = [
    '# Title', '', 'Some **bold** and *italic* text with a [link](https://example.com).', '',
    '1. First item that wraps around because it is quite long indeed.', '- bullet', '> quote', '---',
    '| a | b |', '|---|---|', '| 1 | 2 |', '', '```', 'code *x*', '```', 'Done.'
  ].join('\n');

  it('produces the same output however the text is split into chunks', async () => {
    const reference = await render(skinnyai, sample, { chunk: 1 });
    for (const chunk of [2, 3, 5, 7, 50, sample.length]) {
      expect(await render(skinnyai, sample, { chunk })).toBe(reference);
    }
  });

  it('passes text through raw with markdown off', async () => {
    expect(await render(skinnyai, sample, { markdown: false })).toBe(sample);
  });

  it('passes text through raw when stdout is not a terminal', async () => {
    process.stdout.isTTY = false;
    try {
      expect(await render(skinnyai, sample)).toBe(sample);
    } finally {
      process.stdout.isTTY = true;
    }
  });
});

describe('styleLine', () => {
  it('styles echoed user input per line', () => {
    const capture = captureOutput();
    capture.stop();
    const styled = skinnyai.styleLine('user', 'hi *there*\nline **two**');
    expect(stripAnsi(styled)).toBe('hi there\nline two');
    expect(styled).toMatch(/\x1b\[0;38;5;136;3mthere/);
  });
});

describe('terminal escapes in model text', () => {
  it('stripControls removes ESC and C1 controls but keeps newlines and tabs', async () => {
    const { stripControls } = await import('../src/style.js');
    expect(stripControls('a\x1b]52;c;QQ==\x07b\x1b[2J\u009b31mc\r\nd\te')).toBe('a]52;c;QQ==b[2J31mc\nd\te');
  });
});

describe('rendered output', () => {
  it('never carries a model-written escape sequence to the terminal', async () => {
    const output = await render(skinnyai, 'hi \x1b]52;c;ZXZpbA==\x07 \x1b]2;x\x07\n\n```\ncode \x1b[2J\n```\n');
    expect(output).not.toMatch(/\x1b\](?!8;;)/);
    expect(output).not.toContain('\x1b[2J');
    expect(output).not.toContain('\x07');
  });
});
