import fs from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureOutput, fakeTTY, FakeStdin, KEYS, setColumns, Terminal } from './helpers/tty.js';

let skinnyai;
let stdin;
let capture;

beforeAll(async () => {
  fakeTTY({ columns: 70 });
  skinnyai = await import('./helpers/skinny.js');
});

beforeEach(() => {
  setColumns(70);
  stdin = new FakeStdin().install();
  capture = captureOutput();
});

afterEach(() => {
  capture.stop();
  stdin.uninstall();
});

// Types `keys` into a fresh editLine() and returns what it resolved with,
// plus the screen as a 70-column terminal would show it.
async function edit(chat, ...keys) {
  const start = capture.text.length;
  const result = chat.editLine();
  await stdin.type(...keys);
  const text = await result;
  const terminal = new Terminal(70, { widthOf: skinnyai.graphemeWidth }).write(capture.text.slice(start));
  return { text, screen: terminal.screen, cursor: terminal.cursor };
}

const newChat = () => new skinnyai.OllamaChat('m', {});

describe('line editor', () => {
  it('submits on Enter and echoes the prompt and text', async () => {
    const { text, screen } = await edit(newChat(), 'hello', KEYS.enter);
    expect(text).toBe('hello');
    expect(screen[0]).toBe('> hello');
  });

  it('inserts in the middle of the line after moving the cursor', async () => {
    const { text, screen } = await edit(newChat(), 'helo world', KEYS.left.repeat(7), 'l', KEYS.enter);
    expect(text).toBe('hello world');
    expect(screen[0]).toBe('> hello world');
  });

  it('deletes words with Ctrl+W', async () => {
    const { text } = await edit(newChat(), 'foo bar baz', KEYS.ctrlW, KEYS.ctrlW, 'qux', KEYS.enter);
    expect(text).toBe('foo qux');
  });

  it('supports Backspace, Delete, Ctrl+U, and Ctrl+K', async () => {
    const chat = newChat();
    expect((await edit(chat, 'abcd', KEYS.backspace, KEYS.left, KEYS.left, KEYS.delete, KEYS.enter)).text).toBe('ac');
    expect((await edit(chat, 'abc def', KEYS.left.repeat(3), KEYS.ctrlU, KEYS.enter)).text).toBe('def');
    expect((await edit(chat, 'abc def', KEYS.left.repeat(3), KEYS.ctrlK, KEYS.enter)).text).toBe('abc ');
  });

  it('moves by word with Ctrl+arrows and to line ends with Home/End', async () => {
    const chat = newChat();
    expect((await edit(chat, 'one two three', KEYS.ctrlLeft, KEYS.ctrlLeft, '_', KEYS.enter)).text).toBe('one _two three');
    expect((await edit(chat, 'one two', KEYS.home, '[', KEYS.end, ']', KEYS.enter)).text).toBe('[one two]');
    expect((await edit(chat, 'one two', KEYS.ctrlA, KEYS.ctrlRight, '!', KEYS.enter)).text).toBe('one! two');
  });

  it('recalls earlier messages with Up and Down, keeping the draft', async () => {
    const chat = newChat();
    await edit(chat, 'first', KEYS.enter);
    await edit(chat, 'second', KEYS.enter);
    expect((await edit(chat, KEYS.up, KEYS.up, KEYS.up, KEYS.end, '!', KEYS.enter)).text).toBe('first!');
    expect((await edit(chat, 'draft', KEYS.up, KEYS.down, KEYS.enter)).text).toBe('draft');
    expect(chat.inputHistory).toEqual(['first', 'second', 'first!', 'draft']);
  });

  it('inserts a newline with Ctrl+J, and Home works on the second line', async () => {
    const { text, screen } = await edit(newChat(), 'line one', KEYS.ctrlJ, 'line two', KEYS.home, '>', KEYS.enter);
    expect(text).toBe('line one\n>line two');
    expect(screen.slice(0, 2)).toEqual(['> line one', '>line two']);
  });

  it('moves between lines of a multi-line message with Up/Down before recalling history', async () => {
    const chat = newChat();
    await edit(chat, 'old', KEYS.enter);
    const { text } = await edit(chat, 'abc', KEYS.ctrlJ, 'defgh', KEYS.up, 'X', KEYS.down, 'Y', KEYS.enter);
    expect(text).toBe('abcX\ndefgYh');
  });

  it('keeps a bracketed paste whole, line breaks included', async () => {
    const { text } = await edit(newChat(), KEYS.paste('pasted\rtext\ttabbed'), ' more', KEYS.enter);
    expect(text).toBe('pasted\ntext\ttabbed more');
  });

  it('edits correctly when input exactly fills a row and wraps', async () => {
    // "> " + 68 characters fills the 70-column row; inserting one more wraps.
    const { text, screen, cursor } = await edit(newChat(), 'a'.repeat(68), KEYS.left.repeat(3), 'X', KEYS.enter);
    expect(text).toBe(`${'a'.repeat(65)}X${'a'.repeat(3)}`);
    expect(screen.slice(0, 2)).toEqual([`> ${'a'.repeat(65)}X${'a'.repeat(2)}`, 'a']);
    expect(cursor).toEqual({ row: 2, col: 0 });
  });

  it('handles input that fills the row exactly without wrapping early', async () => {
    const { screen, cursor } = await edit(newChat(), 'b'.repeat(68), KEYS.enter);
    expect(screen.slice(0, 2)).toEqual([`> ${'b'.repeat(68)}`, '']);
    expect(cursor).toEqual({ row: 2, col: 0 });
  });

  it('wraps wide characters and keeps the cursor in step with them', async () => {
    const phrase = 'wide 日本語テキスト';
    const { text, screen } = await edit(newChat(), phrase.repeat(6), KEYS.left.repeat(20), '!', KEYS.enter);
    const expected = phrase.repeat(6);
    const at = [...expected].length - 20;
    expect(text).toBe([...expected].slice(0, at).join('') + '!' + [...expected].slice(at).join(''));
    expect(screen.slice(0, 2).join('')).toBe(`> ${text}`);
    expect(screen.every((line) => skinnyai.visibleWidth(line) <= 70)).toBe(true);
  });

  it('treats an emoji cluster as one character', async () => {
    const chat = newChat();
    expect((await edit(chat, 'a⚠️', KEYS.backspace, 'b', KEYS.enter)).text).toBe('ab');
    expect((await edit(chat, 'a👩‍💻b', KEYS.left, KEYS.left, KEYS.delete, KEYS.enter)).text).toBe('ab');
  });

  it('returns null for Ctrl+D on an empty line, but deletes forward otherwise', async () => {
    const chat = newChat();
    expect((await edit(chat, KEYS.ctrlD)).text).toBeNull();
    expect((await edit(chat, 'abc', KEYS.home, KEYS.ctrlD, KEYS.enter)).text).toBe('bc');
  });

  it('turns bracketed paste on while editing and off afterwards', async () => {
    const start = capture.text.length;
    await edit(newChat(), 'x', KEYS.enter);
    const output = capture.text.slice(start);
    expect(output).toContain('\x1b[?2004h');
    expect(output.lastIndexOf('\x1b[?2004l')).toBeGreaterThan(output.lastIndexOf('\x1b[?2004h'));
    expect(stdin.isRaw).toBe(false);
  });
});

