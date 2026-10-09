import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeTTY, render, stripAnsi } from './helpers/tty.js';

let skinnyai;

beforeAll(async () => {
  fakeTTY({ columns: 60, rows: 40 });
  process.env.TERM_PROGRAM = 'iTerm.app'; // image support is detected at load
  skinnyai = await import('./helpers/skinny.js');
});

// Just enough of each format for sniffImage: the signature and the size.
function fakePng(width, height) {
  const bytes = Buffer.alloc(33);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function fakeGif(width, height) {
  const bytes = Buffer.alloc(13);
  bytes.write('GIF89a', 0, 'latin1');
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function fakeJpeg(width, height) {
  // SOI, an APP0 segment to skip over, then a baseline start-of-frame.
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0
  ]);
}

const dataUrl = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;

describe('sniffImage', () => {
  it('reads PNG, GIF, and JPEG sizes', () => {
    expect(skinnyai.sniffImage(fakePng(152, 90))).toEqual({ format: 'png', width: 152, height: 90 });
    expect(skinnyai.sniffImage(fakeGif(10, 20))).toEqual({ format: 'gif', width: 10, height: 20 });
    expect(skinnyai.sniffImage(fakeJpeg(640, 480))).toEqual({ format: 'jpeg', width: 640, height: 480 });
  });

  it('recognizes WebP, and rejects anything else (like SVG)', () => {
    expect(skinnyai.sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toEqual({ format: 'webp' });
    expect(skinnyai.sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });
});

describe('imageSequence', () => {
  it('uses the iTerm2 protocol, scaled from pixels to rows', () => {
    const bytes = fakePng(152, 152);
    const sequence = skinnyai.imageSequence({ bytes, ...skinnyai.sniffImage(bytes) }, 'iterm');
    expect(sequence).toBe(`\x1b]1337;File=inline=1;size=${bytes.length};height=10;preserveAspectRatio=1:${bytes.toString('base64')}\x07\n`);
  });

  it('caps the height to fit the terminal and scales to its width', () => {
    const tall = fakePng(100, 4000);
    expect(skinnyai.imageSequence({ bytes: tall, ...skinnyai.sniffImage(tall) }, 'iterm')).toContain('height=24;');
    const wide = fakePng(2000, 160); // 250 columns at natural size: scaled to 60
    expect(skinnyai.imageSequence({ bytes: wide, ...skinnyai.sniffImage(wide) }, 'iterm')).toContain('height=2;');
  });

  it('uses the kitty protocol in 4 KB chunks, asking the terminal not to reply', () => {
    const bytes = Buffer.concat([fakePng(16, 16), Buffer.alloc(7000)]);
    const sequence = skinnyai.imageSequence({ bytes, ...skinnyai.sniffImage(bytes) }, 'kitty');
    const chunks = [...sequence.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
    expect(chunks.map((m) => m[1])).toEqual(['a=T,f=100,q=2,r=1,m=1', 'm=1', 'm=0']);
    expect(chunks.map((m) => m[2]).join('')).toBe(bytes.toString('base64'));
  });
});

describe('local image files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyai-local-'));
  const file = path.join(dir, 'my pic.png');
  fs.writeFileSync(file, fakePng(32, 32));

  it('loads an absolute path, a ~ path, and a file:// URL', async () => {
    expect((await skinnyai.loadImage(file)).format).toBe('png');
    expect((await skinnyai.loadImage(`file://${file.replace(/ /g, '%20')}`)).width).toBe(32);
    const home = fs.mkdtempSync(path.join(os.homedir(), '.skinnyai-test-'));
    try {
      fs.writeFileSync(path.join(home, 'a.png'), fakePng(8, 8));
      expect((await skinnyai.loadImage(`~/${path.basename(home)}/a.png`)).width).toBe(8);
    } finally {
      fs.rmSync(home, { recursive: true });
    }
  });

  it('refuses things that are not images, and missing files', async () => {
    fs.writeFileSync(path.join(dir, 'note.txt'), 'hello');
    await expect(skinnyai.loadImage(path.join(dir, 'note.txt'))).rejects.toThrow('not a PNG');
    await expect(skinnyai.loadImage(path.join(dir, 'nope.png'))).rejects.toThrow();
    await expect(skinnyai.loadImage(dir)).rejects.toThrow('not a file');
  });

  it('draws one mentioned in markdown', async () => {
    const out = await render(skinnyai, `![Generated](${path.join(dir, 'x.png')})\n`, { images: true });
    expect(stripAnsi(out)).toContain("couldn't show image"); // no such file, reported in place of the image
    const fine = await render(skinnyai, `![Generated](${file.replace(/ /g, '%20')})\n`, { images: true });
    expect(fine).toContain('\x1b]1337;File=inline=1');
  });
});

