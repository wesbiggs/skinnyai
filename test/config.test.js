import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let skinnyai;

beforeAll(async () => {
  skinnyai = await import('../src/skinnyai.js');
});

describe('Modelfile format', () => {
  const session = {
    from: 'gpt-oss:120b-cloud',
    system: 'Be terse.\nUse "quotes" and ```code```.',
    parameters: { temperature: 0.3, stop: ['<|im_end|>', 'User: '] },
    messages: [
      { role: 'user', content: 'He said """hi""" then "bye"' },
      { role: 'assistant', content: 'Line one\n\n    indented\nends with quote"' },
      { role: 'user', content: '"' },
      { role: 'assistant', content: 'x""' },
      { role: 'user', content: 'backslash \\ path C:\\dir' },
      { role: 'assistant', content: '' }
    ]
  };

  it('writes FROM, PARAMETER, SYSTEM, and MESSAGE lines', () => {
    const lines = skinnyai.formatModelfile(session).split('\n');
    expect(lines[0]).toMatch(/^# Saved by skinnyai on \d{4}-/);
    expect(lines.slice(1, 6)).toEqual([
      'FROM gpt-oss:120b-cloud',
      'PARAMETER temperature 0.3',
      'PARAMETER stop <|im_end|>',
      'PARAMETER stop "User: "',
      'SYSTEM """Be terse.'
    ]);
    expect(lines).toContain('MESSAGE user """He said ""\\"hi""\\" then "bye""""');
  });

  it('records the host and other settings as comments that parse ignores', () => {
    const withSettings = { ...session, settings: { api: 'openai', host: 'http://box:8080', think: undefined, markdown: true } };
    const text = skinnyai.formatModelfile(withSettings);
    expect(text).toContain('# api: openai\n# host: http://box:8080\n# markdown: true\nFROM ');
    expect(text).not.toContain('think');
    const back = skinnyai.parseModelfile(text);
    expect(back.settings).toEqual({ api: 'openai', host: 'http://box:8080', markdown: 'true' });
    expect(back.messages).toEqual(session.messages);
  });

  it('reads back exactly what it wrote, including awkward quoting', () => {
    const back = skinnyai.parseModelfile(skinnyai.formatModelfile(session));
    expect(back.from).toBe(session.from);
    expect(back.system).toBe(session.system);
    expect(back.messages).toEqual(session.messages);
    expect(back.parameters).toEqual([['temperature', '0.3'], ['stop', '<|im_end|>'], ['stop', 'User: ']]);
  });

  it('reads hand-written Modelfiles: comments, single-line values, lowercase instructions', () => {
    const back = skinnyai.parseModelfile([
      '# a comment',
      'from llama3.2',
      'SYSTEM "You are a pirate."',
      'TEMPLATE """{{ .Prompt }}"""',
      'MESSAGE user Ahoy',
      'MESSAGE assistant """Arr."""'
    ].join('\n'));
    expect(back).toEqual({
      from: 'llama3.2',
      system: 'You are a pirate.',
      settings: {},
      parameters: [],
      messages: [{ role: 'user', content: 'Ahoy' }, { role: 'assistant', content: 'Arr.' }]
    });
  });
});

describe('environment defaults', () => {
  const touched = [];
  const setEnv = (name, value) => {
    touched.push(name);
    process.env[name] = value;
  };

  afterEach(() => {
    for (const name of Object.keys(process.env)) if (name.startsWith('SKINNY_') && name !== 'SKINNY_HOME') delete process.env[name];
    delete process.env.OLLAMA_API_KEY;
    vi.restoreAllMocks();
  });

  it('turns SKINNY_* variables into options', () => {
    setEnv('SKINNY_MODEL', 'm');
    setEnv('SKINNY_TOOLS', 'on');
    setEnv('SKINNY_MARKDOWN', '0');
    setEnv('SKINNY_HIDE_THINKING', 'TRUE');
    setEnv('SKINNY_USER_ITALIC_COLOR', 'cyan');
    setEnv('SKINNY_DATE', '');
    expect(skinnyai.envOptions()).toEqual({ model: 'm', tools: true, markdown: false, hideThinking: true, userEmphasisColor: 'cyan' });
  });

  it('exits with an error for a bad on/off value', () => {
    setEnv('SKINNY_IMAGES', 'maybe');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => skinnyai.envOptions()).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls[0][0]).toContain("SKINNY_IMAGES must be true or false (got 'maybe')");
  });
});

