import readline from 'readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import './config.js';
import { CONFIG_FILE, DEFAULT_PROFILE, PROFILE, VERSION } from './config.js';

// --- MCP servers (the active profile's mcpServers in $SKINNY_HOME/config.json) ---
//
// The config uses the format shared by Claude Desktop, Claude Code, Cursor,
// and others:
//   { "mcpServers": {
//       "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "env": {} },
//       "docs":  { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } } } }
// A server with "command" runs as a child process speaking JSON-RPC over
// stdio; one with "url" is reached over streamable HTTP. ${VAR} in strings
// expands from the environment. "disabled": true skips a server; "trust":
// true (or a list of tool names) lets those tools run without asking first;
// answering "a" (always) at the prompt adds a tool to that list.

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_TIMEOUT_MS = 30000;
export const MCP_CALL_TIMEOUT_MS = 120000;
export const MCP_MAX_RESULT_CHARS = 20000;

export const expandVars = (value) => (typeof value === 'string' ? value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '') : value);

// Returns [{ name, ...config }] for each enabled server in the active profile.
export function loadMcpConfig() {
  return Object.entries(PROFILE.mcpServers)
    .filter(([, config]) => config && !config.disabled)
    .map(([name, config]) => ({ ...config, name }));
}

export class McpServer {
  constructor(config) {
    this.name = config.name;
    this.config = config;
    // true: every tool runs without asking; or a list of tool names.
    this.trust = config.trust;
    this.tools = [];
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
  }

  async start() {
    if (this.config.url) {
      this.sessionId = null;
    } else if (this.config.command) {
      this.startProcess();
    } else {
      throw new Error('needs "command" or "url"');
    }
    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'skinnyai', version: VERSION }
    }, MCP_TIMEOUT_MS);
    await this.notify('notifications/initialized');
    let cursor;
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : {}, MCP_TIMEOUT_MS);
      this.tools.push(...(page.tools || []));
      cursor = page.nextCursor;
    } while (cursor);
  }

  startProcess() {
    const { command, args = [], env = {}, cwd } = this.config;
    const child = spawn(expandVars(command), args.map(expandVars), {
      cwd: cwd ? expandVars(cwd) : undefined,
      env: { ...process.env, ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, expandVars(String(v))])) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child = child;
    child.on('error', (error) => this.fail(new Error(`couldn't run '${command}': ${error.message}`)));
    child.on('exit', (code) => this.fail(new Error(`exited (code ${code})${this.stderr ? `: ${this.stderr.trim().split('\n').pop()}` : ''}`)));
    child.stdin.on('error', () => {});
    child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-2000); });
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onMessage(line));
  }

  fail(error) {
    this.dead = error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  // One JSON-RPC message from the server: a response to a request of ours,
  // or a request/notification of its own (answered "method not found",
  // except ping, since this client offers no roots, sampling, or the like).
  onMessage(line) {
    let message;
    try { message = JSON.parse(line); } catch (e) { return; }
    if (message.method && message.id !== undefined) {
      const reply = message.method === 'ping'
        ? { result: {} }
        : { error: { code: -32601, message: 'Method not found' } };
      this.send({ jsonrpc: '2.0', id: message.id, ...reply }).catch(() => {});
    } else if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || 'request failed'));
      else resolve(message.result ?? {});
    }
  }

  async send(message) {
    if (this.child) {
      this.child.stdin.write(JSON.stringify(message) + '\n');
      return null;
    }
    const response = await fetch(expandVars(this.config.url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
        ...(this.sessionId && { 'Mcp-Session-Id': this.sessionId }),
        ...Object.fromEntries(Object.entries(this.config.headers || {}).map(([k, v]) => [k, expandVars(String(v))]))
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(MCP_CALL_TIMEOUT_MS)
    });
    this.sessionId = response.headers.get('mcp-session-id') || this.sessionId;
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    if (message.id === undefined) return null;
    const body = await response.text();
    if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
      // Take the event that answers this request; others are server chatter.
      for (const line of body.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        try {
          const event = JSON.parse(line.slice(5));
          if (event.id === message.id) return event;
        } catch (e) { /* not JSON */ }
      }
      throw new Error('no response in the event stream');
    }
    return JSON.parse(body);
  }

  notify(method, params) {
    return this.send({ jsonrpc: '2.0', method, ...(params && { params }) }).catch(() => {});
  }

  async request(method, params, timeoutMs = MCP_CALL_TIMEOUT_MS) {
    if (this.dead) throw this.dead;
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    if (this.child) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
        this.pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); }
        });
        this.send(message).catch(reject);
      });
    }
    const reply = await this.send(message);
    if (reply.error) throw new Error(reply.error.message || 'request failed');
    return reply.result ?? {};
  }

  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    // Images (MCP "image" content: base64 data and a mimeType) are relayed to
    // the model as they came, in order: as image_url parts (data: URLs) in a
    // tool message's content array, or, for Anthropic, as image blocks inside
    // the tool_result. `text` carries a short marker where each image was.
    const images = [];
    const parts = [];
    const clip = (text) => (text.length > MCP_MAX_RESULT_CHARS ? `${text.slice(0, MCP_MAX_RESULT_CHARS)}\n[truncated]` : text);
    const markers = [];
    for (const part of result.content || []) {
      if (part.type === 'image' && part.data) {
        const mime = part.mimeType || 'image/png';
        images.push({ mime, data: part.data });
        parts.push({ type: 'image', mime, data: part.data });
        markers.push(`[image: ${mime}, ${Math.round(part.data.length * 0.75 / 1024)} KB]`);
        continue;
      }
      const text = part.type === 'text' ? part.text
        : part.type === 'resource' ? part.resource?.text ?? `[resource ${part.resource?.uri ?? ''}]`
        : `[${part.type} content not shown]`;
      parts.push({ type: 'text', text: clip(text) });
      markers.push(clip(text));
    }
    const fallback = markers.length === 0 && result.structuredContent ? clip(JSON.stringify(result.structuredContent)) : '';
    if (fallback) parts.push({ type: 'text', text: fallback });
    const finish = (text) => (result.isError ? `Error: ${text || 'the tool reported an error'}` : text || '(no output)');
    const summary = finish(markers.join('\n') || fallback);
    return images.length ? { text: summary, parts, images } : summary;
  }

  isTrusted(toolName) {
    return this.trust === true || (Array.isArray(this.trust) && this.trust.includes(toolName));
  }

  // "Always allow" for one tool: remembered here and written back into the
  // config file as "trust": ["tool", ...] on its server. Returns false if the
  // file couldn't be updated (the tool stays trusted for this session anyway).
  trustTool(toolName) {
    if (this.trust === true) return true;
    this.trust = [...(Array.isArray(this.trust) ? this.trust : []), toolName];
    try {
      const json = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      // The server is in the active profile, or inherited from Default.
      const entry = [json.profiles?.[PROFILE.name], json.profiles?.[DEFAULT_PROFILE]]
        .map((p) => (p?.mcpServers ?? p?.servers)?.[this.name]).find(Boolean);
      if (!entry) return false;
      entry.trust = this.trust;
      writeFileSync(CONFIG_FILE, `${JSON.stringify(json, null, 2)}\n`);
      return true;
    } catch (error) {
      return false;
    }
  }

  close() {
    this.child?.kill();
    if (this.config.url && this.sessionId) {
      fetch(expandVars(this.config.url), {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': this.sessionId, ...Object.fromEntries(Object.entries(this.config.headers || {}).map(([k, v]) => [k, expandVars(String(v))])) },
        signal: AbortSignal.timeout(2000)
      }).catch(() => {});
    }
  }
}

