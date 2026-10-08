import readline from 'readline';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import './config.js';
import { INLINE_FILE, extractAttachments, inlineFile } from './attachments.js';
import { envOptions } from './cli.js';
import { API_LABELS, API_NAMES, CONFIG, CONFIG_FILE, DEFAULT_ANTHROPIC_HOST, DEFAULT_KEEP_ALIVE, DEFAULT_OLLAMA_HOST, EXTRA_CA_FILE, PROFILE, VERSION, activateProfile, loadConfigFile, resolveProfile } from './config.js';
import { DEBUG_LOG, IMAGE_DIR, debugLog, enableDebugLog, setDebugEnabled } from './debug.js';
import { anthropicHeaders, ollamaApiKey, openaiApiKey, hostFetch, isOllamaCom, readErrorBody, streamingPost } from './http.js';
import { IMAGE_PROTOCOL, sniffImage } from './images.js';
import { decodeCsiU, inputPosition } from './lineedit.js';
import { createMarkdownRenderer } from './markdown.js';
import { adaptHistory, describeAdaptation, newCallId, parseArguments, purgeHistory, wireShape } from './history.js';
import { loadMcpConfig, runTool, startMcpServers, toolDefinitions } from './mcp.js';
import { pickDefaultModel } from './models.js';
import { SESSION_DIR, autosaveName, compactLocalSession, deleteLocalSession, formatModelfile, isAutosaveName, listLocalSessions, localSessionExists, readLocalSession, resumeHint, saveLocalSession, sessionStamp } from './sessions.js';
import { formatMarkdown } from './export.js';
import { ANSI, CHROME_COLOR, PROMPT, createWordWrapper, drawBox, graphemeWidth, graphemes, styleLine, styledPrompt, supportsColor, visibleWidth } from './style.js';
import { MAX_TOOL_ROUNDS, TOOLS, formatToday } from './tools.js';

export class OllamaChat {
  constructor(model, options = {}) {
    this.model = model;
    this.api = API_NAMES.includes(options.api) ? options.api : 'ollama';
    this.host = options.host || (this.api === 'anthropic' ? DEFAULT_ANTHROPIC_HOST : DEFAULT_OLLAMA_HOST);
    this.keepAlive = options.keepAlive || DEFAULT_KEEP_ALIVE;
    this.history = []; // history[0] may be a {role: 'system', ...} message
    this.options = {}; // /set parameter overrides (temperature, num_ctx, ...)
    this.format = ''; // '' | 'json'
    this.think = undefined; // undefined | true | false | 'low'|'medium'|'high'|'max'
    this.verbose = false;
    this.showThinking = !options.hideThinking;
    this.stopOnExit = Boolean(options.stopOnExit);
    this.toolsEnabled = options.tools !== false; // on unless --no-tools / SKINNY_TOOLS=false
    this.mcpEnabled = options.mcp !== false;
    this.debug = Boolean(options.debug);
    this.queuedAttachments = []; // /attach: sent with the next message
    this.pendingFiles = []; // what the line editor attached to the line it just returned
    this.mcp = null; // set by startMcp(): { servers, tools, failures, close }
    // undefined = automatic: tell the model today's date whenever tools are on.
    this.injectDate = options.date;
    this.markdown = options.markdown !== false;
    // Off by default: drawing an image means fetching whatever URL the model
    // wrote, and a prompt injection (say, in a page fetch_page read) could
    // use that to send conversation details to a server in the URL.
    this.images = Boolean(options.images) && IMAGE_PROTOCOL !== null;
    this.inputHistory = []; // submitted messages/commands, for Up/Down recall
    // On by default where there is a person to lose a chat (a terminal);
    // piped runs and scripts don't leave files behind unless asked.
    this.autosave = options.autosave ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    // The local session file this conversation is saved in, once it has one:
    // set by autosave, a local /save, or loading a local session; cleared
    // when a new conversation starts (/clear, loading a model).
    this._sessionName = null;
    // How many messages the session file holds, as far as this chat knows,
    // so autosave can append instead of rewriting; null when unknown.
    this.persistedCount = null;
    // What that file looked like when this chat last wrote or read it, to
    // notice another chat saving to it (see writeSession).
    this.sessionStamp = null;
  }

  get sessionName() { return this._sessionName; }

  // Inside the SkinnyAI app, the window title carries the session name ("SkinnyAI: name") so the app's
  // Save menu item knows whether the chat already has one.
  set sessionName(name) {
    if (name === this._sessionName) return;
    this._sessionName = name;
    this.sessionStamp = null;
    this.persistedCount = null;
    if (process.env.TERM_PROGRAM === 'SkinnyAI' && process.stdout.isTTY) {
      process.stdout.write(`\x1b]2;${name ? `SkinnyAI: ${name}` : 'SkinnyAI'}\x07`);
    }
  }

  // keep_alive and unloading only mean something on a self-hosted Ollama:
  // OpenAI-style servers have no such concept, and ollama.com manages model
  // lifetimes itself.
  get managesModelLifetime() {
    return this.api === 'ollama' && !isOllamaCom(this.host);
  }

  // The tools the model may call: the built-in web tools when they're
  // switched on, plus those of any MCP servers that started.
  activeTools() {
    const tools = new Map(this.toolsEnabled ? Object.entries(TOOLS) : []);
    if (this.mcpEnabled && this.mcp) for (const [name, tool] of this.mcp.tools) tools.set(name, tool);
    return tools;
  }

  toolDefinitions(today) {
    return toolDefinitions(this.activeTools(), today);
  }

  // Starts the configured MCP servers and collects what to say about them
  // (this.mcpLines); the welcome box shows it under the Tools line.
  async startMcp() {
    this.mcpLines = [];
    if (!this.mcpEnabled) return;
    let configs;
    try {
      configs = loadMcpConfig();
    } catch (error) {
      this.mcpLines.push(`❌ MCP: ${error.message}`);
      return;
    }
    if (configs.length === 0) return;
    if (supportsColor) process.stdout.write('🔌 Starting MCP servers...\n');
    this.mcp = await startMcpServers(configs);
    debugLog('mcp-servers', {
      config: CONFIG_FILE,
      started: this.mcp.servers.map((server) => ({ server: server.name, tools: server.tools.map((tool) => tool.name) })),
      failed: this.mcp.failures
    });
    const ok = this.mcp.servers.map((server) => `${server.name} (${server.tools.length} tool${server.tools.length === 1 ? '' : 's'})`);
    if (ok.length) this.mcpLines.push(`🔌 MCP: ${ok.join(', ')}`);
    for (const { name, error } of this.mcp.failures) this.mcpLines.push(`❌ MCP server '${name}' failed to start: ${error}`);
  }

  printMcp() {
    const mcp = this.mcp;
    if (!mcp) {
      console.log(`\nNo MCP servers are running. Add them to the "${PROFILE.name}" profile in ${CONFIG_FILE}:`);
      console.log('  "mcpServers": { "name": { "command": "npx", "args": ["-y", "some-mcp-server"] } }\n');
      return;
    }
    console.log('');
    for (const server of mcp.servers) {
      const trusted = server.trust === true ? ' (trusted: tools run without asking)'
        : Array.isArray(server.trust) && server.trust.length ? ` (trusted tools: ${server.trust.join(', ')})` : '';
      console.log(`  ${server.name}${trusted}`);
      for (const tool of server.tools) console.log(`    ${tool.name}${tool.description ? ` - ${tool.description.split('\n')[0].slice(0, 70)}` : ''}`);
    }
    for (const { name, error } of mcp.failures) console.log(`  ${name}: failed to start: ${error}`);
    console.log('');
  }

