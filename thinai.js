#!/usr/bin/env node

import readline from 'readline';
import http from 'node:http';
import https from 'node:https';

const DEFAULT_KEEP_ALIVE = '1h';
const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

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
        'Content-Length': Buffer.byteLength(payload)
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

// *Starred text* is narration in RP-style chats. Each speaker gets its own
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

// Converts '*narration*' spans into colored, asterisk-free text. Stateful across
// calls so streamed chunks that split a '*' pair still toggle correctly.
function createStyler(role) {
  const colors = ANSI[role];
  let inNarration = false;

  return function style(text) {
    let out = '';
    for (const ch of text) {
      if (ch === '*') {
        inNarration = !inNarration;
        out += inNarration ? colors.narration : colors.dialogue;
      } else {
        out += ch;
      }
    }
    return out;
  };
}

function styleLine(role, text) {
  return ANSI[role].dialogue + createStyler(role)(text) + ANSI.reset;
}

// A '*' at the start of a line (ignoring leading whitespace) with no closing
// '*' later on that same line is a markdown list bullet, not narration -
// replace it with a bullet glyph so it doesn't get misread as *narration*.
// Operates on raw text, ahead of the narration styler/word-wrapper, so a
// substituted bullet is just a plain character to everything downstream.
// Only lines that open with '*' get buffered (to look ahead for a closing
// '*'); ordinary text is forwarded to `sink` immediately, unbuffered.
function createBulletFilter(sink) {
  const BULLET = '•';
  let atLineStart = true;
  let leadingWhitespace = '';
  let buffering = false;
  let buffer = '';
  let plain = '';

  function flushPlain() {
    if (plain) {
      sink(plain);
      plain = '';
    }
  }

  function finalizeBuffer(hasClosingAsterisk) {
    sink(hasClosingAsterisk ? buffer : buffer.replace('*', BULLET));
    buffer = '';
    buffering = false;
  }

  return {
    write(text) {
      for (const ch of text) {
        if (buffering) {
          if (ch === '*') {
            buffer += ch;
            finalizeBuffer(true);
          } else if (ch === '\n') {
            finalizeBuffer(false);
            plain += '\n';
            atLineStart = true;
          } else {
            buffer += ch;
          }
          continue;
        }

        if (atLineStart) {
          if (ch === ' ' || ch === '\t') {
            leadingWhitespace += ch;
            continue;
          }
          if (ch === '*') {
            flushPlain();
            buffering = true;
            buffer = leadingWhitespace + ch;
            leadingWhitespace = '';
            atLineStart = false;
            continue;
          }
          plain += leadingWhitespace;
          leadingWhitespace = '';
          atLineStart = false;
          // fall through to plain handling below
        }

        plain += ch;
        if (ch === '\n') {
          atLineStart = true;
        }
      }
      flushPlain();
    },
    end() {
      if (buffering) {
        finalizeBuffer(false); // stream ended - no closing '*' is coming
      }
      plain += leadingWhitespace;
      leadingWhitespace = '';
      flushPlain();
    }
  };
}

// Word-wraps text at the terminal width as it's written, so long lines break
// on a space instead of relying on the terminal's own mid-word hard wrap.
// `style` is a stateful per-character styler (see createStyler) applied to
// each word once its width is known; spaces/newlines pass through as-is.
// Only wraps on a real TTY - piped/redirected output is left unwrapped.
function createWordWrapper(style, startColumn = 0) {
  if (!process.stdout.isTTY) {
    return { write: (text) => process.stdout.write(style(text)), end() {} };
  }

  const columns = process.stdout.columns || 80;
  let column = startColumn;
  let pending = '';

  function flushWord() {
    if (!pending) return;
    const wordLen = pending.length;
    if (column > 0) {
      if (column + 1 + wordLen > columns) {
        process.stdout.write('\n');
        column = 0;
      } else {
        process.stdout.write(' ');
        column += 1;
      }
    }
    process.stdout.write(style(pending));
    column += wordLen;
    pending = '';
  }

  return {
    write(text) {
      for (const ch of text) {
        if (ch === '\n') {
          flushWord();
          process.stdout.write('\n');
          column = 0;
        } else if (ch === ' ' || ch === '\t') {
          flushWord();
        } else {
          pending += ch;
        }
      }
    },
    end() {
      flushWord();
    }
  };
}

