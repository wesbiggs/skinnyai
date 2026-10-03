import { pathToFileURL } from 'node:url';
import './config.js';
import { IMAGE_PROTOCOL, localImagePath, showImages } from './images.js';
import { ANSI, CHROME_COLOR, CODE_BG, CODE_COLOR, LINK_CLOSE, createInlineStyler, createWordWrapper, linkOpen, renderTable, visibleWidth } from './style.js';
import { MAX_FETCH_BYTES } from './tools.js';

// Streams markdown to the terminal as it arrives: inline styling (see
// createInlineStyler), word wrapping, headings, bullet and numbered lists
// with hanging indents, block quotes, horizontal rules, fenced code blocks,
// tables, [links](url) as clickable OSC 8 hyperlinks, and - with `images`
// on - ![images](url) drawn inline after the line that mentions them. Each
// line's first few characters are held back until they say what kind of
// line it is; the rest streams through word by word. Tables are the
// exception - they're buffered whole (with a progress placeholder), since
// every column's width depends on every row. With `markdown` off (/set
// nomarkdown), or when stdout isn't a TTY, the text passes through raw, so
// it's still valid markdown. write() and end() are async only so they can
// wait for images to load; await them.
export function createMarkdownRenderer(role, startColumn = 0, { markdown = true, images = false } = {}) {
  if (!markdown || !process.stdout.isTTY) {
    return { write: async (text) => { process.stdout.write(text); }, async end() {} };
  }

  let out = '';
  const emit = (text) => { out += text; };
  const flush = () => {
    if (out) process.stdout.write(out);
    out = '';
  };

  const styler = createInlineStyler(role);
  const wrapper = createWordWrapper(styler.style, startColumn, emit);
  const columns = process.stdout.columns || 80;

  let mode = 'start'; // 'start' (classifying line) | 'text' | 'code' | 'table' | 'fence'
  let head = '';
  let inFence = false;
  let tableRows = [];
  let inCode = false; // inside an inline `code` span, where [x](y) isn't a link
  let link = null; // { text, url, image, phase: 'text' | 'paren' | 'url' } while a link is arriving
  let bang = false; // held-back '!' that may start an ![image](url)
  const queuedImages = []; // drawn once the current line ends
  const drawImages = images && IMAGE_PROTOCOL !== null;

  // Decides what kind of line `head` begins, or returns null if more
  // characters are needed to tell. `complete` means the line has ended.
  function classify(complete) {
    const indent = /^[ \t]*/.exec(head)[0];
    const rest = head.slice(indent.length);
    const need = (pattern) => !complete && pattern.test(rest);
    let m;

    if (inFence) {
      if (need(/^`{0,2}$/)) return null;
      return rest.startsWith('```') ? { type: 'fence' } : { type: 'code' };
    }
    if (need(/^$/) || need(/^`{1,2}$/) || need(/^#{1,6}$/) || need(/^\d{1,3}[.)]?$/) || need(/^[>+]$/) ||
        need(/^([-*_])(\s*\1)*\s*$/)) {
      return null;
    }
    if (rest.startsWith('|')) return { type: 'table' };
    if (rest.startsWith('```')) return { type: 'fence' };
    if (/^([-*_])(\s*\1){2,}\s*$/.test(rest)) return { type: 'rule', indent };
    if ((m = /^#{1,6} +/.exec(rest))) return { type: 'heading', indent, content: rest.slice(m[0].length) };
    if ((m = /^(\d{1,3}[.)]) +/.exec(rest))) return { type: 'list', indent, marker: m[1], content: rest.slice(m[0].length) };
    if ((m = /^[-*+] +/.exec(rest))) return { type: 'list', indent, marker: indent ? '◦' : '•', content: rest.slice(m[0].length) };
    if ((m = /^> ?/.exec(rest))) return { type: 'quote', indent, content: rest.slice(m[0].length) };
    return { type: 'text', indent, content: rest };
  }

  // Shown in place of a table while its rows arrive; the table overwrites it.
  function showTableProgress() {
    const rows = tableRows.filter((row) => !/^[\s|:-]*$/.test(row)).length;
    const label = rows ? `⋯ receiving table (${rows} row${rows === 1 ? '' : 's'})` : '⋯ receiving table';
    emit(`\r\x1b[2K${CHROME_COLOR || ''}${label}${ANSI.reset}`);
  }

  function flushTable() {
    if (tableRows.length === 0) return;
    emit('\r\x1b[2K');
    emit(renderTable(tableRows, role));
    emit(styler.sgr());
    tableRows = [];
  }

  function begin(line) {
    if (line.type !== 'table') flushTable();
    switch (line.type) {
      case 'table':
        if (tableRows.length === 0) showTableProgress();
        mode = line.type;
        return;
      case 'fence':
        mode = line.type;
        return;
      case 'code':
        wrapper.raw(CODE_BG + CODE_COLOR + head);
        mode = 'code';
        return;
      case 'rule':
        wrapper.raw(line.indent + CHROME_COLOR + '─'.repeat(Math.max(3, columns - visibleWidth(line.indent))) + styler.sgr());
        break;
      case 'heading':
        wrapper.raw(line.indent);
        styler.setLineBold(true);
        wrapper.raw(styler.sgr());
        wrapper.setHang(line.indent);
        break;
      case 'list': {
        const prefix = `${line.indent}${line.marker} `;
        wrapper.raw(prefix);
        wrapper.setHang(' '.repeat(visibleWidth(prefix)));
        break;
      }
      case 'quote': {
        const bar = CHROME_COLOR + '│ ' + styler.sgr();
        wrapper.raw(line.indent + bar);
        wrapper.setHang(line.indent + bar);
        break;
      }
      default:
        wrapper.raw(line.indent);
        wrapper.setHang(line.indent);
    }
    mode = 'text';
    for (const ch of line.content ?? '') text(ch);
  }

  // Inline text, watching for [text](url). A candidate link is held back
  // until it either completes - and is written as a hyperlink - or turns
  // out not to be one, and is written as the plain text it was.
  function text(ch) {
    if (!link) {
      const image = bang;
      if (bang && ch !== '[') wrapper.write('!');
      bang = false;
      if (ch === '`') inCode = !inCode;
      if (ch === '!' && !inCode) {
        bang = true;
      } else if (ch === '[' && !inCode) {
        link = { text: '', url: '', image, phase: 'text' };
      } else {
        wrapper.write(ch);
      }
      return;
    }
    if (link.phase === 'text' && ch === ']') {
      link.phase = 'paren';
    } else if (link.phase === 'text' && ch !== '[' && link.text.length < 500) {
      link.text += ch;
    } else if (link.phase === 'paren' && ch === '(') {
      link.phase = 'url';
    } else if (link.phase === 'url' && ch === ')') {
      writeLink(link.text, link.url, link.image);
      link = null;
    } else if (link.phase === 'url' && !/\s/.test(ch) && link.url.length < (link.url.startsWith('data:') ? MAX_FETCH_BYTES * 2 : 2000)) {
      link.url += ch;
    } else {
      abandonLink();
      text(ch);
    }
  }

  function abandonLink() {
    if (!link) return;
    const { text: linkText, url, image, phase } = link;
    link = null;
    wrapper.write(image ? '![' : '[');
    for (const ch of linkText) text(ch);
    if (phase !== 'text') text(']');
    if (phase === 'url') for (const ch of '(' + url) text(ch);
  }

  function flushPending() {
    abandonLink();
    if (bang) wrapper.write('!');
    bang = false;
  }

  function writeLink(linkText, url, image) {
    if (image) {
      // Images show as a clickable caption; the picture itself follows the line.
      // A local file (path or file: URL) is drawn too, and its caption opens it.
      const local = localImagePath(url);
      const drawable = drawImages && (/^(https?:|data:image\/)/i.test(url) || local !== null);
      if (drawable) queuedImages.push({ url });
      linkText = `🖼\uFE0F ${linkText || (drawable ? 'image' : url)}`;
      if (/^data:/i.test(url)) {
        wrapper.write(linkText);
        return;
      }
      if (local) url = pathToFileURL(local).href;
    }
    // Only web/mail/file links; anything else is shown as plain text.
    if (!/^(https?|mailto|ftp|file):/i.test(url)) {
      wrapper.write(linkText);
      return;
    }
    const target = url.replace(/[\x00-\x1f\x7f]/g, '');
    styler.setLink(true);
    wrapper.setLink({ open: () => linkOpen(target) + styler.sgr(), close: LINK_CLOSE });
    wrapper.write(linkText);
    wrapper.setLink(null);
    styler.setLink(false);
    wrapper.raw(styler.sgr());
  }

  // A code fence line as a full-width bar on the code background. The ```
  // markers aren't shown; an opening fence keeps its language name.
  function fenceBar(line) {
    const label = inFence ? '' : line.trim().replace(/^`+\s*/, '');
    return `${CODE_BG}${CHROME_COLOR}${label ? ' ' + label : ''}\x1b[K${ANSI.reset}`;
  }

  function endLine() {
    flushPending();
    inCode = false;
    if (mode === 'table') {
      tableRows.push(head);
      showTableProgress();
    } else if (mode === 'fence') {
      emit(fenceBar(head) + '\n');
      inFence = !inFence;
    } else if (mode === 'code') {
      wrapper.raw(`\x1b[K${ANSI.reset}`);
      wrapper.write('\n');
    } else {
      wrapper.write('\n');
    }
    styler.endLine();
    emit(styler.sgr());
    mode = 'start';
    head = '';
  }

  function handle(ch) {
    if (ch === '\r') return;
    if (mode === 'start') {
      if (ch === '\n') {
        begin(classify(true));
        endLine();
        return;
      }
      head += ch;
      const line = classify(false);
      if (line) begin(line);
      return;
    }
    if (ch === '\n') {
      endLine();
    } else if (mode === 'table' || mode === 'fence') {
      head += ch;
    } else if (mode === 'code') {
      wrapper.raw(ch);
    } else {
      text(ch);
    }
  }

  async function drawQueuedImages() {
    flush();
    await showImages(queuedImages.splice(0));
    emit(styler.sgr());
  }

  return {
    async write(text) {
      for (const ch of text) {
        handle(ch);
        if (queuedImages.length && mode === 'start') await drawQueuedImages();
      }
      flush();
    },
    async end() {
      if (mode === 'start' && head) begin(classify(true));
      flushPending();
      if (mode === 'table') {
        tableRows.push(head);
      } else if (mode === 'fence') {
        emit(fenceBar(head));
      } else if (mode === 'code') {
        wrapper.raw(`\x1b[K${ANSI.reset}`);
      }
      flushTable();
      wrapper.end();
      if (queuedImages.length) {
        emit('\n');
        await drawQueuedImages();
      }
      emit(ANSI.reset);
      flush();
    }
  };
}
