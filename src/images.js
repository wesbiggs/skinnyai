import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import './config.js';
import { MAX_ATTACHMENT_BYTES } from './attachments.js';
import { ANSI, CHROME_COLOR } from './style.js';
import { MAX_FETCH_BYTES, fetchPublic, readCappedBytes } from './tools.js';

// Inline images, for markdown ![alt](url). Two escape-sequence protocols
// cover the terminals that can draw them: iTerm2's (the one imgcat uses;
// also WezTerm) and kitty's graphics protocol (kitty, Ghostty). Returns
// null for other terminals, and inside tmux/screen, which don't pass these
// sequences through.
export function detectImageProtocol() {
  const env = process.env;
  if (!process.stdout.isTTY || env.TMUX || /^screen/.test(env.TERM || '')) return null;
  if (env.TERM_PROGRAM === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2' || env.TERM_PROGRAM === 'WezTerm' || env.TERM_PROGRAM === 'SkinnyAI') return 'iterm';
  if (env.TERM === 'xterm-kitty' || env.KITTY_WINDOW_ID || env.TERM_PROGRAM === 'ghostty') return 'kitty';
  return null;
}
export const IMAGE_PROTOCOL = detectImageProtocol();

// Identifies an image by its magic bytes and reads its pixel size.
// Returns null for anything that isn't a PNG, GIF, JPEG, or WebP.
export function sniffImage(bytes) {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && bytes.toString('latin1', 0, 4) === 'GIF8') {
    return { format: 'gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return { format: 'webp' }; // size varies by encoding; not needed to draw it
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Walk the JPEG segments to the start-of-frame, which holds the size.
    for (let i = 2; i + 9 < bytes.length;) {
      if (bytes[i] !== 0xff) break;
      const marker = bytes[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { format: 'jpeg', width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
      }
      i += 2 + bytes.readUInt16BE(i + 2);
    }
    return { format: 'jpeg' };
  }
  return null;
}

// The file an image reference points to, if it's a local one: an absolute
// path, ~/path, or file:// URL (percent-encoded paths are decoded). Else null.
export function localImagePath(reference) {
  if (/^file:\/\//i.test(reference)) {
    try { return decodeURIComponent(new URL(reference).pathname); } catch (e) { return null; }
  }
  const plain = reference.startsWith('~/') ? path.join(os.homedir(), reference.slice(2)) : reference;
  if (!path.isAbsolute(plain)) return null;
  try { return decodeURIComponent(plain); } catch (e) { return plain; }
}

// Loads an image from an http(s) or data: URL, or a local file. Web images get the same
// guards as fetch_page: public addresses only, and a size cap.
export async function loadImage(url) {
  let bytes;
  const data = /^data:image\/[\w.+-]+;base64,(.*)$/is.exec(url);
  const local = localImagePath(url);
  if (data) {
    bytes = Buffer.from(data[1], 'base64');
  } else if (local) {
    // A file on this machine (say, one an image-generating tool just wrote).
    // It's only drawn on your own screen, never sent anywhere.
    const stat = await fs.stat(local);
    if (!stat.isFile()) throw new Error('not a file');
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    bytes = await fs.readFile(local);
  } else {
    const { res } = await fetchPublic(new URL(url), 'image/png,image/jpeg,image/gif,image/webp;q=0.9,image/*;q=0.5');
    const read = await readCappedBytes(res);
    if (read.truncated) throw new Error(`larger than ${MAX_FETCH_BYTES / 1024 / 1024} MB`);
    bytes = read.bytes;
  }
  const info = sniffImage(bytes);
  if (!info) throw new Error('not a PNG, JPEG, GIF, or WebP image');
  return { bytes, ...info };
}

// Escape sequence that draws an image at the cursor, scaled down to fit
// the terminal width and at most ~60% of its height, followed by a newline.
// Pixel-to-cell conversion assumes a typical 8x16 cell, since terminals
// don't report their cell size in a way Node can read.
export function imageSequence(image, protocol = IMAGE_PROTOCOL) {
  const columns = process.stdout.columns || 80;
  const maxRows = Math.max(4, Math.min(30, Math.floor((process.stdout.rows || 40) * 0.6)));
  let rows = maxRows;
  if (image.width && image.height) {
    const cols = Math.ceil(image.width / 8);
    const natural = Math.ceil(image.height / 16);
    rows = Math.max(1, Math.round(natural * Math.min(1, maxRows / natural, columns / cols)));
  }
  const base64 = image.bytes.toString('base64');
  if (protocol === 'iterm') {
    return `\x1b]1337;File=inline=1;size=${image.bytes.length};height=${rows};preserveAspectRatio=1:${base64}\x07\n`;
  }
  // kitty: PNG only (f=100), sent in 4 KB chunks; q=2 stops the terminal
  // from answering on stdin, where the replies would look like keystrokes.
  let out = '';
  for (let i = 0; i < base64.length; i += 4096) {
    const more = i + 4096 < base64.length ? 1 : 0;
    const keys = i === 0 ? `a=T,f=100,q=2,r=${rows},m=${more}` : `m=${more}`;
    out += `\x1b_G${keys};${base64.slice(i, i + 4096)}\x1b\\`;
  }
  return out + '\n';
}

// Loads and draws images queued by the markdown renderer. Failures are
// reported in place of the image rather than interrupting the response.
export async function showImages(images) {
  for (const { url } of images) {
    try {
      const image = await loadImage(url);
      if (IMAGE_PROTOCOL === 'kitty' && image.format !== 'png') {
        throw new Error(`this terminal's image protocol only takes PNG (got ${image.format.toUpperCase()})`);
      }
      process.stdout.write(imageSequence(image));
    } catch (error) {
      process.stdout.write(`${CHROME_COLOR}   (couldn't show image: ${error.message})${ANSI.reset}\n`);
    }
  }
}