// Rows a prompt label + (possibly multi-line, possibly wrapped) text will occupy
// in the terminal, so we know how far to move up to erase and redraw it.
function computeRows(promptLabel, text) {
  const columns = process.stdout.columns || 80;
  const prefixLen = promptLabel.length;
  const lines = text.split('\n');
  return lines.reduce((total, line, i) => {
    const len = (i === 0 ? prefixLen : 0) + line.length;
    return total + Math.max(1, Math.ceil(len / columns));
  }, 0);
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
      await fetch(`${this.host}/api/chat`, {
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
    const response = await fetch(`${this.host}/api/show`, {
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
    this.options = {};
    this.format = '';
    this.think = undefined;

    if (messages.length > 0) {
      this.printRestoredHistory(messages);
    }
    return true;
  }

  async loadModelContext() {
    try {
      await this.fetchAndApplyModelContext(this.model);
    } catch (error) {
      // Non-fatal: just start with an empty session.
    }
  }

  printRestoredHistory(messages) {
    console.log(`📜 Restored conversation from '${this.model}':\n`);

    for (const message of messages) {
      if (message.role === 'system') {
        console.log(`💬 System: ${message.content}\n`);
      } else if (message.role === 'user') {
        process.stdout.write('You: ');
        this.writeWrapped('user', message.content, 'You: '.length);
        process.stdout.write('\n');
      } else if (message.role === 'assistant') {
        process.stdout.write('\n');
        this.writeWrapped('assistant', message.content, 0);
        process.stdout.write('\n\n');
      }
    }
  }

  writeWrapped(role, text, startColumn = 0) {
    const wrapper = createWordWrapper(createStyler(role), startColumn);
    const bullets = createBulletFilter((t) => wrapper.write(t));
    process.stdout.write(ANSI[role].dialogue);
    bullets.write(text);
    bullets.end();
    wrapper.end();
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
    const body = {
      model: this.model,
      messages: this.history,
      keep_alive: this.keepAlive,
      stream: true
    };
    if (Object.keys(this.options).length > 0) body.options = this.options;
    if (this.format) body.format = this.format;
    if (this.think !== undefined) body.think = this.think;
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
    const body = {
      model: this.model,
      messages: this.history,
      stream: true,
      stream_options: { include_usage: true },
      ...this.options
    };
    if (this.format === 'json') body.response_format = { type: 'json_object' };
    return body;
  }

  async chat(prompt) {
    // Add to history
    this.history.push({ role: 'user', content: prompt });

    process.stdout.write('\n');
    let spinner = this.startSpinner();

    try {
      const isOpenAI = this.api === 'openai';
      const body = isOpenAI ? this.buildOpenAIChatBody() : this.buildOllamaChatBody();
      const path = isOpenAI ? '/v1/chat/completions' : '/api/chat';

      const response = await streamingPost(`${this.host}${path}`, body);

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      let fullResponse = '';
      let lineBuffer = '';
      let started = false;
      let thinkingStarted = false;
      let thinkingEnded = false;
      let stats = null;
      const decoder = new TextDecoder();
      const wrapper = createWordWrapper(createStyler('assistant'));
      const bullets = createBulletFilter((t) => wrapper.write(t));
      // Thinking text is the model's raw internal monologue, not RP dialogue,
      // so it's wrapped plain (no *narration* toggling) in a constant dim color.
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

      const handleLine = (line) => {
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
          bullets.write(content);
          fullResponse += content;
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
          handleLine(line);
        }
      }
      if (lineBuffer) {
        handleLine(lineBuffer);
      }
      if (isOpenAI) {
        stats = { done_reason: openaiFinishReason || 'stop', usage: openaiUsage };
      }
      endThinking(Boolean(stats?.done_reason && stats.done_reason !== 'stop'));
      bullets.end();
      wrapper.end();

      if (started) {
        process.stdout.write(ANSI.reset);
      }

      // Add assistant response to history (raw, asterisks intact)
      this.history.push({ role: 'assistant', content: fullResponse });

      process.stdout.write('\n');
      if (this.verbose && stats) {
        this.printStats(stats);
      }
      process.stdout.write('\n');
    } catch (error) {
      console.error(`\n❌ Error: ${error.message}\n`);
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
    console.log('\n📝 Commands:');
    this.printCommandList();
    console.log('\nPress Enter to send. Ctrl+J adds a new line without sending.');
    console.log('\n' + '='.repeat(50) + '\n');
  }

  printCommandList() {
    console.log('  /set            Set session variables');
    console.log('  /show           Show model information');
    console.log('  /load <model>   Load a session or model');
    console.log('  /save <model>   Save your current session');
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
    console.log('');
  }

  printShowUsage() {
    console.log('\nAvailable Commands:');
    console.log('  /show info         Show details for this model');
    console.log('  /show license      Show model license');
    console.log('  /show modelfile    Show Modelfile for this model');
    console.log('  /show parameters   Show parameters for this model');
    console.log('  /show system       Show system message');
    console.log('  /show template     Show prompt template');
    console.log('');
  }

  printShortcuts() {
    console.log('\nAvailable keyboard shortcuts:');
    console.log('  Enter               Send your message');
    console.log('  Ctrl + j            Insert a new line without sending');
    console.log('  Ctrl + c            Exit immediately');
    console.log('  Ctrl + d            Exit (on an empty line)');
    console.log('');
  }

  async save(name) {
    if (!name) {
      console.log('\n❌ Usage: /save <name>\n');
      return;
    }
    if (this.api !== 'ollama') {
      console.log("\n❌ /save isn't supported for --api openai (no /api/create equivalent)\n");
      return;
    }

    const system = this.getSystemMessage();
    const messages = system ? this.history.slice(1) : this.history;

    try {
      const body = { model: name, from: this.model, stream: false };
      if (system) body.system = system;
      if (messages.length > 0) body.messages = messages;
      if (Object.keys(this.options).length > 0) body.parameters = this.options;

      const response = await fetch(`${this.host}/api/create`, {
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

      console.log(`\n✅ Saved session as model '${name}'\n`);
    } catch (error) {
      console.error(`\n❌ Error saving model: ${error.message}\n`);
    }
  }

  async load(name) {
    if (!name) {
      console.log('\nUsage:\n  /load <modelname>\n');
      return;
    }

    // OpenAI-compatible servers have no /api/show equivalent to restore a
    // saved system message/history from, so /load there just switches the
    // active model name and starts a fresh session.
    if (this.api !== 'ollama') {
      this.model = name;
      this.history = [];
      this.options = {};
      this.format = '';
      this.think = undefined;
      console.log(`\n📦 Switched to model '${name}' (session reset - context restore isn't supported for --api openai)\n`);
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
        const response = await fetch(`${this.host}/v1/models`);
        if (!response.ok) {
          throw new Error(`API error: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        console.log('');
        for (const m of data.data || []) {
          console.log(`  ${m.id}`);
        }
        console.log('');
        return;
      }
      const response = await fetch(`${this.host}/api/tags`);
      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      console.log('');
      for (const m of data.models || []) {
        const sizeGB = (m.size / 1e9).toFixed(1);
        console.log(`  ${m.name.padEnd(35)} ${sizeGB} GB`);
      }
      console.log('');
    } catch (error) {
      console.log(`\n❌ Error: ${error.message}\n`);
    }
  }

  async show(args) {
    const sub = (args[0] || '').toLowerCase();
    if (!sub) {
      this.printShowUsage();
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
      const response = await fetch(`${this.host}/api/show`, {
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
      case 'history':
      case 'nohistory':
      case 'wordwrap':
      case 'nowordwrap':
        console.log(`\n'/set ${sub}' doesn't apply here - this client doesn't keep its own input`);
        console.log('history or do manual word-wrapping; your terminal already handles that.\n');
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
        this.handleSet(rest);
        return true;
      case '/help':
      case '/?':
        this.printHelp(rest[0]?.toLowerCase());
        return true;
      default:
        return null; // Not a command
    }
  }

  // Reads one turn of input. On a real TTY this is a small hand-rolled editor
  // supporting multi-line messages: plain Enter submits, Ctrl+J always inserts
  // a newline, and Shift+Enter inserts one too if the terminal happens to send
  // a distinguishable sequence for it (most don't by default - Ctrl+J is the
  // reliable option). Falls back to plain line reading when stdin isn't a TTY
  // (piped input). Resolves null on Ctrl+D / Ctrl+C to signal "quit".
  async readTurnInput(promptLabel) {
    if (!process.stdin.isTTY) {
      return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
        process.stdout.write(promptLabel);
        rl.once('line', (line) => {
          rl.close();
          resolve(line);
        });
        rl.once('close', () => resolve(null));
      });
    }

    return new Promise((resolve) => {
      const stdin = process.stdin;
      let buffer = '';

      const SPECIAL_KEYS = new Set([
        'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
        'insert', 'delete', 'tab', 'escape',
        'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'
      ]);

      const cleanup = () => {
        stdin.removeListener('keypress', onKeypress);
        stdin.setRawMode(false);
        stdin.pause();
      };

      const onKeypress = async (str, key) => {
        key = key || {};

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

        const isNewlineInsert =
          (key.name === 'return' && key.shift) || // best-effort: few terminals report this
          str === '\x1b\r' || str === '\x1b\n' || str === '\x1b[13;2u' || // best-effort shift+enter sequences
          (key.ctrl && key.name === 'j'); // guaranteed: Ctrl+J always sends a real linefeed

        const isSubmit = !isNewlineInsert && (key.name === 'return' || key.name === 'enter');

        if (isNewlineInsert) {
          buffer += '\n';
          process.stdout.write('\r\n');
          return;
        }

        if (isSubmit) {
          cleanup();
          process.stdout.write('\r\n');
          resolve(buffer);
          return;
        }

        if (key.name === 'backspace') {
          if (buffer.length === 0) return;
          const priorRows = computeRows(promptLabel, buffer);
          buffer = buffer.slice(0, -1);
          process.stdout.moveCursor(0, -(priorRows - 1));
          process.stdout.cursorTo(0);
          process.stdout.clearScreenDown();
          // Raw mode disables automatic CR-on-LF, so embedded newlines need an explicit \r.
          process.stdout.write((promptLabel + buffer).replace(/\n/g, '\r\n'));
          return;
        }

        if (SPECIAL_KEYS.has(key.name)) {
          return; // Arrow-key/mid-line editing isn't supported by this simple editor.
        }

        if (str) {
          buffer += str;
          process.stdout.write(str);
        }
      };

      process.stdout.write(promptLabel);
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

    const promptLabel = 'You: ';
    const rows = computeRows(promptLabel, input);

    process.stdout.moveCursor(0, -rows);
    process.stdout.cursorTo(0);
    process.stdout.clearScreenDown();
    process.stdout.write(`${promptLabel}${styleLine('user', input)}`.replace(/\n/g, '\r\n') + '\r\n');
  }

  async start() {
    this.printWelcome();
    if (this.api === 'ollama') {
      await this.loadModelContext();
    }

    while (true) {
      const input = await this.readTurnInput('You: ');

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

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {};
  let model = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' || args[i] === '-m') {
      model = args[++i];
    } else if (args[i] === '--keep-alive' || args[i] === '-k') {
      options.keepAlive = args[++i];
    } else if (args[i] === '--host' || args[i] === '-h') {
      options.host = args[++i];
    } else if (args[i] === '--user-emphasis-color') {
      options.userEmphasisColor = args[++i];
    } else if (args[i] === '--user-normal-color') {
      options.userNormalColor = args[++i];
    } else if (args[i] === '--model-emphasis-color') {
      options.modelEmphasisColor = args[++i];
    } else if (args[i] === '--model-normal-color') {
      options.modelNormalColor = args[++i];
    } else if (args[i] === '-x' || args[i] === '--stop-on-exit') {
      options.stopOnExit = true;
    } else if (args[i] === '--hide-thinking') {
      options.hideThinking = true;
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

  return { model, options };
}

function printUsage() {
  console.log(`
Usage: ollama-chat.js [model] [options]

Arguments:
  model                Model name (e.g., llama2, neural-chat)

Options:
  -m, --model NAME     Specify model name
  -k, --keep-alive TIME   Keep model loaded for TIME (default: 1h)
                       Examples: 5m, 1h, 24h, 30s
  -h, --host URL      Ollama API host (default: http://localhost:11434)
  --user-emphasis-color COLOR   Color for *narration* in your messages (default: 136 / dim yellow)
  --user-normal-color COLOR     Color for dialogue in your messages (default: 226 / bright yellow)
  --model-emphasis-color COLOR  Color for *narration* in model responses (default: 28 / dim green)
  --model-normal-color COLOR    Color for dialogue in model responses (default: 83 / bright green)
                       COLOR can be a hex code (#RRGGBB), a 256-color index (0-255),
                       or a name (red, green, yellow, blue, magenta, cyan, white, black,
                       or bright- prefixed, e.g. brightgreen; gray/grey aliases brightblack)
  -x, --stop-on-exit   Unload the model from Ollama when the session ends
                       (same effect as \`ollama stop\`)
  --hide-thinking      Don't stream thinking-model reasoning output
                       (shown by default; same as running \`/set hidethinking\`)
  --api <ollama|openai>  Backend API to speak (default: ollama)
                       Use 'openai' for OpenAI-compatible servers (vLLM,
                       llama.cpp server, LM Studio, ...). Ollama-only
                       features (/save, /show info/license/modelfile/
                       parameters/template, keep-alive, --stop-on-exit)
                       aren't supported there and are disabled/no-ops.
  --help              Show this message

Examples:
  ollama-chat.js llama2
  ollama-chat.js neural-chat --keep-alive 30m
  ollama-chat.js --model mistral --keep-alive 2h --host http://192.168.1.100:11434
  ollama-chat.js llama2 --user-normal-color cyan --model-normal-color "#ff8800"
  ollama-chat.js llama2 --stop-on-exit
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

main().catch(console.error);
