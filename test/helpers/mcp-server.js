// A tiny MCP server over stdio (newline-delimited JSON-RPC) for tests: one
// tool, "echo", plus "fail", which reports an error result.
import readline from 'node:readline';

const tools = [
  { name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
  { name: 'draw', description: 'Returns a caption and an image', inputSchema: { type: 'object', properties: {} } }
];
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return; // notifications
  if (method === 'initialize') {
    reply(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
  } else if (method === 'tools/list') {
    reply(id, { tools });
  } else if (method === 'tools/call') {
    if (params.name === 'draw') {
      reply(id, { content: [{ type: 'text', text: 'saved to /tmp/pic.png' }, { type: 'image', data: PNG, mimeType: 'image/png' }] });
    } else if (params.name === 'fail') reply(id, { isError: true, content: [{ type: 'text', text: 'it broke' }] });
    else reply(id, { content: [{ type: 'text', text: `echo: ${process.env.FAKE_PREFIX ?? ''}${params.arguments.text}` }] });
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }) + '\n');
  }
});
