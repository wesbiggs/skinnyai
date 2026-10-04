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
// optional "mcpServers" block. The top-level "defaultProfile" names the profile used
// unless --profile NAME, SKINNY_PROFILE, or /set profile says otherwise.
// A top-level "shared" block (same shape as a profile) holds what every
// profile starts from, overridden by what it sets itself; and "startupEnv"
// holds settings that apply once, as skinnyai starts (a CA file, colors,
// directories), which /set profile never changes.
// Variables already in the environment win over the file, and command-line
// flags win over both. It's loaded before anything reads process.env, so
// OLLAMA_API_KEY can live there too.
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

// The name a profile goes by in the file, matched ignoring case; undefined
// if there's none.
export function findProfile(config, name) {
  const profiles = config.profiles;
  return profiles[name] ? name : Object.keys(profiles).find((n) => n.toLowerCase() === String(name).toLowerCase());
}

// The settings of one profile on top of the file's "shared" block: { name,
// env, mcpServers } (an MCP server of the same name replaces the shared one).
// env values become strings, as environment variables are. Without
// `requested` it's the file's "defaultProfile" (else the first profile). Throws if
// the profile doesn't exist.
export function resolveProfile(config, requested) {
  const profiles = config.profiles;
  const names = Object.keys(profiles);
  let name;
  if (requested !== undefined) {
    name = findProfile(config, requested);
    if (!name) throw new Error(`no profile named '${requested}' (profiles: ${names.join(', ') || 'none'})`);
  } else if (config.defaultProfile !== undefined) {
    name = findProfile(config, config.defaultProfile);
    if (!name) throw new Error(`"defaultProfile" is '${config.defaultProfile}', but there is no such profile (profiles: ${names.join(', ') || 'none'})`);
  } else {
    name = names[0];
  }
  const env = {};
  const mcpServers = {};
  for (const source of [config.shared, profiles[name]]) {
    for (const [key, value] of Object.entries(source?.env ?? {})) {
      if (value !== null && value !== undefined) env[key] = String(value);
    }
    Object.assign(mcpServers, source?.mcpServers ?? source?.servers);
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

export let EXTRA_CA_FILE = null; // the startupEnv's NODE_EXTRA_CA_CERTS, once added

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

// The variables copied from the active profile into process.env, so
// switching profiles can take them back out (ones set in the real
// environment aren't touched, and keep winning).
let injected = new Set();

// Makes `requested` (default: the file's defaultProfile) the active profile: reads
// config.json, and puts the profile's variables into process.env. At
// startup it also applies "startupEnv". Throws if the file or profile can't
// be used, leaving the current one active.
export function activateProfile(requested, { startup = false } = {}) {
  const config = loadConfigFile(CONFIG_FILE);
  if (!config) {
    if (requested !== undefined) throw new Error(`there is no ${CONFIG_FILE}`);
    CONFIG = null;
    return PROFILE;
  }
  const profile = resolveProfile(config, requested);
  for (const key of injected) delete process.env[key];
  injected = new Set();
  if (startup) {
    const startupEnv = typeof config.startupEnv === 'object' && config.startupEnv !== null ? config.startupEnv : {};
    const extraCerts = process.env.NODE_EXTRA_CA_CERTS === undefined ? startupEnv.NODE_EXTRA_CA_CERTS : undefined;
    for (const [key, value] of Object.entries(startupEnv)) {
      if (process.env[key] === undefined && value !== null && value !== undefined) process.env[key] = String(value);
    }
    // Node reads NODE_EXTRA_CA_CERTS only as it starts, so the file's value
    // is added to the trusted certificates here instead.
    if (extraCerts) EXTRA_CA_FILE = addExtraCaCertificates(String(extraCerts)) ? String(extraCerts) : null;
  }
  for (const [key, value] of Object.entries(profile.env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      injected.add(key);
    }
  }
  CONFIG = config;
  PROFILE = profile;
  return profile;
}

try {
  activateProfile(PROFILE_REQUEST, { startup: true });
} catch (error) {
  startupError(error.message);
}