describe('config.json', () => {
  const write = (config) => {
    const file = path.join(process.env.SKINNY_HOME, `config-${Math.random()}.json`);
    fs.writeFileSync(file, JSON.stringify(config));
    return file;
  };

  it('returns null when there is no file, and rejects a malformed one', () => {
    expect(skinnyai.loadConfigFile(path.join(process.env.SKINNY_HOME, 'nope.json'))).toBeNull();
    expect(() => skinnyai.loadConfigFile(write({ nope: 1 }))).toThrow('no "profiles" object');
  });

  it('resolves a profile, stringifying values', () => {
    const config = skinnyai.loadConfigFile(write({
      profiles: {
        Main: { env: { A: 'a', B: true, C: 3, D: null }, mcpServers: { x: { command: 'x' } } },
        Work: { env: { A: 'w' } }
      }
    }));
    expect(skinnyai.resolveProfile(config)).toEqual({ name: 'Main', env: { A: 'a', B: 'true', C: '3' }, mcpServers: { x: { command: 'x' } } });
    expect(skinnyai.resolveProfile(config, 'work')).toEqual({ name: 'Work', env: { A: 'w' }, mcpServers: {} });
    expect(() => skinnyai.resolveProfile(config, 'Nope')).toThrow("no profile named 'Nope'");
  });

  it('uses the top-level "defaultProfile", with profiles standing alone', () => {
    const config = skinnyai.loadConfigFile(write({
      defaultProfile: 'work',
      profiles: {
        Default: { env: { A: 'a', B: 'b' } },
        Work: { env: { A: 'w' }, mcpServers: { x: { command: 'x' } } }
      }
    }));
    expect(skinnyai.resolveProfile(config)).toEqual({ name: 'Work', env: { A: 'w' }, mcpServers: { x: { command: 'x' } } });
    expect(skinnyai.resolveProfile(config, 'Default').env).toEqual({ A: 'a', B: 'b' });
    expect(() => skinnyai.resolveProfile({ ...config, defaultProfile: 'Gone' })).toThrow('"defaultProfile" is \'Gone\'');
  });

  it('puts the "shared" block under every profile', () => {
    const config = skinnyai.loadConfigFile(write({
      shared: { env: { A: 'a', B: 'b' }, mcpServers: { x: { command: 'x' }, y: { command: 'y' } } },
      profiles: { Work: { env: { A: 'w' }, mcpServers: { y: { disabled: true } } }, Bare: {} }
    }));
    expect(skinnyai.resolveProfile(config, 'Work')).toEqual({
      name: 'Work', env: { A: 'w', B: 'b' }, mcpServers: { x: { command: 'x' }, y: { disabled: true } }
    });
    expect(skinnyai.resolveProfile(config, 'Bare').env).toEqual({ A: 'a', B: 'b' });
  });

  it('falls back to the first profile when there is no defaultProfile', () => {
    const config = skinnyai.loadConfigFile(write({ profiles: { One: { env: { A: '1' } }, Two: { env: {} } } }));
    expect(skinnyai.resolveProfile(config).name).toBe('One');
  });

  it('reads --profile and SKINNY_PROFILE', () => {
    expect(skinnyai.requestedProfile(['m', '--profile', 'A B'], {})).toBe('A B');
    expect(skinnyai.requestedProfile(['--profile=Z'], { SKINNY_PROFILE: 'E' })).toBe('Z');
    expect(skinnyai.requestedProfile([], { SKINNY_PROFILE: 'E' })).toBe('E');
    expect(skinnyai.requestedProfile([], {})).toBeUndefined();
  });

  it('ships a config.json.example whose profiles all resolve', () => {
    const config = skinnyai.loadConfigFile(new URL('../config.json.example', import.meta.url).pathname);
    expect(Object.keys(config.profiles)).toContain(config.defaultProfile);
    for (const name of Object.keys(config.profiles)) expect(skinnyai.resolveProfile(config, name).env.SKINNY_MODEL).toBeTruthy();
  });
});

