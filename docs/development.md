# Development

The source is the ES modules in `src/` (entry `src/skinnyai.js`); `npm run build` minifies it into the single file `bin/skinnyai.js` (not checked in, about 90 KB), which has no runtime dependencies beyond Node.js. esbuild and postject are build tools only. `CLAUDE.md` has a module-by-module orientation and the reasoning behind non-obvious decisions.

```bash
npm install
npm run ollama -- llama2                                          # run from source
npm run openai -- my-model --host http://localhost:8000
npm run build                                                      # bin/skinnyai.js
```

## Tests

Tests use [Vitest](https://vitest.dev) (a dev dependency):

```bash
npm test            # or: npm run test:watch
```

They cover markdown rendering (checked against a small terminal emulator, so wrapping and table borders are tested as they'd appear on screen), emoji widths, inline images, the line editor (driven with simulated keystrokes), the Modelfile format, `config.json` profiles and flag handling, and `/save`, `/load`, `/share`, and autosave. `test/cli.test.js` runs the CLI end to end against a mock server that speaks the Ollama, OpenAI, and Anthropic APIs; set `SKINNYAI_SCRIPT` to run it against the built `bin/skinnyai.js`. Tests use a temporary `SKINNY_HOME`, so they never touch your real `~/.skinny`.

GitHub Actions ([`ci.yml`](../.github/workflows/ci.yml)) runs the suite on Node 22 and 24 for every push to `main` and every pull request. No real terminal is needed: the tests fake one, including iTerm2 and kitty image support, so everything runs headless on Linux. Pushing a `v*` tag runs [`release.yml`](../.github/workflows/release.yml), which lints, tests, builds, and attaches `skinnyai.js` and its checksum to a GitHub release.

The macOS app's UI and terminal behavior aren't covered by tests; see [macos-app.md](macos-app.md) for building it.