describe('confirm', () => {
  it('takes a single keypress, and only y means yes', async () => {
    const chat = newChat();
    for (const [key, expected] of [['y', true], ['Y', true], ['n', false], ['x', false], ['\r', false]]) {
      const answer = chat.confirm('Overwrite?');
      await stdin.type(key);
      expect(await answer).toBe(expected);
    }
    expect(capture.text).toContain('Overwrite? [y/N] yes\n');
    expect(capture.text).toContain('Overwrite? [y/N] no\n');
  });
});

describe('Shift+Enter', () => {
  it('inserts a newline when the terminal reports it as a CSI-u key (kitty protocol)', async () => {
    const { text, screen } = await edit(newChat(), 'one', '\x1b[13;2u', 'two', KEYS.enter);
    expect(text).toBe('one\ntwo');
    expect(screen.slice(0, 2)).toEqual(['> one', 'two']);
  });

  it('asks the terminal for key reports while editing, and turns them off at the end', async () => {
    const start = capture.text.length;
    await edit(newChat(), 'x', KEYS.enter);
    const written = capture.text.slice(start);
    expect(written).toContain('\x1b[>1u');
    expect(written.lastIndexOf('\x1b[<u')).toBeGreaterThan(written.indexOf('\x1b[>1u'));
  });

  it('treats Ctrl+J as a newline when reported as a CSI-u key too', async () => {
    expect((await edit(newChat(), 'a', '\x1b[106;5u', 'b', KEYS.enter)).text).toBe('a\nb');
  });

  it('still understands other keys reported that way: plain Enter submits, Ctrl+W deletes a word', async () => {
    expect((await edit(newChat(), 'hi', '\x1b[13u')).text).toBe('hi');
    expect((await edit(newChat(), 'foo bar', '\x1b[119;5u', KEYS.enter)).text).toBe('foo ');
  });
});

