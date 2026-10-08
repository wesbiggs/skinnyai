#!/usr/bin/env node

import './quiet-warnings.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyFile, extractAttachments } from './attachments.js';
import { OllamaChat } from './chat.js';
import { envOptions, parseArgs, printUsage } from './cli.js';
import { API_NAMES, CONFIG_FILE, VERSION, loadConfigFile, requestedProfile, resolveProfile } from './config.js';
import { anthropicApiKey, isOllamaCom } from './http.js';
import { imageSequence, loadImage, sniffImage } from './images.js';
import { inputPosition } from './lineedit.js';
import { createMarkdownRenderer } from './markdown.js';
import { pickDefaultModel } from './models.js';
import { SESSION_DIR, autosaveName, chatFileExists, commitCount, formatModelfile, isAutosaveName, legacySessionPath, listLocalSessions, localSessionExists, messageCount, parseModelfile, readLocalSession, redactLocalSession, resumeHint, saveLocalSession, sessionPath, verifyChat } from './sessions.js';
import { PROMPT, applyColorOverrides, charWidth, createInlineStyler, createWordWrapper, drawBox, graphemeWidth, renderTable, splitTableRow, styleLine, visibleWidth, wrapStyled } from './style.js';

// Main
async function main() {
  const { model, options } = parseArgs();

  if (!model) {
    console.error('❌ Error: Model name is required\n');
    printUsage();
    process.exit(1);
  }

  if (options.api && !API_NAMES.includes(options.api)) {
    console.error(`❌ Error: --api must be 'ollama', 'openai', or 'anthropic' (got '${options.api}')\n`);
    process.exit(1);
  }
  if (options.api === 'anthropic' && !anthropicApiKey()) {
    console.error(`❌ Error: --api anthropic needs ANTHROPIC_API_KEY (set it in the environment or ${CONFIG_FILE})\n`);
    process.exit(1);
  }

  applyColorOverrides(options);

  const chat = new OllamaChat(model, options);
  
  try {
    await chat.start();
  } catch (error) {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  }
}

// Run only when executed directly, not when imported (as the tests do).
// argv[1] may be a symlink, like ~/.local/bin/skinnyai, so compare real paths.
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch (error) {
    return false;
  }
}

if (invokedDirectly()) main().catch(console.error);

export {
  charWidth, graphemeWidth, visibleWidth, createInlineStyler, styleLine, createWordWrapper,
  splitTableRow, wrapStyled, renderTable, createMarkdownRenderer, inputPosition,
  drawBox, VERSION, sniffImage, imageSequence, loadImage, pickDefaultModel, extractAttachments, classifyFile,
  formatModelfile, parseModelfile, saveLocalSession, readLocalSession, listLocalSessions,
  localSessionExists, isAutosaveName, autosaveName, sessionPath, legacySessionPath, chatFileExists, commitCount, redactLocalSession, verifyChat, messageCount, resumeHint,
  loadConfigFile, resolveProfile, requestedProfile, envOptions, parseArgs, isOllamaCom, OllamaChat, main,
  PROMPT, SESSION_DIR, CONFIG_FILE
};
