#!/usr/bin/env node

import readline from 'readline';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_KEEP_ALIVE = '1h';
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

// Saved sessions and the .env defaults file live here.
const SKINNY_HOME = process.env.SKINNY_HOME || path.join(os.homedir(), '.skinny');

// Default settings can be kept in $SKINNY_HOME/.env as KEY=value lines (see
// ENV_SETTINGS and the README). Variables already in the environment win
// over the file, and command-line flags win over both. It's loaded before
// anything reads process.env, so OLLAMA_API_KEY can live there too.
const ENV_FILE = path.join(SKINNY_HOME, '.env');

function loadEnvFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return false;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) {
      value = quoted[1] === '"' ? quoted[2].replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1') : quoted[2];
    } else {
      value = value.replace(/\s+#.*$/, ''); // trailing comment; a bare #ff8800 color stays
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
  return true;
}
const ENV_FILE_LOADED = loadEnvFile(ENV_FILE);

// ollama.com (cloud models, web search/fetch) needs an API key. It's only
// ever sent to ollama.com over https, never to other --host servers.
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';

function isOllamaCom(url) {
  const { hostname } = new URL(url);
  return hostname === 'ollama.com' || hostname.endsWith('.ollama.com');
}

function ollamaAuthHeaders(url) {
  if (!OLLAMA_API_KEY) return {};
  return new URL(url).protocol === 'https:' && isOllamaCom(url) ? { Authorization: `Bearer ${OLLAMA_API_KEY}` } : {};
}

// fetch() for requests to the chat server, adding the API key when it's ollama.com.
function hostFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { ...init.headers, ...ollamaAuthHeaders(url) } });
}

// Node's global fetch (via its bundled undici) aborts a request after 5
// minutes of inactivity between chunks (UND_ERR_HEADERS_TIMEOUT /
// UND_ERR_BODY_TIMEOUT), surfacing as a bare "fetch failed". Thinking models
// can go quiet for longer than that before emitting a token, so the
// long-lived streaming chat request uses plain http/https instead, which has
// no such default idle timeout.
function streamingPost(url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = transport.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...ollamaAuthHeaders(url)
      }
    }, (res) => {
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        statusText: res.statusMessage,
        body: res
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// Reads a (non-streamed) error response body so API errors can show the
// server's actual message, e.g. Ollama's "... does not support tools".
async function readErrorBody(res) {
  let text = '';
  try {
    for await (const chunk of res) text += chunk;
    const json = JSON.parse(text);
    return json.error?.message || json.error || text;
  } catch (e) {
    return text;
  }
}

// --- Tools (enabled with --tools or /set tools) ---

const MAX_TOOL_ROUNDS = 5;
const SEARCH_TIMEOUT_MS = 10000;
const MAX_SEARCH_RESULTS = 8;
// DuckDuckGo's HTML endpoint serves a bot-check page (HTTP 202, 'anomaly'
// markup) to clients that don't look like a browser.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  'Accept': 'text/html',
  'Accept-Language': 'en-US,en;q=0.9'
};

function decodeEntities(text) {
  const codePoint = (n) => {
    try {
      return String.fromCodePoint(n);
    } catch (e) {
      return '';
    }
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function stripHtml(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// DuckDuckGo's official Instant Answer API: Wikipedia-style abstracts and
// direct answers only, not web results - many queries come back empty.
async function ddgInstantAnswer(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Instant Answer API: HTTP ${res.status}`);
  const data = await res.json();
  const lines = [];
  if (data.Answer) lines.push(`Answer: ${stripHtml(String(data.Answer))}`);
  if (data.AbstractText) {
    lines.push(`${data.Heading ? data.Heading + ': ' : ''}${data.AbstractText}`);
    if (data.AbstractURL) lines.push(`Source: ${data.AbstractURL}`);
  }
  if (data.Definition) {
    lines.push(`Definition: ${data.Definition}`);
    if (data.DefinitionURL) lines.push(`Source: ${data.DefinitionURL}`);
  }
  return lines.join('\n');
}

// Unofficial: scrapes html.duckduckgo.com. May break if the markup changes,
// and heavy use gets rate-limited/CAPTCHA'd.
// `df` is DuckDuckGo's date filter: 'd' | 'w' | 'm' | 'y', or '' for any time.
async function ddgHtmlSearch(query, df = '') {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://html.duckduckgo.com/'
    },
    body: new URLSearchParams({ q: query, b: '', df }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  });
  const html = await res.text();
  if (res.status === 202 || /anomaly-modal/.test(html)) {
    throw new Error('DuckDuckGo blocked the request as automated traffic (try again later)');
  }
  if (!res.ok) throw new Error(`DuckDuckGo search: HTTP ${res.status}`);

  const results = [];
  for (const block of html.split('class="result__a"').slice(1)) {
    const link = block.match(/^[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    let href = link[1].replace(/&amp;/g, '&');
    // Older markup routes results through a //duckduckgo.com/l/?uddg=<url> redirect.
    const redirect = href.match(/[?&]uddg=([^&]+)/);
    if (redirect) href = decodeURIComponent(redirect[1]);
    if (href.includes('duckduckgo.com/y.js')) continue; // ad
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    results.push({ title: stripHtml(link[2]), url: href, snippet: snippet ? stripHtml(snippet[1]) : '' });
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    .join('\n');
}

// Small models don't always stick to the schema's enum, so unrecognized
// recency values just mean "any time" rather than an error.
const RECENCY_FILTERS = { day: 'd', today: 'd', week: 'w', month: 'm', year: 'y' };

// Ollama's hosted search (used when OLLAMA_API_KEY is set) returns each
// result's page text, not just a snippet, so small models get real content
// without having to chain a fetch_page call. That text runs 3-11K characters
// per result, so each is cut down to keep five of them within context.
const OLLAMA_SEARCH_RESULTS = 5;
const MAX_RESULT_CHARS = 1500;

async function ollamaApi(path, body) {
  const url = `https://ollama.com/api/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ollamaAuthHeaders(url) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!res.ok) {
    const detail = await res.json().then((j) => j.error, () => '');
    throw new Error(`HTTP ${res.status}${detail ? ` - ${detail}` : ''}`);
  }
  return res.json();
}

// Ollama's extracted text keeps page chrome like share buttons ("Text",
// "*", "Small Text", "*", "Facebook", ...) as one or two words per line;
// drop bullet-only lines and long runs of those before truncating.
const CHROME_RUN_LENGTH = 6;
function tidyText(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => !/^[*•·|-]*$/.test(line));
  const isChrome = (line) => !line.startsWith('#') && line.split(/\s+/).length <= 2;
  const kept = [];
  let run = [];
  for (const line of [...lines, null]) {
    if (line !== null && isChrome(line)) {
      run.push(line);
      continue;
    }
    if (run.length < CHROME_RUN_LENGTH) kept.push(...run);
    run = [];
    if (line !== null) kept.push(line);
  }
  return kept.join('\n');
}

async function ollamaWebSearch(query) {
  const { results = [] } = await ollamaApi('web_search', { query, max_results: OLLAMA_SEARCH_RESULTS });
  return results.map((r, i) => {
    const content = tidyText(r.content || '');
    const text = content.length > MAX_RESULT_CHARS ? `${content.slice(0, MAX_RESULT_CHARS)}…` : content;
    return `[${i + 1}] ${r.title}\nURL: ${r.url}\n${text}`;
  }).join('\n\n');
}

// The hosted APIs share the free tier's usage limits; when a call fails,
// say so and fall back to the keyless implementation rather than failing.
function noteFallback(what, error) {
  process.stdout.write(`${ANSI.assistant.narration}   ⚠️  Ollama ${what} failed (${error.message}); falling back to the local implementation${ANSI.reset}\n`);
}

async function webSearch({ query, recency }) {
  if (!query || typeof query !== 'string') throw new Error("missing 'query' argument");
  if (OLLAMA_API_KEY) {
    try {
      return (await ollamaWebSearch(query)) || `No results found for "${query}".`;
    } catch (error) {
      noteFallback('web search', error);
    }
  }
  const df = RECENCY_FILTERS[String(recency ?? '').toLowerCase()] || '';
  // Instant Answers are timeless encyclopedia summaries, so skip them when
  // the model asked for recent results.
  if (!df) {
    let instant = '';
    try {
      instant = await ddgInstantAnswer(query);
    } catch (e) {
      // Fall through to the HTML search.
    }
    if (instant) return instant;
  }
  return (await ddgHtmlSearch(query, df)) || `No results found for "${query}".`;
}

const FETCH_TIMEOUT_MS = 15000;
const MAX_FETCH_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
// ~1500 tokens. Ollama's default context window is small (often 4096
// tokens), so a whole page would push the conversation out of it.
const MAX_PAGE_CHARS = 6000;

// Pages the model reads can contain instructions aimed at it, so fetch_page
// refuses addresses on this machine or the local network: otherwise a page
// could get the model to read e.g. a router admin page and then leak it by
// "fetching" an attacker's URL with the contents in the query string.
// net.BlockList also matches IPv4-mapped IPv6 forms like ::ffff:7f00:1.
const PRIVATE_ADDRESSES = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10] // last: carrier-grade NAT
]) PRIVATE_ADDRESSES.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]]) {
  PRIVATE_ADDRESSES.addSubnet(prefix, bits, 'ipv6');
}

function isPrivateAddress(ip) {
  return PRIVATE_ADDRESSES.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

async function assertPublicUrl(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http and https URLs can be fetched (got ${url.protocol})`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error(`refusing to fetch ${url.hostname}: it resolves to a local or private network address`);
  }
}

// Fetches a public URL, following redirects by hand so each hop gets the
// private-address check.
async function fetchPublic(target, accept) {
  let res;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(target);
    res = await fetch(target, {
      headers: { ...BROWSER_HEADERS, 'Accept': accept },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) break;
    if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
    target = new URL(location, target);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${target.href}`);
  return { res, url: target };
}

// Reads at most MAX_FETCH_BYTES, so a huge download can't stall the chat.
async function readCappedBytes(res) {
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= MAX_FETCH_BYTES) break;
  }
  return { bytes: Buffer.concat(chunks).subarray(0, MAX_FETCH_BYTES), truncated: total >= MAX_FETCH_BYTES };
}