// Starts the configured servers side by side; one that fails is reported
// and left out. Tool names are "<server>__<tool>" (letters, digits, _ and -
// only, at most 64 characters, which is what model APIs accept).
export async function startMcpServers(configs) {
  const servers = [];
  const failures = [];
  await Promise.all(configs.map(async (config) => {
    const server = new McpServer(config);
    try {
      await server.start();
      servers.push(server);
    } catch (error) {
      server.close();
      failures.push({ name: config.name, error: error.message });
    }
  }));
  servers.sort((a, b) => a.name.localeCompare(b.name));
  const tools = new Map();
  for (const server of servers) {
    for (const tool of server.tools) {
      const base = `${server.name}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      let name = base;
      for (let n = 2; tools.has(name); n++) name = `${base.slice(0, 62 - String(n).length)}_${n}`;
      tools.set(name, {
        description: `[${server.name}] ${tool.description || tool.name}`,
        parameters: tool.inputSchema?.type === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
        describe: () => `${server.name}: ${tool.name}`, // just the name: arguments can be long, and --debug logs them
        needsApproval: () => !server.isTrusted(tool.name),
        trustAlways: () => server.trustTool(tool.name),
        run: (args) => server.callTool(tool.name, args)
      });
    }
  }
  return { servers, tools, failures, close: () => servers.forEach((server) => server.close()) };
}

// Built per request so the date is current. Small models often weigh the
// tool definition more than the system prompt, so it carries the date too.
export function toolDefinitions(tools, today) {
  return [...tools].map(([name, tool]) => ({
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
export async function runTool(tools, name, args) {
  const tool = tools.get(name);
  if (!tool) return `Error: unknown tool '${name}'`;
  try {
    return await tool.run(args || {});
  } catch (error) {
    return `Error: ${error.message}`;
  }
}
