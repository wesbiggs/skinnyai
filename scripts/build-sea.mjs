#!/usr/bin/env node
// Builds dist/skinnyai, a standalone executable: this machine's node binary
// with the bundled script injected (Node single-executable application).
//   node scripts/build-sea.mjs [--out dist/skinnyai]
// Node 24's SEA only accepts CommonJS, hence the esbuild step.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outIndex = process.argv.indexOf('--out');
const out = path.resolve(root, outIndex > 0 ? process.argv[outIndex + 1] : 'dist/skinnyai');
const work = path.join(root, 'build', 'sea');
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(path.dirname(out), { recursive: true });

const bundle = path.join(work, 'skinnyai.cjs');
await build({
  entryPoints: [path.join(root, 'build/sea-entry.js')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  define: { 'import.meta.url': '"file:///skinnyai-sea"' },
  logLevel: 'warning'
});

const config = path.join(work, 'sea-config.json');
const blob = path.join(work, 'skinnyai.blob');
fs.writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });

fs.copyFileSync(process.execPath, out);
fs.chmodSync(out, 0o755);
const darwin = process.platform === 'darwin';
if (darwin) execFileSync('codesign', ['--remove-signature', out], { stdio: 'inherit' });
const postject = path.join(root, 'node_modules', '.bin', 'postject');
execFileSync(postject, [
  out, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(darwin ? ['--macho-segment-name', 'NODE_SEA'] : [])
], { stdio: 'inherit' });
// Ad-hoc signature so it runs locally; scripts/build-app.sh re-signs for release.
if (darwin) execFileSync('codesign', ['--sign', '-', out], { stdio: 'inherit' });
console.log(`Built ${path.relative(root, out)} (${(fs.statSync(out).size / 1e6).toFixed(0)} MB)`);