async function readCapped(res) {
  const { bytes } = await readCappedBytes(res);
  const charset = res.headers.get('content-type')?.match(/charset=["']?([\w-]+)/i)?.[1];
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch (e) {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// Rough readable-text extraction: drops scripts/styles/navigation, prefers
// <main>/<article> when they hold most of the text, and keeps line breaks
// and headings so the model can tell headlines from body text.
function htmlToText(html) {
  const title = stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  let body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, '')
    // Drop attributes (quote-aware: values like Wikipedia's data-mw JSON
    // contain '>'), so the simple tag patterns below can't be thrown off.
    .replace(/<(\/?[a-z][\w-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '<$1>');
  const main = body.match(/<(main|article)\b[\s\S]*<\/\1>/i)?.[0];
  if (main && stripHtml(main).length > 500) body = main;
  const text = decodeEntities(body
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|section|article|main|header|h[1-6]|ul|ol|table|tr|blockquote|pre|figure|figcaption|dt|dd)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !/^#+$/.test(line) && line !== '-');
  return { title, text: dropMenuRuns(text).join('\n') };
}

// Language pickers and nav menus come out as long runs of one- or two-word
// list items, and would otherwise use up the character budget before the
// page's actual content.
const MENU_RUN_LENGTH = 10;
function dropMenuRuns(lines) {
  const isMenuItem = (line) => line.startsWith('- ') && line.split(' ').length <= 4;
  const kept = [];
  let run = [];
  for (const line of [...lines, '']) {
    if (isMenuItem(line)) {
      run.push(line);
      continue;
    }
    if (run.length < MENU_RUN_LENGTH) kept.push(...run);
    run = [];
    if (line) kept.push(line);
  }
  return kept;
}

function formatPage(title, url, text) {
  if (!text) return `No readable text found at ${url} (the page may need JavaScript).`;
  const header = `${title ? `Title: ${title}\n` : ''}URL: ${url}\n\n`;
  if (text.length <= MAX_PAGE_CHARS) return header + text;
  return `${header}${text.slice(0, MAX_PAGE_CHARS)}\n\n[truncated: showing the first ${MAX_PAGE_CHARS} of ${text.length} characters]`;
}

async function fetchPage({ url }) {
  if (!url || typeof url !== 'string') throw new Error("missing 'url' argument");
  let target;
  try {
    target = new URL(url);
  } catch (e) {
    throw new Error(`not a valid URL: ${url}`);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`only http and https URLs can be fetched (got ${target.protocol})`);
  }

  // Ollama's fetch runs on its servers, so it can't reach this machine or
  // its network; the private-address check below only matters locally.
  if (OLLAMA_API_KEY) {
    try {
      const page = await ollamaApi('web_fetch', { url: target.href });
      return formatPage(page.title, target.href, tidyText(page.content || ''));
    } catch (error) {
      noteFallback('web fetch', error);
    }
  }
  return localFetchPage(target);
}

async function localFetchPage(page) {
  const { res, url: target } = await fetchPublic(page, 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5');

  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const isHtml = type === 'text/html' || type === 'application/xhtml+xml';
  if (!isHtml && !type.startsWith('text/') && !/json|xml/.test(type)) {
    throw new Error(`can't read ${type || 'unknown'} content, only web pages and text`);
  }
  const raw = await readCapped(res);
  const { title, text } = isHtml ? htmlToText(raw) : { title: '', text: raw.trim() };
  return formatPage(title, target.href, text);
}

// e.g. "Tuesday, September 29, 2026", in the local timezone.
function formatToday() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

const TOOLS = {
  web_search: {
    description: `Search the web. Use this for current events, recent facts, or anything you are unsure about. Returns result titles, URLs, and ${OLLAMA_API_KEY ? 'the start of each result page' : 'snippets'}.`,
    // Ollama's hosted search has no date filter, so recency is only offered
    // with DuckDuckGo.
    parameters: () => ({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "The search query, naming the topic (e.g. 'world news headlines')" +
            (OLLAMA_API_KEY ? '' : ". Use recency for time limits instead of words like 'today'.")
        },
        ...(!OLLAMA_API_KEY && { recency: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year'],
          description: 'Only return results from the past day, week, month, or year. Use for news and other time-sensitive queries.'
        } })
      },
      required: ['query']
    }),
    mentionsDate: true,
    describe: (args) => `searching: "${args.query}"${RECENCY_FILTERS[args.recency] && !OLLAMA_API_KEY ? ` (past ${args.recency})` : ''}`,
    run: webSearch
  },
  fetch_page: {
    description: "Fetch a web page and return its readable text. Use it to read a web_search result's actual content, e.g. the headlines on a news site, instead of relying on its snippet. Long pages are truncated.",
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full http(s) URL to fetch' }
      },
      required: ['url']
    },
    describe: (args) => `fetching: ${args.url}`,
    run: fetchPage
  }
};

// Built per request so the date is current. Small models often weigh the
// tool definition more than the system prompt, so it carries the date too.
function toolDefinitions(today) {
  return Object.entries(TOOLS).map(([name, tool]) => ({
    type: 'function',
    function: {
      name,
      description: today && tool.mentionsDate ? `${tool.description} Today's date is ${today}.` : tool.description,
      parameters: typeof tool.parameters === 'function' ? tool.parameters() : tool.parameters
    }
  }));
}

// Tool output goes straight back to the model as a 'tool' message; errors are
// reported the same way so the model can recover or tell the user.
async function runTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) return `Error: unknown tool '${name}'`;
  try {
    return await tool.run(args || {});
  } catch (error) {
    return `Error: ${error.message}`;
  }
}

// *Italic text* doubles as narration in RP-style chats. Each speaker gets its own
// dialogue/narration pair so turns are visually distinct: user = yellow, assistant = green.
const supportsColor = Boolean(process.stdout.isTTY);
const ANSI = {
  reset: supportsColor ? '\x1b[0m' : '',
  user: {
    dialogue: supportsColor ? '\x1b[38;5;226m' : '',
    narration: supportsColor ? '\x1b[38;5;136m' : ''
  },
  assistant: {
    dialogue: supportsColor ? '\x1b[38;5;83m' : '',
    narration: supportsColor ? '\x1b[38;5;28m' : ''
  }
};

// Input prompt. Plain text for width math; styledPrompt() for display, read
// at call time so --user-italic-color applies to it.
const PROMPT = '> ';
function styledPrompt() {
  return ANSI.user.narration + PROMPT + ANSI.reset;
}

// Basic 16-color names, for --*-color flags. 'gray'/'grey' alias brightblack.
const NAMED_COLORS = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  brightblack: 90, brightred: 91, brightgreen: 92, brightyellow: 93,
  brightblue: 94, brightmagenta: 95, brightcyan: 96, brightwhite: 97,
  gray: 90, grey: 90
};

// Parses a --*-color flag value into an SGR escape sequence. Accepts a hex
// triplet (#RRGGBB, truecolor), a 256-color palette index (0-255), or a
// basic color name (see NAMED_COLORS). Exits with an error on bad input.
function parseColor(value, flagName) {
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
function applyColorOverrides(options) {
  if (!supportsColor) return;
  if (options.userNormalColor) ANSI.user.dialogue = parseColor(options.userNormalColor, '--user-normal-color');
  if (options.userEmphasisColor) ANSI.user.narration = parseColor(options.userEmphasisColor, '--user-emphasis-color');
  if (options.modelNormalColor) ANSI.assistant.dialogue = parseColor(options.modelNormalColor, '--model-normal-color');
  if (options.modelEmphasisColor) ANSI.assistant.narration = parseColor(options.modelEmphasisColor, '--model-emphasis-color');
}

// Inline code, code blocks, and fence/rule/quote chrome get fixed colors of
// their own, independent of the per-speaker palette.
const CODE_COLOR = supportsColor ? '\x1b[38;5;117m' : '';
const CHROME_COLOR = supportsColor ? '\x1b[38;5;244m' : '';

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
// SGR styles plus OSC 8 hyperlink open/close - everything that takes no columns.
const ESCAPE_PATTERN = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;

// OSC 8 hyperlinks: terminals that support them (iTerm2, WezTerm, kitty,
// GNOME Terminal, Windows Terminal, ...) make the text clickable; others
// ignore the sequence and just show the text.
const linkOpen = (url) => `\x1b]8;;${url}\x1b\\`;
const LINK_CLOSE = '\x1b]8;;\x1b\\';
// Markdown [text](url), for links that arrive whole (table cells).
// A leading '!' (an image) is dropped: cells show images as links.
const LINK_PATTERN = /!?\[([^\]]*)\]\(([^)\s]+)\)/g;

