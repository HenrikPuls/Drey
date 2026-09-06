// @ts-check
import tseslint from 'typescript-eslint';

/**
 * This config is intentionally narrow. It is not a full lint pass over the
 * codebase -- it exists to enforce the feature-module boundaries introduced
 * with the path-based-tags restructure: code outside `electron/llm/` /
 * `shared/llm/` (and later the `tags/` modules) must import through the
 * module's `index.ts` barrel, never reach into a file inside it. Internal
 * files import their siblings directly.
 */

/** Reaching into `shared/llm/` from anywhere by its `shared/`-qualified path. */
const SHARED_LLM = {
  group: ['**/shared/llm/*', '**/shared/llm/*/*', '!**/shared/llm/index'],
  message:
    'Import from the module barrel (`shared/llm`), not a file inside it. The barrel is the module’s only public surface.',
};

/** Reaching into a sibling `llm/` folder by a relative path (used inside electron/ and shared/). */
const LOCAL_LLM = {
  group: ['./llm/*', '../llm/*', '../../llm/*', '!**/llm/index'],
  message:
    'Import from the module barrel (`./llm`), not a file inside it. The barrel is the module’s only public surface.',
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'dist-electron/**', '.angular/**', '.tools/**', 'node_modules/**'],
  },
  {
    // A full lint pass (which would use these directives) is not set up yet;
    // this config only guards module boundaries, so don't flag inline
    // disables that target rules it doesn't enable.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    // Register the plugin so rule names in existing inline disable
    // directives resolve; no @typescript-eslint rules are enabled here.
    files: ['**/*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: false },
    },
  },
  {
    files: ['electron/**/*.ts', 'shared/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [SHARED_LLM, LOCAL_LLM] }],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [SHARED_LLM] }],
    },
  },
  {
    // A feature module's own files reach their siblings directly.
    files: ['electron/llm/**/*.ts', 'shared/llm/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
);
