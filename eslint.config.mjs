// @ts-check
import tseslint from 'typescript-eslint';

/**
 * This config is intentionally narrow. It is not a full lint pass over the
 * codebase -- it exists to enforce the feature-module boundaries introduced
 * with the path-based-tags restructure: code outside a feature module
 * (`electron/llm/`, `shared/llm/`, `electron/tags/`, `shared/tags/`,
 * `src/app/tags/`, `src/app/keybindings/`) must import through the
 * module's `index.ts` barrel,
 * never reach into a file inside it. Internal files import their siblings
 * directly.
 */

const MODULES = ['llm', 'tags', 'mcp'];

/** Reaching into `shared/<mod>/` from anywhere by its `shared/`-qualified path. */
const sharedModulePatterns = MODULES.map((mod) => ({
  group: [`**/shared/${mod}/*`, `**/shared/${mod}/*/*`, `!**/shared/${mod}/index`],
  message: `Import from the module barrel (\`shared/${mod}\`), not a file inside it. The barrel is the module's only public surface.`,
}));

/**
 * Reaching into a sibling `<mod>/` folder by a relative path. Safe to apply
 * inside `electron/` and `shared/` (no innocent `llm/` or `tags/` subfolder
 * exists there); for `src/` `tags/` and `keybindings/` are feature modules,
 * so `llm/` is left out (`src/app/settings/llm/` is a plain folder).
 */
const relativeModulePatterns = (mods) =>
  mods.map((mod) => ({
    group: [`./${mod}/*`, `../${mod}/*`, `../../${mod}/*`, `!**/${mod}/index`],
    message: `Import from the module barrel (\`./${mod}\`), not a file inside it. The barrel is the module's only public surface.`,
  }));

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
      'no-restricted-imports': [
        'error',
        { patterns: [...sharedModulePatterns, ...relativeModulePatterns(MODULES)] },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...sharedModulePatterns,
            ...relativeModulePatterns(['tags', 'keybindings', 'dock', 'titlebar']),
          ],
        },
      ],
    },
  },
  {
    // A feature module's own files reach their siblings directly.
    files: [
      'electron/llm/**/*.ts',
      'shared/llm/**/*.ts',
      'electron/tags/**/*.ts',
      'shared/tags/**/*.ts',
      'electron/mcp/**/*.ts',
      'src/app/tags/**/*.ts',
      'src/app/keybindings/**/*.ts',
      'src/app/dock/**/*.ts',
      'src/app/titlebar/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
);
