import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep in step with package.json (a test checks).
export const VERSION = '0.9.0';

export const DEFAULT_KEEP_ALIVE = '1h';
export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
export const DEFAULT_ANTHROPIC_HOST = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
export const API_NAMES = ['ollama', 'openai', 'anthropic'];
export const API_LABELS = { ollama: 'ollama', openai: 'openai-compatible', anthropic: 'anthropic' };

// Saved sessions and the config.json defaults file live here.
export const SKINNY_HOME = process.env.SKINNY_HOME || path.join(os.homedir(), '.skinny');

// Default settings live in $SKINNY_HOME/config.json, in named profiles (see
// loadConfigFile, config.json.example, and the README). Each profile has an
// "env" block of the variables listed in ENV_SETTINGS (plus API keys) and an
// optional "mcpServers" block. The "Default" profile is the base: the one
// used unless --profile NAME or SKINNY_PROFILE says otherwise, and other
// profiles inherit from it, overriding what they set. Variables already in
// the environment win over the file, and command-line flags win over both.
// It's loaded before anything reads process.env, so OLLAMA_API_KEY can live
// there too.
export const CONFIG_FILE = path.join(SKINNY_HOME, 'config.json');
export const DEFAULT_PROFILE = 'Default';

// Reads config.json: null if there is none; throws if it can't be used.
export function loadConfigFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} isn't valid JSON: ${error.message}`, { cause: error });
  }
  if (!json || typeof json.profiles !== 'object' || json.profiles === null || Array.isArray(json.profiles)) {
    throw new Error(`${file} has no "profiles" object`);
  }
  return json;
}

// The settings of one profile on top of the Default profile's: { name, env,
// mcpServers }. env values become strings, as environment variables are.
// Throws if the named profile doesn't exist.
export function resolveProfile(config, requested = DEFAULT_PROFILE) {
  const profiles = config.profiles;
  const name = profiles[requested] ? requested : Object.keys(profiles).find((n) => n.toLowerCase() === requested.toLowerCase());
  if (!name && requested !== DEFAULT_PROFILE) {
    throw new Error(`no profile named '${requested}' (profiles: ${Object.keys(profiles).join(', ') || 'none'})`);
  }
  const env = {};
  const mcpServers = {};
  for (const profile of [profiles[DEFAULT_PROFILE], name && name !== DEFAULT_PROFILE ? profiles[name] : null]) {
    for (const [key, value] of Object.entries(profile?.env ?? {})) {
      if (value !== null && value !== undefined) env[key] = String(value);
    }
    Object.assign(mcpServers, profile?.mcpServers ?? profile?.servers);
  }
  return { name: name || DEFAULT_PROFILE, env, mcpServers };
}

// --profile NAME / --profile=NAME on the command line, else SKINNY_PROFILE.
// (parseArgs skips the same words; this runs first because the profile
// decides the defaults parseArgs starts from.)
export function requestedProfile(args, env) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--profile') return args[i + 1] ?? '';
    if (args[i].startsWith('--profile=')) return args[i].slice('--profile='.length);
  }
  return env.SKINNY_PROFILE || undefined;
}

export let EXTRA_CA_FILE = null; // the profile's NODE_EXTRA_CA_CERTS, once added

export function addExtraCaCertificates(file) {
  try {
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), readFileSync(file, 'utf8')]);
    return true;
  } catch (error) {
    console.error(`⚠️  Couldn't use NODE_EXTRA_CA_CERTS ${file}: ${error.message}\n`);
    return false;
  }
}

export function startupError(message) {
  console.error(`❌ Error: ${message}\n`);
  process.exit(1);
}

export let CONFIG = null;
export let PROFILE = { name: DEFAULT_PROFILE, env: {}, mcpServers: {} };
export const PROFILE_REQUEST = requestedProfile(process.argv.slice(2), process.env);
try {
  CONFIG = loadConfigFile(CONFIG_FILE);
  if (CONFIG) {
    PROFILE = resolveProfile(CONFIG, PROFILE_REQUEST ?? DEFAULT_PROFILE);
    const extraCerts = process.env.NODE_EXTRA_CA_CERTS === undefined ? PROFILE.env.NODE_EXTRA_CA_CERTS : undefined;
    for (const [key, value] of Object.entries(PROFILE.env)) if (process.env[key] === undefined) process.env[key] = value;
    // Node reads NODE_EXTRA_CA_CERTS only as it starts, so a profile's value
    // is added to the trusted certificates here instead.
    if (extraCerts) EXTRA_CA_FILE = addExtraCaCertificates(extraCerts) ? extraCerts : null;
  } else if (PROFILE_REQUEST !== undefined && PROFILE_REQUEST.toLowerCase() !== DEFAULT_PROFILE.toLowerCase()) {
    startupError(`--profile '${PROFILE_REQUEST}': there is no ${CONFIG_FILE}`);
  }
} catch (error) {
  startupError(error.message);
}
