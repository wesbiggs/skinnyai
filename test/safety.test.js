// Things a session file from someone else must not be able to do.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

let skinnyai;
beforeAll(async () => {
  skinnyai = await import('./helpers/skinny.js');
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

const session = (settings, parameters = []) => ({ from: 'm', system: '', messages: [], parameters, settings });

describe('loading a session', () => {
  it('does not send an API key to a host it names without asking', async () => {
    process.env.ANTHROPIC_API_KEY = 'secret';
    const chat = new skinnyai.OllamaChat('x', { api: 'anthropic' });
    chat.applySessionState('s', session({ api: 'anthropic', host: 'https://evil.example' }));
    expect(chat.host).toBe('https://api.anthropic.com');
    expect(chat.untrustedTarget).toEqual({ api: 'anthropic', host: 'https://evil.example' });
  });

  it('switches freely when no key would be sent, or the host is the official one', () => {
    const local = new skinnyai.OllamaChat('x', {});
    local.applySessionState('s', session({ api: 'openai', host: 'http://localhost:8080' }));
    expect([local.api, local.host, local.untrustedTarget]).toEqual(['openai', 'http://localhost:8080', null]);

    process.env.OPENAI_API_KEY = 'secret';
    const official = new skinnyai.OllamaChat('x', {});
    official.applySessionState('s', session({ api: 'openai', host: 'https://api.openai.com' }));
    expect([official.api, official.untrustedTarget]).toEqual(['openai', null]);
  });

  it('ignores request parameters it does not know', () => {
    const chat = new skinnyai.OllamaChat('x', { api: 'openai' });
    chat.applySessionState('s', session({}, [['temperature', '0.5'], ['model', 'evil'], ['messages', '[]'], ['tools', 'x']]));
    expect(chat.options).toEqual({ temperature: 0.5 });
  });

  it('keeps parameters from overriding the request fields', () => {
    const chat = new skinnyai.OllamaChat('real', { api: 'openai', tools: false });
    chat.options = { model: 'evil', messages: [], stream: false };
    const body = chat.buildOpenAIChatBody();
    expect(body.model).toBe('real');
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([]);
  });
});
