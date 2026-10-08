import { describe, expect, it } from 'vitest';
import { adaptHistory, describeAdaptation, estimateTokens, newCallId, parseArguments, wireShape } from '../src/history.js';

const tools = new Set(['web_search']);
const target = (extra = {}) => ({ api: 'openai', model: 'm', toolNames: tools, vision: null, contextTokens: null, ...extra });
const call = (id = 'c1', name = 'web_search', args = { query: 'x' }) => ({ id, function: { name, arguments: args } });
const toolTurn = (extra = {}) => [
  { role: 'user', content: 'look it up' },
  { role: 'assistant', content: '', tool_calls: [call()], origin: { api: 'openai', model: 'm' }, ...extra },
  { role: 'tool', tool_call_id: 'c1', tool_name: 'web_search', content: 'result text' },
  { role: 'assistant', content: 'done' }
];

describe('adaptHistory', () => {
  it('passes a plain conversation through untouched', () => {
    const history = [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
    const { messages, report } = adaptHistory(history, target());
    expect(messages).toEqual(history);
    expect(describeAdaptation(report)).toEqual([]);
  });

  it('keeps a tool call whose tool is offered, with its result', () => {
    const { messages, report } = adaptHistory(toolTurn(), target());
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(messages[1].tool_calls[0].id).toBe('c1');
    expect(report.flattened).toBe(0);
  });

  it('turns a call into text when its tool is not offered', () => {
    const { messages, report } = adaptHistory(toolTurn(), target({ toolNames: new Set() }));
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(messages[1].tool_calls).toBeUndefined();
    expect(messages[1].content).toBe('[Tool call: web_search({"query":"x"}) -> result text]');
    expect(report.flattened).toBe(1);
    expect(describeAdaptation(report)).toEqual(["1 tool call kept as text (those tools aren't available here)"]);
  });

  it('turns a call with no result into text and drops stray results', () => {
    const history = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'thinking out loud', tool_calls: [call('c9')] },
      { role: 'user', content: 'b' },
      { role: 'tool', tool_call_id: 'zz', content: 'stray' }
    ];
    const { messages, report } = adaptHistory(history, target());
    expect(messages[1].content).toBe('thinking out loud\n\n[Tool call: web_search({"query":"x"}) -> no result recorded]');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(report.orphans).toBe(1);
  });

  it('gives ids to calls that have none and matches results by position', () => {
    const history = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: {} } }] },
      { role: 'tool', tool_name: 'web_search', content: 'r' }
    ];
    const { messages } = adaptHistory(history, target());
    expect(messages[1].tool_calls[0].id).toMatch(/^call_/);
    expect(messages[2].tool_call_id).toBe(messages[1].tool_calls[0].id);
  });

  it('replays thinking only to the model that wrote it', () => {
    const history = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', thinkingBlocks: [{ type: 'thinking', thinking: 't', signature: 's' }], origin: { api: 'anthropic', model: 'claude-x' } }
    ];
    expect(adaptHistory(history, target({ api: 'anthropic', model: 'claude-x' })).messages[1].thinkingBlocks).toHaveLength(1);
    const other = adaptHistory(history, target({ api: 'anthropic', model: 'claude-y' }));
    expect(other.messages[1].thinkingBlocks).toBeUndefined();
    expect(describeAdaptation(other.report)).toEqual(['1 thinking block not replayed to this model']);
    expect(adaptHistory(history, target({ api: 'ollama' })).messages[1].thinkingBlocks).toBeUndefined();
  });

  it("leaves out PDFs for Ollama and old images for a model that can't see", () => {
    const image = { mime: 'image/png', data: 'AA' };
    const history = [
      { role: 'user', content: 'see', images: [image], documents: [{ name: 'a.pdf', mime: 'application/pdf', data: 'AA' }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'and this', images: [image] }
    ];
    const { messages, report } = adaptHistory(history, target({ api: 'ollama', vision: false }));
    expect(messages[0].documents).toBeUndefined();
    expect(messages[0].images).toBeUndefined();
    expect(messages[0].content).toContain('a.pdf not sent');
    expect(messages[0].content).toContain("can't see images");
    expect(messages[2].images).toEqual([image]); // the message being sent keeps its image
    expect(report.documents).toBe(1);
    expect(report.images).toBe(1);
  });

  it('drops the oldest whole turns to fit a known window, keeping system and the latest turn', () => {
    const big = 'x'.repeat(400); // 100 tokens
    const history = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: big }, { role: 'assistant', content: big },
      { role: 'user', content: big }, { role: 'assistant', content: big },
      { role: 'user', content: 'latest' }
    ];
    const { messages, report } = adaptHistory(history, target({ contextTokens: 300 }));
    expect(messages.map((m) => m.content)).toEqual(['sys', big, big, 'latest']);
    expect(report.droppedMessages).toBe(2);
    expect(adaptHistory(history, target({ contextTokens: 10 })).messages.map((m) => m.content)).toEqual(['sys', 'latest']);
    expect(adaptHistory(history, target()).messages).toHaveLength(6); // window unknown: nothing dropped
  });

  it('does not change the history it is given', () => {
    const history = toolTurn({ thinkingBlocks: [{ type: 'thinking' }] });
    const copy = structuredClone(history);
    adaptHistory(history, target({ toolNames: new Set(), api: 'ollama' }));
    expect(history).toEqual(copy);
  });
});

describe('wireShape', () => {
  const history = toolTurn({ thinkingBlocks: [{ type: 'thinking' }] });
  const shaped = (api, args = { query: 'x' }) => wireShape([{ role: 'assistant', content: '', tool_calls: [call('c1', 'web_search', args)], origin: {} }, history[2]], api);

  it('gives Ollama object arguments, no ids, and a tool_name', () => {
    const [assistant, tool] = shaped('ollama', '{"query":"x"}');
    expect(assistant).toEqual({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: {} } }] });
    expect(tool).toEqual({ role: 'tool', tool_name: 'web_search', content: 'result text' });
    expect(shaped('ollama')[0].tool_calls[0].function.arguments).toEqual({ query: 'x' });
  });

  it('gives OpenAI string arguments and ids', () => {
    const [assistant, tool] = shaped('openai');
    expect(assistant.tool_calls).toEqual([{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }]);
    expect(tool).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'result text' });
  });

  it('keeps what the Anthropic request builder reads', () => {
    const [assistant, tool] = wireShape(history.slice(1, 3), 'anthropic');
    expect(assistant.thinkingBlocks).toHaveLength(1);
    expect(assistant.tool_calls[0].id).toBe('c1');
    expect(tool.tool_call_id).toBe('c1');
    expect(assistant.origin).toBeUndefined();
  });
});

describe('helpers', () => {
  it('parses arguments, keeping unparseable text as it came', () => {
    expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
    expect(parseArguments('')).toEqual({});
    expect(parseArguments(undefined)).toEqual({});
    expect(parseArguments('{oops')).toBe('{oops');
    expect(parseArguments({ a: 1 })).toEqual({ a: 1 });
  });

  it('makes distinct call ids and rough token estimates', () => {
    expect(newCallId()).not.toBe(newCallId());
    expect(estimateTokens({ content: 'x'.repeat(40) })).toBe(10);
    expect(estimateTokens({ content: '', images: [{}] })).toBe(1000);
  });
});
