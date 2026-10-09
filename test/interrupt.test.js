// Ctrl+C while a reply streams stops the reply, not the chat.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../src/skinnyai.js', import.meta.url));
let server;
let port;
const open = new Set();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    open.add(res);
    req.resume();
    if (req.url === '/api/chat') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'partial words' }, done: false })}\n`); // then hangs
    } else {
      res.writeHead(404).end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
afterAll(() => {
  for (const res of open) res.destroy();
  server.close();
});

it('keeps the chat alive and says it was interrupted', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyai-int-'));
  const child = spawn(process.execPath, [SCRIPT, 'm', '--host', `http://127.0.0.1:${port}`, '--no-tools'], {
    env: { ...process.env, SKINNY_HOME: home }
  });
  let out = '';
  child.stdout.on('data', (chunk) => (out += chunk));
  const waitFor = async (text) => {
    for (let i = 0; i < 100 && !out.includes(text); i++) await new Promise((r) => setTimeout(r, 50));
    expect(out).toContain(text);
  };
  child.stdin.write('hello\n');
  await waitFor('partial words');
  child.kill('SIGINT');
  await waitFor('Interrupted');
  child.stdin.end('/exit\n');
  const code = await new Promise((resolve) => child.on('close', resolve));
  expect(code).toBe(0);
  expect(out).toContain('what arrived is kept');
  expect(out).toContain('Goodbye');
});
