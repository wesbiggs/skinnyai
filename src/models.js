import './config.js';

// The newest flagship among a /v1/models listing ({ id, created } for OpenAI,
// { id, created_at } for Anthropic), for "--model default". Neither API has
// a "default" alias or a flagship flag, so this goes by release date:
// OpenAI's newest plain gpt-N (no mini, codex, audio, ... or dated copies of
// an alias); Anthropic's newest Opus, or else its newest model of any kind.
export const OPENAI_NON_FLAGSHIP = /mini|nano|audio|realtime|image|tts|transcribe|search|codex|instruct|preview|chat-latest|embedding|moderation|whisper|deep-research/;
export function pickDefaultModel(api, models) {
  const released = (m) => Number(m.created) || Date.parse(m.created_at) / 1000 || 0;
  const newest = (list) => list.reduce((best, m) => (!best || released(m) > released(best) ||
    (released(m) === released(best) && m.id.length < best.id.length) ? m : best), null)?.id ?? null;
  if (api === 'anthropic') {
    const opus = models.filter((m) => /opus/.test(m.id));
    return newest(opus.length ? opus : models);
  }
  return newest(models.filter((m) => /^gpt-\d/.test(m.id) && !OPENAI_NON_FLAGSHIP.test(m.id) && !/-\d{4}-\d{2}-\d{2}$/.test(m.id)));
}