describe('command-line arguments', () => {
  const parse = (...args) => {
    const argv = process.argv;
    process.argv = ['node', 'skinnyai.js', ...args];
    try {
      return skinnyai.parseArgs();
    } finally {
      process.argv = argv;
    }
  };

  afterEach(() => {
    for (const name of Object.keys(process.env)) if (name.startsWith('SKINNY_') && name !== 'SKINNY_HOME') delete process.env[name];
  });

  it('skips --profile and its value instead of taking it for the model', () => {
    expect(parse('--profile', 'My Profile', 'llama3.2').model).toBe('llama3.2');
    expect(parse('--profile=X', '--model', 'q').model).toBe('q');
  });

  it('reads the model from the first positional argument or --model', () => {
    expect(parse('llama3.2').model).toBe('llama3.2');
    expect(parse('--model', 'qwen3', '--tools').model).toBe('qwen3');
  });

  it('falls back to SKINNY_MODEL', () => {
    process.env.SKINNY_MODEL = 'from-env';
    expect(parse().model).toBe('from-env');
    expect(parse('from-cli').model).toBe('from-cli');
  });

  it('lets flags override environment defaults in both directions', () => {
    process.env.SKINNY_TOOLS = 'true';
    process.env.SKINNY_AUTOSAVE = 'false';
    process.env.SKINNY_HOST = 'http://env:1';
    const { options } = parse('m', '--no-tools', '--autosave', '--host', 'http://cli:2');
    expect(options).toMatchObject({ tools: false, autosave: true, host: 'http://cli:2' });
  });

  it('has a negative form for every on/off flag', () => {
    const { options } = parse('m', '--no-tools', '--no-date', '--no-markdown', '--no-images', '--no-autosave',
      '--show-thinking', '--no-stop-on-exit');
    expect(options).toEqual({ tools: false, date: false, markdown: false, images: false, autosave: false,
      hideThinking: false, stopOnExit: false });
  });

  it('accepts both the italic and the older emphasis color flags', () => {
    expect(parse('m', '--user-italic-color', 'red', '--model-emphasis-color', 'blue').options)
      .toEqual({ userEmphasisColor: 'red', modelEmphasisColor: 'blue' });
  });
});

describe('sessions on disk', () => {
  it('recognizes autosave names', () => {
    expect(skinnyai.isAutosaveName('chat-2026-09-30-154907')).toBe(true);
    expect(skinnyai.isAutosaveName('chat-2026-09-30-154907-3')).toBe(true);
    expect(skinnyai.isAutosaveName('chat-report')).toBe(false);
    expect(skinnyai.isAutosaveName('report')).toBe(false);
  });

  it('names autosaves from the date and time, adding a suffix when taken', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 30, 15, 49, 7));
    try {
      expect(await skinnyai.autosaveName()).toBe('chat-2026-09-30-154907');
      await skinnyai.saveLocalSession('chat-2026-09-30-154907', { from: 'm', system: '', parameters: {}, messages: [] });
      expect(await skinnyai.autosaveName()).toBe('chat-2026-09-30-154907-2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stores names with any characters as safe filenames', async () => {
    const file = await skinnyai.saveLocalSession('me/chat:v2', { from: 'm', system: '', parameters: {}, messages: [] });
    expect(path.basename(file)).toBe('me%2Fchat%3Av2.skinny');
    expect(await skinnyai.listLocalSessions()).toContain('me/chat:v2');
    expect((await skinnyai.readLocalSession('me/chat:v2')).from).toBe('m');
    expect(await skinnyai.readLocalSession('missing')).toBeNull();
  });

  it('keeps spaces in filenames, and still finds files saved with %20', async () => {
    const session = { from: 'm', system: '', parameters: {}, messages: [] };
    const file = await skinnyai.saveLocalSession('My Memos', session);
    expect(path.basename(file)).toBe('My Memos.skinny');
    expect(await skinnyai.listLocalSessions()).toContain('My Memos');
    // An earlier version saved Modelfiles with %20 for spaces.
    fs.rmSync(file);
    fs.writeFileSync(path.join(path.dirname(file), 'My%20Memos.Modelfile'), skinnyai.formatModelfile({ ...session, from: 'old', parameters: {} }));
    expect((await skinnyai.readLocalSession('My Memos')).from).toBe('old');
    expect((await skinnyai.listLocalSessions()).filter((n) => n === 'My Memos')).toHaveLength(1);
  });

  it('words how to resume a session by how the program was started', () => {
    expect(skinnyai.resumeHint('trip', { termProgram: 'SkinnyAI', script: '/x/skinnyai-cli' })).toBe('use File > Open Chat...');
    expect(skinnyai.resumeHint('trip', { termProgram: 'iTerm.app', script: '/home/me/.local/bin/skinnyai' })).toBe('start with: skinnyai trip');
    expect(skinnyai.resumeHint('My Memos', { termProgram: undefined, script: '/a/skinnyai.js' })).toBe("start with: skinnyai.js 'My Memos'");
  });

  it('recognizes ollama.com hosts', () => {
    expect(skinnyai.isOllamaCom('https://ollama.com')).toBe(true);
    expect(skinnyai.isOllamaCom('https://api.ollama.com/x')).toBe(true);
    expect(skinnyai.isOllamaCom('http://localhost:11434')).toBe(false);
    expect(skinnyai.isOllamaCom('https://notollama.com')).toBe(false);
  });
});
