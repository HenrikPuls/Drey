// @ts-check
import { readdirSync } from 'node:fs';
import tseslint from 'typescript-eslint';

/**
 * This config is intentionally narrow. It is not a style pass over the
 * codebase -- it enforces four things:
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
 * 3. No promise is dropped by accident (`no-floating-promises`,
 *    `no-misused-promises`): most of the app is async IPC, and a call
 *    nobody awaits loses its error. A promise that is meant to run on its
 *    own is marked `void`, with its failure handled where it matters.
 *    These two rules need type information, so every linted file must
 *    belong to one of the tsconfig projects listed below.
 * 4. The dependency rules between the four parts (docs/05, "The
 *    dependency rules"): `shared/` imports from none of the others,
 *    renderer and main never import each other, the base imports no
 *    plugin, and a plugin imports only its own folder and `shared/`.
 *    They run under `@typescript-eslint/no-restricted-imports`, so the
 *    barrel rule's `off` inside a module (plain `no-restricted-imports`)
 *    does not switch them off. Type-only imports count too -- the
 *    contract between the parts is `shared/`.
 */

/** A relative import that reaches into one of the repo's top-level parts. */
const layer = (dir, message) => ({ group: [`**/${dir}/**`], message });

const NO_RENDERER = layer(
  'src',
  'Only the renderer imports `src/`. What both sides need belongs in `shared/`.',
);
const NO_MAIN = layer(
  'electron',
  'Only the main process imports `electron/`. What both sides need belongs in `shared/` (`shared/ipc-api.ts` is the contract).',
);
const NO_PLUGINS = layer(
  'plugins',
  'The base never imports a plugin -- it reaches plugin behaviour through a registry the plugin filled (ADR-0044).',
);

const PLUGIN_IDS = readdirSync(new URL('./plugins', import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/** From inside `plugins/<id>/`, every way up and over into a sibling plugin. */
const otherPluginPatterns = (id) =>
  PLUGIN_IDS.filter((other) => other !== id).map((other) => ({
    group: ['..', '../..', '../../..', '../../../..'].map((up) => `${up}/${other}/**`),
    message: `A plugin never imports another plugin (\`${other}\`) -- share through \`shared/\` or a base registry (ADR-0044).`,
  }));

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
    ignores: ['dist/**', 'dist-electron/**', 'dist-plugins/**', '.angular/**', '.tools/**', 'node_modules/**', 'plugins/*/vendor/**'],
  },
  {
    // Only a few rules are enabled, so don't flag inline disables that
    // target rules this config doesn't run.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    // Register the plugin so rule names in existing inline disable
    // directives resolve.
    files: ['**/*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: [
          'electron/tsconfig.json',
          'electron/tsconfig.spec.json',
          'tsconfig.app.json',
          'tsconfig.spec.json',
          'plugins/tsconfig.main.json',
          'plugins/tsconfig.renderer.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
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
              'external-open',
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
      'src/app/external-open/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    // The dependency rules between the four parts (docs/05).
    files: ['shared/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [NO_RENDERER, NO_MAIN, NO_PLUGINS] },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [NO_MAIN, NO_PLUGINS] }],
    },
  },
  {
    files: ['electron/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [NO_RENDERER, NO_PLUGINS] },
      ],
    },
  },
  // Plugin authoring rules (ADR-0044 rules 1 + 2) plus the plugin's side of
  // the dependency rules: its own folder and `shared/`, nothing else.
  // `allowTypeImports` keeps the ADR's escape hatch: a plugin may *type*
  // against the host's CodeMirror classes
  // (`import type { EditorView } from '@codemirror/view'`), it just can't
  // load its own runtime copy.
  ...PLUGIN_IDS.map((id) => ({
    files: [`plugins/${id}/**/*.ts`],
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
            NO_RENDERER,
            {
              ...NO_MAIN,
              message:
                'A plugin works through its `MainPluginContext` and `shared/`, never a file under `electron/` (ADR-0044).',
            },
            ...otherPluginPatterns(id),
          ],
        },
      ],
    },
  })),
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
