// A stand-in chat server speaking both the Ollama API and the OpenAI
// chat-completions API, for end-to-end tests. Replies echo the last user
// message as "You said: **...**", or return `replies[message]` when set.
import http from 'node:http';

export async function startMockServer({ replies = {}, models = [], canCreate = false } = {}) {
  const created = [];
  const requests = [];
  const existing = new Set(models);

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const json = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, body: json });
      const reply = (messages) => {
        const last = messages.at(-1)?.content ?? '';
        return replies[last] ?? `You said: **${last}**`;
      };

      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const text = reply(json.messages);
        for (let i = 0; i < text.length; i += 7) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 7) } }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      } else if (req.url === '/api/chat') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const text = reply(json.messages ?? []);
        if (json.messages?.length) {
          for (let i = 0; i < text.length; i += 7) {
            res.write(JSON.stringify({ message: { role: 'assistant', content: text.slice(i, i + 7) }, done: false }) + '\n');
          }
        }
        res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n');
      } else if (req.url === '/api/show') {
        if (existing.has(json.model)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ details: {}, messages: [] }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `model '${json.model}' not found` }));
        }
      } else if (req.url === '/api/create') {
        if (canCreate) {
          created.push(json);
          existing.add(json.model);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'success' }));
        } else {
          res.writeHead(404);
          res.end('404 page not found');
        }
      } else if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [...existing].map((name) => ({ name, size: 1e9 })) }));
      } else if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [...existing].map((id) => ({ id })) }));
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
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
