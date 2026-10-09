// End-to-end (spawned process, piped input, mock server): the welcome screen,
// keep-alive visibility, /load, image attachments, the Anthropic API, and MCP.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockServer } from './helpers/mock-server.js';

const SCRIPT = fileURLToPath(new URL('../src/skinnyai.js', import.meta.url));
const MCP_SERVER = fileURLToPath(new URL('./helpers/mcp-server.js', import.meta.url));
let server;
let home;

beforeAll(async () => {
  server = await startMockServer({
    models: ['vis', 'text', 'claude-haiku-9', 'claude-opus-4', 'claude-opus-5', 'claude-sonnet-9'],
    modelMeta: {
      'claude-haiku-9': { created_at: '2026-09-01T00:00:00Z' },
      'claude-opus-4': { created_at: '2025-01-01T00:00:00Z' },
      'claude-opus-5': { created_at: '2026-03-01T00:00:00Z' },
      'claude-sonnet-9': { created_at: '2026-06-01T00:00:00Z' }
    },
    capabilities: { vis: ['completion', 'vision'], text: ['completion'] },
    openaiToolCalls: { 'use draw': { name: 'fake__draw', input: {} } },
    anthropicToolCalls: { 'use draw': { name: 'fake__draw', input: {} }, 'use nope': { name: 'generate_image', input: {} }, 'use echo': { name: 'fake__echo', input: { text: 'hi' } }, 'use fail': { name: 'fake__fail', input: {} } }
  });
});
afterAll(() => server.close());
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyai-features-'));
  server.requests.length = 0;
});

function run(args, input = '', env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, SKINNY_HOME: home, SKINNY_TOOLS: 'false', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

const requestsTo = (url) => server.requests.filter((r) => r.url === url);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);

function writeImage(name = 'pic.png') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyai-img-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, png);
  return file;
}

function writeMcpConfig(extra = {}) {
  const mcpServers = { fake: { command: process.execPath, args: [MCP_SERVER], env: { FAKE_PREFIX: '>' }, ...extra } };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ profiles: { Default: { mcpServers } } }));
}

function writeProfileMcpConfig() {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    defaultProfile: 'Default',
    profiles: { Default: { env: {} }, Other: { mcpServers: { fake: { command: process.execPath, args: [MCP_SERVER], env: { FAKE_PREFIX: '>' } } } } }
  }));
}

describe('web tools', () => {
  it('are offered by default, and --no-tools / SKINNY_TOOLS=false turn them off', async () => {
    const env = { SKINNY_TOOLS: '' };
    await run(['m', '--api', 'openai', '--host', server.url], 'hi\n', env);
    expect(requestsTo('/v1/chat/completions').at(0).body.tools.map((t) => t.function.name)).toEqual(['web_search', 'fetch_page']);
    server.requests.length = 0;
    await run(['m', '--api', 'openai', '--host', server.url, '--no-tools'], 'hi\n', env);
    expect(requestsTo('/v1/chat/completions').at(0).body).not.toHaveProperty('tools');
    server.requests.length = 0;
    await run(['m', '--api', 'openai', '--host', server.url], 'hi\n', { SKINNY_TOOLS: 'false' });
    expect(requestsTo('/v1/chat/completions').at(0).body).not.toHaveProperty('tools');
  });
});

