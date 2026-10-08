// Imported first by the entry point: Node 22 prints an ExperimentalWarning
// when node:sqlite loads (Node 24 doesn't). Chats are stored with it, so
// that notice would appear on every launch; everything else still shows.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (type === 'ExperimentalWarning' && /sqlite/i.test(text)) return undefined;
  return emitWarning.call(this, warning, ...args);
};
