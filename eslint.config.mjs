// @ts-check
import tseslint from 'typescript-eslint';

/**
 * This config is intentionally narrow. It is not a full lint pass over the
 * codebase -- it enforces two things:
 *
 * 1. The feature-module barrels (ADR-0016): code outside a module must
 *    import through the module's `index.ts`, never reach into a file inside
 *    it. Since ADR-0044 the feature modules (tags, tasks, templates,
 *    meeting, assistant, browser) are runtime plugins under `plugins/` --
 *    what remains are the *base* modules listed below.
 * 2. The plugin authoring rules (ADR-0044): plugins never import
 *    `@codemirror/*` or `@angular/*` at runtime (extensions compose from
 *    the host's CM module instances -- a plugin's own copies break facets
 *    silently -- and plugin UI is plain DOM, not Angular), and a plugin's
 *    renderer entry has no Node access.
 */

const MODULES = ['llm', 'mcp', 'session', 'plugin-host'];

/** `shared/<mod>/` folders that actually exist (the shared half of `llm`). */
const SHARED_MODULES = ['llm'];

/** Reaching into `shared/<mod>/` from anywhere by its `shared/`-qualified path. */
const sharedModulePatterns = SHARED_MODULES.map((mod) => ({
  group: [`**/shared/${mod}/*`, `**/shared/${mod}/*/*`, `!**/shared/${mod}/index`],
  message: `Import from the module barrel (\`shared/${mod}\`), not a file inside it. The barrel is the module's only public surface.`,
}));

/**
 * Reaching into a sibling `<mod>/` folder by a relative path. Safe to apply
 * inside `electron/` and `shared/` (no innocent `llm/` subfolder exists
 * there).
 */
const relativeModulePatterns = (mods) =>
  mods.map((mod) => ({
    group: [`./${mod}/*`, `../${mod}/*`, `../../${mod}/*`, `!**/${mod}/index`],
    message: `Import from the module barrel (\`./${mod}\`), not a file inside it. The barrel is the module's only public surface.`,
  }));

/**
 * Same, minus the `./${mod}/*` form. For a renderer module whose name also
 * exists as a `src/app/settings/<mod>/` *plain* folder (`llm`, `entry`):
 * from `src/app/settings/settings.ts` a `./<mod>/settings-<mod>` import is
 * that settings folder, not the module, and must not be flagged. Deep
 * imports from further out (`../<mod>/x`, `../../<mod>/x`) are still
 * caught.
 */
const relativeModulePatternsDeepOnly = (mods) =>
  mods.map((mod) => ({
    group: [`../${mod}/*`, `../../${mod}/*`, `!**/${mod}/index`],
    message: `Import from the module barrel (\`../${mod}\`), not a file inside it. The barrel is the module's only public surface.`,
  }));

export default tseslint.config(
  {
    ignores: ['dist/**', 'dist-electron/**', 'dist-plugins/**', '.angular/**', '.tools/**', 'node_modules/**'],
  },
  {
    // A full lint pass (which would use these directives) is not set up yet;
    // this config only guards module boundaries, so don't flag inline
    // disables that target rules it doesn't enable.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    // Register the plugin so rule names in existing inline disable
    // directives resolve.
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
              'session',
              'keybindings',
              'dock',
              'titlebar',
              'widgets',
              'calendar',
              'plugin-host',
            ]),
            // `llm` / `entry` / `vault` also exist as `src/app/settings/<mod>/`
            // plain folders -- from the settings screen the `./` form is that
            // folder, not the module.
            ...relativeModulePatternsDeepOnly(['llm', 'entry', 'vault']),
          ],
        },
      ],
    },
  },
  {
    // A module's own files reach their siblings directly.
    files: [
      'electron/llm/**/*.ts',
      'shared/llm/**/*.ts',
      'electron/mcp/**/*.ts',
      'electron/plugin-host/**/*.ts',
      'electron/session/**/*.ts',
      'src/app/session/**/*.ts',
      'src/app/keybindings/**/*.ts',
      'src/app/dock/**/*.ts',
      'src/app/titlebar/**/*.ts',
      'src/app/widgets/**/*.ts',
      'src/app/llm/**/*.ts',
      'src/app/entry/**/*.ts',
      'src/app/calendar/**/*.ts',
      'src/app/vault/**/*.ts',
      'src/app/plugin-host/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // Plugin authoring rules (ADR-0044 rules 1 + 2). `allowTypeImports`
    // keeps the ADR's escape hatch: a plugin may *type* against the host's
    // CodeMirror classes (`import type { EditorView } from '@codemirror/view'`),
    // it just can't load its own runtime copy.
    files: ['plugins/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@codemirror/*', '@codemirror'],
              allowTypeImports: true,
              message:
                'Plugins must not load their own CodeMirror runtime copy -- extensions only compose from the host instances via `api.editor.cm` (ADR-0044 rule 1); `import type` is fine.',
            },
            {
              group: ['@angular/*', '@angular'],
              message:
                'Plugin UI is plain DOM mounted into host-provided elements, not Angular components (ADR-0044 rule 2).',
            },
          ],
        },
      ],
    },
  },
  {
    // A plugin's renderer entry runs in the browser context: no Node, no
    // electron. (Its main entry may -- that's the trusted-model split.)
    files: ['plugins/*/renderer/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'node:*', 'fs', 'path', 'os'],
              message:
                "A plugin's renderer runs in the browser context with no Node integration -- go through `api.backend` / `api.vault` (ADR-0044).",
            },
          ],
        },
      ],
    },
  },
);