describe('welcome box', () => {
  it('names the program and version, boxes the details, and shows MCP under Tools', async () => {
    const { VERSION } = await import('./helpers/skinny.js');
    expect(VERSION).toBe(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    writeMcpConfig();
    const { stdout } = await run(['m', '--api', 'openai', '--host', server.url, '--tools'], '', { SKINNY_TOOLS: 'true' });
    const lines = stdout.split('\n').filter((l) => /^[┌│└]/.test(l));
    expect(lines[0]).toMatch(/^┌─+┐$/);
    expect(lines.at(-1)).toMatch(/^└─+┘$/);
    expect(lines[1]).toContain(`🚀 SkinnyAI v${VERSION}`);
    expect(stdout).not.toContain('Ollama Interactive Chat');
    const body = lines.map((l) => l.replace(/^│ | │$/g, ''));
    const tools = body.findIndex((l) => l.startsWith('🔧 Tools:'));
    expect(body[tools + 1]).toMatch(/^🔌 MCP: fake \(3 tools\)/);
  });

  it('draws a border that lines up around wide characters', async () => {
    const { drawBox, visibleWidth } = await import('./helpers/skinny.js');
    const rows = drawBox(['🚀 title', 'plain', '', '日本語']).split('\n');
    expect(new Set(rows.map(visibleWidth)).size).toBe(1);
    expect(rows[1].startsWith('│ 🚀 title')).toBe(true);
  });
});

describe('welcome screen', () => {
  it('points at /help instead of listing every command', async () => {
    const { stdout } = await run(['vis', '--host', server.url], '');
    expect(stdout).toContain('Type /help for commands');
    expect(stdout).not.toContain('/save [name]');
  });

  it('shows keep-alive for a self-hosted Ollama but not for OpenAI-style servers', async () => {
    expect((await run(['vis', '--host', server.url], '')).stdout).toContain('Keep-alive');
    expect((await run(['vis', '--api', 'openai', '--host', server.url], '')).stdout).not.toContain('Keep-alive');
  });
});

describe('keep-alive and unload', () => {
  it('are left out for ollama.com', async () => {
    const { OllamaChat } = await import('./helpers/skinny.js');
    const cloud = new OllamaChat('m', { host: 'https://ollama.com', stopOnExit: true });
    expect(cloud.buildOllamaChatBody()).not.toHaveProperty('keep_alive');
    expect(cloud.managesModelLifetime).toBe(false);
    const local = new OllamaChat('m', { host: server.url });
    expect(local.buildOllamaChatBody().keep_alive).toBe('1h');
  });

  it('do not show in /model or /show settings there', async () => {
    const { stdout } = await run(['m', '--api', 'openai', '--host', server.url, '--stop-on-exit'], '/model\n/show settings\n');
    expect(stdout).not.toMatch(/keep-alive/i);
    expect(stdout).not.toContain('stop on exit');
    expect(stdout).not.toContain('--stop-on-exit has no equivalent');
  });
});

describe('/load without a name', () => {
  it('shows the same list as /list', async () => {
    const list = (await run(['vis', '--host', server.url], '/list\n')).stdout;
    const load = (await run(['vis', '--host', server.url], '/load\n')).stdout;
    expect(load).toContain('vis');
    expect(load).toContain('text');
    expect(list).toContain('vis');
    expect(load).toContain('Usage: /load');
  });
});

describe('dragging an image into the prompt', () => {
  it('attaches it for Ollama and strips the path from the message', async () => {
    const file = writeImage();
    const { stdout } = await run(['vis', '--host', server.url], `what is this ${file}\n`);
    const message = requestsTo('/api/chat').at(-1).body.messages.at(-1);
    expect(message.content).toBe('what is this');
    expect(message.images).toEqual([png.toString('base64')]);
    expect(stdout).toContain('Attached pic.png');
    expect(stdout).not.toContain('vision');
  });

  it('understands escaped spaces, quotes, and file:// URLs', async () => {
    const file = writeImage('my pic.png');
    for (const form of [file.replace(/ /g, '\\ '), `'${file}'`, `"${file}"`, `file://${file.replace(/ /g, '%20')}`]) {
      server.requests.length = 0;
      await run(['vis', '--host', server.url], `look ${form}\n`);
      const message = requestsTo('/api/chat').at(-1).body.messages.at(-1);
      expect(message, form).toMatchObject({ content: 'look', images: [expect.any(String)] });
    }
  });

  it('warns when the model has no vision capability, but still sends it', async () => {
    const { stdout } = await run(['text', '--host', server.url], `${writeImage()}\n`);
    expect(stdout).toContain("'text' doesn't list vision support");
    expect(requestsTo('/api/chat').at(-1).body.messages.at(-1).images).toHaveLength(1);
  });

  it('leaves paths to non-images and missing files alone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyai-img-'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    const input = `see ${path.join(dir, 'notes.txt')} and /no/such/pic.png`;
    await run(['vis', '--host', server.url], `${input}\n`);
    expect(requestsTo('/api/chat').at(-1).body.messages.at(-1)).toEqual({ role: 'user', content: input });
  });

  it('sends content parts to OpenAI-style servers', async () => {
    await run(['m', '--api', 'openai', '--host', server.url], `hi ${writeImage()}\n`);
    const { content } = requestsTo('/v1/chat/completions').at(-1).body.messages.at(-1);
    expect(content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }
    ]);
  });
});

