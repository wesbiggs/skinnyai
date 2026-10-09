// Everything the tests reach for, in one place (the CLI's entry, src/skinnyai.js, only runs main).
import { classifyFile, extractAttachments } from '../../src/attachments.js';
import { tightenDir } from '../../src/home.js';
import { OllamaChat } from '../../src/chat.js';
import { envOptions, parseArgs } from '../../src/cli.js';
import { CONFIG_FILE, VERSION, loadConfigFile, requestedProfile, resolveProfile } from '../../src/config.js';
import { isOllamaCom } from '../../src/http.js';
import { imageSequence, loadImage, sniffImage } from '../../src/images.js';
import { inputPosition } from '../../src/lineedit.js';
import { createMarkdownRenderer } from '../../src/markdown.js';
import { pickDefaultModel } from '../../src/models.js';
import { SESSIONS_ENCRYPTED, SESSION_DIR, VOLUME_MARKER, autosaveName, chatFileExists, commitCount, formatModelfile, isAutosaveName, legacySessionPath, listLocalSessions, localSessionExists, messageCount, parseModelfile, readLocalSession, redactLocalSession, resumeHint, saveLocalSession, sessionPath, sessionsLocked, tidyTitle, uniqueSessionName, verifyChat } from '../../src/sessions.js';
import { PROMPT, charWidth, createInlineStyler, createWordWrapper, drawBox, graphemeWidth, renderTable, splitTableRow, styleLine, visibleWidth, wrapStyled } from '../../src/style.js';

import { main } from '../../src/skinnyai.js';

export {
  charWidth, graphemeWidth, visibleWidth, createInlineStyler, styleLine, createWordWrapper,
  splitTableRow, wrapStyled, renderTable, createMarkdownRenderer, inputPosition,
  drawBox, VERSION, sniffImage, imageSequence, loadImage, pickDefaultModel, extractAttachments, classifyFile,
  formatModelfile, parseModelfile, saveLocalSession, readLocalSession, listLocalSessions,
  localSessionExists, isAutosaveName, autosaveName, sessionPath, legacySessionPath, chatFileExists, commitCount, redactLocalSession, verifyChat, sessionsLocked, SESSIONS_ENCRYPTED, VOLUME_MARKER, tidyTitle, uniqueSessionName, tightenDir, messageCount, resumeHint,
  loadConfigFile, resolveProfile, requestedProfile, envOptions, parseArgs, isOllamaCom, OllamaChat, main,
  PROMPT, SESSION_DIR, CONFIG_FILE
};
