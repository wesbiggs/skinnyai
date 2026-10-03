import http from 'node:http';
import https from 'node:https';
import './config.js';
import { ANTHROPIC_VERSION } from './config.js';

// ollama.com (cloud models, web search/fetch) needs an API key. It's only
// ever sent to ollama.com over https, never to other --host servers.
export const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY || '';

export function isOllamaCom(url) {
  const { hostname } = new URL(url);
  return hostname === 'ollama.com' || hostname.endsWith('.ollama.com');
}

export function ollamaAuthHeaders(url) {
  if (!OLLAMA_API_KEY) return {};
  return new URL(url).protocol === 'https:' && isOllamaCom(url) ? { Authorization: `Bearer ${OLLAMA_API_KEY}` } : {};
}

// fetch() for requests to the chat server, adding the API key when it's ollama.com.
export function hostFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { ...init.headers, ...ollamaAuthHeaders(url) } });
}

// Node's global fetch (via its bundled undici) aborts a request after 5
// minutes of inactivity between chunks (UND_ERR_HEADERS_TIMEOUT /
// UND_ERR_BODY_TIMEOUT), surfacing as a bare "fetch failed". Thinking models
// can go quiet for longer than that before emitting a token, so the
// long-lived streaming chat request uses plain http/https instead, which has
// no such default idle timeout.
export function streamingPost(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = transport.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...ollamaAuthHeaders(url),
        ...extraHeaders
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
export async function readErrorBody(res) {
  let text = '';
  try {
    for await (const chunk of res) text += chunk;
    const json = JSON.parse(text);
    return json.error?.message || json.error || text;
  } catch (e) {
    return text;
  }
}

// The Anthropic API wants its key in x-api-key (sent to whatever --host is
// set, since the key is only ever configured for this API) and a version.
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
export function anthropicHeaders() {
  return { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': ANTHROPIC_VERSION };
}

// OpenAI-style servers, hosted or local, take a bearer key if one is set.
// It goes to whatever --host is, so a stray OPENAI_API_KEY in the
// environment reaches a local server too; the host is always your choice.
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
