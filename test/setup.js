// Runs before each test file: keeps the tests away from the real
// ~/.thinai (its .env and saved sessions) and from any real API key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.THINAI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'thinai-test-'));
for (const name of Object.keys(process.env)) {
  if (name.startsWith('THINAI_') && name !== 'THINAI_HOME') delete process.env[name];
}
delete process.env.OLLAMA_API_KEY;
delete process.env.TMUX;