// Terminal column width of one code point: 0 for combining marks and
// zero-width joiners/variation selectors, 2 for East Asian wide characters,
// 1 otherwise. Rough, but covers what models commonly emit.
function charWidth(cp) {
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
const graphemes = new Intl.Segmenter();
const EMOJI_GLYPH = /^\p{Emoji_Presentation}|^\p{Emoji}️|‍\p{Extended_Pictographic}/u;

function graphemeWidth(cluster) {
  if (EMOJI_GLYPH.test(cluster)) return 2;
  let width = 0;
  for (const ch of cluster) width += charWidth(ch.codePointAt(0));
  return width;
}

// Printed width of a string, ignoring escape sequences.
function visibleWidth(text) {
  let width = 0;
  for (const { segment } of graphemes.segment(text.replace(ESCAPE_PATTERN, ''))) width += graphemeWidth(segment);
  return width;
}

// Renders inline markdown within one word (or one whole table cell) at a
// time: **bold**, *italic* / _italic_, ~~strike~~, `code`, and \-escapes.
// Italic also switches to the role's narration color, so RP-style
// '*narration*' keeps its distinct look. State carries across calls, so a
// span can cover several words; endLine() drops it, so an unclosed marker
// can't bleed into the next paragraph. Every SGR it emits is a full reset
// plus the current state, so any emitted sequence alone restores the style.
function createInlineStyler(role) {
  const colors = ANSI[role];
  let bold = false;
  let italic = false;
  let strike = false;
  let codeRun = 0; // length of the backtick run that opened the current code span
  let lineBold = false; // headings/table headers
  let link = false; // underlined while inside a [link](url)

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

      if (ch === '\\' && i + 1 < chars.length && /[\\`*_~|#[\]()<>-]/.test(chars[i + 1])) {
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
      bold = italic = strike = lineBold = link = false;
      codeRun = 0;
    }
  };
}

// Styles a line (or several, split on '\n') of user input for echoing back.
function styleLine(role, text) {
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
function createWordWrapper(style, startColumn = 0, emit = (text) => process.stdout.write(text)) {
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
function splitTableRow(line) {
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
function wrapStyled(styled, width) {
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
function renderTable(rows, role) {
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

// Inline images, for markdown ![alt](url). Two escape-sequence protocols
// cover the terminals that can draw them: iTerm2's (the one imgcat uses;
// also WezTerm) and kitty's graphics protocol (kitty, Ghostty). Returns
// null for other terminals, and inside tmux/screen, which don't pass these
// sequences through.
function detectImageProtocol() {
  const env = process.env;
  if (!process.stdout.isTTY || env.TMUX || /^screen/.test(env.TERM || '')) return null;
  if (env.TERM_PROGRAM === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2' || env.TERM_PROGRAM === 'WezTerm') return 'iterm';
  if (env.TERM === 'xterm-kitty' || env.KITTY_WINDOW_ID || env.TERM_PROGRAM === 'ghostty') return 'kitty';
  return null;
}
const IMAGE_PROTOCOL = detectImageProtocol();

// Identifies an image by its magic bytes and reads its pixel size.
// Returns null for anything that isn't a PNG, GIF, JPEG, or WebP.
function sniffImage(bytes) {
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

// Fetches an image from an http(s) or data: URL. Web images get the same
// guards as fetch_page: public addresses only, and a size cap.
async function loadImage(url) {
  let bytes;
  const data = /^data:image\/[\w.+-]+;base64,(.*)$/is.exec(url);
  if (data) {
    bytes = Buffer.from(data[1], 'base64');
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
function imageSequence(image, protocol = IMAGE_PROTOCOL) {
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
async function showImages(images) {
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
function createMarkdownRenderer(role, startColumn = 0, { markdown = true, images = false } = {}) {
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
        wrapper.raw(CODE_COLOR + head);
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
      const drawable = drawImages && /^(https?:|data:image\/)/i.test(url);
      if (drawable) queuedImages.push({ url });
      linkText = `🖼\uFE0F ${linkText || (drawable ? 'image' : url)}`;
      if (/^data:/i.test(url)) {
        wrapper.write(linkText);
        return;
      }
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

  function endLine() {
    flushPending();
    inCode = false;
    if (mode === 'table') {
      tableRows.push(head);
      showTableProgress();
    } else if (mode === 'fence') {
      emit(CHROME_COLOR + head + '\n');
      inFence = !inFence;
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
        emit(CHROME_COLOR + head);
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

// Where the terminal cursor ends up after printing PROMPT + text from the
// start of a row, as { row, col } relative to the prompt's row. Accounts for
// embedded newlines, soft wrapping at the terminal width, and wide
// characters. Text that exactly fills a row leaves the real cursor parked at
// the right edge ("pending wrap"); that's reported as the start of the next
// row, with `pending` set so the caller can nudge the cursor there.
function inputPosition(text) {
  const columns = process.stdout.columns || 80;
  let row = 0;
  let col = visibleWidth(PROMPT);
  let pending = false;
  for (const { segment: ch } of graphemes.segment(text)) {
    if (ch === '\n') {
      row++;
      col = 0;
      pending = false;
      continue;
    }
    const width = graphemeWidth(ch);
    if (pending || col + width > columns) {
      row++;
      col = 0;
      pending = false;
    }
    col += width;
    if (col >= columns) pending = true;
  }
  return pending ? { row: row + 1, col: 0, pending } : { row, col, pending };
}

// Sessions saved on this machine, for servers that can't store them: only
// a self-hosted Ollama has /api/create, not ollama.com or OpenAI-compatible
// servers. They use the same Modelfile format /save creates on an Ollama
// server (FROM, SYSTEM, PARAMETER, MESSAGE), one file per name, so a saved
// session can also be turned into a real model with `ollama create -f`.
const SESSION_DIR = path.join(SKINNY_HOME, 'sessions');
const SESSION_SUFFIX = '.Modelfile';

// Names can hold anything a model name can (like 'me/chat:v2'), so they're
// URL-encoded into safe filenames.
function sessionPath(name) {
  return path.join(SESSION_DIR, encodeURIComponent(name) + SESSION_SUFFIX);
}

// A triple-quoted Modelfile value. Ollama's format has no escape for a
// literal """ inside one, so it's written as ""\" and turned back on load.
function quoteModelfile(text) {
  return `"""${text.replace(/"""/g, '""\\"')}"""`;
}

function formatModelfile({ from, system, parameters, messages }) {
  const lines = [`# Saved by skinnyai on ${new Date().toISOString()}`, `FROM ${from}`];
  for (const [name, value] of Object.entries(parameters)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      lines.push(`PARAMETER ${name} ${typeof v === 'string' && /\s|"/.test(v) ? JSON.stringify(v) : v}`);
    }
  }
  if (system) lines.push(`SYSTEM ${quoteModelfile(system)}`);
  for (const { role, content } of messages) lines.push(`MESSAGE ${role} ${quoteModelfile(content)}`);
  return lines.join('\n') + '\n';
}

// Reads the Modelfile subset formatModelfile writes (plus comments and
// single-line values), returning { from, system, parameters: [[name, value]],
// messages }. Other instructions (TEMPLATE, LICENSE, ...) are skipped.
function parseModelfile(text) {
  const session = { from: '', system: '', parameters: [], messages: [] };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*([A-Za-z]+)\s+(.*)$/.exec(lines[i]);
    if (!match || lines[i].trimStart().startsWith('#')) continue;
    const instruction = match[1].toUpperCase();
    let args = match[2];
    let role = '';
    if (instruction === 'MESSAGE') {
      [, role, args] = /^(\S+)\s*(.*)$/.exec(args) || [, '', ''];
    }

    // A value is either the rest of the line (optionally "quoted") or a
    // """block""" that runs until a line ending in """.
    let value = args.trim();
    if (value.startsWith('"""')) {
      const body = [value.slice(3)];
      while (!/"""\s*$/.test(body[body.length - 1]) && i + 1 < lines.length) body.push(lines[++i]);
      value = body.join('\n').replace(/"""\s*$/, '').replace(/""\\"/g, '"""');
    } else if (/^".*"$/.test(value)) {
      try {
        value = JSON.parse(value);
      } catch (e) {
        value = value.slice(1, -1);
      }
    }

    if (instruction === 'FROM') session.from = value;
    else if (instruction === 'SYSTEM') session.system = value;
    else if (instruction === 'PARAMETER') {
      const [, name, rest] = /^(\S+)\s+(.*)$/s.exec(args.trim()) || [];
      if (name) session.parameters.push([name, /^".*"$/.test(rest) ? JSON.parse(rest) : rest]);
    } else if (instruction === 'MESSAGE' && role) session.messages.push({ role: role.toLowerCase(), content: value });
  }
  return session;
}

async function saveLocalSession(name, session) {
  await fs.mkdir(SESSION_DIR, { recursive: true });
  const file = sessionPath(name);
  await fs.writeFile(file, formatModelfile(session));
  return file;
}

// Returns the parsed session, or null if none is saved under that name.
async function readLocalSession(name) {
  try {
    return parseModelfile(await fs.readFile(sessionPath(name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function localSessionExists(name) {
  try {
    await fs.access(sessionPath(name));
    return true;
  } catch (error) {
    return false;
  }
}

async function deleteLocalSession(name) {
  await fs.rm(sessionPath(name), { force: true });
}

// Whether a session still has the name autosave gave it (see autosaveName).
function isAutosaveName(name) {
  return /^chat-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?$/.test(name);
}

// Name for a new autosaved session, from the local date and time, e.g.
// 'chat-2026-09-30-154907', with a -2, -3, ... suffix if that's taken (say,
// two conversations started within a second of each other via /clear).
async function autosaveName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const base = `chat-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!await localSessionExists(name)) return name;
  }
}

async function listLocalSessions() {
  try {
    const files = await fs.readdir(SESSION_DIR);
    return files.filter((f) => f.endsWith(SESSION_SUFFIX)).map((f) => decodeURIComponent(f.slice(0, -SESSION_SUFFIX.length))).sort();
  } catch (error) {
    return [];
  }
}

class OllamaChat {
  constructor(model, options = {}) {
    this.model = model;
    this.host = options.host || DEFAULT_OLLAMA_HOST;
    this.keepAlive = options.keepAlive || DEFAULT_KEEP_ALIVE;
    this.history = []; // history[0] may be a {role: 'system', ...} message
    this.options = {}; // /set parameter overrides (temperature, num_ctx, ...)
    this.format = ''; // '' | 'json'
    this.think = undefined; // undefined | true | false | 'low'|'medium'|'high'|'max'
    this.verbose = false;
    this.showThinking = !options.hideThinking;
    this.stopOnExit = Boolean(options.stopOnExit);
    this.api = options.api === 'openai' ? 'openai' : 'ollama';
    this.toolsEnabled = Boolean(options.tools);
    // undefined = automatic: tell the model today's date whenever tools are on.
    this.injectDate = options.date;
    this.markdown = options.markdown !== false;
    // Off by default: drawing an image means fetching whatever URL the model
    // wrote, and a prompt injection (say, in a page fetch_page read) could
    // use that to send conversation details to a server in the URL.
    this.images = Boolean(options.images) && IMAGE_PROTOCOL !== null;
    this.inputHistory = []; // submitted messages/commands, for Up/Down recall
    this.autosave = Boolean(options.autosave);
    // The local session file this conversation is saved in, once it has one:
    // set by autosave, a local /save, or loading a local session; cleared
    // when a new conversation starts (/clear, loading a model).
    this.sessionName = null;
  }

  shouldInjectDate() {
    return this.injectDate ?? this.toolsEnabled;
  }

  // Models only know their training cutoff (llama3.2's template even states
  // "Cutting Knowledge Date: December 2023"), so they assume it's still then.
  // The date goes into the outgoing system message rather than into history,
  // so it's always current and never ends up in /save or /show system.
  requestMessages(today) {
    if (!today) return this.history;
    const dateLine = `Today's date is ${today}.`;
    const system = this.getSystemMessage();
    const rest = system ? this.history.slice(1) : this.history;
    return [{ role: 'system', content: system ? `${dateLine}\n\n${system}` : dateLine }, ...rest];
  }

  // Unloads the current model from Ollama (same effect as `ollama stop`),
  // via keep_alive: 0. Best-effort: failures here shouldn't block exiting.
  // No equivalent concept exists in the OpenAI API, so this is a no-op there.
  async stopModel() {
    if (this.api !== 'ollama') {
      console.log("ℹ️  --stop-on-exit has no equivalent for --api openai; skipping.");
      return;
    }
    try {
      await hostFetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, messages: [], keep_alive: 0 })
      });
      console.log(`🛑 Stopped model '${this.model}'`);
    } catch (error) {
      console.error(`⚠️  Couldn't stop model '${this.model}': ${error.message}`);
    }
  }

  getSystemMessage() {
    return this.history[0]?.role === 'system' ? this.history[0].content : '';
  }

  setSystemMessage(text) {
    if (this.history[0]?.role === 'system') {
      this.history[0] = { role: 'system', content: text };
    } else {
      this.history.unshift({ role: 'system', content: text });
    }
  }

  setParameter(name, values) {
    if (name === 'stop') {
      this.options.stop = [...(this.options.stop || []), ...values];
      return;
    }
    const numeric = new Set(['seed', 'num_predict', 'top_k', 'num_ctx', 'num_gpu', 'repeat_last_n']);
    const float = new Set(['top_p', 'min_p', 'temperature', 'repeat_penalty']);
    let value = values[0];
    if (numeric.has(name)) value = parseInt(value, 10);
    else if (float.has(name)) value = parseFloat(value);
    this.options[name] = value;
  }

  // Fetches model info via /api/show and, if found, switches to it: applies any
  // saved messages/system message and resets per-session overrides. Returns
  // false (without touching state) if the model doesn't exist.
  async fetchAndApplyModelContext(modelName) {
    const response = await hostFetch(`${this.host}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName })
    });

    if (!response.ok) return false;

    const info = await response.json();
    const messages = Array.isArray(info.messages) ? [...info.messages] : [];
    if (info.system && (!messages[0] || messages[0].role !== 'system')) {
      messages.unshift({ role: 'system', content: info.system });
    }

    this.model = modelName;
    this.history = messages;
    this.sessionName = null;
    this.options = {};
    this.format = '';
    this.think = undefined;

    if (messages.length > 0) {
      await this.printRestoredHistory(messages, `📜 Restored conversation from '${this.model}':`);
    }
    return true;
  }

  // Switches to a session saved on this machine (see saveLocalSession): its
  // FROM model, system message, parameters, and conversation.
  async applyLocalSession(name, session) {
    this.model = session.from || this.model;
    this.history = session.system ? [{ role: 'system', content: session.system }] : [];
    this.history.push(...session.messages);
    this.options = {};
    for (const [param, value] of session.parameters) this.setParameter(param, [value]);
    this.format = '';
    this.think = undefined;
    this.sessionName = name; // autosave keeps updating the same file
    await this.printRestoredHistory(this.history, `📜 Restored saved session '${name}' (model: ${this.model}):`);
  }

  // At startup, a name with a locally saved session resumes it, the way
  // `ollama run` resumes a model /save created; otherwise an Ollama server
  // is asked for the model's own saved messages.
  async loadModelContext() {
    try {
      const session = await readLocalSession(this.model);
      if (session) {
        await this.applyLocalSession(this.model, session);
      } else if (this.api === 'ollama') {
        await this.fetchAndApplyModelContext(this.model);
      }
    } catch (error) {
      // Non-fatal: just start with an empty session.
    }
  }

  async printRestoredHistory(messages, heading) {
    console.log(`${heading}\n`);

    for (const message of messages) {
      if (message.role === 'system') {
        console.log(`💬 System: ${message.content}\n`);
      } else if (message.role === 'user') {
        process.stdout.write(styledPrompt());
        await this.writeWrapped('user', message.content, PROMPT.length);
        process.stdout.write('\n');
      } else if (message.role === 'assistant' && message.content) {
        process.stdout.write('\n');
        await this.writeWrapped('assistant', message.content, 0);
        process.stdout.write('\n\n');
      }
    }
  }

  renderOptions() {
    return { markdown: this.markdown, images: this.images };
  }

  async writeWrapped(role, text, startColumn = 0) {
    const renderer = createMarkdownRenderer(role, startColumn, this.renderOptions());
    process.stdout.write(ANSI[role].dialogue);
    await renderer.write(text);
    await renderer.end();
    process.stdout.write(ANSI.reset);
  }

  startSpinner() {
    if (!supportsColor) return null;
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    process.stdout.write(`${frames[0]} waiting for ${this.model}...`);
    return setInterval(() => {
      i = (i + 1) % frames.length;
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(`${frames[i]} waiting for ${this.model}...`);
    }, 80);
  }

  stopSpinner(timer) {
    if (!timer) return;
    clearInterval(timer);
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }

  buildOllamaChatBody() {
    const today = this.shouldInjectDate() ? formatToday() : '';
    const body = {
      model: this.model,
      messages: this.requestMessages(today),
      keep_alive: this.keepAlive,
      stream: true
    };
    if (Object.keys(this.options).length > 0) body.options = this.options;
    if (this.format) body.format = this.format;
    if (this.think !== undefined) body.think = this.think;
    if (this.toolsEnabled) body.tools = toolDefinitions(today);
    return body;
  }

  // OpenAI-compatible servers apply sampling params (temperature, top_p, stop, ...)
  // directly at the top level rather than nested under 'options' - and several
  // llama.cpp/vLLM-style servers additionally accept Ollama-style extras
  // (top_k, min_p, repeat_penalty) the same way, so passing this.options
  // through as top-level fields is the most broadly compatible option.
  // stream_options.include_usage asks for a trailing token-count chunk, used
  // for /set verbose stats; servers that don't support it just ignore it.
  buildOpenAIChatBody() {
    const today = this.shouldInjectDate() ? formatToday() : '';
    const body = {
      model: this.model,
      messages: this.requestMessages(today),
      stream: true,
      stream_options: { include_usage: true },
      ...this.options
    };
    if (this.format === 'json') body.response_format = { type: 'json_object' };
    if (this.toolsEnabled) body.tools = toolDefinitions(today);
    return body;
  }

  async chat(prompt) {
    // Add to history
    this.history.push({ role: 'user', content: prompt });

    process.stdout.write('\n');

    try {
      // Each round streams one model response; if it asked for tools, run
      // them, append their results to history, and let the model continue.
      // After MAX_TOOL_ROUNDS, the last request omits tools so the model has
      // to answer with what it has.
      for (let round = 0; ; round++) {
        const toolCalls = await this.streamTurn(round < MAX_TOOL_ROUNDS);
        if (toolCalls.length === 0 || round >= MAX_TOOL_ROUNDS) break;
        await this.runToolCalls(toolCalls);
      }
    } catch (error) {
      console.error(`\n❌ Error: ${error.message}\n`);
    }
    await this.autosaveSession();
  }

  // The conversation minus tool calls and results, which have no Modelfile
  // form; the answers built from them are kept.
  savableMessages() {
    const system = this.getSystemMessage();
    return (system ? this.history.slice(1) : this.history)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content);
  }

  sessionSnapshot() {
    return { from: this.model, system: this.getSystemMessage(), parameters: this.options, messages: this.savableMessages() };
  }

  // With autosave on, writes the conversation to its local session file
  // after each model turn, naming it from the date and time the first time.
  async autosaveSession() {
    if (!this.autosave || this.savableMessages().length === 0) return;
    if (!this.sessionName) {
      this.sessionName = await autosaveName();
      process.stdout.write(`${CHROME_COLOR}💾 Autosaving as '${this.sessionName}' (/save <name> saves it under a new name)${ANSI.reset}\n\n`);
    }
    try {
      await saveLocalSession(this.sessionName, this.sessionSnapshot());
    } catch (error) {
      console.log(`⚠️  Autosave failed: ${error.message}\n`);
    }
  }

  async runToolCalls(toolCalls) {
    for (const call of toolCalls) {
      const { name } = call.function;
      let args = call.function.arguments;
      // OpenAI-style APIs send arguments as a JSON string; Ollama sends an object.
      if (typeof args === 'string') {
        try {
          args = args ? JSON.parse(args) : {};
        } catch (e) {
          args = null;
        }
      }
      const label = args && TOOLS[name]?.describe ? TOOLS[name].describe(args) : name;
      process.stdout.write(`${ANSI.assistant.narration}🔧 ${label}${ANSI.reset}\n`);

      const result = args === null
        ? `Error: couldn't parse arguments for '${name}' as JSON`
        : await runTool(name, args);
      if (result.startsWith('Error:')) {
        process.stdout.write(`${ANSI.assistant.narration}   ${result}${ANSI.reset}\n`);
      }

      if (this.api === 'openai') {
        this.history.push({ role: 'tool', tool_call_id: call.id, content: result });
      } else {
        this.history.push({ role: 'tool', tool_name: name, content: result });
      }
    }
    process.stdout.write('\n');
  }

  // Streams one model response to the terminal and records it in history.
  // Returns any tool calls the model made (empty if it just answered).
  async streamTurn(allowTools = true) {
    let spinner = this.startSpinner();

    try {
      const isOpenAI = this.api === 'openai';
      const body = isOpenAI ? this.buildOpenAIChatBody() : this.buildOllamaChatBody();
      if (!allowTools) delete body.tools;
      const path = isOpenAI ? '/v1/chat/completions' : '/api/chat';

      const response = await streamingPost(`${this.host}${path}`, body);

      if (!response.ok) {
        const detail = await readErrorBody(response.body);
        let message = `API error: ${response.status} ${response.statusText}${detail ? ` - ${detail}` : ''}`;
        if (this.toolsEnabled && /tool/i.test(detail)) {
          message += "\n   (this model may not support tools - try '/set notools')";
        }
        throw new Error(message);
      }

      // Ollama sends each tool call whole; OpenAI-style servers stream them
      // as fragments keyed by index, with the arguments string split up.
      const toolCalls = [];
      const collectOpenAIToolCalls = (deltas) => {
        for (const delta of deltas) {
          const i = delta.index ?? toolCalls.length;
          toolCalls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (delta.id) toolCalls[i].id = delta.id;
          if (delta.function?.name) toolCalls[i].function.name += delta.function.name;
          if (delta.function?.arguments) toolCalls[i].function.arguments += delta.function.arguments;
        }
      };

      let fullResponse = '';
      let lineBuffer = '';
      let started = false;
      let thinkingStarted = false;
      let thinkingEnded = false;
      let stats = null;
      const decoder = new TextDecoder();
      const renderer = createMarkdownRenderer('assistant', 0, this.renderOptions());
      // Thinking text is the model's raw internal monologue, so it's wrapped
      // plain (no markdown rendering) in a constant dim color.
      const thinkingWrapper = createWordWrapper((t) => t);

      // `truncated` is set when the stream ended (done_reason !== 'stop')
      // before any answer content ever arrived - i.e. the model ran out of
      // its token/context budget mid-thought, not because it finished
      // reasoning. Otherwise "...done thinking." would print even though
      // the visible thinking text was really just chopped off mid-sentence.
      const endThinking = (truncated) => {
        if (thinkingStarted && !thinkingEnded) {
          thinkingWrapper.end();
          if (truncated) {
            process.stdout.write(`${ANSI.reset}\n⚠️  cut off - ran out of tokens while still thinking (raise num_predict/num_ctx with /set parameter)\n\n`);
          } else {
            process.stdout.write(`${ANSI.reset}\n...done thinking.\n\n`);
          }
          thinkingEnded = true;
        }
      };

      // OpenAI-compatible servers stream Server-Sent Events: 'data: {...}'
      // lines (one JSON chunk per event) terminated by a literal 'data: [DONE]'
      // line, rather than Ollama's bare-NDJSON-per-line format.
      let openaiFinishReason = null;
      let openaiUsage = null;
      const parseSSEChunk = (line) => {
        if (!line.startsWith('data:')) return null;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return null;
        try {
          return JSON.parse(data);
        } catch (e) {
          return null;
        }
      };

      const handleLine = async (line) => {
        if (!line.trim()) return;
        let json;
        if (isOpenAI) {
          json = parseSSEChunk(line);
          if (!json) return;
        } else {
          try {
            json = JSON.parse(line);
          } catch (e) {
            return; // Incomplete/malformed line; skip it.
          }
        }
        const choice = isOpenAI ? json.choices?.[0] : null;
        // reasoning_content is a de facto extension some OpenAI-compatible
        // servers (e.g. vLLM serving DeepSeek-R1-style models) use to stream
        // reasoning; there's no standardized field for it.
        const thinking = isOpenAI ? choice?.delta?.reasoning_content : json.message?.thinking;
        if (thinking && this.showThinking) {
          if (!thinkingStarted) {
            this.stopSpinner(spinner);
            spinner = null;
            process.stdout.write(`${ANSI.assistant.narration}Thinking...\n`);
            thinkingStarted = true;
          }
          thinkingWrapper.write(thinking);
        }
        const content = isOpenAI ? choice?.delta?.content : json.message?.content;
        if (content) {
          endThinking(false);
          if (!started) {
            this.stopSpinner(spinner);
            spinner = null;
            process.stdout.write(ANSI.assistant.dialogue);
            started = true;
          }
          await renderer.write(content);
          fullResponse += content;
        }
        if (isOpenAI) {
          if (choice?.delta?.tool_calls) collectOpenAIToolCalls(choice.delta.tool_calls);
        } else if (json.message?.tool_calls) {
          toolCalls.push(...json.message.tool_calls);
        }
        if (isOpenAI) {
          if (choice?.finish_reason) openaiFinishReason = choice.finish_reason;
          if (json.usage) openaiUsage = json.usage;
        } else if (json.done) {
          stats = json;
        }
      };

      // Stream the response. Chunks are raw bytes and don't align with NDJSON
      // line boundaries, so decode incrementally and buffer partial lines.
      for await (const chunk of response.body) {
        lineBuffer += decoder.decode(chunk, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop();
        for (const line of lines) {
          await handleLine(line);
        }
      }
      if (lineBuffer) {
        await handleLine(lineBuffer);
      }
      if (isOpenAI) {
        stats = { done_reason: openaiFinishReason || 'stop', usage: openaiUsage };
      }
      const doneReason = stats?.done_reason;
      endThinking(Boolean(doneReason && doneReason !== 'stop' && doneReason !== 'tool_calls'));
      await renderer.end();

      if (started) {
        process.stdout.write(ANSI.reset);
      }

      // Add assistant response to history (raw, asterisks intact)
      const calls = toolCalls.filter(Boolean);
      const message = { role: 'assistant', content: fullResponse };
      if (calls.length > 0) message.tool_calls = calls;
      this.history.push(message);

      // A tool-calling turn continues right away, so skip the blank-line
      // spacing (and stats) that close off a finished response.
      if (calls.length > 0) {
        if (started) process.stdout.write('\n');
        return calls;
      }

      process.stdout.write('\n');
      if (this.verbose && stats) {
        this.printStats(stats);
      }
      process.stdout.write('\n');
      return [];
    } finally {
      this.stopSpinner(spinner);
    }
  }

  printStats(stats) {
    if (this.api === 'openai') {
      if (!stats.usage) {
        console.log('  (token stats unavailable - server did not return usage data)');
        return;
      }
      console.log(`  prompt tokens:      ${stats.usage.prompt_tokens ?? 0}`);
      console.log(`  completion tokens:  ${stats.usage.completion_tokens ?? 0}`);
      console.log(`  total tokens:       ${stats.usage.total_tokens ?? 0}`);
      return;
    }
    const secs = (ns) => ((ns || 0) / 1e9).toFixed(2);
    const rate = (count, ns) => (ns ? (count / (ns / 1e9)).toFixed(2) : '0.00');
    console.log(`  total duration:       ${secs(stats.total_duration)}s`);
    console.log(`  load duration:        ${secs(stats.load_duration)}s`);
    console.log(`  prompt eval count:    ${stats.prompt_eval_count ?? 0} token(s)`);
    console.log(`  prompt eval duration: ${secs(stats.prompt_eval_duration)}s`);
    console.log(`  prompt eval rate:     ${rate(stats.prompt_eval_count, stats.prompt_eval_duration)} tokens/s`);
    console.log(`  eval count:           ${stats.eval_count ?? 0} token(s)`);
    console.log(`  eval duration:        ${secs(stats.eval_duration)}s`);
    console.log(`  eval rate:            ${rate(stats.eval_count, stats.eval_duration)} tokens/s`);
  }

  printWelcome() {
    console.clear?.();
    console.log('\n🚀 Ollama Interactive Chat');
    console.log(`📦 Model: ${this.model}`);
    if (this.api === 'ollama') console.log(`⏱️  Keep-alive: ${this.keepAlive}`);
    else console.log(`🔌 API: openai-compatible`);
    console.log(`🌐 Host: ${this.host}`);
    if (this.toolsEnabled) {
      console.log(`🔧 Tools: ${Object.keys(TOOLS).join(', ')} (${OLLAMA_API_KEY ? 'Ollama web search' : 'DuckDuckGo'})`);
    }
    console.log('\n📝 Commands:');
    this.printCommandList();
    console.log('\nPress Enter to send. Ctrl+J adds a new line without sending.');
    console.log('\n' + '='.repeat(50) + '\n');
  }

  printCommandList() {
    console.log('  /set            Set session variables');
    console.log('  /show           Show model information');
    console.log('  /load <model>   Load a session or model');
    console.log('  /save [name]    Save your current session to a file on this machine');
    console.log('  /share [name]   Save your current session as a model on the Ollama server');
    console.log('  /clear          Clear session context');
    console.log('  /model          Show current model, keep-alive, and host');
    console.log('  /list           List locally available models');
    console.log('  /bye            Exit');
    console.log('  /?, /help       Help for a command');
    console.log('  /? shortcuts    Help for keyboard shortcuts');
  }

  printHelp(topic) {
    if (topic === 'set') return this.printSetUsage();
    if (topic === 'show') return this.printShowUsage();
    if (topic === 'shortcuts') return this.printShortcuts();

    console.log('\nAvailable Commands:');
    this.printCommandList();
    console.log('');
  }

  printSetUsage() {
    console.log('\nAvailable Commands:');
    console.log('  /set parameter ...     Set a parameter');
    console.log('  /set system <string>   Set system message');
    console.log('  /set format json       Enable JSON mode');
    console.log('  /set noformat          Disable formatting');
    console.log('  /set verbose           Show LLM stats');
    console.log('  /set quiet             Disable LLM stats');
    console.log('  /set think [level]     Enable thinking');
    console.log('  /set nothink           Disable thinking');
    console.log('  /set showthinking      Show thinking output as it streams');
    console.log('  /set hidethinking      Hide thinking output');
    console.log('  /set tools             Let the model call tools (web_search, fetch_page)');
    console.log('  /set notools           Disable tool calling');
    console.log("  /set date              Tell the model today's date (default: on with tools)");
    console.log("  /set nodate            Don't tell the model today's date");
    console.log('  /set markdown          Render markdown in responses (default)');
    console.log('  /set nomarkdown        Show responses as raw text');
    console.log('  /set images            Download and draw ![images](url) inline (iTerm2, WezTerm, kitty, Ghostty)');
    console.log('  /set noimages          Show images as links (default)');
    console.log('  /set autosave          Save the session to a local file after each reply');
    console.log('  /set noautosave        Stop autosaving (default)');
    console.log('\nUse /show settings to see the current values.');
    console.log('');
  }

  // Everything /set (and the matching command-line flags) can change, with
  // the current value and, where it isn't obvious, what it comes from.
  printSettings() {
    const onOff = (value) => (value ? 'on' : 'off');
    const sys = this.getSystemMessage();
    const dateSetting = this.injectDate === undefined
      ? `${onOff(this.shouldInjectDate())} (automatic: follows tools)`
      : onOff(this.injectDate);
    const think = this.think === undefined ? 'model default' : this.think === false ? 'off' : this.think === true ? 'on' : this.think;
    const protocols = { iterm: 'iTerm2 inline images', kitty: 'kitty graphics' };
    const images = IMAGE_PROTOCOL
      ? `${onOff(this.images)} (terminal supports ${protocols[IMAGE_PROTOCOL]})`
      : "off (this terminal can't draw images)";
    const rows = [
      ['model', this.model],
      ['api', this.api === 'openai' ? 'openai-compatible' : 'ollama'],
      ['host', this.host],
      ...(this.api === 'ollama' ? [['keep-alive', this.keepAlive]] : []),
      ['system message', sys ? `set, ${sys.length} characters (/show system)` : 'none'],
      ['parameters', Object.keys(this.options).length
        ? Object.entries(this.options).map(([k, v]) => `${k}=${Array.isArray(v) ? JSON.stringify(v) : v}`).join(', ')
        : 'model defaults'],
      ['format', this.format || 'none'],
      ['think', think],
      ['show thinking', onOff(this.showThinking)],
      ['verbose', onOff(this.verbose)],
      ['tools', this.toolsEnabled ? `on (${Object.keys(TOOLS).join(', ')}; ${OLLAMA_API_KEY ? 'Ollama web search' : 'DuckDuckGo'})` : 'off'],
      ['date', dateSetting],
      ['markdown', onOff(this.markdown)],
      ['images', images],
      ['autosave', this.autosave ? `on (${this.sessionName ? `'${this.sessionName}'` : 'named after the next reply'})` : 'off'],
      ['stop on exit', onOff(this.stopOnExit)],
      ['defaults file', ENV_FILE_LOADED ? ENV_FILE : `none (${ENV_FILE})`]
    ];
    console.log('\nSession settings:');
    for (const [name, value] of rows) console.log(`  ${name.padEnd(16)} ${value}`);
    console.log('');
  }

  printShowUsage() {
    console.log('\nAvailable Commands:');
    console.log('  /show info         Show details for this model');
    console.log('  /show license      Show model license');
    console.log('  /show modelfile    Show Modelfile for this model');
    console.log('  /show parameters   Show parameters for this model');
    console.log('  /show settings     Show this session\'s settings (/set toggles, host, ...)');
    console.log('  /show system       Show system message');
    console.log('  /show template     Show prompt template');
    console.log('');
  }

  printShortcuts() {
    console.log('\nAvailable keyboard shortcuts:');
    console.log('  Enter               Send your message');
    console.log('  Ctrl + j            Insert a new line without sending');
    console.log('  Left / Right        Move the cursor');
    console.log('  Ctrl/Alt + arrows   Move a word at a time (also Alt + b / f)');
    console.log('  Home / End          Start / end of line (also Ctrl + a / e)');
    console.log('  Up / Down           Previous / next line, then message history');
    console.log('  Ctrl + w            Delete the previous word');
    console.log('  Ctrl + u / k        Delete to the start / end of the line');
    console.log('  Ctrl + c            Exit immediately');
    console.log('  Ctrl + d            Exit (on an empty line)');
    console.log('');
  }

  // Saves the session as a Modelfile on this machine: under `name`, or
  // under its current name, or else a new date-and-time name. Saving a
  // named session under a new name leaves the old file as it was (later
  // saves, and autosave, go to the new one); a session that only has an
  // autosave name is renamed instead, so it doesn't leave a stray copy.
  // Asks before overwriting a different session's file.
  async save(name) {
    const previous = this.sessionName;
    const target = name || previous || await autosaveName();
    const renaming = previous && previous !== target && isAutosaveName(previous);
    try {
      if (target !== previous && await localSessionExists(target) &&
          !await this.confirm(`\nA saved session named '${target}' already exists. Overwrite it?`)) {
        console.log('Not saved.\n');
        return;
      }
      const file = await saveLocalSession(target, this.sessionSnapshot());
      if (renaming) await deleteLocalSession(previous);
      this.sessionName = target;
      if (renaming) console.log(`\n✅ Renamed session '${previous}' to '${target}' (${file})`);
      else console.log(`\n✅ Saved session '${target}' to ${file}`);
      if (previous && previous !== target && !renaming) console.log(`   '${previous}' is unchanged; from now on this session saves as '${target}'.`);
      console.log(`   Resume it with /load ${target}, or start with: skinnyai.js ${target}\n`);
    } catch (error) {
      console.error(`\n❌ Error saving session: ${error.message}\n`);
    }
  }

  // Pushes the session to the Ollama server as a model (via /api/create,
  // like `/save` in `ollama run`), so `ollama run <name>` resumes it from
  // anywhere that server is used. Only a self-hosted Ollama supports this.
  async share(name) {
    if (this.api !== 'ollama') {
      console.log("\n❌ /share needs an Ollama server; OpenAI-compatible servers can't store sessions. Use /save to keep it locally.\n");
      return;
    }
    if (isOllamaCom(this.host)) {
      console.log("\n❌ ollama.com doesn't accept shared sessions; /share only works with a self-hosted Ollama server. Use /save to keep it locally.\n");
      return;
    }
    const target = name || this.sessionName || await autosaveName();
    try {
      // /api/create silently replaces a model of the same name.
      const existing = await hostFetch(`${this.host}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: target })
      });
      if (existing.ok && !await this.confirm(`\nA model named '${target}' already exists on ${this.host}. Replace it?`)) {
        console.log('Not shared.\n');
        return;
      }
      await this.saveOnServer(target, this.getSystemMessage(), this.savableMessages());
      console.log(`\n✅ Shared session as model '${target}' on ${this.host}`);
      console.log(`   Resume it with /load ${target}, or: ollama run ${target}\n`);
    } catch (error) {
      console.error(`\n❌ Error sharing session: ${error.message}\n`);
    }
  }

  async saveOnServer(name, system, messages) {
    const body = { model: name, from: this.model, stream: false };
    if (system) body.system = system;
    if (messages.length > 0) body.messages = messages;
    if (Object.keys(this.options).length > 0) body.parameters = this.options;

    const response = await hostFetch(`${this.host}/api/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    const result = await response.json();
    if (result.status && result.status !== 'success') {
      throw new Error(result.status);
    }
  }

  async load(name) {
    if (!name) {
      console.log('\nUsage:\n  /load <modelname>\n');
      return;
    }

    // A session saved on this machine takes precedence over a model of the
    // same name, since saving it was an explicit choice.
    try {
      const session = await readLocalSession(name);
      if (session) {
        console.log('');
        await this.applyLocalSession(name, session);
        return;
      }
    } catch (error) {
      console.log(`\n❌ Error reading saved session '${name}': ${error.message}\n`);
      return;
    }

    // OpenAI-compatible servers have no /api/show equivalent to restore a
    // saved system message/history from, so /load there just switches the
    // active model name and starts a fresh session.
    if (this.api !== 'ollama') {
      this.model = name;
      this.history = [];
      this.sessionName = null;
      this.options = {};
      this.format = '';
      this.think = undefined;
      console.log(`\n📦 Switched to model '${name}' (no saved session by that name, so starting fresh)\n`);
      return;
    }

    console.log(`\nLoading model '${name}'...`);
    try {
      const ok = await this.fetchAndApplyModelContext(name);
      if (!ok) {
        console.log(`Couldn't find model '${name}'\n`);
      } else {
        console.log('');
      }
    } catch (error) {
      console.log(`\n❌ Error loading model: ${error.message}\n`);
    }
  }

  async list() {
    try {
      if (this.api !== 'ollama') {
        const response = await hostFetch(`${this.host}/v1/models`);
        if (!response.ok) {
          throw new Error(`API error: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        console.log('');
        for (const m of data.data || []) {
          console.log(`  ${m.id}`);
        }
      } else {
        const response = await hostFetch(`${this.host}/api/tags`);
        if (!response.ok) {
          throw new Error(`API error: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        console.log('');
        for (const m of data.models || []) {
          const sizeGB = (m.size / 1e9).toFixed(1);
          console.log(`  ${m.name.padEnd(35)} ${sizeGB} GB`);
        }
      }
    } catch (error) {
      console.log(`\n❌ Error: ${error.message}`);
    }

    const sessions = await listLocalSessions();
    if (sessions.length > 0) {
      console.log(`\nSaved sessions (${SESSION_DIR}):`);
      for (const name of sessions) console.log(`  ${name}`);
    }
    console.log('');
  }

  async show(args) {
    const sub = (args[0] || '').toLowerCase();
    if (!sub) {
      this.printShowUsage();
      return;
    }
    if (sub === 'settings') {
      this.printSettings();
      return;
    }

    if (this.api !== 'ollama') {
      if (sub === 'system') {
        const sys = this.getSystemMessage();
        console.log(sys ? `\n${sys}\n` : '\nNo system message was specified for this session.\n');
      } else {
        console.log(`\n❌ /show ${sub} isn't supported for --api openai (no /api/show equivalent)\n`);
      }
      return;
    }

    let info;
    try {
      const response = await hostFetch(`${this.host}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model })
      });
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }
      info = await response.json();
    } catch (error) {
      console.log(`\n❌ Error: ${error.message}\n`);
      return;
    }

    switch (sub) {
      case 'info': {
        const d = info.details || {};
        console.log('\n  Model');
        console.log(`    architecture        ${d.family || 'unknown'}`);
        console.log(`    parameters          ${d.parameter_size || 'unknown'}`);
        console.log(`    quantization        ${d.quantization_level || 'unknown'}`);
        if (info.capabilities?.length) {
          console.log('\n  Capabilities');
          for (const c of info.capabilities) console.log(`    ${c}`);
        }
        console.log('');
        break;
      }
      case 'license':
        console.log(info.license ? `\n${info.license}\n` : '\nNo license was specified for this model.\n');
        break;
      case 'modelfile':
        console.log(info.modelfile ? `\n${info.modelfile}\n` : '\nNo modelfile is available for this model.\n');
        break;
      case 'parameters': {
        console.log('\nModel defined parameters:');
        if (info.parameters) {
          for (const line of info.parameters.split('\n')) console.log(`  ${line}`);
        } else {
          console.log('  No additional parameters were specified for this model.');
        }
        if (Object.keys(this.options).length > 0) {
          console.log('\nUser defined parameters:');
          for (const [k, v] of Object.entries(this.options)) {
            console.log(`  ${k.padEnd(30)} ${v}`);
          }
        }
        console.log('');
        break;
      }
      case 'system': {
        const sys = this.getSystemMessage() || info.system;
        console.log(sys ? `\n${sys}\n` : '\nNo system message was specified for this model.\n');
        break;
      }
      case 'template':
        console.log(info.template ? `\n${info.template}\n` : '\nNo prompt template was specified for this model.\n');
        break;
      default:
        console.log(`\nUnknown command '/show ${sub}'. Type /help for help\n`);
    }
  }

  handleSet(args) {
    const [sub, ...rest] = args;
    switch (sub) {
      case undefined:
        this.printSetUsage();
        break;
      case 'system':
        if (rest.length === 0) {
          console.log('\nUsage:\n  /set system <string>\n');
          break;
        }
        this.setSystemMessage(rest.join(' '));
        console.log('Set system message.\n');
        break;
      case 'parameter': {
        if (rest.length < 2) {
          this.printSetUsage();
          break;
        }
        const [name, ...values] = rest;
        this.setParameter(name, values);
        console.log(`Set parameter '${name}' to '${values.join(', ')}'\n`);
        break;
      }
      case 'format':
        if (rest[0] === 'json') {
          this.format = 'json';
          console.log("Set format to 'json' mode.\n");
        } else {
          console.log("Invalid or missing format. For 'json' mode use '/set format json'\n");
        }
        break;
      case 'noformat':
        this.format = '';
        console.log('Disabled format.\n');
        break;
      case 'verbose':
        this.verbose = true;
        console.log("Set 'verbose' mode.\n");
        break;
      case 'quiet':
        this.verbose = false;
        console.log("Set 'quiet' mode.\n");
        break;
      case 'think': {
        const level = rest[0];
        this.think = level || true;
        console.log(level ? `Set 'think' mode to '${level}'.\n` : "Set 'think' mode.\n");
        break;
      }
      case 'nothink':
        this.think = false;
        console.log("Set 'nothink' mode.\n");
        break;
      case 'showthinking':
        this.showThinking = true;
        console.log("Set 'showthinking' mode.\n");
        break;
      case 'hidethinking':
        this.showThinking = false;
        console.log("Set 'hidethinking' mode.\n");
        break;
      case 'tools':
        this.toolsEnabled = true;
        console.log(`Set 'tools' mode (${Object.keys(TOOLS).join(', ')}).\n`);
        break;
      case 'notools':
        this.toolsEnabled = false;
        console.log("Set 'notools' mode.\n");
        break;
      case 'date':
        this.injectDate = true;
        console.log("Set 'date' mode (the model is told today's date).\n");
        break;
      case 'nodate':
        this.injectDate = false;
        console.log("Set 'nodate' mode.\n");
        break;
      case 'markdown':
        this.markdown = true;
        console.log("Set 'markdown' mode.\n");
        break;
      case 'nomarkdown':
        this.markdown = false;
        console.log("Set 'nomarkdown' mode (responses are shown as raw text).\n");
        break;
      case 'images':
        if (!IMAGE_PROTOCOL) {
          console.log("This terminal can't draw inline images (iTerm2, WezTerm, kitty, and Ghostty can;");
          console.log('tmux and screen block them). Images are shown as links instead.\n');
          break;
        }
        this.images = true;
        console.log("Set 'images' mode (markdown images are downloaded and drawn inline).\n");
        break;
      case 'noimages':
        this.images = false;
        console.log("Set 'noimages' mode.\n");
        break;
      case 'autosave':
        this.autosave = true;
        console.log(this.sessionName
          ? `Set 'autosave' mode (saving to '${this.sessionName}' after each reply).\n`
          : "Set 'autosave' mode (the session is saved after each reply, named from the date and time).\n");
        return this.autosaveSession();
      case 'noautosave':
        this.autosave = false;
        console.log("Set 'noautosave' mode.\n");
        break;
      case 'history':
      case 'nohistory':
        console.log(`\n'/set ${sub}' doesn't apply here - input history (Up/Down) lasts for this`);
        console.log('session only and is never written to disk.\n');
        break;
      default:
        console.log(`Unknown command '/set ${sub}'. Type /help for help\n`);
    }
  }

  async handleCommand(input) {
    const trimmed = input.trim();
    const [rawCmd, ...rest] = trimmed.split(/\s+/);
    const cmd = rawCmd.toLowerCase();

    switch (cmd) {
      case '/exit':
      case '/bye':
        console.log('\n👋 Goodbye!\n');
        return false;
      case '/clear': {
        const system = this.getSystemMessage();
        this.history = system ? [{ role: 'system', content: system }] : [];
        this.sessionName = null; // a new conversation gets its own autosave file
        console.log('🗑️  Conversation history cleared.\n');
        return true;
      }
      case '/model':
        console.log(`\n📦 Current model: ${this.model}`);
        if (this.api === 'ollama') console.log(`⏱️  Keep-alive: ${this.keepAlive}`);
        else console.log(`🔌 API: openai-compatible`);
        console.log(`🌐 Host: ${this.host}\n`);
        return true;
      case '/save':
        await this.save(rest.join(' '));
        return true;
      case '/share':
        await this.share(rest.join(' '));
        return true;
      case '/load':
        await this.load(rest.join(' '));
        return true;
      case '/list':
        await this.list();
        return true;
      case '/show':
        await this.show(rest);
        return true;
      case '/set':
        await this.handleSet(rest);
        return true;
      case '/help':
      case '/?':
        this.printHelp(rest[0]?.toLowerCase());
        return true;
      default:
        return null; // Not a command
    }
  }

  // Reads one turn of input. On a real TTY this is a small line editor (see
  // editLine); otherwise it reads a line from piped stdin. Resolves null on
  // Ctrl+D / end of input to signal "quit".
  async readTurnInput() {
    return process.stdin.isTTY ? this.editLine() : this.readPipedLine();
  }

  // Piped stdin gets one readline interface for the whole session: each
  // interface reads ahead and buffers lines, so a fresh one per turn would
  // lose whatever its predecessor had already read. The line is echoed after
  // the prompt so the transcript reads like an interactive session.
  async readPipedLine() {
    process.stdout.write(PROMPT);
    const line = await this.nextPipedLine();
    if (line !== null) process.stdout.write(`${line}\n`);
    return line;
  }

  nextPipedLine() {
    if (!this.pipedInput) {
      const lines = [];
      const waiting = [];
      let closed = false;
      const rl = readline.createInterface({ input: process.stdin, terminal: false });
      rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
      rl.on('close', () => {
        closed = true;
        while (waiting.length) waiting.shift()(null);
      });
      this.pipedInput = () => {
        if (lines.length) return Promise.resolve(lines.shift());
        if (closed) return Promise.resolve(null);
        return new Promise((resolve) => waiting.push(resolve));
      };
    }
    return this.pipedInput();
  }

  // Asks a yes/no question; anything but 'y' is no. On a TTY it takes a
  // single keypress; with piped input it reads (and echoes) the next line,
  // so scripts can answer it.
  async confirm(question) {
    process.stdout.write(`${question} [y/N] `);
    if (!process.stdin.isTTY) {
      const line = await this.nextPipedLine();
      process.stdout.write(`${line ?? ''}\n`);
      return /^\s*y(es)?\s*$/i.test(line ?? '');
    }
    return new Promise((resolve) => {
      const stdin = process.stdin;
      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.once('keypress', (str) => {
        stdin.setRawMode(false);
        stdin.pause();
        const yes = /^y$/i.test(str || '');
        process.stdout.write(yes ? 'yes\n' : 'no\n');
        resolve(yes);
      });
    });
  }

  // A small line editor. Enter submits; Ctrl+J (and Shift+Enter, if the
  // terminal sends a distinguishable sequence for it - most don't) inserts a
  // newline. Supports cursor movement (arrows, Home/End, Ctrl+A/E, word jumps
  // with Ctrl/Alt+arrows or Alt+B/F), deletion (Backspace, Delete, Ctrl+W,
  // Ctrl+U, Ctrl+K), history recall with Up/Down (from the first/last line of
  // a multi-line message), and bracketed paste, so pasted line breaks become
  // part of the message instead of submitting it. The whole input is redrawn
  // after each change, which keeps wrapping and wide characters simple.
  async editLine() {
    return new Promise((resolve) => {
      const stdin = process.stdin;
      const history = this.inputHistory;
      let buffer = '';
      let cursor = 0; // UTF-16 index into buffer, always on a grapheme boundary
      let cursorRow = 0; // terminal row the cursor is on, relative to the prompt's
      let historyIndex = history.length;
      let draft = ''; // unsent input, kept while browsing history
      let pasting = false;

      const render = () => {
        const end = inputPosition(buffer);
        const target = inputPosition(buffer.slice(0, cursor));
        let out = cursorRow > 0 ? `\x1b[${cursorRow}A` : '';
        // Raw mode disables automatic CR-on-LF, so embedded newlines need an explicit \r.
        out += '\r\x1b[J' + styledPrompt() + buffer.replace(/\n/g, '\r\n');
        if (end.pending) out += ' \r'; // move off the right edge onto the next row
        if (end.row > target.row) out += `\x1b[${end.row - target.row}A`;
        out += '\r' + (target.col > 0 ? `\x1b[${target.col}C` : '');
        cursorRow = target.row;
        process.stdout.write(out);
      };

      // Cursor steps and deletes whole grapheme clusters, so an emoji like ⚠️
      // or 👩‍💻 behaves as the single character it looks like.
      const boundaries = () => [...Array.from(graphemes.segment(buffer), (g) => g.index), buffer.length];
      const prev = (i) => boundaries().filter((b) => b < i).pop() ?? 0;
      const next = (i) => boundaries().find((b) => b > i) ?? buffer.length;
      const snap = (i) => boundaries().filter((b) => b <= i).pop() ?? 0;
      const lineStart = (i) => buffer.lastIndexOf('\n', i - 1) + 1;
      const lineEnd = (i) => (buffer.indexOf('\n', i) === -1 ? buffer.length : buffer.indexOf('\n', i));
      const wordLeft = (i) => {
        while (i > 0 && /\s/.test(buffer[i - 1])) i--;
        while (i > 0 && !/\s/.test(buffer[i - 1])) i--;
        return i;
      };
      const wordRight = (i) => {
        while (i < buffer.length && /\s/.test(buffer[i])) i++;
        while (i < buffer.length && !/\s/.test(buffer[i])) i++;
        return i;
      };

      const insert = (text) => {
        buffer = buffer.slice(0, cursor) + text + buffer.slice(cursor);
        cursor += text.length;
      };
      const remove = (from, to) => {
        buffer = buffer.slice(0, from) + buffer.slice(to);
        cursor = from;
      };
      const recall = (index) => {
        if (historyIndex === history.length) draft = buffer;
        historyIndex = index;
        buffer = index === history.length ? draft : history[index];
        cursor = buffer.length;
      };

      const cleanup = () => {
        process.stdout.write('\x1b[?2004l'); // bracketed paste off
        stdin.removeListener('keypress', onKeypress);
        stdin.setRawMode(false);
        stdin.pause();
      };

      const onKeypress = async (str, key) => {
        key = key || {};

        if (key.name === 'paste-start') {
          pasting = true;
          return;
        }
        if (key.name === 'paste-end') {
          pasting = false;
          render();
          return;
        }
        if (pasting) {
          // Terminals send pasted line breaks as \r; keep them as newlines.
          if (key.name === 'return' || key.name === 'enter') insert('\n');
          else if (str && !/[\x00-\x08\x0b-\x1f\x7f]/.test(str)) insert(str);
          return;
        }

        if (key.ctrl && key.name === 'c') {
          cleanup();
          process.stdout.write('\n');
          if (this.stopOnExit) {
            await this.stopModel();
          }
          process.exit(0);
          return;
        }

        if (key.ctrl && key.name === 'd' && buffer.length === 0) {
          cleanup();
          process.stdout.write('\n');
          resolve(null);
          return;
        }

        // Enter sends \r ('return'); Ctrl+J sends a bare \n, which Node names 'enter'.
        const isNewlineInsert =
          key.name === 'enter' ||
          (key.name === 'return' && (key.shift || key.meta)) || // best-effort shift+enter
          str === '\x1b[13;2u';
        if (isNewlineInsert) {
          insert('\n');
        } else if (key.name === 'return') {
          cursor = buffer.length;
          render();
          cleanup();
          process.stdout.write('\r\n');
          if (buffer.trim() && buffer !== history[history.length - 1]) history.push(buffer);
          resolve(buffer);
          return;
        } else if (key.name === 'backspace') {
          if (key.meta) remove(wordLeft(cursor), cursor);
          else if (cursor > 0) remove(prev(cursor), cursor);
        } else if (key.name === 'delete' || (key.ctrl && key.name === 'd')) {
          if (cursor < buffer.length) remove(cursor, next(cursor));
        } else if (key.ctrl && key.name === 'w') {
          remove(wordLeft(cursor), cursor);
        } else if (key.ctrl && key.name === 'u') {
          remove(lineStart(cursor), cursor);
        } else if (key.ctrl && key.name === 'k') {
          const end = lineEnd(cursor);
          buffer = buffer.slice(0, cursor) + buffer.slice(end === cursor && end < buffer.length ? end + 1 : end);
        } else if ((key.name === 'left' && (key.ctrl || key.meta)) || (key.meta && key.name === 'b')) {
          cursor = wordLeft(cursor);
        } else if ((key.name === 'right' && (key.ctrl || key.meta)) || (key.meta && key.name === 'f')) {
          cursor = wordRight(cursor);
        } else if (key.name === 'left' || (key.ctrl && key.name === 'b')) {
          cursor = prev(cursor);
        } else if (key.name === 'right' || (key.ctrl && key.name === 'f')) {
          cursor = next(cursor);
        } else if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
          cursor = lineStart(cursor);
        } else if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
          cursor = lineEnd(cursor);
        } else if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
          const start = lineStart(cursor);
          if (start > 0) {
            const above = lineStart(start - 1);
            cursor = snap(Math.min(above + (cursor - start), start - 1));
          } else if (historyIndex > 0) {
            recall(historyIndex - 1);
          }
        } else if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
          const end = lineEnd(cursor);
          if (end < buffer.length) {
            const below = end + 1;
            cursor = snap(Math.min(below + (cursor - lineStart(cursor)), lineEnd(below)));
          } else if (historyIndex < history.length) {
            recall(historyIndex + 1);
          }
        } else if (str && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str)) {
          insert(str);
        } else {
          return; // Unhandled key (Tab, Escape, function keys, ...)
        }
        render();
      };

      process.stdout.write(styledPrompt() + '\x1b[?2004h'); // bracketed paste on
      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('keypress', onKeypress);
    });
  }

  // Overwrites the raw (unstyled) lines the user just typed with the styled
  // version. Handles input that spans multiple terminal rows, whether from
  // wrapping or embedded newlines (Ctrl+J), by erasing the whole block and
  // rewriting it rather than assuming a single row.
  rewriteInputLine(input) {
    if (!supportsColor || !process.stdin.isTTY || !process.stdout.isTTY) return;

    const rows = inputPosition(input).row + 1;

    process.stdout.moveCursor(0, -rows);
    process.stdout.cursorTo(0);
    process.stdout.clearScreenDown();
    process.stdout.write(`${styledPrompt()}${styleLine('user', input)}`.replace(/\n/g, '\r\n') + '\r\n');
  }

  async start() {
    this.printWelcome();
    await this.loadModelContext();

    while (true) {
      const input = await this.readTurnInput();

      if (input === null) {
        console.log('\n👋 Goodbye!\n');
        break;
      }

      if (!input.trim()) {
        continue;
      }

      this.rewriteInputLine(input);

      // Check if it's a command
      if (input.startsWith('/')) {
        const shouldContinue = await this.handleCommand(input);
        if (shouldContinue === false) {
          break;
        }
        continue;
      }

      // Send to Ollama
      await this.chat(input);
    }

    if (this.stopOnExit) {
      await this.stopModel();
    }
  }
}

// Settings the .env file (or the environment) can default, by variable
// name: [option key, type]. Each matches a command-line flag.
const ENV_SETTINGS = {
  SKINNY_MODEL: ['model', 'string'],
  SKINNY_HOST: ['host', 'string'],
  SKINNY_API: ['api', 'string'],
  SKINNY_KEEP_ALIVE: ['keepAlive', 'string'],
  SKINNY_TOOLS: ['tools', 'boolean'],
  SKINNY_DATE: ['date', 'boolean'],
  SKINNY_MARKDOWN: ['markdown', 'boolean'],
  SKINNY_IMAGES: ['images', 'boolean'],
  SKINNY_AUTOSAVE: ['autosave', 'boolean'],
  SKINNY_HIDE_THINKING: ['hideThinking', 'boolean'],
  SKINNY_STOP_ON_EXIT: ['stopOnExit', 'boolean'],
  SKINNY_USER_NORMAL_COLOR: ['userNormalColor', 'string'],
  SKINNY_USER_ITALIC_COLOR: ['userEmphasisColor', 'string'],
  SKINNY_MODEL_NORMAL_COLOR: ['modelNormalColor', 'string'],
  SKINNY_MODEL_ITALIC_COLOR: ['modelEmphasisColor', 'string']
};

function envOptions() {
  const options = {};
  for (const [name, [key, type]] of Object.entries(ENV_SETTINGS)) {
    const value = process.env[name];
    if (value === undefined || value === '') continue;
    if (type === 'string') {
      options[key] = value;
    } else if (/^(1|true|yes|on)$/i.test(value)) {
      options[key] = true;
    } else if (/^(0|false|no|off)$/i.test(value)) {
      options[key] = false;
    } else {
      console.error(`❌ Error: ${name} must be true or false (got '${value}')${ENV_FILE_LOADED ? ` - check ${ENV_FILE}` : ''}\n`);
      process.exit(1);
    }
  }
  return options;
}

// Boolean flags, each with a --no- (or opposite) form so a flag can
// override a .env default either way.
const BOOLEAN_FLAGS = {
  '--tools': ['tools', true], '--no-tools': ['tools', false],
  '--date': ['date', true], '--no-date': ['date', false],
  '--markdown': ['markdown', true], '--no-markdown': ['markdown', false],
  '--images': ['images', true], '--no-images': ['images', false],
  '--autosave': ['autosave', true], '--no-autosave': ['autosave', false],
  '--hide-thinking': ['hideThinking', true], '--show-thinking': ['hideThinking', false],
  '-x': ['stopOnExit', true], '--stop-on-exit': ['stopOnExit', true], '--no-stop-on-exit': ['stopOnExit', false]
};

// Parse command line arguments, on top of the .env/environment defaults.
function parseArgs() {
  const args = process.argv.slice(2);
  const { model: defaultModel, ...options } = envOptions();
  let model = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' || args[i] === '-m') {
      model = args[++i];
    } else if (args[i] === '--keep-alive' || args[i] === '-k') {
      options.keepAlive = args[++i];
    } else if (args[i] === '--host' || args[i] === '-h') {
      options.host = args[++i];
    } else if (args[i] === '--user-italic-color' || args[i] === '--user-emphasis-color') {
      options.userEmphasisColor = args[++i];
    } else if (args[i] === '--user-normal-color') {
      options.userNormalColor = args[++i];
    } else if (args[i] === '--model-italic-color' || args[i] === '--model-emphasis-color') {
      options.modelEmphasisColor = args[++i];
    } else if (args[i] === '--model-normal-color') {
      options.modelNormalColor = args[++i];
    } else if (BOOLEAN_FLAGS[args[i]]) {
      const [key, value] = BOOLEAN_FLAGS[args[i]];
      options[key] = value;
    } else if (args[i] === '--api') {
      options.api = args[++i];
    } else if (args[i] === '--help') {
      printUsage();
      process.exit(0);
    } else if (!model && !args[i].startsWith('-')) {
      // First non-flag argument is the model
      model = args[i];
    }
  }

  return { model: model || defaultModel, options };
}

