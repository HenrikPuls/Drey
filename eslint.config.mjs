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

const MODULES = ['llm', 'tags', 'tasks', 'mcp'];

/** Reaching into `shared/<mod>/` from anywhere by its `shared/`-qualified path. */
const sharedModulePatterns = MODULES.map((mod) => ({
  group: [`**/shared/${mod}/*`, `**/shared/${mod}/*/*`, `!**/shared/${mod}/index`],
  message: `Import from the module barrel (\`shared/${mod}\`), not a file inside it. The barrel is the module's only public surface.`,
}));

/**
 * Reaching into a sibling `<mod>/` folder by a relative path. Safe to apply
 * inside `electron/` and `shared/` (no innocent `llm/` or `tags/` subfolder
 * exists there).
 */
const relativeModulePatterns = (mods) =>
  mods.map((mod) => ({
    group: [`./${mod}/*`, `../${mod}/*`, `../../${mod}/*`, `!**/${mod}/index`],
    message: `Import from the module barrel (\`./${mod}\`), not a file inside it. The barrel is the module's only public surface.`,
  }));

/**
 * Same, minus the `./${mod}/*` form. For a renderer feature module whose
 * name also exists as a `src/app/settings/<mod>/` *plain* folder (`llm`,
 * `assistant`, `entry`): from `src/app/settings/settings.ts` a
 * `./​<mod>/settings-<mod>` import is that settings folder, not the feature
 * module, and must not be flagged. Deep imports from further out
 * (`../<mod>/x`, `../../<mod>/x`) are still caught.
 */
const relativeModulePatternsDeepOnly = (mods) =>
  mods.map((mod) => ({
    group: [`../${mod}/*`, `../../${mod}/*`, `!**/${mod}/index`],
    message: `Import from the module barrel (\`../${mod}\`), not a file inside it. The barrel is the module's only public surface.`,
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
            ...relativeModulePatterns([
              'tags',
              'tasks',
              'keybindings',
              'dock',
              'titlebar',
              'widgets',
              'calendar',
              'vault',
            ]),
            ...relativeModulePatternsDeepOnly(['llm', 'assistant', 'entry']),
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
      'electron/tasks/**/*.ts',
      'shared/tasks/**/*.ts',
      'electron/mcp/**/*.ts',
      'src/app/tags/**/*.ts',
      'src/app/tasks/**/*.ts',
      'src/app/templates/**/*.ts',
      'src/app/keybindings/**/*.ts',
      'src/app/dock/**/*.ts',
      'src/app/titlebar/**/*.ts',
      'src/app/widgets/**/*.ts',
      'src/app/llm/**/*.ts',
      'src/app/assistant/**/*.ts',
      'src/app/entry/**/*.ts',
      'src/app/calendar/**/*.ts',
      'src/app/vault/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
);