  shouldInjectDate() {
    return this.injectDate ?? this.toolsEnabled;
  }

  // "--model default" (what Settings writes for OpenAI and Anthropic) means
  // the newest flagship model the server lists, so it keeps up on its own.
  async resolveDefaultModel() {
    if (this.model.toLowerCase() !== 'default') return;
    if (this.api === 'ollama') throw new Error("'default' isn't a model name for Ollama; pick one with /list");
    const response = await hostFetch(`${this.host}/v1/models${this.api === 'anthropic' ? '?limit=100' : ''}`, { headers: this.authHeaders() });
    if (!response.ok) throw new Error(`couldn't look up the default model: ${response.status} ${response.statusText}`);
    const picked = pickDefaultModel(this.api, (await response.json()).data || []);
    if (!picked) throw new Error(`couldn't tell which of ${this.host}'s models is the default; name one`);
    this.model = picked;
    this.modelIsDefault = true;
  }

  // Credentials for APIs that take one from us; Ollama's key is handled
  // per host by hostFetch/streamingPost (it only goes to ollama.com).
  authHeaders() {
    if (this.api === 'anthropic') return anthropicHeaders();
    if (this.api === 'openai' && openaiApiKey()) return { Authorization: `Bearer ${openaiApiKey()}` };
    return {};
  }

  // What the next request can take, for adaptHistory. The window is only
  // known (and enforced here) when the user set num_ctx on Ollama; elsewhere
  // the server decides what to do with a long conversation.
  adaptTarget() {
    const numCtx = Number(this.options.num_ctx);
    return {
      api: this.api,
      model: this.model,
      toolNames: new Set(this.activeTools().keys()),
      vision: this.visionCache?.get(this.model) ?? null,
      contextTokens: this.api === 'ollama' && numCtx > 0 ? numCtx : null
    };
  }

