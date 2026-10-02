// End-to-end: runs skinnyai.js as a real process with piped input, against
// the mock server. Output isn't a terminal here, so markdown stays raw.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockServer } from './helpers/mock-server.js';

const SCRIPT = fileURLToPath(new URL('../bin/skinnyai.js', import.meta.url));
let server;
let home;

beforeAll(async () => {
  server = await startMockServer({ replies: { md: '# Title\n\n**bold** and a table:\n\n| a | b |\n|---|---|\n| 1 | 2 |' } });
});

afterAll(() => server.close());

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyai-cli-'));
  server.requests.length = 0;
});

function run(args, input = '', { env = {}, script = SCRIPT } = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env, SKINNY_HOME: home, SKINNY_TOOLS: 'false', ...env };
    for (const name of Object.keys(childEnv)) if (childEnv[name] === null) delete childEnv[name];
    const child = spawn(process.execPath, [script, ...args], { env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

const openai = () => ['--api', 'openai', '--host', server.url];
const chatRequests = () => server.requests.filter((r) => r.url === '/v1/chat/completions');
// The transcript after the welcome box.
const transcript = (stdout) => stdout.split(/└─+┘\n\n/)[1];

describe('piped input', () => {
  it('answers every line, echoing each after the prompt', async () => {
    const { stdout, code } = await run(['m', ...openai()], 'hello\nsecond line\n');
    expect(code).toBe(0);
    expect(transcript(stdout)).toBe(
      '> hello\n\nYou said: **hello**\n\n> second line\n\nYou said: **second line**\n\n> \n👋 Goodbye!\n\n'
    );
    expect(chatRequests().map((r) => r.body.messages.at(-1).content)).toEqual(['hello', 'second line']);
  });

  it('keeps the conversation history across turns', async () => {
    await run(['m', ...openai()], 'one\ntwo\n');
    expect(chatRequests()[1].body.messages.map((m) => m.content)).toEqual(['one', 'You said: **one**', 'two']);
  });

  it('writes markdown raw when output is redirected', async () => {
    const { stdout } = await run(['m', ...openai()], 'md\n');
    expect(stdout).toContain('# Title\n\n**bold** and a table:\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(stdout).not.toContain('\x1b[');
  });

  it('reads answers to confirmation prompts from the next line', async () => {
    const { stdout } = await run(['m', ...openai()], 'hi\n/save report\n/clear\nbye\n/save report\nn\n/save report\ny\n');
    expect(stdout).toContain("A saved session named 'report' already exists. Overwrite it? [y/N] n\nNot saved.");
    expect(stdout).toContain("Overwrite it? [y/N] y\n\n✅ Saved session 'report'");
    expect(fs.readFileSync(path.join(home, 'sessions', 'report.Modelfile'), 'utf8')).toContain('MESSAGE user """bye"""');
  });
});

describe('saved sessions', () => {
  it('resumes a session named on the command line, with its model and history', async () => {
    await run(['some-model', ...openai()], '/set system You are terse.\nfirst\n/save demo\n');
    server.requests.length = 0;
    const { stdout } = await run(['demo', ...openai()], 'second\n');
    expect(stdout).toContain("📜 Restored saved session 'demo' (model: some-model):");
    const request = chatRequests()[0].body;
    expect(request.model).toBe('some-model');
    expect(request.messages.map((m) => m.content)).toEqual(['You are terse.', 'first', 'You said: **first**', 'second']);
  });

  it('autosaves after each reply with --autosave', async () => {
    await run(['m', ...openai(), '--autosave'], 'hello\nagain\n');
    const [file] = fs.readdirSync(path.join(home, 'sessions'));
    expect(file).toMatch(/^chat-\d{4}-\d{2}-\d{2}-\d{6}\.Modelfile$/);
    expect(fs.readFileSync(path.join(home, 'sessions', file), 'utf8').match(/^MESSAGE/gm)).toHaveLength(4);
  });
});

describe('defaults from config.json', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      profiles: { Default: { env: {
        SKINNY_MODEL: 'envmodel', SKINNY_API: 'openai', SKINNY_HOST: server.url, SKINNY_AUTOSAVE: 'yes', SKINNY_TOOLS: true
      } } }
    }));
  });

  it('uses the file for anything not given on the command line', async () => {
    const { stdout } = await run([], 'hello\n/show settings\n', { env: { SKINNY_TOOLS: null } });
    expect(chatRequests()[0].body.model).toBe('envmodel');
    expect(stdout).toMatch(/tools +on/);
    expect(stdout).toMatch(/autosave +on \('chat-/);
    expect(stdout).toContain(`defaults file    ${path.join(home, 'config.json')}`);
    expect(fs.readdirSync(path.join(home, 'sessions'))).toHaveLength(1);
  });

  it('lets environment variables override the file, and flags override both', async () => {
    const { stdout } = await run(['climodel', '--no-autosave'], '/show settings\n', { env: { SKINNY_TOOLS: 'false' } });
    expect(stdout).toMatch(/model +climodel/);
    expect(stdout).toMatch(/tools +off/);
    expect(stdout).toMatch(/autosave +off/);
  });

  it('fails clearly on a bad on/off value', async () => {
    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    config.profiles.Default.env.SKINNY_IMAGES = 'maybe';
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
    const { stderr, code } = await run([]);
    expect(code).toBe(1);
    expect(stderr).toContain("SKINNY_IMAGES must be true or false (got 'maybe')");
  });
});

