import './config.js';
import { CONFIG, CONFIG_FILE } from './config.js';
import { DEBUG_LOG } from './debug.js';

// Settings a profile (or the environment) can default, by variable
// name: [option key, type]. Each matches a command-line flag.
export const ENV_SETTINGS = {
  SKINNY_MODEL: ['model', 'string'],
  SKINNY_HOST: ['host', 'string'],
  SKINNY_API: ['api', 'string'],
  SKINNY_KEEP_ALIVE: ['keepAlive', 'string'],
  SKINNY_TOOLS: ['tools', 'boolean'],
  SKINNY_DATE: ['date', 'boolean'],
  SKINNY_MARKDOWN: ['markdown', 'boolean'],
  SKINNY_MCP: ['mcp', 'boolean'],
  SKINNY_DEBUG: ['debug', 'boolean'],
  SKINNY_IMAGES: ['images', 'boolean'],
  SKINNY_AUTOSAVE: ['autosave', 'boolean'],
  SKINNY_HIDE_THINKING: ['hideThinking', 'boolean'],
  SKINNY_STOP_ON_EXIT: ['stopOnExit', 'boolean'],
  SKINNY_USER_NORMAL_COLOR: ['userNormalColor', 'string'],
  SKINNY_USER_ITALIC_COLOR: ['userEmphasisColor', 'string'],
  SKINNY_MODEL_NORMAL_COLOR: ['modelNormalColor', 'string'],
  SKINNY_MODEL_ITALIC_COLOR: ['modelEmphasisColor', 'string']
};

export function envOptions() {
  const options = {};
  for (const [name, [key, type]] of Object.entries(ENV_SETTINGS)) {
    const value = process.env[name];
    if (value === undefined || value === '') continue;
    if (type === 'string') {
      options[key] = value;
    } else if (/^(1|true|yes|on)$/i.test(value)) {
      options[key] = true;
    } else if (/^(0|false|no|off)$/i.test(value)) {
      options[key] = false;
    } else {
      console.error(`❌ Error: ${name} must be true or false (got '${value}')${CONFIG ? ` - check ${CONFIG_FILE}` : ''}\n`);
      process.exit(1);
    }
  }
  return options;
}

// Boolean flags, each with a --no- (or opposite) form so a flag can
// override a profile default either way.
export const BOOLEAN_FLAGS = {
  '--tools': ['tools', true], '--no-tools': ['tools', false],
  '--date': ['date', true], '--no-date': ['date', false],
  '--markdown': ['markdown', true], '--no-markdown': ['markdown', false],
  '--mcp': ['mcp', true], '--no-mcp': ['mcp', false],
  '--debug': ['debug', true], '--no-debug': ['debug', false],
  '--images': ['images', true], '--no-images': ['images', false],
  '--autosave': ['autosave', true], '--no-autosave': ['autosave', false],
  '--hide-thinking': ['hideThinking', true], '--show-thinking': ['hideThinking', false],
  '-x': ['stopOnExit', true], '--stop-on-exit': ['stopOnExit', true], '--no-stop-on-exit': ['stopOnExit', false]
};

// Parse command line arguments, on top of the profile/environment defaults.
export function parseArgs() {
  const args = process.argv.slice(2);
  const { model: defaultModel, ...options } = envOptions();
  let model = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' || args[i] === '-m') {
      model = args[++i];
    } else if (args[i] === '--keep-alive' || args[i] === '-k') {
      options.keepAlive = args[++i];
    } else if (args[i] === '--host' || args[i] === '-h') {
      options.host = args[++i];
    } else if (args[i] === '--user-italic-color' || args[i] === '--user-emphasis-color') {
      options.userEmphasisColor = args[++i];
    } else if (args[i] === '--user-normal-color') {
      options.userNormalColor = args[++i];
    } else if (args[i] === '--model-italic-color' || args[i] === '--model-emphasis-color') {
      options.modelEmphasisColor = args[++i];
    } else if (args[i] === '--model-normal-color') {
      options.modelNormalColor = args[++i];
    } else if (BOOLEAN_FLAGS[args[i]]) {
      const [key, value] = BOOLEAN_FLAGS[args[i]];
      options[key] = value;
    } else if (args[i] === '--api') {
      options.api = args[++i];
    } else if (args[i] === '--profile') {
      i++; // already applied when the module loaded
    } else if (args[i].startsWith('--profile=')) {
      // likewise
    } else if (args[i] === '--help') {
      printUsage();
      process.exit(0);
    } else if (!model && !args[i].startsWith('-')) {
      // First non-flag argument is the model
      model = args[i];
    }
  }

  return { model: model || defaultModel, options };
}

