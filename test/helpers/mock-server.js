// A stand-in chat server speaking both the Ollama API and the OpenAI
// chat-completions API, for end-to-end tests. Replies echo the last user
// message as "You said: **...**", or return `replies[message]` when set.
import http from 'node:http';

export async function startMockServer({ replies = {}, models = [], canCreate = false, capabilities, anthropicToolCalls = {}, modelMeta = {}, openaiToolCalls = {}, titleReply } = {}) {
  const created = [];
  const requests = [];
  const titleRequests = []; // the small non-streamed "give a short title" requests, kept apart from chat turns
  const existing = new Set(models);

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const json = body ? JSON.parse(body) : {};
      const url = req.url.split('?')[0];
      if (!json.stream && JSON.stringify(json.messages ?? []).includes('Give a short title')) {
        titleRequests.push({ url, body: json, headers: req.headers });
        if (titleReply === undefined) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end('{"error":"no title"}');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (url === '/v1/messages') return res.end(JSON.stringify({ content: [{ type: 'text', text: titleReply }] }));
        if (url === '/v1/chat/completions') return res.end(JSON.stringify({ choices: [{ message: { content: titleReply } }] }));
        return res.end(JSON.stringify({ message: { role: 'assistant', content: titleReply }, done: true }));
      }
      requests.push({ url, body: json, headers: req.headers });
      const reply = (messages) => {
        const last = messages.at(-1)?.content ?? '';
        return replies[last] ?? `You said: **${last}**`;
      };

      if (url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const lastMessage = json.messages.at(-1);
        const toolCall = lastMessage.role === 'user' ? openaiToolCalls[lastMessage.content] : null;
        if (toolCall) {
          const call = { index: 0, id: 'call_1', type: 'function', function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) } };
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
          return res.end();
        }
        // Like mfluxible's chat stub: answer a tool result with its images as markdown, then its text.
        let text = reply(json.messages);
        if (lastMessage.role === 'tool') {
          const parts = Array.isArray(lastMessage.content) ? lastMessage.content : [{ type: 'text', text: lastMessage.content }];
          const images = parts.filter((p) => p.type === 'image_url').map((p) => `![Image](${p.image_url.url})`);
          const captions = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim();
          text = [...images, captions].filter(Boolean).join('\n\n');
        }
        for (let i = 0; i < text.length; i += 7) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 7) } }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      } else if (url === '/v1/messages') {
        // Anthropic's streaming format: typed events, tool calls as content blocks.
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        const last = json.messages.at(-1);
        const parts = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
        const result = parts.find((p) => p.type === 'tool_result');
        const lastText = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
        const call = result ? null : anthropicToolCalls[lastText];
        event('message_start', { message: { usage: { input_tokens: 11, output_tokens: 1 } } });
        if (call) {
          event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: call.name, input: {} } });
          const partial = JSON.stringify(call.input);
          event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: partial.slice(0, 5) } });
          event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: partial.slice(5) } });
          event('content_block_stop', { index: 0 });
        } else {
          const text = result ? `Tool said: ${typeof result.content === 'string' ? result.content : JSON.stringify(result.content)}` : replies[lastText] ?? `You said: **${lastText}**`;
          event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
          for (let i = 0; i < text.length; i += 7) event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 7) } });
          event('content_block_stop', { index: 0 });
        }
        event('message_delta', { delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } });
        event('message_stop', {});
        res.end();
      } else if (url === '/api/chat') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const text = reply(json.messages ?? []);
        if (json.messages?.length) {
          for (let i = 0; i < text.length; i += 7) {
            res.write(JSON.stringify({ message: { role: 'assistant', content: text.slice(i, i + 7) }, done: false }) + '\n');
          }
        }
        res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n');
      } else if (url === '/api/show') {
        if (existing.has(json.model)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ details: {}, messages: [], ...(capabilities && { capabilities: capabilities[json.model] ?? [] }) }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `model '${json.model}' not found` }));
        }
      } else if (url === '/api/create') {
        if (canCreate) {
          created.push(json);
          existing.add(json.model);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'success' }));
        } else {
          res.writeHead(404);
          res.end('404 page not found');
        }
      } else if (url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [...existing].map((name) => ({ name, size: 1e9 })) }));
      } else if (url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [...existing].map((id) => ({ id, ...modelMeta[id] })) }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    created,
    requests,
    titleRequests,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