describe('dragged-in images', () => {
  
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);

  function image(name) {
    const dir = fs.mkdtempSync(`${process.env.TMPDIR || '/tmp'}/skinnyai-drop-`);
    fs.writeFileSync(`${dir}/${name}`, png);
    return `${dir}/${name}`;
  }

  it('turns a pasted path into a chip above the prompt, leaving the text', async () => {
    const chat = newChat();
    const file = image('my pic.png');
    const { text, screen } = await edit(chat, 'what is ', KEYS.paste(file.replace(/ /g, '\\ ')), 'this', KEYS.enter);
    expect(text).toBe('what is this');
    expect(screen[0]).toBe('📎 my pic.png');
    expect(screen[1]).toBe('> what is this');
    expect(chat.pendingFiles.map((i) => i.name)).toEqual(['my pic.png']);
  });

  it('catches a path that arrives as typed characters once a space follows', async () => {
    const chat = newChat();
    const file = image('a.png');
    const { text, screen } = await edit(chat, `${file} look`, KEYS.enter);
    expect(text).toBe('look');
    expect(screen[0]).toBe('📎 a.png');
    expect(chat.pendingFiles).toHaveLength(1);
  });

  it('removes the last image with Backspace on an empty line', async () => {
    const chat = newChat();
    const { text, screen } = await edit(chat, KEYS.paste(image('a.png')), KEYS.backspace, 'hi', KEYS.enter);
    expect(text).toBe('hi');
    expect(chat.pendingFiles).toEqual([]);
    expect(screen.at(-1)).toBe('> hi');
  });

  it('takes any file we can send when it is pasted, but only images when typed', async () => {
    const dir = fs.mkdtempSync(`${process.env.TMPDIR || '/tmp'}/skinnyai-drop-`);
    fs.writeFileSync(`${dir}/notes.txt`, 'hello');
    const pasted = newChat();
    const { text } = await edit(pasted, KEYS.paste(`${dir}/notes.txt`), KEYS.enter);
    expect(text).toBe('');
    expect(pasted.pendingFiles.map((f) => [f.kind, f.name])).toEqual([['text', 'notes.txt']]);

    const typed = newChat();
    const typedResult = await edit(typed, `read ${dir}/notes.txt please`, KEYS.enter);
    expect(typedResult.text).toBe(`read ${dir}/notes.txt please`);
    expect(typed.pendingFiles).toEqual([]);
  });

  it('leaves paths to files we cannot send, and missing files, as text', async () => {
    const dir = fs.mkdtempSync(`${process.env.TMPDIR || '/tmp'}/skinnyai-drop-`);
    fs.writeFileSync(`${dir}/blob.bin`, Buffer.from([0, 1, 2, 3, 255, 254]));
    expect((await edit(newChat(), KEYS.paste(`${dir}/blob.bin`), KEYS.enter)).text).toBe(`${dir}/blob.bin`);
    expect((await edit(newChat(), KEYS.paste('/no/such/file.txt'), KEYS.enter)).text).toBe('/no/such/file.txt');
  });
});