export function printUsage() {
  console.log(`
Usage: skinnyai.js [model] [options]

Arguments:
  model                Model name (e.g., llama2, neural-chat)

Options:
  -m, --model NAME     Specify model name
  -k, --keep-alive TIME   Keep model loaded for TIME (default: 1h)
                       Examples: 5m, 1h, 24h, 30s
  -h, --host URL      Ollama API host (default: http://localhost:11434)
                       Use https://ollama.com for cloud models; needs the
                       OLLAMA_API_KEY environment variable
  --user-italic-color COLOR     Color for *italic*/narration in your messages (default: 136 / dim yellow)
  --user-normal-color COLOR     Color for dialogue in your messages (default: 226 / bright yellow)
  --model-italic-color COLOR    Color for *italic*/narration in model responses (default: 77 / medium green)
  --model-normal-color COLOR    Color for dialogue in model responses (default: 120 / bright green)
                       COLOR can be a hex code (#RRGGBB), a 256-color index (0-255),
                       or a name (red, green, yellow, blue, magenta, cyan, white, black,
                       or bright- prefixed, e.g. brightgreen; gray/grey aliases brightblack)
                       (--user-emphasis-color / --model-emphasis-color still work as aliases)
  --no-markdown        Show responses as raw text instead of rendering markdown
                       (same as running \`/set nomarkdown\`)
  --images             Download and draw markdown images inline, in terminals
                       that support it: iTerm2, WezTerm, kitty, Ghostty (same
                       as running \`/set images\`). Off by default, since it
                       fetches whatever image URLs the model writes.
  -x, --stop-on-exit   Unload the model from Ollama when the session ends
                       (same effect as \`ollama stop\`)
  --autosave           Save the session to a local file after each reply,
                       named from the date and time; /save <name> renames it
                       (same as running \`/set autosave\`)
  --hide-thinking      Don't stream thinking-model reasoning output
                       (shown by default; same as running \`/set hidethinking\`)
  --no-tools           Don't offer the model web_search and
                       fetch_page; they're on by default (same as running
                       \`/set notools\`). They need a
                       tool-capable model (e.g. llama3.1, qwen3). With
                       OLLAMA_API_KEY set, uses Ollama's hosted search/fetch.
  --no-mcp             Don't start the MCP servers in ${CONFIG_FILE}
                       (standard "mcpServers" format; their tools ask before
                       each call unless a server sets "trust": true. See /mcp.)
  --debug              Log every chat request (with the tools offered), response
                       status, and tool call to ${DEBUG_LOG}
  --date, --no-date    Always / never tell the model today's date via the
                       system message (default: only when tools are on)
  --api <ollama|openai|anthropic>  Backend API to speak (default: ollama)
                       Use 'anthropic' for Claude (needs ANTHROPIC_API_KEY;
                       the default host becomes https://api.anthropic.com)
                       Use 'openai' for OpenAI-compatible servers (vLLM,
                       llama.cpp server, LM Studio, ...). Ollama-only
                       features (/save, /show info/license/modelfile/
                       parameters/template, keep-alive, --stop-on-exit)
                       aren't supported there and are disabled/no-ops.
  --profile NAME      Use the named profile from ${CONFIG_FILE}
                       (default: the "defaultProfile" named in the file; also SKINNY_PROFILE;
                       /set profile switches during a chat)
  --help              Show this message

  Every on/off flag has an opposite (--no-tools, --no-images, --no-autosave,
  --markdown, --show-thinking, --no-stop-on-exit), to override a default.

Defaults:
  Settings can be defaulted in ${CONFIG_FILE}, in named profiles
  (see config.json.example): each profile's "env" block holds, e.g.:
    "SKINNY_MODEL": "gemma4:31b",  "SKINNY_HOST": "https://ollama.com",
    "SKINNY_TOOLS": true,          "SKINNY_AUTOSAVE": true,
    "OLLAMA_API_KEY": "..."
  and an optional "mcpServers" block. The top-level "defaultProfile" names the
  profile used unless you pick another with --profile NAME or
  SKINNY_PROFILE=NAME. A top-level "shared" block (same shape) is what every
  profile starts from, and "startupEnv" holds settings applied once at launch
  (NODE_EXTRA_CA_CERTS, colors, SKINNY_TRUSTED_HOSTS, SKINNY_IMAGE_DIR). Also: SKINNY_API, SKINNY_KEEP_ALIVE,
  SKINNY_DATE, SKINNY_MARKDOWN, SKINNY_IMAGES, SKINNY_HIDE_THINKING,
  SKINNY_STOP_ON_EXIT, SKINNY_MCP, SKINNY_DEBUG,
  SKINNY_TRUSTED_HOSTS (hosts, comma-separated, that images and fetch_page may
  reach even though they resolve to a private address), SKINNY_IMAGE_DIR (where /saveimage writes by default: ~/Pictures/skinnyai), and
  SKINNY_{USER,MODEL}_{NORMAL,ITALIC}_COLOR. OPENAI_API_KEY and
  ANTHROPIC_API_KEY go with --api openai / anthropic. Environment variables override
  the file, and command-line flags override both.

Examples:
  skinnyai.js llama2
  skinnyai.js neural-chat --keep-alive 30m
  skinnyai.js --model mistral --keep-alive 2h --host http://192.168.1.100:11434
  skinnyai.js llama2 --user-normal-color cyan --model-normal-color "#ff8800"
  skinnyai.js llama2 --stop-on-exit
  skinnyai.js qwen3 --tools
`);
}
