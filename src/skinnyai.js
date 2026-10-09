#!/usr/bin/env node

import './quiet-warnings.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OllamaChat } from './chat.js';
import { tightenDir } from './home.js';
import { printUsage, parseArgs } from './cli.js';
import { API_NAMES, CONFIG_FILE, SKINNY_HOME } from './config.js';
import { anthropicApiKey } from './http.js';
import { applyColorOverrides } from './style.js';
import { SESSION_DIR } from './sessions.js';

// Main
export async function main() {
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
  if (!process.env.SKINNY_HOME) {
    tightenDir(SKINNY_HOME);
    tightenDir(SESSION_DIR);
  }

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

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
