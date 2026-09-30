import { beforeAll, describe, expect, it } from 'vitest';
import { captureOutput, fakeTTY, render, setColumns, stripAnsi, Terminal } from './helpers/tty.js';

let thinai;

beforeAll(async () => {
  fakeTTY({ columns: 60 });
  thinai = await import('../bin/thinai.js');
});

// What a 60-column terminal shows after `markdown` is rendered.
async function screen(markdown, options = {}) {
  setColumns(options.columns ?? 60);
  const output = await render(thinai, markdown, options);
  return new Terminal(options.columns ?? 60, { widthOf: thinai.graphemeWidth, onlcr: true }).write(output).screen;
}

describe('inline styles', () => {
  it('renders bold, italic, strike, and code with SGR codes and hides the markers', async () => {
    const output = await render(thinai, 'Some **bold**, *italic*, ~~gone~~, and `code`.');
    expect(stripAnsi(output)).toBe('Some bold, italic, gone, and code.');
    expect(output).toMatch(/\x1b\[0;38;5;83;1mbold/);
    expect(output).toMatch(/\x1b\[0;38;5;28;3mitalic/); // italic uses the narration color
    expect(output).toMatch(/\x1b\[0;38;5;83;9mgone/);
    expect(output).toMatch(/\x1b\[0;38;5;117mcode/);
  });

  it('keeps a span going across words', async () => {
    const output = await render(thinai, '*italic narration spanning words* then plain');
    expect(stripAnsi(output)).toBe('italic narration spanning words then plain');
    expect(output).toMatch(/3mitalic narration spanning words\x1b\[0;38;5;83m then/);
  });

  it('leaves snake_case, a lone asterisk, and escaped markers literal', async () => {
    const output = await render(thinai, 'snake_case_name and 5 * 3 = 15 and \\*not italic\\*');
    expect(stripAnsi(output)).toBe('snake_case_name and 5 * 3 = 15 and *not italic*');
    expect(output).not.toMatch(/;3m/);
  });

  it('treats __dunder__ as bold, like CommonMark', async () => {
    const output = await render(thinai, 'and __dunder__ is bold');
    expect(stripAnsi(output)).toBe('and dunder is bold');
    expect(output).toMatch(/1mdunder/);
  });

  it("doesn't style markers inside inline code", async () => {
    const output = await render(thinai, 'run `a *b* c` now');
    expect(stripAnsi(output)).toBe('run a *b* c now');
  });

  it("doesn't let an unclosed marker bleed into the next line", async () => {
    const output = await render(thinai, '*unclosed\nnext line');
    expect(output).toMatch(/\n\x1b\[0;38;5;83mnext line/);
  });
});

describe('blocks', () => {
  it('renders headings bold without the #s', async () => {
    const output = await render(thinai, '## Getting started\nbody');
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

  it('shows fenced code unwrapped and unstyled, with the fences dimmed', async () => {
    const code = '```python\ndef hello():\n    print("hi *not italic*")\n```\nDone.';
    const output = await render(thinai, code);
    expect(stripAnsi(output)).toBe(code);
    expect(output).toMatch(/\x1b\[38;5;117m {4}print\("hi \*not italic\*"\)/);
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
    const output = await render(thinai, 'See [the Node docs](https://nodejs.org/api/). Done.');
    expect(stripAnsi(output)).toBe('See the Node docs. Done.');
    for (const word of ['the', 'Node', 'docs']) {
      expect(output).toContain(`\x1b]8;;https://nodejs.org/api/\x1b\\\x1b[0;38;5;83;4m${word}\x1b]8;;\x1b\\`);
    }
  });

  it('leaves [brackets] without a URL, and links inside code, alone', async () => {
    const output = await render(thinai, 'Also [not a link] here and `[x](y)` in code.');
    expect(stripAnsi(output)).toBe('Also [not a link] here and [x](y) in code.');
    expect(output).not.toContain('\x1b]8;;');
  });

  it('shows links with other schemes as plain text', async () => {
    const output = await render(thinai, '[bad](javascript:alert) text');
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
    const reference = await render(thinai, sample, { chunk: 1 });
    for (const chunk of [2, 3, 5, 7, 50, sample.length]) {
      expect(await render(thinai, sample, { chunk })).toBe(reference);
    }
  });

  it('passes text through raw with markdown off', async () => {
    expect(await render(thinai, sample, { markdown: false })).toBe(sample);
  });

  it('passes text through raw when stdout is not a terminal', async () => {
    process.stdout.isTTY = false;
    try {
      expect(await render(thinai, sample)).toBe(sample);
    } finally {
      process.stdout.isTTY = true;
    }
  });
});

describe('styleLine', () => {
  it('styles echoed user input per line', () => {
    const capture = captureOutput();
    capture.stop();
    const styled = thinai.styleLine('user', 'hi *there*\nline **two**');
    expect(stripAnsi(styled)).toBe('hi there\nline two');
    expect(styled).toMatch(/\x1b\[0;38;5;136;3mthere/);
  });
});
