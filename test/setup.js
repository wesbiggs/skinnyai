// Runs before each test file: keeps the tests away from the real
// ~/.skinny (its .env and saved sessions) and from any real API key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SKINNY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyai-test-'));
for (const name of Object.keys(process.env)) {
  if (name.startsWith('SKINNY_') && name !== 'SKINNY_HOME') delete process.env[name];
}
delete process.env.OLLAMA_API_KEY;
delete process.env.TMUX;
