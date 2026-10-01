// End-to-end (spawned process, piped input, mock server): the welcome screen,
// keep-alive visibility, /load, image attachments, the Anthropic API, and MCP.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockServer } from './helpers/mock-server.js';

const SCRIPT = fileURLToPath(new URL('../bin/skinnyai.js', import.meta.url));
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
    anthropicToolCalls: { 'use echo': { name: 'fake__echo', input: { text: 'hi' } }, 'use fail': { name: 'fake__fail', input: {} } }
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
  const config = { mcpServers: { fake: { command: process.execPath, args: [MCP_SERVER], env: { FAKE_PREFIX: '>' }, ...extra } } };
  fs.writeFileSync(path.join(home, 'mcp.json'), JSON.stringify(config));
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
    const { OllamaChat } = await import('../bin/skinnyai.js');
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

describe('--api anthropic', () => {
  const anthropic = (extra = []) => ['claude-x', '--api', 'anthropic', '--host', server.url, ...extra];
  const env = { ANTHROPIC_API_KEY: 'sk-test' };

  it('streams a reply using x-api-key and a top-level system prompt', async () => {
    const { stdout, code } = await run(anthropic(['--verbose-never']), '/set system Be brief.\nhello\n', env);
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
    expect(stdout).toContain('🔌 MCP: fake (2 tools)');
    expect(stdout).toContain('echo - Echo the text back');
    const first = requestsTo('/v1/messages').at(0).body;
    expect(first.tools.map((t) => t.name)).toEqual(['fake__echo', 'fake__fail']);
    expect(first.tools[0].input_schema.required).toEqual(['text']);
    expect(stdout).toContain('Allow this tool call? [y/N/a(lways)] y');
    expect(stdout).toContain('Tool said: echo: >hi');
    const second = requestsTo('/v1/messages').at(1).body.messages;
    expect(second.at(-2).content.at(-1)).toMatchObject({ type: 'tool_use', id: 'toolu_1', name: 'fake__echo', input: { text: 'hi' } });
    expect(second.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'echo: >hi' });
  });

  it('does not run a tool the user declines', async () => {
    writeMcpConfig();
    const { stdout } = await run(claude(), 'use echo\nn\n', env);
    expect(stdout).toContain('the user declined this tool call');
    expect(stdout).not.toContain('echo: >hi');
  });

  it('"always" trusts just that tool and saves it to mcp.json', async () => {
    writeMcpConfig();
    const first = await run(claude(), 'use echo\na\n', env);
    expect(first.stdout).toContain('Tool said: echo: >hi');
    expect(first.stdout).toContain('this tool is now trusted');
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'mcp.json'), 'utf8'));
    expect(saved.mcpServers.fake.trust).toEqual(['echo']);
    expect(saved.mcpServers.fake.command).toBe(process.execPath); // the rest is kept

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