describe('--model default', () => {
  it('picks the newest Opus for Anthropic', async () => {
    const { stdout } = await run(['default', '--api', 'anthropic', '--host', server.url], 'hi\n', { ANTHROPIC_API_KEY: 'k' });
    expect(stdout).toContain('Model: claude-opus-5 (the default)');
    expect(requestsTo('/v1/messages').at(0).body.model).toBe('claude-opus-5');
  });

  it('is not a thing for Ollama', async () => {
    const { stderr, code } = await run(['default', '--host', server.url], '');
    expect(code).toBe(1);
    expect(stderr).toContain("'default' isn't a model name for Ollama");
  });

  it('chooses the newest plain gpt for OpenAI by release date', async () => {
    const { pickDefaultModel } = await import('./helpers/skinny.js');
    const list = [
      { id: 'gpt-5', created: 100 }, { id: 'gpt-5.1', created: 300 }, { id: 'gpt-5.1-2025-11-13', created: 301 },
      { id: 'gpt-5.2-mini', created: 400 }, { id: 'gpt-5-codex', created: 500 }, { id: 'o3', created: 600 },
      { id: 'text-embedding-3-large', created: 700 }, { id: 'gpt-4o', created: 50 }
    ];
    expect(pickDefaultModel('openai', list)).toBe('gpt-5.1');
    expect(pickDefaultModel('openai', [{ id: 'whisper-1' }])).toBeNull();
    expect(pickDefaultModel('anthropic', [{ id: 'claude-haiku-9', created_at: '2026-01-01T00:00:00Z' }])).toBe('claude-haiku-9');
  });
});

describe('--debug', () => {
  const readLog = () => fs.readFileSync(path.join(home, 'debug.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  it('logs requests with the tools offered, responses, and tool calls, without secrets', async () => {
    writeMcpConfig({ trust: true });
    const env = { ANTHROPIC_API_KEY: 'sk-secret-key' };
    const { stdout } = await run(['claude-x', '--api', 'anthropic', '--host', server.url, '--debug'], 'use echo\nuse nope\n', env);
    expect(stdout).toContain('🐞 Debug log:');
    const log = readLog();
    const request = log.find((e) => e.event === 'request');
    expect(request).toMatchObject({ api: 'anthropic', authenticated: true });
    expect(request.offeredTools).toEqual(['fake__echo', 'fake__fail', 'fake__draw']);
    expect(request.body.messages[0].content[0].text).toBe('use echo');
    expect(log.find((e) => e.event === 'response').status).toBe(200);
    expect(log.find((e) => e.event === 'mcp-servers').started[0]).toEqual({ server: 'fake', tools: ['echo', 'fail', 'draw'] });
    const [call, unknown] = log.filter((e) => e.event === 'tool-call');
    expect(call).toMatchObject({ name: 'fake__echo', known: true, arguments: { text: 'hi' }, result: 'echo: >hi' });
    // a name the model used that was never offered is flagged, which is the usual sign of a naming mismatch
    expect(unknown).toMatchObject({ name: 'generate_image', known: false, result: "Error: unknown tool 'generate_image'" });
    expect(fs.readFileSync(path.join(home, 'debug.log'), 'utf8')).not.toContain('sk-secret-key');
    expect(fs.statSync(path.join(home, 'debug.log')).mode & 0o777).toBe(0o600);
  });

  it('can be switched on and off in the chat with /set debug and /set nodebug', async () => {
    const { stdout } = await run(['m', '--api', 'openai', '--host', server.url], 'first\n/set debug\nsecond\n/set nodebug\nthird\n/show settings\n');
    expect(stdout).toContain("Set 'debug' mode");
    expect(stdout).toContain("Set 'nodebug' mode");
    const requests = readLog().filter((e) => e.event === 'request');
    expect(requests.map((r) => r.body.messages.at(-1).content)).toEqual(['second']); // not first, not third
    expect(stdout.split('/show settings')[0]).not.toMatch(/debug log +\//);
  });

  it('lists offered tools in the OpenAI shape too', async () => {
    writeMcpConfig();
    await run(['m', '--api', 'openai', '--host', server.url, '--debug'], 'hi\n');
    expect(readLog().find((e) => e.event === 'request').offeredTools).toEqual(['fake__echo', 'fake__fail', 'fake__draw']);
  });

  it('shrinks encoded data and writes nothing without --debug', async () => {
    const image = path.join(home, 'pic.png');
    fs.writeFileSync(image, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3000)]));
    await run(['vis', '--host', server.url, '--debug'], `look ${image}\n`);
    const request = readLog().find((e) => e.event === 'request');
    expect(JSON.stringify(request.body)).toMatch(/characters of encoded data/);
    fs.rmSync(path.join(home, 'debug.log'));
    await run(['vis', '--host', server.url], 'hi\n');
    expect(fs.existsSync(path.join(home, 'debug.log'))).toBe(false);
  });
});

