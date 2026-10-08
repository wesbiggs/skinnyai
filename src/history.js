import { randomUUID } from 'node:crypto';

// A conversation is kept in one provider-neutral shape and adapted to
// whichever model receives it, at send time, so the same history can move
// between Ollama, OpenAI-style servers, and Anthropic. The stored history is
// never rewritten for a target; adaptHistory returns a copy.
//
//   { role: 'system', content }
//   { role: 'user', content, images?: [{ mime, data }], documents?: [{ name, mime, data }] }
//   { role: 'assistant', content, tool_calls?: [{ id, function: { name, arguments } }],
//     thinkingBlocks?, origin?: { api, model } }
//   { role: 'tool', tool_call_id, tool_name, content, images?, parts? }
//
// `arguments` is an object (a string only if the model's JSON didn't parse),
// and every tool call has an id, made up here when the server gave none.

export const newCallId = () => `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

export function parseArguments(args) {
  if (typeof args !== 'string') return args ?? {};
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch (e) {
    return args;
  }
}

// How much of a tool result survives when a call is turned into text.
export const FLATTENED_RESULT_CHARS = 1500;
// Rough sizes for the context estimate (characters per token; per attachment).
export const CHARS_PER_TOKEN = 4;
export const IMAGE_TOKENS = 1000;
export const DOCUMENT_TOKENS = 2000;
// Leave this share of the window for the reply when trimming to fit.
export const CONTEXT_HEADROOM = 0.8;

const without = (object, ...keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function estimateTokens(message) {
  let chars = typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content ?? '').length;
  for (const call of message.tool_calls ?? []) chars += JSON.stringify(call.function ?? {}).length;
  const attachments = (message.images?.length ?? 0) * IMAGE_TOKENS + (message.documents?.length ?? 0) * DOCUMENT_TOKENS;
  return Math.ceil(chars / CHARS_PER_TOKEN) + attachments;
}

const emptyReport = () => ({ thinking: 0, flattened: 0, orphans: 0, images: 0, documents: 0, droppedMessages: 0 });

// Returns { messages, report }: `history` as `target` can take it.
//   target = {
//     api,            // 'ollama' | 'openai' | 'anthropic'
//     model,
//     toolNames,      // Set of tools offered with the request
//     vision,         // false only when the model is known not to see images
//     contextTokens   // window to fit, or null when unknown (nothing is dropped)
//   }
// - Thinking blocks are replayed only to the model that wrote them.
// - A tool call (with its results) stays structured only if every tool it
//   used is offered now and every call has a result; otherwise it becomes a
//   line of text in the assistant message. Stray results are dropped.
// - PDFs Ollama can't take and images a text-only model can't see become a
//   marker in the message.
// - If the window is known and too small, the oldest turns go, whole.
export function adaptHistory(history, target) {
  const report = emptyReport();
  const out = [];
  // Images in the message being sent are the user's choice (the chat warns
  // about a text-only model but sends them); only older ones are left out.
  const latestUser = history.map((m) => m.role).lastIndexOf('user');
  const offered = target.toolNames ?? new Set();

  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role === 'tool') {
      report.orphans++;
      if (m.images?.length) report.images += m.images.length;
      continue;
    }
    if (m.role === 'user') {
      out.push(adaptUser(m, i === latestUser ? { ...target, vision: null } : target, report));
      continue;
    }
    if (m.role !== 'assistant') {
      out.push(m);
      continue;
    }

    let next = m;
    if (m.thinkingBlocks?.length && !target.keepThinking && !(m.origin && m.origin.api === target.api && m.origin.model === target.model && target.api === 'anthropic')) {
      report.thinking += m.thinkingBlocks.length;
      next = without(next, 'thinkingBlocks');
    }
    const calls = m.tool_calls ?? [];
    if (!calls.length) {
      out.push(next);
      continue;
    }

    // The results that follow this message, up to the next non-tool message.
    const results = [];
    while (history[i + 1]?.role === 'tool') results.push(history[++i]);
    const resultFor = (call, n) => results.find((r) => r.tool_call_id && r.tool_call_id === call.id) ?? (call.id ? undefined : results[n]);
    const matched = calls.map(resultFor);
    const complete = matched.every(Boolean) && new Set(matched).size === matched.length;
    if (complete && calls.every((call) => offered.has(call.function?.name))) {
      const ids = calls.map((call) => call.id || newCallId());
      out.push({ ...next, tool_calls: calls.map((call, n) => ({ ...call, id: ids[n] })) });
      matched.forEach((r, n) => out.push({ ...r, tool_call_id: ids[n], tool_name: r.tool_name ?? calls[n].function?.name }));
      report.orphans += results.length - matched.length;
      continue;
    }

    const notes = calls.map((call, n) => {
      const result = matched[n];
      if (result?.images?.length) report.images += result.images.length;
      const args = JSON.stringify(parseArguments(call.function?.arguments));
      return `[Tool call: ${call.function?.name}(${args}) -> ${result ? clip(result.content ?? '', FLATTENED_RESULT_CHARS) : 'no result recorded'}]`;
    });
    report.flattened += calls.length;
    report.orphans += results.filter((r) => !matched.includes(r)).length;
    out.push({ ...without(next, 'tool_calls'), content: [next.content, ...notes].filter(Boolean).join('\n\n') });
  }

  return { messages: fitContext(out, target.contextTokens, report), report };
}

function adaptUser(m, target, report) {
  let next = m;
  const markers = [];
  if (m.documents?.length && target.api === 'ollama') {
    markers.push(...m.documents.map((d) => `[attached file ${d.name} not sent: Ollama can't take PDFs]`));
    report.documents += m.documents.length;
    next = without(next, 'documents');
  }
  if (m.images?.length && target.vision === false) {
    markers.push(`[${m.images.length} attached image${m.images.length === 1 ? '' : 's'} not sent: ${target.model} can't see images]`);
    report.images += m.images.length;
    next = without(next, 'images');
  }
  return markers.length ? { ...next, content: [next.content, ...markers].filter(Boolean).join('\n\n') } : next;
}

