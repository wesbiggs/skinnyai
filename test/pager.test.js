import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageText, withPager } from '../src/pager.js';

let out;
const tty = (value) => [process.stdin, process.stdout].forEach((s) => Object.defineProperty(s, 'isTTY', { value, configurable: true }));
const numbered = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

beforeEach(() => {
  out = '';
  tty(true);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += chunk), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  tty(undefined);
});

describe('pageText', () => {
  it('prints short text straight through', async () => {
    const readKey = vi.fn();
    await pageText(numbered(5), { readKey, rows: 10, columns: 80 });
    expect(out).toBe(numbered(5));
    expect(readKey).not.toHaveBeenCalled();
  });

  it('stops after each screen and continues on Space', async () => {
    const keys = ['space', 'space'];
    const readKey = vi.fn(async () => keys.shift());
    await pageText(numbered(25), { readKey, rows: 10, columns: 80 });
    expect(readKey).toHaveBeenCalledTimes(2);
    expect(out).toContain('line 25\n');
    expect(out.indexOf('line 9\n')).toBeLessThan(out.indexOf(':'));
  });

  it('shows one more line on Enter', async () => {
    const keys = ['enter', 'quit'];
    const readKey = vi.fn(async () => keys.shift());
    await pageText(numbered(25), { readKey, rows: 10, columns: 80 });
    expect(out).toContain('line 10\n');
    expect(out).not.toContain('line 11\n');
  });

  it('stops for good on q', async () => {
    await pageText(numbered(25), { readKey: async () => 'quit', rows: 10, columns: 80 });
    expect(out).toContain('line 9\n');
    expect(out).not.toContain('line 10\n');
  });

  it('counts wrapped lines as several rows', async () => {
    const readKey = vi.fn(async () => 'quit');
    await pageText(`${'x'.repeat(200)}\n`.repeat(5), { readKey, rows: 10, columns: 80 });
    expect(readKey).toHaveBeenCalledTimes(1);
  });

  it('does nothing special when stdout is not a terminal', async () => {
    tty(false);
    const readKey = vi.fn();
    await pageText(numbered(100), { readKey, rows: 10, columns: 80 });
    expect(out).toBe(numbered(100));
    expect(readKey).not.toHaveBeenCalled();
  });
});

describe('withPager', () => {
  it('runs the function unchanged when disabled', async () => {
    await withPager(false, async () => process.stdout.write('hello\n'));
    expect(out).toBe('hello\n');
  });

  it('returns what the function returns', async () => {
    expect(await withPager(true, async () => 42)).toBe(42);
  });
});

describe('createReplyPager', () => {
  it('holds a long reply at the end of the screen until a key is pressed', async () => {
    const { createReplyPager } = await import('../src/pager.js');
    const keys = ['space'];
    const readKey = vi.fn(async () => keys.shift());
    const pager = createReplyPager({ readKey, rows: 6, columns: 80 });
    process.stdout.write(numbered(8));
    expect(out).toContain('line 5\n');
    expect(out).not.toContain('line 6\n');
    await pager.wait();
    expect(readKey).toHaveBeenCalledTimes(1);
    expect(out).toContain('line 6\n');
    await pager.close();
  });

  it('keeps asking while text keeps arriving, and drops the rest on q', async () => {
    const { createReplyPager } = await import('../src/pager.js');
    const pager = createReplyPager({ readKey: async () => 'quit', rows: 6, columns: 80 });
    process.stdout.write(numbered(3));
    process.stdout.write(numbered(12));
    await pager.wait();
    process.stdout.write('after\n');
    await pager.close();
    expect(out).not.toContain('line 6\n');
    expect(out).not.toContain('after');
    expect(out).toContain('/page');
  });

  it('does not ask when the reply fits', async () => {
    const { createReplyPager } = await import('../src/pager.js');
    const readKey = vi.fn();
    const pager = createReplyPager({ readKey, rows: 20, columns: 80 });
    process.stdout.write(numbered(5));
    await pager.wait();
    await pager.close();
    expect(readKey).not.toHaveBeenCalled();
    expect(out).toBe(numbered(5));
  });
});

describe('going back', () => {
  it('redraws the page before and then carries on', async () => {
    const { createReplyPager } = await import('../src/pager.js');
    const keys = ['space', 'back', 'space', 'space'];
    const readKey = vi.fn(async () => keys.shift());
    const pager = createReplyPager({ readKey, rows: 6, columns: 80 });
    process.stdout.write(numbered(12));
    await pager.wait();
    const second = out.indexOf('line 10\n');
    expect(second).toBeGreaterThan(-1);
    expect(out.slice(second)).toContain('\x1b[H\x1b[2J'); // back redrew page one
    expect(out.slice(out.indexOf('\x1b[2J'))).toMatch(/^\x1b\[2Jline 1\nline 2\n/);
    expect(out.endsWith('line 12\n')).toBe(true);
    await pager.close();
  });

  it('puts the colors back after the prompt', async () => {
    const { createReplyPager } = await import('../src/pager.js');
    const green = '\x1b[0;38;5;120m';
    const keys = ['space'];
    const pager = createReplyPager({ readKey: async () => keys.shift(), rows: 4, columns: 80 });
    process.stdout.write(`${green}one\ntwo\nthree\nfour\n`);
    await pager.wait();
    expect(out).toMatch(new RegExp(`\\r\\x1b\\[2K(\\x1b\\[0m)?${green.replace('[', '\\[')}four`));
    await pager.close();
  });
});