describe('OPENAI_API_KEY', () => {
  it('is sent as a bearer token to chat and /list with --api openai, and not otherwise', async () => {
    await run(['m', '--api', 'openai', '--host', server.url], 'hi\n/list\n', { OPENAI_API_KEY: 'sk-oai' });
    expect(requestsTo('/v1/chat/completions').at(0).headers.authorization).toBe('Bearer sk-oai');
    expect(requestsTo('/v1/models').at(0).headers.authorization).toBe('Bearer sk-oai');
    server.requests.length = 0;
    await run(['m', '--host', server.url], 'hi\n', { OPENAI_API_KEY: 'sk-oai' });
    expect(requestsTo('/api/chat').at(0).headers.authorization).toBeUndefined();
  });
});

describe('attaching files', () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
  function file(name, bytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skinnyai-file-'));
    fs.writeFileSync(path.join(dir, name), bytes);
    return path.join(dir, name);
  }
  const claude = () => ['claude-x', '--api', 'anthropic', '--host', server.url];
  const env = { ANTHROPIC_API_KEY: 'k' };

  it('pastes a text file into the message, for any API, and saves it with the session', async () => {
    const notes = file('notes.txt', 'line one\n```js\ncode\n```\n');
    const { stdout } = await run(['vis', '--host', server.url, '--autosave'], `/attach ${notes}\nsummarize\n`);
    expect(stdout).toContain('notes.txt will go with your next message');
    const sent = requestsTo('/api/chat').at(-1).body.messages.at(-1).content;
    expect(sent).toMatch(/^summarize\n\n\[attached file: notes.txt\]\n````\nline one\n```js\ncode\n```\n````$/);
    const saved = fs.readdirSync(path.join(home, 'sessions')).map((f) => fs.readFileSync(path.join(home, 'sessions', f), 'utf8')).join('');
    expect(saved).toContain('line one');
  });

  it('sends a PDF as a document block to Anthropic and a file part to OpenAI', async () => {
    const doc = file('paper.pdf', pdf);
    await run(claude(), `/attach ${doc}\nsummarize\n`, env);
    expect(requestsTo('/v1/messages').at(0).body.messages[0].content).toEqual([
      { type: 'document', title: 'paper.pdf', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
      { type: 'text', text: 'summarize' }
    ]);
    await run(['m', '--api', 'openai', '--host', server.url], `/attach ${doc}\nsummarize\n`);
    expect(requestsTo('/v1/chat/completions').at(0).body.messages.at(-1).content).toEqual([
      { type: 'text', text: 'summarize' },
      { type: 'file', file: { filename: 'paper.pdf', file_data: `data:application/pdf;base64,${pdf.toString('base64')}` } }
    ]);
  });

  it('refuses a PDF for Ollama, and files of kinds that cannot be sent', async () => {
    const doc = file('paper.pdf', pdf);
    const blob = file('thing.bin', Buffer.from([0, 1, 2, 255]));
    const { stdout } = await run(['vis', '--host', server.url], `/attach ${doc}\n/attach ${blob}\n`);
    expect(stdout).toContain('Ollama can only take images and text, not PDFs');
    expect(stdout).toContain("thing.bin isn't an image, PDF, or text file");
  });

  it('does not attach a text file just because its path is in a typed message', async () => {
    const notes = file('notes.txt', 'secret');
    await run(['vis', '--host', server.url], `what is in ${notes}\n`);
    expect(requestsTo('/api/chat').at(-1).body.messages.at(-1).content).toBe(`what is in ${notes}`);
  });

  it('keeps a queued file when a command is typed before the message', async () => {
    const notes = file('notes.txt', 'abc');
    await run(['vis', '--host', server.url], `/attach ${notes}\n/model\nhi\n`);
    expect(requestsTo('/api/chat').at(-1).body.messages.at(-1).content).toContain('[attached file: notes.txt]');
  });
});

