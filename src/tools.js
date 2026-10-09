import dnsCallbacks from 'node:dns';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { VERSION } from './config.js';
import { ollamaApiKey, ollamaAuthHeaders } from './http.js';
import { ANSI } from './style.js';

// --- Tools (enabled with --tools or /set tools) ---

export const MAX_TOOL_ROUNDS = 5;
export const SEARCH_TIMEOUT_MS = 10000;
// An honest identity: skinnyai fetches pages on the user's behalf and says so,
// rather than posing as a browser.
export const APP_HEADERS = {
  'User-Agent': `skinnyai/${VERSION} (+https://github.com/wesbiggs/skinnyai)`,
  'Accept-Language': 'en-US,en;q=0.9'
};

export function decodeEntities(text) {
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

export function stripHtml(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// DuckDuckGo's official Instant Answer API: Wikipedia-style abstracts and
// direct answers only, not web results - many queries come back empty. Its
// terms ask for the t= app name and attribution to DuckDuckGo and the source.
export async function ddgInstantAnswer(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=skinnyai`;
  const res = await fetch(url, { headers: APP_HEADERS, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Instant Answer API: HTTP ${res.status}`);
  const data = await res.json();
  const lines = [];
  if (data.Answer) lines.push(`Answer: ${stripHtml(String(data.Answer))}`);
  if (data.AbstractText) {
    lines.push(`${data.Heading ? data.Heading + ': ' : ''}${data.AbstractText}`);
    if (data.AbstractURL) lines.push(`Source: ${data.AbstractSource ? data.AbstractSource + ', ' : ''}${data.AbstractURL}`);
  }
  if (data.Definition) {
    lines.push(`Definition: ${data.Definition}`);
    if (data.DefinitionURL) lines.push(`Source: ${data.DefinitionURL}`);
  }
  if (lines.length) lines.push('(Instant answer from DuckDuckGo, https://duckduckgo.com)');
  return lines.join('\n');
}

// Ollama's hosted search (used when ollamaApiKey() is set) returns each
// result's page text, not just a snippet, so small models get real content
// without having to chain a fetch_page call. That text runs 3-11K characters
// per result, so each is cut down to keep five of them within context.
export const OLLAMA_SEARCH_RESULTS = 5;
export const MAX_RESULT_CHARS = 1500;

export async function ollamaApi(path, body) {
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
export const CHROME_RUN_LENGTH = 6;
export function tidyText(text) {
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

export async function ollamaWebSearch(query) {
  const { results = [] } = await ollamaApi('web_search', { query, max_results: OLLAMA_SEARCH_RESULTS });
  return results.map((r, i) => {
    const content = tidyText(r.content || '');
    const text = content.length > MAX_RESULT_CHARS ? `${content.slice(0, MAX_RESULT_CHARS)}…` : content;
    return `[${i + 1}] ${r.title}\nURL: ${r.url}\n${text}`;
  }).join('\n\n');
}

// The hosted APIs share the free tier's usage limits; when a call fails,
// say so and fall back to the keyless implementation rather than failing.
export function noteFallback(what, error) {
  process.stdout.write(`${ANSI.assistant.narration}   ⚠️  Ollama ${what} failed (${error.message}); falling back to the local implementation${ANSI.reset}\n`);
}

export const NO_KEY_NOTE = 'Without an Ollama API key, web_search only returns DuckDuckGo Instant Answers (encyclopedia-style summaries), not web results. Set OLLAMA_API_KEY (a free ollama.com account) for full web search.';

export async function webSearch({ query }) {
  if (!query || typeof query !== 'string') throw new Error("missing 'query' argument");
  if (ollamaApiKey()) {
    try {
      return (await ollamaWebSearch(query)) || `No results found for "${query}".`;
    } catch (error) {
      noteFallback('web search', error);
    }
  }
  const instant = await ddgInstantAnswer(query);
  return instant || `No instant answer found for "${query}". ${NO_KEY_NOTE}`;
}

export const FETCH_TIMEOUT_MS = 15000;
export const MAX_FETCH_BYTES = 3 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
// ~1500 tokens. Ollama's default context window is small (often 4096
// tokens), so a whole page would push the conversation out of it.
export const MAX_PAGE_CHARS = 6000;

// Pages the model reads can contain instructions aimed at it, so fetch_page
// refuses addresses on this machine or the local network: otherwise a page
// could get the model to read e.g. a router admin page and then leak it by
// "fetching" an attacker's URL with the contents in the query string.
// net.BlockList also matches IPv4-mapped IPv6 forms like ::ffff:7f00:1.
export const PRIVATE_ADDRESSES = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], // carrier-grade NAT
  ['224.0.0.0', 4], ['240.0.0.0', 4] // multicast; reserved, with broadcast
]) PRIVATE_ADDRESSES.addSubnet(prefix, bits, 'ipv4');
for (const [prefix, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2002::', 16]]) { // last two: addresses that embed an IPv4 one
  PRIVATE_ADDRESSES.addSubnet(prefix, bits, 'ipv6');
}

export function isPrivateAddress(ip) {
  return PRIVATE_ADDRESSES.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

// Hosts you trust to resolve to a private address (SKINNY_TRUSTED_HOSTS, a
// comma-separated list, e.g. a local image server behind a reverse proxy).
// An entry covers that host and its subdomains; "*." in front is optional.
export function isTrustedHost(host) {
  return (process.env.SKINNY_TRUSTED_HOSTS || '').split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/^\*\./, ''))
    .some((entry) => entry && (host === entry || host.endsWith(`.${entry}`)));
}

