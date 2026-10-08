import { parseArguments } from './history.js';

const RESULT_CHARS = 1000;
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const quote = (text) => text.split('\n').map((line) => `> ${line}`).join('\n');

// /export to .md: a transcript to read. Thinking blocks and attachment
// bytes stay out; tool calls show as one line each with the start of their
// results, and attachments as a note.
export function formatMarkdown({ title, system, messages, exportedAt = new Date() }) {
  const models = [...new Set(messages.filter((m) => m.role === 'assistant' && m.origin?.model).map((m) => m.origin.model))];
  const lines = [`# ${title}`, '', `*Exported from skinnyai on ${exportedAt.toISOString().slice(0, 10)}${models.length ? `. Models: ${models.join(', ')}` : ''}.*`, ''];
  if (system) lines.push('**System message:**', '', quote(system), '');
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push('### You', '', m.content, '');
      for (const image of m.images ?? []) lines.push(`📎 image (${image.mime})`, '');
      for (const doc of m.documents ?? []) lines.push(`📎 ${doc.name}`, '');
    } else if (m.role === 'assistant') {
      if (!m.content && !m.tool_calls?.length) continue;
      lines.push(`### Assistant${m.origin?.model ? ` (${m.origin.model})` : ''}`, '');
      if (m.content) lines.push(m.content, '');
      for (const call of m.tool_calls ?? []) {
        lines.push(`🔧 \`${call.function?.name}(${JSON.stringify(parseArguments(call.function?.arguments))})\``, '');
      }
    } else if (m.role === 'tool') {
      lines.push(quote(`Result: ${clip(m.content ?? '', RESULT_CHARS)}`), '');
      if (m.images?.length) lines.push(`📎 ${m.images.length} image${m.images.length === 1 ? '' : 's'} (${m.images[0].mime})`, '');
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