describe('--api anthropic', () => {
  const anthropic = (extra = []) => ['claude-x', '--api', 'anthropic', '--host', server.url, ...extra];
  const env = { ANTHROPIC_API_KEY: 'sk-test' };

  it('streams a reply using x-api-key and a top-level system prompt', async () => {
    const { stdout, code } = await run(anthropic([]), '/set system Be brief.\nhello\n', env);
    expect(code).toBe(0);
    expect(stdout).toContain('You said: **hello**');
    const request = requestsTo('/v1/messages').at(0);
    expect(request.headers['x-api-key']).toBe('sk-test');
    expect(request.headers['anthropic-version']).toBeTruthy();
    expect(request.body).toMatchObject({ model: 'claude-x', stream: true, system: 'Be brief.', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
    expect(request.body.max_tokens).toBeGreaterThan(1000);
    expect(request.body).not.toHaveProperty('keep_alive');
  });

  it('keeps the conversation going across turns', async () => {
    await run(anthropic(), 'one\ntwo\n', env);
    const second = requestsTo('/v1/messages')[1].body.messages;
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[1].content).toEqual([{ type: 'text', text: 'You said: **one**' }]);
  });

  it('sends attached images as base64 source blocks', async () => {
    await run(anthropic(), `describe ${writeImage()}\n`, env);
    const content = requestsTo('/v1/messages').at(0).body.messages[0].content;
    expect(content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
    expect(content[1]).toEqual({ type: 'text', text: 'describe' });
  });

  it('lists models with /list', async () => {
    const { stdout } = await run(anthropic(), '/list\n', env);
    expect(stdout).toContain('vis');
    expect(requestsTo('/v1/models').at(0).headers['x-api-key']).toBe('sk-test');
  });

  it('needs ANTHROPIC_API_KEY', async () => {
    const { stderr, code } = await run(anthropic(), '', { ANTHROPIC_API_KEY: '' });
    expect(code).toBe(1);
    expect(stderr).toContain('ANTHROPIC_API_KEY');
  });
});

describe('images in tool results', () => {
  const png = { mime: 'image/png', data: 'AAAA' };
  const history = [
    { role: 'user', content: 'draw' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'web_search', arguments: '{}' } }, { id: 'c2', function: { name: 'web_search', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'saved to /tmp/p.png\n[image: image/png, 0 KB]', images: [png], parts: [{ type: 'image', ...png }, { type: 'text', text: 'saved to /tmp/p.png' }] },
    { role: 'tool', tool_call_id: 'c2', content: 'two' }
  ];

  it('are relayed in order as image_url parts for OpenAI-style servers', async () => {
    const { OllamaChat } = await import('./helpers/skinny.js');
    const chat = new OllamaChat('m', { api: 'openai', host: server.url });
    chat.history = structuredClone(history);
    const sent = chat.requestMessages('');
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']); // no extra messages
    expect(sent[2]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: 'saved to /tmp/p.png' }]
    });
    expect(sent[3].content).toBe('two');
  });

  it('are data: URLs in the text for Ollama, whose tool messages are plain text', async () => {
    const { OllamaChat } = await import('./helpers/skinny.js');
    const chat = new OllamaChat('m', { host: server.url });
    chat.history = structuredClone(history);
    expect(chat.requestMessages('')[2].content).toBe('data:image/png;base64,AAAA\nsaved to /tmp/p.png');
  });

  it('reach a stub that answers tool results with markdown exactly once (no duplicated image data)', async () => {
    writeMcpConfig({ trust: true });
    const { stdout } = await run(['m', '--api', 'openai', '--host', server.url], 'use draw\n');
    expect(stdout.match(/iVBORw0KGgo/g)).toHaveLength(1);
    expect(stdout).toContain('![Image](data:image/png;base64,iVBORw0KGgo');
    expect(stdout).toContain('saved to /tmp/pic.png');
  });
});