export async function assertPublicUrl(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http and https URLs can be fetched (got ${url.protocol})`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isTrustedHost(host.toLowerCase())) return;
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error(`refusing to fetch ${url.hostname}: it resolves to a local or private network address (add it to SKINNY_TRUSTED_HOSTS to allow it)`);
  }
}

// The address check again, at the moment of connecting: assertPublicUrl
// resolves the name first, but fetch() would resolve it a second time, and a
// name that answers differently the second time (DNS rebinding) could point at
// this network. Resolving once, here, and checking what is actually used
// closes that.
export function guardedLookup(hostname, options, callback) {
  dnsCallbacks.lookup(hostname, options, (error, address, family) => {
    if (error) return callback(error, address, family);
    const found = Array.isArray(address) ? address : [{ address, family }];
    if (!isTrustedHost(hostname.toLowerCase()) && found.some((entry) => isPrivateAddress(entry.address))) {
      return callback(new Error(`refusing to fetch ${hostname}: it resolves to a local or private network address (add it to SKINNY_TRUSTED_HOSTS to allow it)`));
    }
    return callback(null, address, family);
  });
}

const DECODERS = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };

// One GET, answered like the part of fetch()'s Response used here: ok, status,
// headers.get(), body (async iterable of bytes), and cancel().
function guardedGet(target, headers) {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, {
      method: 'GET',
      headers: { ...headers, 'Accept-Encoding': 'gzip, deflate, br' },
      lookup: guardedLookup,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    }, (incoming) => {
      const decoder = DECODERS[String(incoming.headers['content-encoding'] || '').toLowerCase()];
      const body = decoder ? incoming.pipe(decoder()) : incoming;
      if (decoder) body.on('error', () => incoming.destroy());
      resolve({
        ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
        status: incoming.statusCode,
        headers: { get: (name) => [incoming.headers[name.toLowerCase()]].flat().join(', ') || null },
        body,
        cancel: () => { incoming.destroy(); body.destroy(); }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

// Fetches a public URL, following redirects by hand so each hop gets the
// private-address check.
export async function fetchPublic(target, accept) {
  let res;
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(target);
    res = await guardedGet(target, { ...APP_HEADERS, 'Accept': accept });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) break;
    res.cancel();
    if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
    target = new URL(location, target);
  }
  if (!res.ok) {
    res.cancel();
    throw new Error(`HTTP ${res.status} fetching ${target.href}`);
  }
  return { res, url: target };
}

// Reads at most MAX_FETCH_BYTES, so a huge download can't stall the chat.
export async function readCappedBytes(res) {
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= MAX_FETCH_BYTES) break;
  }
  res.cancel?.();
  return { bytes: Buffer.concat(chunks).subarray(0, MAX_FETCH_BYTES), truncated: total >= MAX_FETCH_BYTES };
}

export async function readCapped(res) {
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
export function htmlToText(html) {
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
export const MENU_RUN_LENGTH = 10;
export function dropMenuRuns(lines) {
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

export function formatPage(title, url, text) {
  if (!text) return `No readable text found at ${url} (the page may need JavaScript).`;
  const header = `${title ? `Title: ${title}\n` : ''}URL: ${url}\n\n`;
  if (text.length <= MAX_PAGE_CHARS) return header + text;
  return `${header}${text.slice(0, MAX_PAGE_CHARS)}\n\n[truncated: showing the first ${MAX_PAGE_CHARS} of ${text.length} characters]`;
}

export async function fetchPage({ url }) {
  if (!url || typeof url !== 'string') throw new Error("missing 'url' argument");
  let target;
  try {
    target = new URL(url);
  } catch (e) {
    throw new Error(`not a valid URL: ${url}`, { cause: e });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`only http and https URLs can be fetched (got ${target.protocol})`);
  }

  // Ollama's fetch runs on its servers, so it can't reach this machine or
  // its network; the private-address check below only matters locally.
  if (ollamaApiKey()) {
    try {
      const page = await ollamaApi('web_fetch', { url: target.href });
      return formatPage(page.title, target.href, tidyText(page.content || ''));
    } catch (error) {
      noteFallback('web fetch', error);
    }
  }
  return localFetchPage(target);
}

export async function localFetchPage(page) {
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
export function formatToday() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

export const TOOLS = {
  web_search: {
    get description() {
      return ollamaApiKey()
        ? 'Search the web. Use this for current events, recent facts, or anything you are unsure about. Returns result titles, URLs, and the start of each result page.'
        : 'Look up a topic. Use this for facts about well-known people, places, and things. Returns a short encyclopedia-style answer if one exists; it is not a full web search, so it is often empty.';
    },
    parameters: () => ({
      type: 'object',
      properties: {
        query: { type: 'string', description: "The search query, naming the topic (e.g. 'world news headlines')" }
      },
      required: ['query']
    }),
    mentionsDate: true,
    describe: (args) => `searching: "${args.query}"`,
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