function printUsage() {
  console.log(`
Usage: skinnyai.js [model] [options]

Arguments:
  model                Model name (e.g., llama2, neural-chat)

Options:
  -m, --model NAME     Specify model name
  -k, --keep-alive TIME   Keep model loaded for TIME (default: 1h)
                       Examples: 5m, 1h, 24h, 30s
  -h, --host URL      Ollama API host (default: http://localhost:11434)
                       Use https://ollama.com for cloud models; needs the
                       OLLAMA_API_KEY environment variable
  --user-italic-color COLOR     Color for *italic*/narration in your messages (default: 136 / dim yellow)
  --user-normal-color COLOR     Color for dialogue in your messages (default: 226 / bright yellow)
  --model-italic-color COLOR    Color for *italic*/narration in model responses (default: 28 / dim green)
  --model-normal-color COLOR    Color for dialogue in model responses (default: 83 / bright green)
                       COLOR can be a hex code (#RRGGBB), a 256-color index (0-255),
                       or a name (red, green, yellow, blue, magenta, cyan, white, black,
                       or bright- prefixed, e.g. brightgreen; gray/grey aliases brightblack)
                       (--user-emphasis-color / --model-emphasis-color still work as aliases)
  --no-markdown        Show responses as raw text instead of rendering markdown
                       (same as running \`/set nomarkdown\`)
  --images             Download and draw markdown images inline, in terminals
                       that support it: iTerm2, WezTerm, kitty, Ghostty (same
                       as running \`/set images\`). Off by default, since it
                       fetches whatever image URLs the model writes.
  -x, --stop-on-exit   Unload the model from Ollama when the session ends
                       (same effect as \`ollama stop\`)
  --autosave           Save the session to a local file after each reply,
                       named from the date and time; /save <name> renames it
                       (same as running \`/set autosave\`)
  --hide-thinking      Don't stream thinking-model reasoning output
                       (shown by default; same as running \`/set hidethinking\`)
  --tools              Let the model call tools - web_search (DuckDuckGo) and
                       fetch_page (same as running \`/set tools\`). Needs a
                       tool-capable model (e.g. llama3.1, qwen3). With
                       OLLAMA_API_KEY set, uses Ollama's hosted search/fetch.
  --date, --no-date    Always / never tell the model today's date via the
                       system message (default: only when tools are on)
  --api <ollama|openai>  Backend API to speak (default: ollama)
                       Use 'openai' for OpenAI-compatible servers (vLLM,
                       llama.cpp server, LM Studio, ...). Ollama-only
                       features (/save, /show info/license/modelfile/
                       parameters/template, keep-alive, --stop-on-exit)
                       aren't supported there and are disabled/no-ops.
  --help              Show this message

  Every on/off flag has an opposite (--no-tools, --no-images, --no-autosave,
  --markdown, --show-thinking, --no-stop-on-exit), to override a default.

Defaults:
  Settings can be defaulted in ${ENV_FILE}
  (or $SKINNY_HOME/.env) as KEY=value lines, e.g.:
    SKINNY_MODEL=gemma4:31b        SKINNY_HOST=https://ollama.com
    SKINNY_TOOLS=true              SKINNY_AUTOSAVE=true
    OLLAMA_API_KEY=...
  Also: SKINNY_API, SKINNY_KEEP_ALIVE, SKINNY_DATE, SKINNY_MARKDOWN,
  SKINNY_IMAGES, SKINNY_HIDE_THINKING, SKINNY_STOP_ON_EXIT, and
  SKINNY_{USER,MODEL}_{NORMAL,ITALIC}_COLOR. Environment variables override
  the file, and command-line flags override both.

Examples:
  skinnyai.js llama2
  skinnyai.js neural-chat --keep-alive 30m
  skinnyai.js --model mistral --keep-alive 2h --host http://192.168.1.100:11434
  skinnyai.js llama2 --user-normal-color cyan --model-normal-color "#ff8800"
  skinnyai.js llama2 --stop-on-exit
  skinnyai.js qwen3 --tools
`);
}

