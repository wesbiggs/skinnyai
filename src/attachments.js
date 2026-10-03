import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './config.js';
import { sniffImage } from './images.js';

// --- Files attached to your messages (drag a file into the terminal, or /attach) ---
//
// Images go to any API that takes them. PDFs go to Anthropic (document
// blocks) and OpenAI (file parts). Text files are pasted into the message
// itself, so they work everywhere and are saved with the session. Other
// kinds of file can't be sent by these APIs, so they're refused.

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 300 * 1024;
export const IMAGE_MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// What a file is, from its contents: { kind: 'image' | 'pdf' | 'text', mime }, or null.
export function classifyFile(bytes) {
  const image = sniffImage(bytes);
  if (image) return { kind: 'image', mime: IMAGE_MIME[image.format] };
  if (bytes.length >= 5 && bytes.toString('latin1', 0, 5) === '%PDF-') return { kind: 'pdf', mime: 'application/pdf' };
  if (!bytes.subarray(0, 8192).includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { kind: 'text', mime: 'text/plain' };
    } catch (e) { /* not UTF-8 */ }
  }
  return null;
}

// Terminals turn a dropped file into its path in the input: backslash-escaped
// (Terminal.app, iTerm2), quoted, or a file:// URL. A token that looks like a
// path is only taken when it names an existing file of a kind we can send;
// anything else stays in the message as typed. Returns the message without
// those paths, and the attachments as { kind, name, mime, data } (base64
// `data`, or `text` for a text file); `skipped` explains any file that was
// found but couldn't be attached.
//   anyFile   false: only images are taken (a path in ordinary prose
//             shouldn't upload a file); true: PDFs and text files too, for
//             when the user clearly means it (a paste, or /attach).
//   complete  false while the message is still being typed: whitespace is
//             left as is, and problems aren't reported.
//   allowEnd  a path at the very end counts (default only when complete);
//             otherwise it may be unfinished.
export function extractAttachments(text, { anyFile = false, complete = true, allowEnd = complete } = {}) {
  const attachments = [];
  const skipped = [];
  const tokens = /'([^']*)'|"([^"]*)"|((?:\\[\s\S]|[^\s\\])+)/g;
  let out = '';
  let last = 0;
  for (const match of text.matchAll(tokens)) {
    if (!allowEnd && match.index + match[0].length >= text.length) continue;
    if (match.index < last) continue;
    let candidate = match[1] ?? match[2] ?? match[3].replace(/\\([\s\S])/g, '$1');
    if (/^file:\/\//i.test(candidate)) {
      try { candidate = decodeURIComponent(new URL(candidate).pathname); } catch (e) { continue; }
    } else if (candidate.startsWith('~/')) {
      candidate = path.join(os.homedir(), candidate.slice(2));
    }
    if (!path.isAbsolute(candidate)) continue;
    const name = path.basename(candidate);
    let bytes;
    let size;
    try {
      const stat = statSync(candidate);
      if (!stat.isFile()) continue;
      size = stat.size;
      if (size > MAX_ATTACHMENT_BYTES) {
        if (complete && (anyFile || /\.(png|jpe?g|gif|webp)$/i.test(candidate))) {
          skipped.push(`${name} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
        }
        continue;
      }
      bytes = readFileSync(candidate);
    } catch (e) {
      continue;
    }
    const type = classifyFile(bytes);
    if (!type) {
      if (anyFile && complete) skipped.push(`${name} isn't an image, PDF, or text file, which are the kinds that can be sent`);
      continue;
    }
    if (type.kind !== 'image' && !anyFile) continue;
    if (type.kind === 'text' && size > MAX_TEXT_ATTACHMENT_BYTES) {
      if (complete) skipped.push(`${name} is larger than ${MAX_TEXT_ATTACHMENT_BYTES / 1024} KB, too much text to paste into a message`);
      continue;
    }
    attachments.push(type.kind === 'text'
      ? { ...type, name, text: bytes.toString('utf8') }
      : { ...type, name, data: bytes.toString('base64') });
    out += text.slice(last, match.index);
    last = match.index + match[0].length;
    while (!complete && /[ \t]/.test(text[last] ?? '')) last++; // drop the gap the path leaves
  }
  out += text.slice(last);
  return { text: complete ? out.replace(/[ \t]{2,}/g, ' ').trim() : out, attachments, skipped };
}

// A text file as it appears in the message: after a marker line, in a fence
// longer than any run of backticks inside the file.
export function inlineFile(name, content) {
  const longest = Math.max(2, ...(content.match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `[attached file: ${name}]\n${fence}\n${content.replace(/\n$/, '')}\n${fence}`;
}
export const INLINE_FILE = /\n*\[attached file: ([^\]\n]+)\]\n(`{3,})\n[\s\S]*?\n\2/g;
