// Smoke test for the standalone binary from `npm run build:sea`. Skipped
// unless it has been built (build/skinnyai, or SKINNYAI_BINARY).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './helpers/mock-server.js';

const binary = process.env.SKINNYAI_BINARY || fileURLToPath(new URL('../build/skinnyai', import.meta.url));
let server;

beforeAll(async () => { server = await startMockServer(); });
afterAll(() => server.close());

describe.skipIf(!fs.existsSync(binary))('standalone binary', () => {
  function run(args, input, env = {}) {
    return new Promise((resolve) => {
      const child = spawn(binary, args, { env: { ...process.env, ...env } });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.on('close', (code) => resolve({ stdout, code }));
      child.stdin.end(input);
    });
  }

  it('chats using defaults from $SKINNY_HOME/config.json', async () => {
    const home = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'skinnyai-sea-'));
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ profiles: { Default: { env: { SKINNY_MODEL: 'm', SKINNY_API: 'openai', SKINNY_HOST: server.url } } } }));
    const { stdout, code } = await run([], 'hello\n', { SKINNY_HOME: home });
    expect(code).toBe(0);
    expect(stdout).toContain('You said: **hello**');
  });

  it('passes command-line arguments through', async () => {
    const { stdout } = await run(['--help'], '');
    expect(stdout).toContain('Usage: skinnyai.js');
  });
});