  // After switching model or profile with the conversation kept: how much
  // came along and what the new model won't get as it was.
  carryOverNote(prefix) {
    const kept = this.history.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content).length;
    const changes = describeAdaptation(adaptHistory(this.history, this.adaptTarget()).report);
    const lines = [`${prefix}; kept the conversation (${kept} message${kept === 1 ? '' : 's'}).`, ...changes.map((c) => `   ${c}`)];
    return `${lines.join('\n')}\n`;
  }

  // Models only know their training cutoff (llama3.2's template even states
  // "Cutting Knowledge Date: December 2023"), so they assume it's still then.
  // The date goes into the outgoing system message rather than into history,
  // so it's always current and never ends up in /save or /show system.
  requestMessages(today) {
    let messages = this.history;
    // JSON mode is also asked for in words: not every server honors the
    // format field (and OpenAI's refuses unless the messages mention JSON).
    const notes = [today && `Today's date is ${today}.`, this.format === 'json' && 'Respond only with a valid JSON object.'].filter(Boolean).join(' ');
    if (notes) {
      const system = this.getSystemMessage();
      const rest = system ? this.history.slice(1) : this.history;
      messages = [{ role: 'system', content: system ? `${notes}\n\n${system}` : notes }, ...rest];
    }
    // The history is provider-neutral; shape it for this model and API.
    messages = wireShape(adaptHistory(messages, this.adaptTarget()).messages, this.api);
    // A tool result's images are relayed as they were returned. Anthropic takes
    // them inside the tool_result (buildAnthropicChatBody). OpenAI-style servers
    // get the result's parts as a content array, with each image as an image_url
    // part (a data: URL); Ollama's tool messages are plain text, so there the
    // data: URLs sit in the text.
    return messages.map((m) => {
      if (m.role !== 'tool') return this.wireMessage(m);
      if (this.api === 'anthropic') return m;
      const text = { ...m };
      delete text.images;
      delete text.parts;
      const { parts } = m;
      if (!parts) return text;
      const url = (p) => `data:${p.mime};base64,${p.data}`;
      if (this.api === 'openai') {
        return { ...text, content: parts.map((p) => (p.type === 'image' ? { type: 'image_url', image_url: { url: url(p) } } : p)) };
      }
      return { ...text, content: parts.map((p) => (p.type === 'image' ? url(p) : p.text)).join('\n') };
    });
  }

  // History keeps attached images as { mime, data } and PDFs as { name, mime,
  // data } (base64); each API wants them differently: Ollama a plain list of base64 strings on the message,
  // OpenAI-style servers content parts with data: URLs.
  wireMessage(message) {
    const { images = [], documents = [], ...rest } = message;
    if (!images.length && !documents.length) return message;
    if (this.api === 'anthropic') {
      return {
        ...rest,
        content: [
          ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })),
          ...documents.map((d) => ({ type: 'document', title: d.name, source: { type: 'base64', media_type: d.mime, data: d.data } })),
          ...(message.content ? [{ type: 'text', text: message.content }] : [])
        ]
      };
    }
    if (this.api === 'openai') {
      return {
        ...rest,
        content: [
          ...(message.content ? [{ type: 'text', text: message.content }] : []),
          ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } })),
          ...documents.map((d) => ({ type: 'file', file: { filename: d.name, file_data: `data:${d.mime};base64,${d.data}` } }))
        ]
      };
    }
    return { ...rest, ...(images.length && { images: images.map((i) => i.data) }) };
  }

  // Ollama lists what a model can do (vision, tools, ...) in /api/show.
  // Returns false only when the server says the model can't see images;
  // anywhere that can't tell (OpenAI-style servers, older Ollama), it
  // gives the benefit of the doubt.
  async supportsVision() {
    if (this.api !== 'ollama') return true;
    this.visionCache ??= new Map();
    if (!this.visionCache.has(this.model)) {
      let capable = true;
      try {
        const response = await hostFetch(`${this.host}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model })
        });
        const info = response.ok ? await response.json() : {};
        if (Array.isArray(info.capabilities)) capable = info.capabilities.includes('vision');
      } catch (error) {
        // Unknown; don't warn.
      }
      this.visionCache.set(this.model, capable);
    }
    return this.visionCache.get(this.model);
  }

  // Unloads the current model from Ollama (same effect as `ollama stop`),
  // via keep_alive: 0. Best-effort: failures here shouldn't block exiting.
  // A no-op where models aren't loaded by us (see managesModelLifetime).
  async stopModel() {
    if (!this.managesModelLifetime) return;
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

  // Restores the settings /save recorded in comments. Unknown or malformed
  // values are ignored.
  applySavedSettings(saved) {
    const bool = (v) => (v === 'true' ? true : v === 'false' ? false : undefined);
    if (API_NAMES.includes(saved.api)) this.api = saved.api;
    if (/^https?:\/\//.test(saved.host || '')) this.host = saved.host;
    if (saved['keep-alive']) this.keepAlive = saved['keep-alive'];
    if (bool(saved['show thinking']) !== undefined) this.showThinking = bool(saved['show thinking']);
    if (bool(saved.tools) !== undefined) this.toolsEnabled = bool(saved.tools);
    if (bool(saved.markdown) !== undefined) this.markdown = bool(saved.markdown);
    if (bool(saved.verbose) !== undefined) this.verbose = bool(saved.verbose);
    if (bool(saved['stop on exit']) !== undefined) this.stopOnExit = bool(saved['stop on exit']);
    if (bool(saved.images) !== undefined) this.images = bool(saved.images) && IMAGE_PROTOCOL !== null;
    this.injectDate = bool(saved.date);
    this.format = saved.format === 'json' ? 'json' : '';
    const think = saved.think;
    this.think = bool(think) !== undefined ? bool(think) : ['low', 'medium', 'high', 'max'].includes(think) ? think : undefined;
  }

  // Switches to a session saved on this machine (see saveLocalSession): its
  // FROM model, system message, parameters, and conversation. Quiet, so
  // startup can do it before the welcome box (which reports the result).
  applySessionState(name, session) {
    this.applySavedSettings(session.settings || {}, true);
    this.model = session.from || this.model;
    this.history = session.system ? [{ role: 'system', content: session.system }] : [];
    this.history.push(...session.messages);
    this.options = {};
    for (const [param, value] of session.parameters) this.setParameter(param, [value]);
    this.sessionName = name; // autosave keeps updating the same file
    this.sessionStamp = session.stamp ?? null;
    this.persistedCount = session.persisted ?? null;
  }

  async applyLocalSession(name, session) {
    this.applySessionState(name, session);
    await this.showRestoredSession(name);
  }

  async showRestoredSession(name) {
    await this.printRestoredHistory(this.history, `📜 Restored saved session '${name}' (model: ${this.model}):`);
    // Autosave isn't a saved setting, so say where it stands.
    console.log(`${CHROME_COLOR}💾 Autosave is ${this.autosave ? `on (saving to '${name}' after each reply)` : 'off (/set autosave turns it on)'}${ANSI.reset}\n`);
  }

  // At startup, a name with a locally saved session resumes it, the way
  // `ollama run` resumes a model /save created, on the model, API, and host
  // it was saved with (the name is not the model); otherwise an Ollama
  // server is asked for the model's own saved messages. The state is applied
  // before the welcome box so that shows the real model.
  async prepareStartupSession() {
    this.startupSession = null;
    try {
      const session = await readLocalSession(this.model);
      if (session) {
        this.startupSession = this.model;
        this.applySessionState(this.model, session);
      }
    } catch (error) {
      // Non-fatal: just start with an empty session.
    }
  }

  async loadModelContext() {
    try {
      if (this.startupSession === undefined) await this.prepareStartupSession();
      if (this.startupSession) await this.showRestoredSession(this.startupSession);
      else if (this.api === 'ollama') await this.fetchAndApplyModelContext(this.model);
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
        await this.writeWrapped('user', message.content.replace(INLINE_FILE, '\n📎 $1'), PROMPT.length);
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
      stream: true
    };
    if (this.managesModelLifetime) body.keep_alive = this.keepAlive;
    if (Object.keys(this.options).length > 0) body.options = this.options;
    if (this.format) body.format = this.format;
    if (this.think !== undefined) body.think = this.think;
    const tools = this.toolDefinitions(today);
    if (tools.length) body.tools = tools;
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
    const tools = this.toolDefinitions(today);
    if (tools.length) body.tools = tools;
    return body;
  }

  // The Messages API takes the system prompt separately, wants tool calls
  // and results as content blocks, and needs a turn's thinking blocks (with
  // their signatures) handed back while it's still using tools.
  buildAnthropicChatBody() {
    const today = this.shouldInjectDate() ? formatToday() : '';
    const all = this.requestMessages(today);
    const system = all.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const messages = [];
    const push = (role, content) => {
      const last = messages.at(-1);
      if (last && last.role === role) last.content.push(...content);
      else messages.push({ role, content });
    };
    for (const m of all) {
      if (m.role === 'system') continue;
      const blocks = typeof m.content === 'string' ? (m.content ? [{ type: 'text', text: m.content }] : []) : m.content;
      if (m.role === 'tool') {
        const result = m.images?.length
          ? [{ type: 'text', text: m.content }, ...m.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } }))]
          : m.content;
        push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: result, ...(m.content.startsWith('Error:') && { is_error: true }) }]);
      } else if (m.role === 'assistant') {
        const calls = (m.tool_calls || []).map((c) => {
          let input = c.function.arguments;
          if (typeof input === 'string') {
            try { input = input ? JSON.parse(input) : {}; } catch (e) { input = {}; }
          }
          return { type: 'tool_use', id: c.id, name: c.function.name, input };
        });
        push('assistant', [...(m.thinkingBlocks || []), ...blocks, ...calls]);
      } else {
        push('user', blocks);
      }
    }
    const { max_tokens, num_predict, stop, ...sampling } = this.options;
    const body = { model: this.model, max_tokens: max_tokens ?? num_predict ?? 16000, stream: true, messages };
    if (system) body.system = system;
    for (const key of ['temperature', 'top_p', 'top_k']) if (sampling[key] !== undefined) body[key] = sampling[key];
    if (stop) body.stop_sequences = stop;
    if (this.think !== undefined && this.think !== false) {
      body.thinking = { type: 'adaptive', display: this.showThinking ? 'summarized' : 'omitted' };
      if (typeof this.think === 'string') body.output_config = { effort: this.think };
    }
    const tools = this.toolDefinitions(today);
    if (tools.length) body.tools = tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
    return body;
  }

  // `attached` holds files the line editor already attached (and showed) as
  // the message was typed, and /attach ones are queued; images left as paths
  // in the text are found here.
  async chat(prompt, attached = []) {
    const found = extractAttachments(prompt);
    const all = [...this.queuedAttachments.splice(0), ...attached, ...found.attachments];
    const skipped = [...found.skipped];
    const images = all.filter((a) => a.kind === 'image');
    let documents = all.filter((a) => a.kind === 'pdf');
    const texts = all.filter((a) => a.kind === 'text');
    if (documents.length && this.api === 'ollama') {
      skipped.push(`${documents.map((d) => d.name).join(', ')}: Ollama can only take images and text, not PDFs`);
      documents = [];
    }
    let content = all.length ? found.text : prompt;
    if (!content && (images.length || documents.length || texts.length)) {
      content = images.length && images.length === all.length ? 'What is in this image?' : 'Summarize the attached file.';
    }
    content = [content, ...texts.map((t) => inlineFile(t.name, t.text))].filter(Boolean).join('\n\n');
    const message = { role: 'user', content };
    if (images.length) message.images = images.map(({ mime, data }) => ({ mime, data }));
    if (documents.length) message.documents = documents.map(({ name, mime, data }) => ({ name, mime, data }));
    process.stdout.write('\n');
    for (const why of skipped) console.log(`${CHROME_COLOR}⚠️  Not attached: ${why}${ANSI.reset}`);
    for (const file of found.attachments) console.log(`${CHROME_COLOR}📎 Attached ${file.name}${ANSI.reset}`);
    const blind = images.length > 0 && !await this.supportsVision();
    if (blind) {
      console.log(`⚠️  '${this.model}' doesn't list vision support, so it may ignore or reject the image. Use /load to switch to a vision model.`);
    }
    if (found.attachments.length || skipped.length || blind) process.stdout.write('\n');
    this.history.push(message);

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
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
      .map(({ role, content }) => ({ role, content }));
  }

  // Everything but the system message, as the session file keeps it.
  conversation() {
    return this.getSystemMessage() ? this.history.slice(1) : this.history;
  }

  sessionSnapshot() {
    const settings = {
      api: this.api,
      host: this.host,
      format: this.format || undefined,
      think: this.think,
      'show thinking': this.showThinking,
      tools: this.toolsEnabled,
      date: this.injectDate,
      markdown: this.markdown,
      images: this.images,
      verbose: this.verbose
    };
    if (this.managesModelLifetime) {
      settings['keep-alive'] = this.keepAlive;
      settings['stop on exit'] = this.stopOnExit;
    }
    return { from: this.model, system: this.getSystemMessage(), parameters: this.options, messages: this.conversation(), settings };
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
      await this.writeSession(this.sessionName);
    } catch (error) {
      console.log(`⚠️  Autosave failed: ${error.message}\n`);
    }
  }

  // Writes the conversation to the session file `name`, first checking that
  // another chat hasn't saved to that file since this one last did. Returns
  // the path written, or null if nothing was (after saying why).
  async writeSession(name) {
    if (name === this.sessionName && this.sessionStamp) {
      const current = await sessionStamp(name);
      if (current !== null && current !== this.sessionStamp) return this.resolveSessionConflict(name);
    }
    return this.writeSessionFile(name);
  }

  // `full` rewrites the file's messages even if this chat could append.
  async writeSessionFile(name, { full = false } = {}) {
    const snapshot = this.sessionSnapshot();
    const append = !full && name === this.sessionName ? this.persistedCount : null;
    const file = await saveLocalSession(name, snapshot, { append });
    this.sessionName = name;
    this.sessionStamp = await sessionStamp(name);
    this.persistedCount = snapshot.messages.length;
    return file;
  }

  // The file changed under us: reload it, keep this conversation under a new
  // name, overwrite it anyway, or skip (asked again at the next save).
  async resolveSessionConflict(name) {
    const answer = await this.choose(
      `\n⚠️  Session '${name}' was saved by another chat since you last saved it.\n` +
      '   Reload it (r, drops this chat\'s unsaved changes), save under a new name (s), overwrite it (o), or skip (anything else)?',
      '[r/s/o/N]', 'rso');
    if (answer === 'r') {
      const session = await readLocalSession(name);
      if (session) {
        console.log('');
        await this.applyLocalSession(name, session);
        return null;
      }
      return this.writeSessionFile(name, { full: true }); // deleted meanwhile
    }
    if (answer === 'o') return this.writeSessionFile(name, { full: true });
    if (answer === 's') {
      console.log('\nNew name for this session:');
      const newName = ((await this.readTurnInput()) || '').trim();
      if (newName && newName !== name &&
          (!await localSessionExists(newName) || await this.confirm(`\nA saved session named '${newName}' already exists. Overwrite it?`))) {
        const file = await this.writeSessionFile(newName);
        console.log(`\n✅ Saved session '${newName}' to ${file}; '${name}' is unchanged.\n`);
        return file;
      }
    }
    console.log('Not saved.\n');
    return null;
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
      const tools = this.activeTools();
      const tool = tools.get(name);
      const label = args && tool?.describe ? tool.describe(args) : name;
      process.stdout.write(`${ANSI.assistant.narration}🔧 ${label}${ANSI.reset}\n`);

      // MCP tools can do anything their server can, and a web page the model
      // read could try to steer it, so they ask first unless the server is trusted.
      let declined = false;
      if (args !== null && tool?.needsApproval?.()) {
        const answer = await this.choose('   Allow this tool call?', '[y/N/a(lways)]', 'ya');
        declined = answer === 'n';
        if (answer === 'a') {
          const saved = tool.trustAlways();
          console.log(`${CHROME_COLOR}   ${saved ? `Saved: this tool is now trusted in ${CONFIG_FILE}` : `Couldn't update ${CONFIG_FILE}; trusted for this session only`}${ANSI.reset}`);
        }
      }
      const outcome = args === null
        ? `Error: couldn't parse arguments for '${name}' as JSON`
        : declined
          ? 'Error: the user declined this tool call'
          : await runTool(tools, name, args);
      // A tool may return images along with its text (MCP image content);
      // they go to the model as received (see requestMessages).
      const result = typeof outcome === 'string' ? outcome : outcome.text;
      const images = typeof outcome === 'string' ? [] : outcome.images;
      debugLog('tool-call', { name, known: tools.has(name), arguments: args, declined, result, images: images.length });
      if (result.startsWith('Error:')) {
        process.stdout.write(`${ANSI.assistant.narration}   ${result}${ANSI.reset}\n`);
      }

      const message = { role: 'tool', tool_call_id: call.id, tool_name: name, content: result };
      if (images.length) {
        message.images = images;
        message.parts = outcome.parts;
      }
      this.history.push(message);
    }
    process.stdout.write('\n');
  }

  // Streams one model response to the terminal and records it in history.
  // Returns any tool calls the model made (empty if it just answered).
  async streamTurn(allowTools = true) {
    let spinner = this.startSpinner();

    try {
      // "isOpenAI" covers every server-sent-events API; Anthropic's events
      // are translated into OpenAI-style chunks below.
      const isOpenAI = this.api !== 'ollama';
      const isAnthropic = this.api === 'anthropic';
      const body = isAnthropic ? this.buildAnthropicChatBody()
        : isOpenAI ? this.buildOpenAIChatBody() : this.buildOllamaChatBody();
      if (!allowTools) delete body.tools;
      const path = isAnthropic ? '/v1/messages' : isOpenAI ? '/v1/chat/completions' : '/api/chat';

      debugLog('request', {
        api: this.api, url: `${this.host}${path}`, authenticated: Object.keys(this.authHeaders()).length > 0 || (this.api === 'ollama' && Boolean(ollamaApiKey()) && isOllamaCom(this.host)),
        offeredTools: (body.tools || []).map((t) => t.function?.name ?? t.name), body
      });
      const response = await streamingPost(`${this.host}${path}`, body, this.authHeaders());
      debugLog('response', { status: response.status, statusText: response.statusText });

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

      // Anthropic streams typed events (content_block_delta, message_delta,
      // ...); this maps each onto the OpenAI chunk shape handled below.
      const thinkingBlocks = [];
      const anthropicUsage = { prompt_tokens: 0, completion_tokens: 0 };
      const adaptAnthropicEvent = (event) => {
        const delta = (fields) => ({ choices: [{ delta: fields }] });
        switch (event.type) {
          case 'message_start':
            anthropicUsage.prompt_tokens = (event.message?.usage?.input_tokens ?? 0) +
              (event.message?.usage?.cache_read_input_tokens ?? 0) + (event.message?.usage?.cache_creation_input_tokens ?? 0);
            return null;
          case 'content_block_start': {
            const block = event.content_block;
            if (block.type === 'tool_use') return delta({ tool_calls: [{ index: event.index, id: block.id, function: { name: block.name } }] });
            if (block.type === 'thinking' || block.type === 'redacted_thinking') thinkingBlocks[event.index] = { ...block };
            return null;
          }
          case 'content_block_delta': {
            const d = event.delta;
            if (d.type === 'text_delta') return delta({ content: d.text });
            if (d.type === 'input_json_delta') return delta({ tool_calls: [{ index: event.index, function: { arguments: d.partial_json } }] });
            if (d.type === 'thinking_delta') {
              thinkingBlocks[event.index].thinking += d.thinking;
              return delta({ reasoning_content: d.thinking });
            }
            if (d.type === 'signature_delta') thinkingBlocks[event.index].signature = d.signature;
            return null;
          }
          case 'message_delta': {
            anthropicUsage.completion_tokens = event.usage?.output_tokens ?? anthropicUsage.completion_tokens;
            const reason = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls' }[event.delta?.stop_reason] ?? event.delta?.stop_reason;
            return {
              choices: [{ delta: {}, finish_reason: reason }],
              usage: { ...anthropicUsage, total_tokens: anthropicUsage.prompt_tokens + anthropicUsage.completion_tokens }
            };
          }
          case 'error':
            throw new Error(`API error: ${event.error?.message || 'stream failed'}`);
          default:
            return null;
        }
      };

      const handleLine = async (line) => {
        if (!line.trim()) return;
        let json;
        if (isOpenAI) {
          json = parseSSEChunk(line);
          if (json && isAnthropic) json = adaptAnthropicEvent(json);
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
      if (doneReason === 'refusal') process.stdout.write(`${ANSI.reset}\n⚠️  The model declined to answer this request.\n`);
      endThinking(Boolean(doneReason && doneReason !== 'stop' && doneReason !== 'tool_calls'));
      await renderer.end();

      if (started) {
        process.stdout.write(ANSI.reset);
      }

      // Add assistant response to history (raw, asterisks intact)
      const calls = toolCalls.filter(Boolean);
      for (const call of calls) {
        call.id ||= newCallId();
        call.function.arguments = parseArguments(call.function.arguments);
      }
      const message = { role: 'assistant', content: fullResponse, origin: { api: this.api, model: this.model } };
      if (calls.length > 0) message.tool_calls = calls;
      const kept = thinkingBlocks.filter(Boolean);
      if (kept.length > 0) message.thinkingBlocks = kept;
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
    if (this.api !== 'ollama') {
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
    const lines = [
      `🚀 SkinnyAI v${VERSION}`,
      `📦 Model: ${this.model}${this.modelIsDefault ? ' (the default)' : ''}`
    ];
    if (this.managesModelLifetime) lines.push(`⏳ Keep-alive: ${this.keepAlive}`);
    if (this.api !== 'ollama') lines.push(`🔌 API: ${API_LABELS[this.api]}`);
    lines.push(`🌐 Host: ${this.host}`);
    if (this.toolsEnabled) {
      lines.push(`🔧 Tools: ${Object.keys(TOOLS).join(', ')} (${ollamaApiKey() ? 'Ollama web search' : 'DuckDuckGo instant answers'})`);
    }
    lines.push(...(this.mcpLines || []));
    if (this.debug) lines.push(`🐞 Debug log: ${DEBUG_LOG}`);
    lines.push('', 'Type /help for commands.', 'Enter sends; Ctrl+J or Shift+Enter adds a new line.');
    console.log('\n' + drawBox(lines, ANSI.assistant.dialogue) + '\n');
  }

  printCommandList() {
    console.log('  /set            Set session variables');
    console.log('  /show           Show model information');
    console.log('  /load <model>   Load a session or model');
    console.log('  /save [name]    Save your current session to a file on this machine');
    console.log('  /share [name]   Save your current session as a model on the Ollama server');
    console.log('  /clear [name]   Start a new conversation (with a name, saves this one under it first)');
    console.log('  /new [name]     Start a new conversation, optionally named');
    console.log('  /delete [name]  Delete a saved session (this one by default)');
    console.log('  /export [path]  Write the conversation to a .md transcript or a .Modelfile');
    console.log('  /purge <kind>   Shrink the saved chat: thinking, tools (as text), or blobs (images and PDFs)');
    console.log('  /model          Show current model, keep-alive, and host');
    console.log('  /list           List locally available models');
    console.log('  /attach <file>  Send a file (image, PDF, or text) with your next message');
    console.log('  /saveimage [path]  Save the latest image in the conversation to a file');
    console.log('  /mcp            Show connected MCP servers and their tools');
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
    console.log('  /set images            Draw ![images](url or file path) inline (iTerm2, WezTerm, kitty, Ghostty, the SkinnyAI app)');
    console.log('  /set noimages          Show images as links (default)');
    console.log('  /set debug             Log requests, offered tools, and tool calls to a file');
    console.log('  /set nodebug           Stop logging (default)');
    console.log('  /set autosave          Save the session to a local file after each reply');
    console.log('  /set noautosave        Stop autosaving');
    console.log('  /set profile [name]    Switch to a profile from config.json, keeping the conversation (--new starts a fresh one)');
    console.log('  /set model <name>      Switch to another model on this server, keeping the conversation');
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
    const changeable = [
      ['model', this.model],
      ['system message', sys ? `set, ${sys.length} characters (/show system)` : 'none'],
      ['parameters', Object.keys(this.options).length
        ? Object.entries(this.options).map(([k, v]) => `${k}=${Array.isArray(v) ? JSON.stringify(v) : v}`).join(', ')
        : 'model defaults'],
      ['format', this.format || 'none'],
      ['think', think],
      ['show thinking', onOff(this.showThinking)],
      ['verbose', onOff(this.verbose)],
      ['tools', this.toolsEnabled ? `on (${Object.keys(TOOLS).join(', ')}; ${ollamaApiKey() ? 'Ollama web search' : 'DuckDuckGo instant answers'})` : 'off'],
      ['date', dateSetting],
      ['markdown', onOff(this.markdown)],
      ['images', images],
      ...(this.debug ? [['debug log', DEBUG_LOG]] : []),
      ['autosave', this.autosave ? `on (${this.sessionName ? `'${this.sessionName}'` : 'named after the next reply'})` : 'off'],
      ['profile', CONFIG ? PROFILE.name : 'none (no config.json)']
    ];
    const fixed = [
      ['api', API_LABELS[this.api]],
      ['host', this.host],
      ...(this.managesModelLifetime ? [['keep-alive', this.keepAlive], ['stop on exit', onOff(this.stopOnExit)]] : []),
      ...(EXTRA_CA_FILE ? [['extra CA certs', EXTRA_CA_FILE]] : []),
      ['defaults file', CONFIG ? CONFIG_FILE : `none (${CONFIG_FILE})`]
    ];
    const print = (title, rows) => {
      console.log(`\n${title}`);
      for (const [name, value] of rows) console.log(`  ${name.padEnd(16)} ${value}`);
    };
    print('Changeable settings (/set ..., /load, /help lists them):', changeable);
    print('Fixed for this session (from the profile, config.json, or command line; for information):', fixed);
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
    console.log('  Shift + Enter       Same, in terminals that report it (kitty, Ghostty, WezTerm, iTerm2 3.5+)');
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
      const file = await this.writeSession(target);
      if (!file) return; // the conflict prompt said what happened
      if (this.sessionName !== target) return; // and saved it under another name
      if (renaming) await deleteLocalSession(previous);
      if (renaming) console.log(`\n✅ Renamed session '${previous}' to '${target}' (${file})`);
      else console.log(`\n✅ Saved session '${target}' to ${file}`);
      if (previous && previous !== target && !renaming) console.log(`   '${previous}' is unchanged; from now on this session saves as '${target}'.`);
      console.log(`   Resume it with /load ${target}, or ${resumeHint(target)}\n`);
    } catch (error) {
      console.error(`\n❌ Error saving session: ${error.message}\n`);
    }
  }

  // A new conversation: history emptied (the system message stays) and its
  // own session file, named after the date and time unless told otherwise.
  startNewConversation() {
    const system = this.getSystemMessage();
    this.history = system ? [{ role: 'system', content: system }] : [];
    this.sessionName = null;
  }

  async newConversation(name) {
    if (name && await localSessionExists(name)) {
      console.log(`\nA saved session named '${name}' already exists. /load it, or pick another name.\n`);
      return;
    }
    this.startNewConversation();
    if (name) this.sessionName = name;
    console.log(`🆕 New conversation${name ? ` '${name}'` : ''}.${this.autosave ? '' : ' (Autosave is off; /save keeps it.)'}\n`);
  }

  // Asks first, since a deleted session can't be recovered. Deleting the one
  // being chatted in leaves a new conversation.
  async deleteSession(name) {
    const target = name || this.sessionName;
    if (!target || !await localSessionExists(target)) {
      console.log(target ? `\nNo saved session named '${target}'.\n` : '\nThis conversation has no saved session. Usage: /delete <name>\n');
      return;
    }
    if (!await this.confirm(`\nDelete saved session '${target}'? This can't be undone.`)) {
      console.log('Not deleted.\n');
      return;
    }
    try {
      await deleteLocalSession(target);
    } catch (error) {
      console.error(`\n❌ Error deleting session: ${error.message}\n`);
      return;
    }
    console.log(`\n🗑️  Deleted session '${target}'.`);
    if (target === this.sessionName) {
      this.startNewConversation();
      console.log('   Started a new conversation.');
    }
    console.log('');
  }

  // Writes the conversation to a file: a .md transcript, or a .Modelfile
  // (the text of the conversation only, as /share sends it).
  async exportChat(argText) {
    const arg = argText.replace(/^(['"])(.*)\1$/, '$2');
    const file = path.resolve((arg || `${this.sessionName || 'chat'}.md`).replace(/^~(?=\/|$)/, os.homedir()));
    const extension = path.extname(file).toLowerCase();
    if (!['.md', '.markdown', '.modelfile'].includes(extension)) {
      console.log('\nExport as a .md transcript or a .Modelfile, e.g. /export notes.md\n');
      return;
    }
    try {
      if (existsSync(file) && !await this.confirm(`\n${file} already exists. Overwrite it?`)) {
        console.log('Not exported.\n');
        return;
      }
      const text = extension === '.modelfile'
        ? formatModelfile({ ...this.sessionSnapshot(), messages: this.savableMessages() })
        : formatMarkdown({ title: this.sessionName || 'Chat', system: this.getSystemMessage(), messages: this.conversation() });
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
      console.log(`\n✅ Exported to ${file}\n`);
    } catch (error) {
      console.error(`\n❌ Error exporting: ${error.message}\n`);
    }
  }

  // /purge thinking|tools|blobs: drops that bulk from this conversation and
  // its saved file (tool calls become text, so the conversation still reads).
  async purge(kind) {
    const kinds = { thinking: 'thinking', tools: 'tools', tool_calls: 'tools', blobs: 'blobs' };
    if (!kinds[kind]) {
      console.log('\nUsage: /purge thinking | tools | blobs\n  thinking  drop saved thinking blocks\n  tools     turn tool calls and results into text\n  blobs     remove attached images and PDFs, and images in tool results\n');
      return;
    }
    const { history, removed } = purgeHistory(this.history, kinds[kind]);
    if (!removed) {
      console.log(`\nNothing to purge: this conversation has no ${kinds[kind] === 'tools' ? 'tool calls' : kinds[kind]}.\n`);
      return;
    }
    this.history = history;
    try {
      if (this.sessionName && await localSessionExists(this.sessionName)) {
        await this.writeSessionFile(this.sessionName, { full: true });
        compactLocalSession(this.sessionName);
      }
      console.log(`\n🧹 Purged ${removed} ${kinds[kind] === 'tools' ? 'tool call' : kinds[kind] === 'blobs' ? 'attachment' : 'thinking block'}${removed === 1 ? '' : 's'}.\n`);
    } catch (error) {
      console.error(`\n❌ Purged in memory, but saving failed: ${error.message}\n`);
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
      await this.list();
      console.log('Usage: /load <model or saved session>\n');
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

  // /attach <path>...: queues files for the next message. Dragging a file
  // into the prompt does the same; this is for when that doesn't work.
  attach(argText) {
    if (!argText.trim()) {
      console.log('\nUsage: /attach <path> [<path> ...]   (images, PDFs, and text files; or drag a file into the prompt)\n');
      return;
    }
    const found = extractAttachments(argText, { anyFile: true });
    for (const why of found.skipped) console.log(`⚠️  Not attached: ${why}`);
    for (const file of found.attachments) {
      if (file.kind === 'pdf' && this.api === 'ollama') {
        console.log(`⚠️  Not attached: ${file.name}: Ollama can only take images and text, not PDFs`);
        continue;
      }
      this.queuedAttachments.push(file);
      console.log(`📎 ${file.name} will go with your next message`);
    }
    if (found.attachments.length === 0 && found.skipped.length === 0) console.log("Couldn't find a file at that path.");
    console.log('');
  }

  // The images in the conversation, oldest first: data: URLs in replies (what a
  // model writes as ![alt](data:image/...)) and images in tool results.
  conversationImages() {
    const found = [];
    for (const message of this.history) {
      if (message.role === 'tool') {
        for (const part of message.parts || []) if (part.type === 'image') found.push({ mime: part.mime, data: part.data });
      } else if (message.role === 'assistant' && typeof message.content === 'string') {
        for (const match of message.content.matchAll(/data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)/g)) found.push({ mime: match[1], data: match[2] });
      }
    }
    return found;
  }

  // /saveimage [path]: writes the most recent image in the conversation to a
  // file. With no path it goes in the image folder under a date-and-time name;
  // a folder (or a path ending in /) gets that name too.
  async saveImage(argText) {
    const images = this.conversationImages();
    if (images.length === 0) {
      console.log('\nNo image in this conversation yet (a data: URL in a reply, or an image a tool returned).\n');
      return;
    }
    const image = images.at(-1);
    const bytes = Buffer.from(image.data, 'base64');
    const info = sniffImage(bytes);
    const ext = info ? { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' }[info.format] : image.mime.split('/')[1].replace(/\+.*/, '');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    const target = argText.trim().replace(/^(["'])(.*)\1$/, '$2').replace(/\\(.)/g, '$1');
    let file = path.join(IMAGE_DIR, `skinnyai-${stamp}.${ext}`);
    if (target) {
      const expanded = target.startsWith('~/') || target === '~' ? path.join(os.homedir(), target.slice(1)) : path.resolve(target);
      const isDir = /[\\/]$/.test(target) || await fs.stat(expanded).then((st) => st.isDirectory(), () => false);
      file = isDir ? path.join(expanded, `skinnyai-${stamp}.${ext}`) : (path.extname(expanded) ? expanded : `${expanded}.${ext}`);
    }
    try {
      if (await fs.stat(file).then(() => true, () => false) && !await this.confirm(`\n'${file}' already exists. Overwrite it?`)) {
        console.log('Not saved.\n');
        return;
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes);
      console.log(`\n💾 Saved ${image.mime}, ${Math.round(bytes.length / 1024)} KB to ${file}${images.length > 1 ? ` (the latest of ${images.length} images)` : ''}\n`);
    } catch (error) {
      console.log(`\n❌ Couldn't save the image: ${error.message}\n`);
    }
  }

  async list() {
    try {
      if (this.api !== 'ollama') {
        const response = await hostFetch(`${this.host}/v1/models${this.api === 'anthropic' ? '?limit=100' : ''}`, {
          headers: this.authHeaders()
        });
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
        console.log(`\n❌ /show ${sub} isn't supported for --api ${this.api} (no /api/show equivalent)\n`);
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

  // The settings a profile decides (the ones ENV_SETTINGS names), which
  // /set profile replaces as a set.
  static PROFILE_FIELDS = ['model', 'modelIsDefault', 'api', 'host', 'keepAlive', 'showThinking', 'stopOnExit', 'toolsEnabled',
    'mcpEnabled', 'injectDate', 'markdown', 'images', 'autosave'];

  // /set profile: lists the profiles, or switches to one, as if launched with
  // --profile. The conversation carries over (adapted to the new model, see
  // adaptHistory) unless `newChat`, which starts a new one with the system
  // message kept. Command-line flags only applied to the launch, so they
  // don't carry over.
  async switchProfile(name, { newChat = false } = {}) {
    let config;
    try {
      config = loadConfigFile(CONFIG_FILE);
    } catch (error) {
      console.log(`\n❌ ${error.message}\n`);
      return;
    }
    if (!config) {
      console.log(`\nThere is no ${CONFIG_FILE}, so there are no profiles to switch to.\n`);
      return;
    }
    if (!name) {
      const defaultName = resolveProfile(config).name;
      console.log('\nProfiles:');
      for (const profile of Object.keys(config.profiles)) {
        const marks = [profile === PROFILE.name ? 'active' : '', profile === defaultName ? 'default' : ''].filter(Boolean);
        console.log(`  ${profile}${marks.length ? ` (${marks.join(', ')})` : ''}`);
      }
      console.log('\nUsage: /set profile <name> [--new]\n');
      return;
    }

    const before = Object.fromEntries(OllamaChat.PROFILE_FIELDS.map((field) => [field, this[field]]));
    const previous = PROFILE.name;
    const revert = (error) => {
      activateProfile(previous);
      Object.assign(this, before);
      console.log(`\n❌ Couldn't switch to profile '${name}': ${error.message}\n`);
    };
    try {
      activateProfile(name);
    } catch (error) {
      console.log(`\n❌ ${error.message}\n`);
      return;
    }
    const { model, ...options } = envOptions();
    if (!model) return revert(new Error('it sets no SKINNY_MODEL'));
    if (options.api && !API_NAMES.includes(options.api)) return revert(new Error(`SKINNY_API must be 'ollama', 'openai', or 'anthropic' (got '${options.api}')`));

    if (this.stopOnExit) await this.stopModel(); // still the old model and host
    const fresh = new OllamaChat(model, options);
    for (const field of OllamaChat.PROFILE_FIELDS) this[field] = fresh[field];
    this.modelIsDefault = false;
    try {
      await this.resolveDefaultModel();
    } catch (error) {
      return revert(error);
    }
    this.mcp?.close();
    this.mcp = null;
    await this.startMcp();
    if (newChat) {
      const system = this.getSystemMessage();
      this.history = system ? [{ role: 'system', content: system }] : [];
      this.sessionName = null;
    }
    this.options = {};
    this.format = '';
    this.think = undefined;
    this.queuedAttachments = [];
    this.printWelcome();
    console.log(newChat ? `Switched to profile '${PROFILE.name}'; this is a new conversation.\n` : this.carryOverNote(`Switched to profile '${PROFILE.name}'`));
  }

  // /set model: another model on the same server, with the conversation kept
  // (the sampling parameters and settings stay as they are).
  async switchModel(name) {
    if (!name) {
      console.log(`\nUsage: /set model <name>   (now: ${this.model}; /list shows what's available)\n`);
      return;
    }
    if (this.api === 'ollama') {
      try {
        const response = await hostFetch(`${this.host}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: name })
        });
        if (response.status === 404) {
          console.log(`\nCouldn't find model '${name}'\n`);
          return;
        }
      } catch (error) {
        console.log(`\n❌ Couldn't check model '${name}': ${error.message}\n`);
        return;
      }
    }
    if (this.stopOnExit) await this.stopModel(); // still the old model
    this.model = name;
    this.modelIsDefault = false;
    try {
      await this.resolveDefaultModel();
    } catch (error) {
      console.log(`\n❌ ${error.message}\n`);
      return;
    }
    console.log(`\n${this.carryOverNote(`Switched to model '${this.model}'`)}`);
  }

  handleSet(args) {
    const [sub, ...rest] = args;
    switch (sub) {
      case 'profile': {
        const text = rest.join(' ').trim();
        const newChat = /(^|\s)--new$/.test(text);
        return this.switchProfile(text.replace(/\s*--new$/, ''), { newChat });
      }
      case 'model':
        return this.switchModel(rest.join(' ').trim());
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
      case 'debug':
        this.debug = true;
        return enableDebugLog().then(
          () => console.log(`Set 'debug' mode (logging requests, offered tools, and tool calls to ${DEBUG_LOG}).\n`),
          (error) => { this.debug = false; setDebugEnabled(false); console.log(`Couldn't start the debug log: ${error.message}\n`); }
        );
      case 'nodebug':
        this.debug = false;
        setDebugEnabled(false);
        console.log("Set 'nodebug' mode.\n");
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
        const name = rest.join(' ');
        if (name) {
          await this.save(name);
          if (this.sessionName !== name) return true; // not saved, so keep it
        }
        this.startNewConversation();
        console.log(name ? `🗑️  Saved as '${name}' and started a new conversation.\n` : '🗑️  Conversation history cleared.\n');
        return true;
      }
      case '/new':
        await this.newConversation(rest.join(' '));
        return true;
      case '/delete':
        await this.deleteSession(rest.join(' '));
        return true;
      case '/export':
        await this.exportChat(trimmed.slice(rawCmd.length).trim());
        return true;
      case '/purge':
        await this.purge(rest[0]);
        return true;
      case '/model':
        console.log(`\n📦 Current model: ${this.model}`);
        if (this.managesModelLifetime) console.log(`⏱️  Keep-alive: ${this.keepAlive}`);
        if (this.api !== 'ollama') console.log(`🔌 API: ${API_LABELS[this.api]}`);
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
      case '/mcp':
        this.printMcp();
        return true;
      case '/saveimage':
        await this.saveImage(trimmed.slice(rawCmd.length));
        return true;
      case '/attach':
        this.attach(trimmed.slice(rawCmd.length));
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
    return (await this.choose(question, '[y/N]', 'y')) === 'y';
  }

  // Like confirm, but with more answers than yes and no: `letters` are the
  // accepted single-letter answers ('y', 'a' for "always"); anything else is 'n'.
  async choose(question, hint, letters) {
    const words = { y: /^y(es)?$/i, a: /^a(lways)?$/i, r: /^r(eload)?$/i, s: /^s(ave)?$/i, o: /^o(verwrite)?$/i };
    const labels = { y: 'yes', a: 'always', r: 'reload', s: 'new name', o: 'overwrite', n: 'no' };
    process.stdout.write(`${question} ${hint} `);
    if (!process.stdin.isTTY) {
      const line = await this.nextPipedLine();
      process.stdout.write(`${line ?? ''}\n`);
      return [...letters].find((l) => words[l].test((line ?? '').trim())) ?? 'n';
    }
    return new Promise((resolve) => {
      const stdin = process.stdin;
      readline.emitKeypressEvents(stdin);
      stdin.setRawMode(true);
      stdin.resume();
      stdin.once('keypress', (str) => {
        stdin.setRawMode(false);
        stdin.pause();
        const answer = letters.includes((str || '').toLowerCase()) && str ? str.toLowerCase() : 'n';
        process.stdout.write(`${labels[answer]}\n`);
        resolve(answer);
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
      // Files dragged in (their paths are recognized as they arrive) are
      // taken out of the text and shown as chips on a line above the prompt.
      const attached = [];

      const chipLine = () => {
        let text = attached.map((file) => `📎 ${file.name}`).join('  ');
        const room = (process.stdout.columns || 80) - 1;
        if (visibleWidth(text) > room) {
          const kept = [];
          let used = 1;
          for (const { segment } of graphemes.segment(text)) {
            used += graphemeWidth(segment);
            if (used > room) break;
            kept.push(segment);
          }
          text = kept.join('') + '…';
        }
        return `${CHROME_COLOR}${text}${ANSI.reset}\r\n`;
      };

      const render = () => {
        const end = inputPosition(buffer);
        const target = inputPosition(buffer.slice(0, cursor));
        const chips = attached.length > 0;
        let out = cursorRow > 0 ? `\x1b[${cursorRow}A` : '';
        // Raw mode disables automatic CR-on-LF, so embedded newlines need an explicit \r.
        out += '\r\x1b[J' + (chips ? chipLine() : '') + styledPrompt() + buffer.replace(/\n/g, '\r\n');
        if (end.pending) out += ' \r'; // move off the right edge onto the next row
        if (end.row > target.row) out += `\x1b[${end.row - target.row}A`;
        out += '\r' + (target.col > 0 ? `\x1b[${target.col}C` : '');
        cursorRow = target.row + (chips ? 1 : 0);
        process.stdout.write(out);
      };

      // Moves any complete file path in the text into `attached`. Run when a
      // paste ends (a drag-and-drop arrives like one) and after each space, so
      // a path typed or dropped without bracketed paste is caught too.
      // Any kind of file counts when it came in as a paste, since that's what
      // a drop is; typed text only attaches images.
      const attachImages = (pasted) => {
        if (!buffer.includes('/')) return;
        const found = extractAttachments(buffer, { complete: false, allowEnd: pasted, anyFile: pasted });
        if (found.attachments.length === 0) return;
        const atEnd = cursor >= buffer.length;
        attached.push(...found.attachments);
        buffer = found.text;
        cursor = atEnd ? buffer.length : Math.min(cursor, buffer.length);
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
        process.stdout.write('\x1b[?2004l\x1b[<u'); // bracketed paste off; back to the usual key reporting
        stdin.removeListener('keypress', onKeypress);
        stdin.setRawMode(false);
        stdin.pause();
      };

      const onKeypress = async (str, key) => {
        key = key || {};
        const decoded = decodeCsiU(key.sequence ?? str);
        if (decoded) {
          key = decoded.key;
          str = decoded.text;
        }

        if (key.name === 'paste-start') {
          pasting = true;
          return;
        }
        if (key.name === 'paste-end') {
          pasting = false;
          attachImages(true);
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
          this.mcp?.close();
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
          (key.name === 'return' && (key.shift || key.meta)); // Shift+Enter, where the terminal reports it
        if (isNewlineInsert) {
          insert('\n');
        } else if (key.name === 'return') {
          cursor = buffer.length;
          render();
          cleanup();
          process.stdout.write('\r\n');
          if (buffer.trim() && buffer !== history[history.length - 1]) history.push(buffer);
          this.pendingFiles = attached;
          resolve(buffer);
          return;
        } else if (key.name === 'backspace') {
          if (key.meta) remove(wordLeft(cursor), cursor);
          else if (cursor > 0) remove(prev(cursor), cursor);
          else if (buffer.length === 0) attached.pop(); // nothing left to delete: drop the last image
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
          if (/\s/.test(str)) attachImages(false);
        } else {
          return; // Unhandled key (Tab, Escape, function keys, ...)
        }
        render();
      };

      // Bracketed paste on, and (where supported) Shift+Enter reported as such;
      // other terminals ignore the second sequence.
      process.stdout.write(styledPrompt() + '\x1b[?2004h\x1b[>1u');
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
    if (this.debug) await enableDebugLog();
    await this.prepareStartupSession();
    await this.resolveDefaultModel();
    await this.startMcp(); // before the welcome box, which reports on it
    this.printWelcome();
    await this.loadModelContext();

    while (true) {
      this.pendingFiles = [];
      const input = await this.readTurnInput();
      const attached = this.pendingFiles;
      this.pendingFiles = [];

      if (input === null) {
        console.log('\n👋 Goodbye!\n');
        break;
      }

      if (!input.trim() && attached.length === 0) {
        continue;
      }

      this.rewriteInputLine(input);

      // Check if it's a command. Anything else starting with '/' is a message
      // if it holds a path to an image (a drop onto an empty prompt looks like
      // that), and otherwise an unknown command.
      if (input.startsWith('/')) {
        const shouldContinue = await this.handleCommand(input);
        if (shouldContinue === false) {
          break;
        }
        if (shouldContinue === true) {
          this.queuedAttachments.push(...attached); // chips on a command's line wait for the next message
          continue;
        }
        if (extractAttachments(input).attachments.length === 0 && attached.length === 0) {
          console.log(`Unknown command '${input.trim().split(/\s+/)[0]}'. Type /help for help\n`);
          continue;
        }
      }

      // Send to Ollama
      await this.chat(input, attached);
    }

    if (this.stopOnExit) {
      await this.stopModel();
    }
    this.mcp?.close();
  }
}
