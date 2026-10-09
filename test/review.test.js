// Regressions found in a code review.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../src/skinnyai.js', import.meta.url));
let skinnyai;
beforeAll(async () => {
  skinnyai = await import('./helpers/skinny.js');
});

describe('command line', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', input: '', env: { ...process.env, SKINNY_HOME: fs.mkdtempSync('/tmp/skinny-cli-') } });

  it('rejects an unknown option instead of taking its value for the model', () => {
    const result = run('--keepalive', '30m');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown option --keepalive');
  });

  it('rejects a flag that is missing its value', () => {
    const result = run('llama3', '--host');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--host needs a value');
  });

  it('rejects a second positional argument', () => {
    expect(run('a', 'b').stderr).toContain("unexpected argument 'b'");
  });
});

describe('sessions', () => {
  it('lists the rest when one file name is not a name skinnyai wrote', async () => {
    const dir = skinnyai.SESSION_DIR;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fine.skinny'), '');
    fs.writeFileSync(path.join(dir, '100%.skinny'), '');
    expect(await skinnyai.listLocalSessions()).toContain('fine');
  });
});

describe('Anthropic requests', () => {
  it('leave out an assistant message with nothing in it', () => {
    const chat = new skinnyai.OllamaChat('x', { api: 'anthropic', tools: false });
    chat.history = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '' }, { role: 'user', content: 'again' }];
    const { messages } = chat.buildAnthropicChatBody();
    expect(messages.every((m) => m.content.length > 0)).toBe(true);
    expect(messages).toHaveLength(1); // the two user turns merge
  });
});

describe('MCP servers', () => {
  it('start without the API keys in the environment', async () => {
    const { serverEnv } = await import('../src/mcp.js');
    const env = serverEnv({ PATH: '/bin', HOME: '/h', LC_ALL: 'C', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', OLLAMA_API_KEY: 'k', GITHUB_TOKEN: 't' });
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LC_ALL', 'PATH']);
  });
});

describe('fetching pages', () => {
  it('checks the address it is about to connect to, not only the one it looked up before', async () => {
    const { guardedLookup, isPrivateAddress } = await import('../src/tools.js');
    const error = await new Promise((resolve) => guardedLookup('localhost', {}, (err) => resolve(err)));
    expect(error?.message).toContain('local or private network address');
    for (const ip of ['224.0.0.1', '255.255.255.255', 'ff02::1', '2002:7f00:1::1', '64:ff9b::7f00:1', '::ffff:127.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
  });

  it('reads a compressed page and follows a redirect to it', async () => {
    const { fetchPublic, readCapped } = await import('../src/tools.js');
    const server = http.createServer((req, res) => {
      if (req.url === '/old') return res.writeHead(302, { Location: '/new' }).end();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Encoding': 'gzip' });
      res.end(zlib.gzipSync('squeezed ünïcode'));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.SKINNY_TRUSTED_HOSTS = '127.0.0.1';
    try {
      const { res } = await fetchPublic(new URL(`http://127.0.0.1:${server.address().port}/old`), 'text/plain');
      expect(await readCapped(res)).toBe('squeezed ünïcode');
    } finally {
      delete process.env.SKINNY_TRUSTED_HOSTS;
      server.close();
    }
  });
});
