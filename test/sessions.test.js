import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureOutput, fakeTTY, stripAnsi } from './helpers/tty.js';
import { startMockServer } from './helpers/mock-server.js';

let skinnyai;
let server;
let capture;

beforeAll(async () => {
  fakeTTY({ columns: 80 });
  skinnyai = await import('../src/skinnyai.js');
  server = await startMockServer();
});

afterAll(() => server.close());

beforeEach(() => {
  fs.rmSync(skinnyai.SESSION_DIR, { recursive: true, force: true });
  capture = captureOutput();
});

afterEach(() => {
  capture.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const output = () => stripAnsi(capture.text);
const sessionFiles = () => (fs.existsSync(skinnyai.SESSION_DIR) ? fs.readdirSync(skinnyai.SESSION_DIR).sort() : []);
const readSession = (name) => skinnyai.parseModelfile(fs.readFileSync(skinnyai.sessionPath(name), 'utf8'));

function openaiChat(options = {}) {
  return new skinnyai.OllamaChat('some-model', { api: 'openai', host: server.url, ...options });
}

function withHistory(chat, ...contents) {
  chat.history = contents.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content }));
  return chat;
}

function fixTime() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 30, 15, 49, 7));
}

describe('window title in the SkinnyAI app', () => {
  it('announces the session name through the terminal title', async () => {
    vi.stubEnv('TERM_PROGRAM', 'SkinnyAI');
    const chat = withHistory(openaiChat(), 'q', 'a');
    await chat.save('trip');
    expect(capture.text).toContain('\x1b]2;SkinnyAI: trip\x07');
    chat.sessionName = null;
    expect(capture.text).toContain('\x1b]2;SkinnyAI\x07');
    vi.unstubAllEnvs();
  });
});

