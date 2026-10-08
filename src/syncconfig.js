import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SKINNY_HOME } from './config.js';

// The projects this device syncs, and where each one's folder is on this
// device (the same project can sit at different paths on different
// devices). The name is a local label; the folder holds only a suggestion.
// `default` is the project new chats join. One small file for the
// installation, not part of any profile.
export const SYNC_CONFIG_FILE = path.join(SKINNY_HOME, 'sync.json');

export function loadSyncConfig() {
  try {
    const saved = JSON.parse(readFileSync(SYNC_CONFIG_FILE, 'utf8'));
    const projects = Array.isArray(saved.projects) ? saved.projects.filter((p) => p && p.id && p.folder && p.name) : [];
    return { default: projects.some((p) => p.id === saved.default) ? saved.default : null, projects };
  } catch (error) {
    return { default: null, projects: [] };
  }
}

export function saveSyncConfig(config) {
  mkdirSync(path.dirname(SYNC_CONFIG_FILE), { recursive: true });
  writeFileSync(SYNC_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

// A project by name (ignoring case) or by the start of its id.
export function findProject(config, ref) {
  const wanted = (ref ?? '').trim().toLowerCase();
  if (!wanted) return null;
  return config.projects.find((p) => p.name.toLowerCase() === wanted) ?? config.projects.find((p) => p.id.startsWith(wanted)) ?? null;
}

export const defaultProject = (config) => config.projects.find((p) => p.id === config.default) ?? null;

// Adds (or updates) a project; the first one added becomes the default.
export function addProject(project) {
  const config = loadSyncConfig();
  const others = config.projects.filter((p) => p.id !== project.id);
  const next = { default: config.default ?? project.id, projects: [...others, project] };
  saveSyncConfig(next);
  return next;
}

export function removeProject(id) {
  const config = loadSyncConfig();
  const projects = config.projects.filter((p) => p.id !== id);
  const next = { default: config.default === id ? projects[0]?.id ?? null : config.default, projects };
  saveSyncConfig(next);
  return next;
}

export function setDefaultProject(id) {
  const config = loadSyncConfig();
  saveSyncConfig({ ...config, default: id });
}

export function renameProject(id, name) {
  const config = loadSyncConfig();
  saveSyncConfig({ ...config, projects: config.projects.map((p) => (p.id === id ? { ...p, name } : p)) });
}
