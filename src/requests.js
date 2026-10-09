import { formatToday } from './tools.js';
import { adaptHistory, wireShape } from './history.js';

// Turning the conversation into a request body for each API: methods of
// OllamaChat (chat.js adds them to its prototype).
export const requestBuilders = {
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
  },

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
  },

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
  },

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
      ...this.options,
      model: this.model,
      messages: this.requestMessages(today),
      stream: true,
      stream_options: { include_usage: true }
    };
    if (this.format === 'json') body.response_format = { type: 'json_object' };
    const tools = this.toolDefinitions(today);
    if (tools.length) body.tools = tools;
    return body;
  },

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
        const content = [...(m.thinkingBlocks || []), ...blocks, ...calls];
        if (content.length) push('assistant', content); // the API rejects an empty one
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
};