describe('/save', () => {
  it('saves under a new date-and-time name, then keeps using it', async () => {
    fixTime();
    const chat = withHistory(openaiChat(), 'q', 'a');
    await chat.save('');
    await chat.save('');
    expect(sessionFiles()).toEqual(['chat-2026-09-30-154907.Modelfile']);
    expect(chat.sessionName).toBe('chat-2026-09-30-154907');
  });

  it('saves the model, system message, parameters, and conversation', async () => {
    const chat = openaiChat();
    chat.setSystemMessage('Be terse.');
    chat.setParameter('temperature', ['0.2']);
    chat.history.push({ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' });
    await chat.save('notes');
    const saved = readSession('notes');
    expect(saved.settings).toMatchObject({ api: 'openai', host: expect.stringMatching(/^http:\/\//), tools: 'true' });
    delete saved.settings;
    expect(saved).toEqual({
      from: 'some-model', system: 'Be terse.', parameters: [['temperature', '0.2']],
      messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]
    });
  });

  it('/load restores the saved host and settings', async () => {
    const saver = openaiChat({ markdown: false });
    saver.think = 'high';
    saver.format = 'json';
    saver.history.push({ role: 'user', content: 'q' });
    await saver.save('cfg');
    const chat = new skinnyai.OllamaChat('other', { host: 'http://example.invalid:1' });
    await chat.load('cfg');
    expect(chat.api).toBe('openai');
    expect(chat.host).toBe(server.url);
    expect(chat.markdown).toBe(false);
    expect(chat.think).toBe('high');
    expect(chat.format).toBe('json');
  });

  it('/load says whether autosave is on', async () => {
    const saver = openaiChat();
    saver.history.push({ role: 'user', content: 'q' });
    await saver.save('note');
    const off = openaiChat();
    await off.load('note');
    expect(output()).toContain('Autosave is off');
    const on = openaiChat({ autosave: true });
    await on.load('note');
    expect(output()).toContain("Autosave is on (saving to 'note' after each reply)");
  });

  it('/load restores verbose and stop on exit', async () => {
    const saver = new skinnyai.OllamaChat('some-model', { host: server.url, api: 'ollama' });
    saver.verbose = true;
    saver.stopOnExit = true;
    saver.history.push({ role: 'user', content: 'q' });
    await saver.save('life');
    expect(readSession('life').settings).toMatchObject({ verbose: 'true', 'stop on exit': 'true' });
    const chat = new skinnyai.OllamaChat('other', { host: 'http://example.invalid:1' });
    await chat.load('life');
    expect(chat.verbose).toBe(true);
    expect(chat.stopOnExit).toBe(true);
  });

  it('leaves out tool calls and tool results', async () => {
    const chat = openaiChat();
    chat.history = [
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search' } }] },
      { role: 'tool', content: 'sunny' },
      { role: 'assistant', content: "It's sunny." }
    ];
    await chat.save('tools');
    expect(readSession('tools').messages).toEqual([
      { role: 'user', content: 'weather?' }, { role: 'assistant', content: "It's sunny." }
    ]);
  });

  it('renames a session that only has an autosave name', async () => {
    fixTime();
    const chat = withHistory(openaiChat(), 'q', 'a');
    await chat.save('');
    await chat.save('report');
    expect(sessionFiles()).toEqual(['report.Modelfile']);
    expect(output()).toContain("Renamed session 'chat-2026-09-30-154907' to 'report'");
  });

  it('copies a named session, leaving the old file alone', async () => {
    const chat = withHistory(openaiChat(), 'q', 'a');
    await chat.save('report');
    chat.history.push({ role: 'user', content: 'more' });
    await chat.save('report2');
    expect(sessionFiles()).toEqual(['report.Modelfile', 'report2.Modelfile']);
    expect(readSession('report').messages).toHaveLength(2);
    expect(readSession('report2').messages).toHaveLength(3);
    expect(output()).toContain("'report' is unchanged; from now on this session saves as 'report2'.");
    expect(chat.sessionName).toBe('report2');
  });

  it('asks before overwriting a different session, and respects no', async () => {
    await withHistory(openaiChat(), 'original').save('report');
    const chat = withHistory(openaiChat(), 'new');
    chat.confirm = vi.fn(async () => false);
    await chat.save('report');
    expect(chat.confirm).toHaveBeenCalledWith(expect.stringContaining("A saved session named 'report' already exists. Overwrite it?"));
    expect(readSession('report').messages[0].content).toBe('original');
    expect(output()).toContain('Not saved.');

    chat.confirm = vi.fn(async () => true);
    await chat.save('report');
    expect(readSession('report').messages[0].content).toBe('new');
  });

  it("doesn't ask when saving over the session's own file", async () => {
    const chat = withHistory(openaiChat(), 'q');
    chat.confirm = vi.fn(async () => true);
    await chat.save('mine');
    await chat.save('mine');
    await chat.save('');
    expect(chat.confirm).not.toHaveBeenCalled();
  });
});

describe('autosave', () => {
  it('saves after each reply, announcing the name once', async () => {
    fixTime();
    const chat = openaiChat({ autosave: true });
    await chat.chat('hello');
    await chat.chat('again');
    expect(sessionFiles()).toEqual(['chat-2026-09-30-154907.Modelfile']);
    expect(readSession('chat-2026-09-30-154907').messages.map((m) => m.content)).toEqual([
      'hello', 'You said: **hello**', 'again', 'You said: **again**'
    ]);
    expect(output().match(/Autosaving as/g)).toHaveLength(1);
  });

  it('starts a new file after /clear, even within the same second', async () => {
    fixTime();
    const chat = openaiChat({ autosave: true });
    await chat.chat('x');
    await chat.handleCommand('/clear');
    await chat.chat('y');
    expect(sessionFiles()).toEqual(['chat-2026-09-30-154907-2.Modelfile', 'chat-2026-09-30-154907.Modelfile']);
    expect(readSession('chat-2026-09-30-154907-2').messages[0].content).toBe('y');
  });

  it('follows the session to its new name after /save', async () => {
    const chat = openaiChat({ autosave: true });
    await chat.chat('one');
    await chat.save('named');
    await chat.chat('two');
    expect(sessionFiles()).toEqual(['named.Modelfile']);
    expect(readSession('named').messages).toHaveLength(4);
  });

  it('saves right away when turned on mid-conversation', async () => {
    const chat = openaiChat();
    await chat.chat('before');
    expect(sessionFiles()).toEqual([]);
    await chat.handleCommand('/set autosave');
    expect(sessionFiles()).toHaveLength(1);
  });

  it("doesn't save an empty conversation", async () => {
    const chat = openaiChat({ autosave: true });
    await chat.autosaveSession();
    expect(sessionFiles()).toEqual([]);
  });
});

describe('/load', () => {
  it('restores a saved session: model, system message, parameters, and conversation', async () => {
    const saved = openaiChat();
    saved.model = 'other-model';
    saved.setSystemMessage('Be terse.');
    saved.setParameter('temperature', ['0.2']);
    saved.setParameter('stop', ['User:']);
    saved.history.push({ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' });
    await saved.save('trip');

    const chat = openaiChat({ autosave: true });
    await chat.load('trip');
    expect(chat.model).toBe('other-model');
    expect(chat.getSystemMessage()).toBe('Be terse.');
    expect(chat.options).toEqual({ temperature: 0.2, stop: ['User:'] });
    expect(chat.history.slice(1)).toEqual([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);
    expect(output()).toContain("Restored saved session 'trip' (model: other-model)");

    await chat.chat('next'); // autosave keeps updating the loaded session
    expect(readSession('trip').messages).toHaveLength(4);
  });

  it('prefers a saved session over a server model of the same name', async () => {
    await withHistory(openaiChat(), 'saved').save('llama');
    const chat = new skinnyai.OllamaChat('m', { host: server.url });
    await chat.load('llama');
    expect(chat.history[0].content).toBe('saved');
  });

  it('switches models and starts fresh on an OpenAI server when nothing is saved', async () => {
    const chat = withHistory(openaiChat(), 'old');
    chat.sessionName = 'old-session';
    await chat.load('fresh-model');
    expect(chat.model).toBe('fresh-model');
    expect(chat.history).toEqual([]);
    expect(chat.sessionName).toBeNull();
  });

  it('resumes a saved session named on the command line at startup', async () => {
    await withHistory(openaiChat(), 'q', 'a').save('resume-me');
    const chat = new skinnyai.OllamaChat('resume-me', { api: 'openai', host: server.url });
    await chat.loadModelContext();
    expect(chat.model).toBe('some-model');
    expect(chat.sessionName).toBe('resume-me');
    expect(chat.history).toHaveLength(2);
  });
});

describe('/list', () => {
  it('lists saved sessions below the server models', async () => {
    await withHistory(openaiChat(), 'q').save('saved-one');
    await openaiChat().list();
    expect(output()).toMatch(/Saved sessions \(.*\):\n {2}saved-one/);
  });
});

describe('/share', () => {
  it('is refused for OpenAI-compatible servers, without contacting them', async () => {
    const chat = withHistory(openaiChat(), 'q');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await chat.share('x');
    expect(output()).toContain("/share needs an Ollama server; OpenAI-compatible servers can't store sessions.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is refused for ollama.com, without contacting it', async () => {
    const chat = withHistory(new skinnyai.OllamaChat('m', { host: 'https://ollama.com' }), 'q');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await chat.share('x');
    expect(output()).toContain("ollama.com doesn't accept shared sessions");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports an error when the server can't create models", async () => {
    await withHistory(new skinnyai.OllamaChat('m', { host: server.url }), 'q').share('nope');
    expect(output()).toContain('❌ Error sharing session: API error: 404 Not Found');
  });

  describe('with a server that can create models', () => {
    let creator;
    beforeEach(async () => {
      creator = await startMockServer({ canCreate: true, models: ['taken'] });
    });
    afterEach(() => creator.close());

    it('creates a model from the session', async () => {
      const chat = new skinnyai.OllamaChat('base', { host: creator.url });
      chat.setSystemMessage('sys');
      chat.setParameter('temperature', ['0.5']);
      chat.history.push({ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'tool', content: 'x' });
      await chat.share('mine');
      expect(creator.created).toEqual([{
        model: 'mine', from: 'base', stream: false, system: 'sys',
        messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
        parameters: { temperature: 0.5 }
      }]);
      expect(output()).toContain(`Shared session as model 'mine' on ${creator.url}`);
    });

    it('defaults to the session name', async () => {
      const chat = withHistory(new skinnyai.OllamaChat('base', { host: creator.url }), 'q');
      chat.sessionName = 'my-session';
      await chat.share('');
      expect(creator.created[0].model).toBe('my-session');
    });

    it('asks before replacing an existing model', async () => {
      const chat = withHistory(new skinnyai.OllamaChat('base', { host: creator.url }), 'q');
      chat.confirm = vi.fn(async () => false);
      await chat.share('taken');
      expect(chat.confirm).toHaveBeenCalledWith(expect.stringContaining("A model named 'taken' already exists"));
      expect(creator.created).toEqual([]);
      expect(output()).toContain('Not shared.');

      chat.confirm = vi.fn(async () => true);
      await chat.share('taken');
      expect(creator.created).toHaveLength(1);
    });
  });
});

describe('/show settings', () => {
  it('lists the current state of every setting', async () => {
    const chat = openaiChat({ tools: true, autosave: true });
    chat.setSystemMessage('be terse');
    chat.setParameter('temperature', ['0.3']);
    await chat.handleCommand('/set think high');
    await chat.handleCommand('/set nomarkdown');
    capture.stop();
    capture = captureOutput();
    await chat.handleCommand('/show settings');
    const text = output();
    expect(text).toMatch(/model +some-model/);
    expect(text).toMatch(/api +openai-compatible/);
    expect(text).toMatch(/system message +set, 8 characters/);
    expect(text).toMatch(/parameters +temperature=0\.3/);
    expect(text).toMatch(/think +high/);
    expect(text).toMatch(/tools +on \(web_search, fetch_page; DuckDuckGo\)/);
    expect(text).toMatch(/date +on \(automatic: follows tools\)/);
    expect(text).toMatch(/markdown +off/);
    expect(text).toMatch(/autosave +on \(named after the next reply\)/);
    expect(text).toMatch(/defaults file +none/);
  });
});
