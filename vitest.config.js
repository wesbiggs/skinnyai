import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.js'],
    // Each file imports skinnyai.js fresh, after faking the terminal it needs.
    isolate: true,
    // SwiftPM checkouts in .build carry their own test files.
    exclude: [...configDefaults.exclude, '.build/**']
  }
});