describe('images in markdown', () => {
  it('draws a data: image after the line that mentions it, with a caption', async () => {
    const png = fakePng(152, 152);
    const output = await render(skinnyai, `An icon: ![app icon](${dataUrl(png)}) inline.\nNext line.`, { images: true, chunk: 50 });
    expect(stripAnsi(output)).toBe('An icon: 🖼️ app icon inline.\n\nNext line.');
    const lines = output.split('\n');
    expect(stripAnsi(lines[0])).toBe('An icon: 🖼️ app icon inline.');
    expect(lines[1]).toContain(`\x1b]1337;File=inline=1;size=${png.length};`);
  });

  it('refuses local and private addresses', async () => {
    const output = await render(skinnyai, '![local](http://127.0.0.1/x.png)', { images: true });
    expect(stripAnsi(output)).toContain("(couldn't show image: refusing to fetch 127.0.0.1: it resolves to a local or private network address (add it to SKINNY_TRUSTED_HOSTS to allow it))");
  });

  it('lets SKINNY_TRUSTED_HOSTS through, subdomains included', async () => {
    process.env.SKINNY_TRUSTED_HOSTS = 'other.test, 127.0.0.1';
    try {
      const output = await render(skinnyai, '![local](http://127.0.0.1:9/x.png)', { images: true });
      expect(stripAnsi(output)).not.toContain('refusing to fetch'); // it tried, and failed to connect
      process.env.SKINNY_TRUSTED_HOSTS = '*.localhost';
      const sub = await render(skinnyai, '![local](http://a.localhost:9/x.png)', { images: true });
      expect(stripAnsi(sub)).not.toContain('refusing to fetch');
      const other = await render(skinnyai, '![local](http://127.0.0.2:9/x.png)', { images: true });
      expect(stripAnsi(other)).toContain('refusing to fetch');
    } finally {
      delete process.env.SKINNY_TRUSTED_HOSTS;
    }
  });

  it('reports images it cannot decode instead of failing the response', async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`;
    const output = await render(skinnyai, `![logo](${svg}) after`, { images: true });
    expect(stripAnsi(output)).toContain("(couldn't show image: not a PNG, JPEG, GIF, or WebP image)");
  });

  it('shows images as clickable captions when images are off', async () => {
    const output = await render(skinnyai, 'See ![chart](https://example.com/c.png) and ![](https://example.com/d.png).');
    expect(stripAnsi(output)).toBe('See 🖼️ chart and 🖼️ https://example.com/d.png.');
    expect(output).toContain('\x1b]8;;https://example.com/c.png\x1b\\');
    expect(output).not.toContain('1337');
  });

  it('leaves a ! that does not start an image alone', async () => {
    const output = await render(skinnyai, 'Wow! !bang and ![x] y and a [link](https://a.b)!', { images: true });
    expect(stripAnsi(output)).toBe('Wow! !bang and ![x] y and a link!');
  });

  it('keeps long data: URLs together while they stream in', async () => {
    const png = Buffer.concat([fakePng(8, 8), Buffer.alloc(4000)]); // well over the 2000-character link limit
    const output = await render(skinnyai, `![big](${dataUrl(png)})`, { images: true, chunk: 1 });
    expect(output).toContain(`size=${png.length};`);
  });
});