describe('/saveimage', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const ask = (input, env = {}) => { writeMcpConfig({ trust: true }); return run(['m', '--api', 'openai', '--host', server.url], `use draw\n${input}`, env); };

  it('writes the latest image to the path given, adding an extension if it has none', async () => {
    const out = path.join(home, 'out', 'goose');
    const { stdout } = await ask(`/saveimage ${out}\n`);
    expect(stdout).toContain(`Saved image/png, 0 KB to ${out}.png`);
    expect(fs.readFileSync(`${out}.png`).equals(png)).toBe(true);
  });

  it('names the file itself in a folder, or in the image folder when given no path', async () => {
    const folder = path.join(home, 'pics');
    await ask(`/saveimage ${folder}/\n`);
    expect(fs.readdirSync(folder)[0]).toMatch(/^skinnyai-\d{8}-\d{6}\.png$/);
    const fallback = path.join(home, 'default-images');
    await ask('/saveimage\n', { SKINNY_IMAGE_DIR: fallback });
    expect(fs.readdirSync(fallback)[0]).toMatch(/^skinnyai-\d{8}-\d{6}\.png$/);
  });

  it('asks before overwriting, and says so when there is no image', async () => {
    const file = path.join(home, 'x.png');
    fs.writeFileSync(file, 'old');
    const { stdout } = await ask(`/saveimage ${file}\nn\n`);
    expect(stdout).toContain('already exists. Overwrite it? [y/N] n');
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    const none = await run(['m', '--api', 'openai', '--host', server.url], '/saveimage\n');
    expect(none.stdout).toContain('No image in this conversation yet');
  });
});

