#!/usr/bin/env node
// Builds bin/skinnyai.js from src/: one minified, dependency-free ESM file
// with a shebang, the smallest way to install the CLI (all it needs is Node).
//   node scripts/build-cli.mjs [--out bin/skinnyai.js]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outIndex = process.argv.indexOf('--out');
const out = path.resolve(root, outIndex > 0 ? process.argv[outIndex + 1] : 'bin/skinnyai.js');

await build({
  entryPoints: [path.join(root, 'src/skinnyai.js')],
  outfile: out,
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  logLevel: 'warning'
});
fs.chmodSync(out, 0o755);
console.log(`Built ${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
