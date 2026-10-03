import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['bin/', 'build/', 'dist/', 'macos/', '.build/', 'node_modules/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules: {
      // A terminal program: escape sequences in regexes are the point.
      'no-control-regex': 'off',
      // Ignored catch bindings are fine; unused variables and arguments are not.
      'no-unused-vars': ['error', { caughtErrors: 'none' }]
    }
  }
];
