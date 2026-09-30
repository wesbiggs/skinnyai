import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let skinnyai;

beforeAll(async () => {
  skinnyai = await import('../bin/skinnyai.js');
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
      parameters: [],
      messages: [{ role: 'user', content: 'Ahoy' }, { role: 'assistant', content: 'Arr.' }]
    });
  });
});

describe('.env defaults', () => {
  const touched = [];
  const writeEnv = (text) => {
    const file = path.join(process.env.SKINNY_HOME, `test-${touched.length}.env`);
    fs.writeFileSync(file, text);
    return file;
  };
  const setEnv = (name, value) => {
    touched.push(name);
    process.env[name] = value;
  };

  afterEach(() => {
    for (const name of Object.keys(process.env)) if (name.startsWith('SKINNY_') && name !== 'SKINNY_HOME') delete process.env[name];
    delete process.env.OLLAMA_API_KEY;
    vi.restoreAllMocks();
  });

  it('parses KEY=value lines: export, quotes, comments, and bare # colors', () => {
    const file = writeEnv([
      '# comment',
      'SKINNY_MODEL=envmodel',
      'export SKINNY_HOST="http://127.0.0.1:1234"',
      "SKINNY_API='openai'",
      'SKINNY_AUTOSAVE=yes   # trailing comment',
      'SKINNY_MODEL_NORMAL_COLOR=#ff8800',
      'OLLAMA_API_KEY="abc\\"def"',
      'not a setting'
    ].join('\n'));
    expect(skinnyai.loadEnvFile(file)).toBe(true);
    expect(process.env.SKINNY_MODEL).toBe('envmodel');
    expect(process.env.SKINNY_HOST).toBe('http://127.0.0.1:1234');
    expect(process.env.SKINNY_API).toBe('openai');
    expect(process.env.SKINNY_AUTOSAVE).toBe('yes');
    expect(process.env.SKINNY_MODEL_NORMAL_COLOR).toBe('#ff8800');
    expect(process.env.OLLAMA_API_KEY).toBe('abc"def');
  });

  it("doesn't override variables already in the environment", () => {
    setEnv('SKINNY_TOOLS', 'false');
    skinnyai.loadEnvFile(writeEnv('SKINNY_TOOLS=true\n'));
    expect(process.env.SKINNY_TOOLS).toBe('false');
  });

  it('returns false for a missing file', () => {
    expect(skinnyai.loadEnvFile(path.join(process.env.SKINNY_HOME, 'nope.env'))).toBe(false);
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
    expect(path.basename(file)).toBe('me%2Fchat%3Av2.Modelfile');
    expect(await skinnyai.listLocalSessions()).toContain('me/chat:v2');
    expect((await skinnyai.readLocalSession('me/chat:v2')).from).toBe('m');
    expect(await skinnyai.readLocalSession('missing')).toBeNull();
  });

  it('recognizes ollama.com hosts', () => {
    expect(skinnyai.isOllamaCom('https://ollama.com')).toBe(true);
    expect(skinnyai.isOllamaCom('https://api.ollama.com/x')).toBe(true);
    expect(skinnyai.isOllamaCom('http://localhost:11434')).toBe(false);
    expect(skinnyai.isOllamaCom('https://notollama.com')).toBe(false);
  });
});