// Drops the oldest turns (a turn starts at a user message) until the rest
// fits the window with room left for a reply. The system message and the
// latest turn always stay.
function fitContext(messages, contextTokens, report) {
  if (!contextTokens) return messages;
  const budget = Math.floor(contextTokens * CONTEXT_HEADROOM);
  const system = messages.filter((m) => m.role === 'system');
  let rest = messages.filter((m) => m.role !== 'system');
  const kept = rest.length;
  const total = () => [...system, ...rest].reduce((sum, m) => sum + estimateTokens(m), 0);
  while (total() > budget) {
    const next = rest.findIndex((m, i) => i > 0 && m.role === 'user');
    if (next === -1) break;
    report.droppedMessages += next;
    rest = rest.slice(next);
  }
  return rest.length === kept ? messages : [...system, ...rest];
}

// The wire shape each API wants for tool calls and results (images and
// attachments are handled where the request is built).
export function wireShape(messages, api) {
  const names = new Map(); // call id -> tool name
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const { tool_calls } = m;
      const rest = without(m, 'id', 'origin', 'thinkingBlocks', 'tool_calls');
      const out = api === 'anthropic' && m.thinkingBlocks ? { ...rest, thinkingBlocks: m.thinkingBlocks } : rest;
      if (!tool_calls?.length) return out;
      for (const call of tool_calls) names.set(call.id, call.function.name);
      if (api === 'ollama') {
        return { ...out, tool_calls: tool_calls.map((c) => ({ function: { name: c.function.name, arguments: asObject(c.function.arguments) } })) };
      }
      if (api === 'openai') {
        return {
          ...out,
          tool_calls: tool_calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) }
          }))
        };
      }
      return { ...out, tool_calls };
    }
    if (m.role === 'tool') {
      const { tool_call_id, tool_name } = m;
      const rest = without(m, 'id', 'tool_call_id', 'tool_name');
      if (api === 'ollama') return { ...rest, tool_name: tool_name ?? names.get(tool_call_id) };
      if (api === 'openai') return { ...rest, tool_call_id };
      return { ...rest, tool_call_id };
    }
    return m.id ? without(m, 'id') : m;
  });
}

const asObject = (args) => (args && typeof args === 'object' ? args : {});

// What to tell the user after a switch, one line per thing that changed.
export function describeAdaptation(report) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const lines = [];
  if (report.flattened) lines.push(`${plural(report.flattened, 'tool call')} kept as text (those tools aren't available here)`);
  if (report.thinking) lines.push(`${plural(report.thinking, 'thinking block')} not replayed to this model`);
  if (report.images) lines.push(`${plural(report.images, 'image')} left out`);
  if (report.documents) lines.push(`${plural(report.documents, 'PDF')} left out (Ollama can't take them)`);
  if (report.orphans) lines.push(`${plural(report.orphans, 'unmatched tool result')} dropped`);
  if (report.droppedMessages) lines.push(`the oldest ${plural(report.droppedMessages, 'message')} left out to fit the context window`);
  return lines;
}

// /purge: rewrites a history without one kind of bulk. Returns
// { history, removed } (removed counts what went).
//   thinking  drops the saved thinking blocks
//   tools     turns tool calls and their results into text
//   blobs     removes attached images and PDFs and images in tool results,
//             leaving a note where each was
export function purgeHistory(history, kind) {
  if (kind === 'thinking') {
    let removed = 0;
    const next = history.map((m) => {
      if (!m.thinkingBlocks?.length) return m;
      removed += m.thinkingBlocks.length;
      return without(m, 'thinkingBlocks');
    });
    return { history: next, removed };
  }
  if (kind === 'tools') {
    const { messages, report } = adaptHistory(history, { api: '', model: '', toolNames: new Set(), keepThinking: true });
    return { history: messages, removed: report.flattened };
  }
  if (kind === 'blobs') {
    let removed = 0;
    const next = history.map((m) => {
      const markers = [];
      let out = m;
      if (m.images?.length && m.role === 'user') {
        markers.push(`[${m.images.length} attached image${m.images.length === 1 ? '' : 's'} removed]`);
        removed += m.images.length;
        out = without(out, 'images');
      }
      if (m.documents?.length) {
        markers.push(...m.documents.map((d) => `[attached file ${d.name} removed]`));
        removed += m.documents.length;
        out = without(out, 'documents');
      }
      if (m.role === 'tool' && m.images?.length) {
        removed += m.images.length;
        out = without(out, 'images', 'parts');
      }
      return markers.length ? { ...out, content: [out.content, ...markers].filter(Boolean).join('\n\n') } : out;
    });
    return { history: next, removed };
  }
  throw new Error(`unknown kind '${kind}'`);
}