// Main
async function main() {
  const { model, options } = parseArgs();

  if (!model) {
    console.error('❌ Error: Model name is required\n');
    printUsage();
    process.exit(1);
  }

  if (options.api && !['ollama', 'openai'].includes(options.api)) {
    console.error(`❌ Error: --api must be 'ollama' or 'openai' (got '${options.api}')\n`);
    process.exit(1);
  }

  applyColorOverrides(options);

  const chat = new OllamaChat(model, options);
  
  try {
    await chat.start();
  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  }
}

// Run only when executed directly, not when imported (as the tests do).
// argv[1] may be a symlink, like ~/.local/bin/skinnyai, so compare real paths.
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch (error) {
    return false;
  }
}

if (invokedDirectly()) main().catch(console.error);

export {
  charWidth, graphemeWidth, visibleWidth, createInlineStyler, styleLine, createWordWrapper,
  splitTableRow, wrapStyled, renderTable, createMarkdownRenderer, inputPosition,
  sniffImage, imageSequence, loadImage,
  formatModelfile, parseModelfile, saveLocalSession, readLocalSession, listLocalSessions,
  localSessionExists, isAutosaveName, autosaveName, sessionPath,
  loadEnvFile, envOptions, parseArgs, isOllamaCom, OllamaChat, main,
  PROMPT, SESSION_DIR, ENV_FILE
};