describe('config.json profiles', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      profiles: {
        Default: { env: { SKINNY_MODEL: 'defmodel', SKINNY_API: 'openai', SKINNY_HOST: server.url, SKINNY_TOOLS: false, SKINNY_MARKDOWN: true } },
        'My Profile': { env: { SKINNY_MODEL: 'other', SKINNY_MARKDOWN: false } }
      }
    }));
  });

  it('uses the Default profile unless told otherwise', async () => {
    const { stdout } = await run([], 'hello\n/show settings\n', { env: { SKINNY_TOOLS: null } });
    expect(chatRequests()[0].body.model).toBe('defmodel');
    expect(stdout).toMatch(/profile +Default/);
    expect(stdout).toContain(`defaults file    ${path.join(home, 'config.json')}`);
  });

  it('selects a profile with --profile or SKINNY_PROFILE, inheriting from Default', async () => {
    const first = await run(['--profile', 'My Profile'], 'hi\n/show settings\n', { env: { SKINNY_TOOLS: null } });
    expect(chatRequests()[0].body.model).toBe('other');
    expect(first.stdout).toMatch(/profile +My Profile/);
    expect(first.stdout).toMatch(/markdown +off/);
    expect(first.stdout).toMatch(/tools +off/); // from Default
    server.requests.length = 0;
    await run([], 'hi\n', { env: { SKINNY_PROFILE: 'my profile', SKINNY_TOOLS: null } });
    expect(chatRequests()[0].body.model).toBe('other');
  });

  it('lets the command line override the profile', async () => {
    await run(['--profile', 'My Profile', 'climodel'], 'hi\n', { env: { SKINNY_TOOLS: null } });
    expect(chatRequests()[0].body.model).toBe('climodel');
  });

  it('fails clearly for an unknown profile', async () => {
    const { stderr, code } = await run(['--profile', 'Nope']);
    expect(code).toBe(1);
    expect(stderr).toContain("no profile named 'Nope' (profiles: Default, My Profile)");
  });
});

describe('startup', () => {
  it('prints usage for --help', async () => {
    const { stdout, code } = await run(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: skinnyai.js [model] [options]');
  });

  it('exits with an error when no model is given', async () => {
    const { stderr, code } = await run([]);
    expect(code).toBe(1);
    expect(stderr).toContain('Model name is required');
  });

  it('runs when started through a symlink, as when installed on the PATH', async () => {
    const link = path.join(home, 'skinnyai');
    fs.symlinkSync(SCRIPT, link);
    const { stdout } = await run(['--help'], '', { script: link });
    expect(stdout).toContain('Usage: skinnyai.js');
  });
});
