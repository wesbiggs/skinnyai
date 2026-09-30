import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.js'],
    // Each file imports thinai.js fresh, after faking the terminal it needs.
    isolate: true
  }
});