describe('MCP servers', () => {
  const claude = () => ['claude-x', '--api', 'anthropic', '--host', server.url];
  const env = { ANTHROPIC_API_KEY: 'sk-test' };

  it('does nothing without a config file', async () => {
    const { stdout } = await run(claude(), '/mcp\n', env);
    expect(stdout).not.toContain('🔌 MCP');
    expect(stdout).toContain('No MCP servers are running');
  });

  it('lists the tools, and calls one once the user approves', async () => {
    writeMcpConfig();
    const { stdout } = await run(claude(), '/mcp\nuse echo\ny\n', env);
    expect(stdout).toContain('🔌 MCP: fake (3 tools)');
    expect(stdout).toContain('echo - Echo the text back');
    const first = requestsTo('/v1/messages').at(0).body;
    expect(first.tools.map((t) => t.name)).toEqual(['fake__echo', 'fake__fail', 'fake__draw']);
    expect(first.tools[0].input_schema.required).toEqual(['text']);
    expect(stdout).toMatch(/🔧 fake: echo\n/); // the tool's name only, not its arguments
    expect(stdout).toContain('Allow this tool call? [y/N/a(lways)] y');
    expect(stdout).toContain('Tool said: echo: >hi');
    const second = requestsTo('/v1/messages').at(1).body.messages;
    expect(second.at(-2).content.at(-1)).toMatchObject({ type: 'tool_use', id: 'toolu_1', name: 'fake__echo', input: { text: 'hi' } });
    expect(second.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'echo: >hi' });
  });

  it('relays an image a tool returns to the model, not a placeholder', async () => {
    writeMcpConfig({ trust: true });
    const { stdout } = await run(claude(), 'use draw\n', env);
    expect(stdout).not.toContain('content not shown');
    const result = requestsTo('/v1/messages').at(1).body.messages.at(-1).content[0];
    expect(result.type).toBe('tool_result');
    expect(result.content[0]).toEqual({ type: 'text', text: 'saved to /tmp/pic.png\n[image: image/png, 0 KB]' });
    expect(result.content[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png' } });
    expect(result.content[1].source.data).toMatch(/^iVBORw0KGgo/);
  });

  it('does not run a tool the user declines', async () => {
    writeMcpConfig();
    const { stdout } = await run(claude(), 'use echo\nn\n', env);
    expect(stdout).toContain('the user declined this tool call');
    expect(stdout).not.toContain('echo: >hi');
  });

  it('reads servers from a config.json profile and saves "always" there', async () => {
    writeProfileMcpConfig();
    const first = await run([...claude(), '--profile', 'Other'], 'use echo\na\n', env);
    expect(first.stdout).toContain('Tool said: echo: >hi');
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(saved.profiles.Other.mcpServers.fake.trust).toEqual(['echo']);
    expect(saved.profiles.Default).toEqual({ env: {} });
  });

  it('starts servers from "shared" in every profile, and saves "always" there', async () => {
    const fake = { command: process.execPath, args: [MCP_SERVER], env: { FAKE_PREFIX: '>' } };
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      defaultProfile: 'One',
      shared: { mcpServers: { fake } },
      profiles: { One: { env: {} }, Two: { env: {} } }
    }));
    const first = await run([...claude(), '--profile', 'Two'], 'use echo\na\n', env);
    expect(first.stdout).toContain('Tool said: echo: >hi');
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(saved.shared.mcpServers.fake.trust).toEqual(['echo']);
    expect(saved.profiles).toEqual({ One: { env: {} }, Two: { env: {} } });

    // The other profile gets the same server, and its trust.
    const second = await run(claude(), '/mcp\nuse echo\n', env);
    expect(second.stdout).toContain('(trusted tools: echo)');
    expect(second.stdout).toContain('Tool said: echo: >hi');
    expect(second.stdout).not.toContain('Allow this tool call');
  });

  it('lets a profile replace or disable a shared server', async () => {
    const fake = { command: process.execPath, args: [MCP_SERVER], env: { FAKE_PREFIX: '>' }, trust: true };
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      defaultProfile: 'On',
      shared: { mcpServers: { fake } },
      profiles: { On: { env: {} }, Off: { env: {}, mcpServers: { fake: { disabled: true } } } }
    }));
    const on = await run(claude(), 'use echo\n', env);
    expect(on.stdout).toContain('Tool said: echo: >hi');
    const off = await run([...claude(), '--profile', 'Off'], '/mcp\n', env);
    expect(off.stdout).not.toContain('fake');
  });

  it('"always" trusts just that tool and saves it to config.json', async () => {
    writeMcpConfig();
    const first = await run(claude(), 'use echo\na\n', env);
    expect(first.stdout).toContain('Tool said: echo: >hi');
    expect(first.stdout).toContain('this tool is now trusted');
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(saved.profiles.Default.mcpServers.fake.trust).toEqual(['echo']);
    expect(saved.profiles.Default.mcpServers.fake.command).toBe(process.execPath); // the rest is kept

    // Next run: echo goes through, but another tool on the same server still asks.
    const second = await run(claude(), '/mcp\nuse echo\nuse fail\nn\n', env);
    expect(second.stdout).toContain('(trusted tools: echo)');
    expect(second.stdout.match(/Allow this tool call/g)).toHaveLength(1);
    expect(second.stdout).toContain('declined');
  });

  it('runs trusted servers without asking, and reports tool errors', async () => {
    writeMcpConfig({ trust: true });
    const { stdout } = await run(claude(), 'use fail\n', env);
    expect(stdout).not.toContain('Allow this tool call');
    expect(stdout).toContain('Tool said: Error: it broke');
    const result = requestsTo('/v1/messages').at(1).body.messages.at(-1).content[0];
    expect(result.is_error).toBe(true);
  });

  it('reports a server that fails to start and carries on', async () => {
    writeMcpConfig({ command: 'definitely-not-a-real-command', args: [] });
    const { stdout, code } = await run(claude(), 'hello\n', env);
    expect(code).toBe(0);
    expect(stdout).toContain("MCP server 'fake' failed to start");
    expect(stdout).toContain('You said: **hello**');
  });

  it('works with OpenAI-style servers too, and --no-mcp skips the config', async () => {
    writeMcpConfig();
    await run(['m', '--api', 'openai', '--host', server.url], 'hi\n');
    expect(requestsTo('/v1/chat/completions').at(0).body.tools.map((t) => t.function.name)).toContain('fake__echo');
    server.requests.length = 0;
    await run(['m', '--api', 'openai', '--host', server.url, '--no-mcp'], 'hi\n');
    expect(requestsTo('/v1/chat/completions').at(0).body).not.toHaveProperty('tools');
  });
});
