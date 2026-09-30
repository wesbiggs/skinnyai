import { beforeAll, describe, expect, it } from 'vitest';
import { fakeTTY, render, setColumns, stripAnsi, Terminal } from './helpers/tty.js';

let thinai;

beforeAll(async () => {
  fakeTTY({ columns: 100 });
  thinai = await import('../bin/thinai.js');
});

async function screen(markdown, columns = 100) {
  setColumns(columns);
  const output = await render(thinai, markdown);
  // Drop the "receiving table" placeholder the table overwrites.
  const lines = new Terminal(columns, { widthOf: thinai.graphemeWidth, onlcr: true }).write(output).screen;
  return { output, lines };
}

describe('graphemeWidth', () => {
  it.each([
    ['a', 1], ['日', 2], ['é', 1], ['é', 1],
    ['✅', 2], ['❌', 2], ['🚀', 2], ['⚠️', 2], ['⚠', 1], ['1️⃣', 2],
    ['🇺🇸', 2], ['👩‍💻', 2], ['👍🏽', 2], ['©', 1]
  ])('%s is %i column(s) wide', (text, width) => {
    expect(thinai.visibleWidth(text)).toBe(width);
  });

  it('ignores SGR and hyperlink escape sequences', () => {
    expect(thinai.visibleWidth('\x1b[0;38;5;83;1mbold\x1b[0m \x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\')).toBe(9);
  });
});

describe('splitTableRow', () => {
  it('splits on pipes, trimming cells', () => {
    expect(thinai.splitTableRow('| a | b  |c|')).toEqual(['a', 'b', 'c']);
  });

  it('keeps escaped pipes and pipes inside code', () => {
    expect(thinai.splitTableRow('| a \\| b | `x|y` |')).toEqual(['a | b', '`x|y`']);
  });

  it('handles a missing space before the closing pipe', () => {
    expect(thinai.splitTableRow('| **Llama.cpp**| Local |')).toEqual(['**Llama.cpp**', 'Local']);
  });
});

describe('tables', () => {
  const table = [
    '| Name | Type | Description |',
    '|:-----|:----:|------------:|',
    '| `id` | int | The **primary** key |',
    '| name | string | A fairly long description that will surely need to be wrapped inside its cell when narrow |'
  ].join('\n');

  it('draws box borders with a bold header, a separator, and column alignment', async () => {
    const { output, lines } = await screen(table);
    expect(lines.filter((line) => line)).toEqual([
      '┌──────┬────────┬──────────────────────────────────────────────────────────────────────────────────┐',
      '│ Name │  Type  │                                                                      Description │',
      '├──────┼────────┼──────────────────────────────────────────────────────────────────────────────────┤',
      '│ id   │  int   │                                                                  The primary key │',
      '│ name │ string │    A fairly long description that will surely need to be wrapped inside its cell │',
      '│      │        │                                                                      when narrow │',
      '└──────┴────────┴──────────────────────────────────────────────────────────────────────────────────┘'
    ]);
    expect(output).toMatch(/\x1b\[0;38;5;83;1mName/);
  });

  it('shrinks the widest column to fit the terminal, wrapping its cells', async () => {
    const { lines } = await screen(table, 50);
    expect(lines.filter((line) => line)).toEqual([
      '┌──────┬────────┬────────────────────────────────┐',
      '│ Name │  Type  │                    Description │',
      '├──────┼────────┼────────────────────────────────┤',
      '│ id   │  int   │                The primary key │',
      '│ name │ string │ A fairly long description that │',
      '│      │        │ will surely need to be wrapped │',
      '│      │        │    inside its cell when narrow │',
      '└──────┴────────┴────────────────────────────────┘'
    ]);
  });

  it('keeps styling on wrapped lines of a cell', async () => {
    const { output } = await screen('|a|b|\n|-|-|\n|**header-ish long bold text that wraps**|x|', 30);
    const lines = output.split('\n');
    const continuation = lines.find((line) => stripAnsi(line).includes('text that wraps'));
    expect(continuation).toMatch(/\x1b\[0;38;5;83;1mtext that wraps/);
  });

  it('lines up borders in rows with emoji', async () => {
    const { lines } = await screen([
      '| Tool | Run Local? | API Only? |',
      '| :--- | :--- | :--- |',
      '| **Ollama** | ✅ Yes | ❌ No |',
      '| **Aider** | ⚠️ Both | ✅ Yes |',
      '| **Mods** | ❌ No | ✅ Yes |'
    ].join('\n'));
    const table = lines.filter((line) => line);
    const widths = table.map((line) => thinai.visibleWidth(line));
    expect(widths, table.join('\n')).toEqual(widths.map(() => widths[0]));
    expect(table[3]).toBe('│ Ollama │ ✅ Yes     │ ❌ No     │');
    expect(table[4]).toBe('│ Aider  │ ⚠️ Both    │ ✅ Yes    │');
  });

  it('renders the header and separator of a table with bold first-column cells', async () => {
    // The table from a real session that looked unbolded in a screenshot.
    const { output, lines } = await screen([
      '| Tool | Source | Hardware Needs | Best Use Case | Vibe |',
      '| :--- | :--- | :--- | :--- | :--- |',
      '| **Ollama** | Local | High (GPU/RAM) | Privacy & experimenting with open-source models | "Just works" |',
      '| **Llama.cpp**| Local | High (GPU/RAM) | Maximum performance & hardware tuning | "Hardcore/Manual" |'
    ].join('\n'), 90);
    expect(lines.filter((line) => line)).toEqual([
      '┌───────────┬────────┬────────────────┬──────────────────────────────┬───────────────────┐',
      '│ Tool      │ Source │ Hardware Needs │ Best Use Case                │ Vibe              │',
      '├───────────┼────────┼────────────────┼──────────────────────────────┼───────────────────┤',
      '│ Ollama    │ Local  │ High (GPU/RAM) │ Privacy & experimenting with │ "Just works"      │',
      '│           │        │                │ open-source models           │                   │',
      '│ Llama.cpp │ Local  │ High (GPU/RAM) │ Maximum performance &        │ "Hardcore/Manual" │',
      '│           │        │                │ hardware tuning              │                   │',
      '└───────────┴────────┴────────────────┴──────────────────────────────┴───────────────────┘'
    ]);
    expect(output).toMatch(/\x1b\[0;38;5;83;1mTool/);
  });

  it('shows a progress placeholder while rows arrive, then overwrites it', async () => {
    const { output, lines } = await screen('|a|b|\n|-|-|\n|1|2|\n|3|4|\n');
    expect(output).toContain('⋯ receiving table');
    expect(output).toContain('⋯ receiving table (3 rows)');
    expect(lines.join('\n')).not.toContain('receiving');
  });

  it('makes links in cells clickable, one hyperlink per word', async () => {
    const { output, lines } = await screen('| Site | Link |\n|---|---|\n| Node | [Node home page](https://nodejs.org) |');
    expect(lines[3]).toBe('│ Node │ Node home page │');
    expect(output.match(/\x1b\]8;;https:\/\/nodejs\.org\x1b\\/g)).toHaveLength(3);
  });

  it('ends a table at a blank line and starts a new one after it', async () => {
    const { lines } = await screen('|a|\n|-|\n|1|\n\n|b|\n|-|\n|2|');
    expect(lines.filter((line) => line.startsWith('┌'))).toHaveLength(2);
  });
});
