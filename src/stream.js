import readline from 'readline';
import { CONFIG_FILE } from './config.js';
import { debugLog } from './debug.js';
import { newMessageId } from './chatdb.js';
import { newCallId, parseArguments } from './history.js';
import { isOllamaCom, ollamaApiKey, readErrorBody, streamingPost } from './http.js';
import { runTool } from './mcp.js';
import { createMarkdownRenderer } from './markdown.js';
import { ANSI, CHROME_COLOR, createWordWrapper, stripControls, supportsColor } from './style.js';

// Sending a request and showing the reply as it streams in, and running the
// tools it asks for: methods of OllamaChat (chat.js adds them to its prototype).
export const streaming = {
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
  },

  stopSpinner(timer) {
    if (!timer) return;
    clearInterval(timer);
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  },

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
      process.stdout.write(`${ANSI.assistant.narration}🔧 ${stripControls(label)}${ANSI.reset}\n`);

      // MCP tools can do anything their server can, and a web page the model
      // read could try to steer it, so they ask first unless the server is trusted.
      let declined = false;
      if (args !== null && tool?.needsApproval?.()) {
        const shown = JSON.stringify(args);
        process.stdout.write(`${CHROME_COLOR}   arguments: ${stripControls(shown.length > 300 ? `${shown.slice(0, 300)}…` : shown)}${ANSI.reset}\n`);
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
        process.stdout.write(`${ANSI.assistant.narration}   ${stripControls(result)}${ANSI.reset}\n`);
      }

      const message = { id: newMessageId(), role: 'tool', tool_call_id: call.id, tool_name: name, content: result };
      if (images.length) {
        message.images = images;
        message.parts = outcome.parts;
      }
      this.history.push(message);
    }
    process.stdout.write('\n');
  },

  // Streams one model response to the terminal and records it in history.
  // Returns any tool calls the model made (empty if it just answered).
  async streamTurn(allowTools = true) {
    let spinner = this.startSpinner();
    // Ctrl+C while a reply streams stops that reply (what has arrived is kept)
    // instead of ending the whole chat.
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on('SIGINT', interrupt);

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
      const response = await streamingPost(`${this.host}${path}`, body, this.authHeaders(), controller.signal);
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
          thinkingWrapper.write(stripControls(thinking));
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
      try {
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
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        response.body.destroy();
        toolCalls.length = 0; // half-written calls aren't worth running
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
      const message = { id: newMessageId(), role: 'assistant', content: fullResponse, origin: { api: this.api, model: this.model } };
      if (calls.length > 0) message.tool_calls = calls;
      const kept = thinkingBlocks.filter(Boolean);
      if (kept.length > 0) message.thinkingBlocks = kept;
      if (controller.signal.aborted) {
        if (fullResponse) this.history.push(message); // a reply that never started leaves nothing to keep
        process.stdout.write(`\n${CHROME_COLOR}⚠️  Interrupted${fullResponse ? '; what arrived is kept' : ''}.${ANSI.reset}\n\n`);
        return [];
      }
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
    } catch (error) {
      // Interrupted before the server answered: nothing arrived.
      if (!controller.signal.aborted) throw error;
      this.stopSpinner(spinner);
      spinner = null;
      process.stdout.write(`\n${CHROME_COLOR}⚠️  Interrupted.${ANSI.reset}\n\n`);
      return [];
    } finally {
      process.removeListener('SIGINT', interrupt);
      this.stopSpinner(spinner);
    }
  },

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
};
