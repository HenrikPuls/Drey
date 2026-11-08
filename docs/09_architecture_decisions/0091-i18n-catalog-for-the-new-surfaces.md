# 91. One message catalog and ICU runtime for the new surfaces

## Status

Accepted (owner decision O-4, 2026-11-06; built as roadmap item req-102,
**not yet manually verified by the owner**). Amends the "Language
Convention" of `CLAUDE.md`: UI text stays English by convention, but every
user-visible string of the surfaces decided on 2026-11-06 is sourced from
the catalog this ADR introduces. The existing UI is **not** migrated by
this decision (see "What this does not do").

## Context

Every string Drey shows is English and hard-coded: a label is a literal in a
component, a plugin's plain-DOM view or a native dialog call; a count is
assembled (`` `${n} runs` ``); a date is `toLocaleDateString()` with whatever
locale the machine has. The design canvas of 2026-11-06 (concept
`docs/design/work-panel/architecture-concept-v2.md`, §7 and §8.1) decided a
round of new surfaces — the Autopilot switch (req-95), the one state list
(req-99), the decision card (req-97), the cost table and the estimate format
(req-98), the Notes clients (req-101) and the iPad panes (req-96) — on
**four runtimes at once**: the Electron main process (native dialogs), the
Drey renderer (Angular), the plain-DOM plugins (esbuild-bundled, no
framework, no package imports at runtime — ADR-0044) and Mission Control
(Angular, `apps/mission-control` + `libs/mission-ui`, served to phone and
iPad).

The owner ruled that these surfaces are written **once, translatable from
the start**: no hard-coded UI strings, no sentences assembled from parts,
ICU plurals, `Intl` for numbers, dates and currency, layouts that tolerate
labels 40 percent longer. English is the first and only shipped locale.
The mechanism (O-4): one ICU runtime, `intl-messageformat`, with JSON
catalogs in `shared/`, used by all four runtimes.

What this has to settle: where the catalog lives and how each runtime
reaches it without a second copy of the ICU library (a plugin bundle may
not import packages, ADR-0044 rule 1), how a key is named, what happens on
a missing key, how the rule "no literal strings on the new surfaces" is
enforced rather than hoped for, and the explicit scope — the hundreds of
existing strings do not move in this step.

## Decision

1. **One module, `shared/i18n/`**, owns the catalog and the runtime:
   `catalog/en.json` (flat `key → ICU message`), `catalog.ts` (the loader,
   `MessageKey` derived from the English file, the key grammar),
   `facade.ts` (`createI18n` → `t`, `lookup`, `has`, the Intl helpers,
   the missing-key report), `intl.ts` (numbers, currency, the currency
   range, durations, dates, times, relative times — all through `Intl`,
   none by string assembly), `types.ts` (the `I18n` interface) and the
   barrel `index.ts` with the shared English instance `i18n`.
   `intl-messageformat` is the one ICU runtime (a `dependencies` entry;
   ESM for the two Angular bundles, CJS for main). The catalog is part of
   every bundle: a plain import, nothing fetched or read at runtime.

2. **Each runtime binds the module once; plugins get it from the host.**
   - Main: a plain import — `i18n.t('autopilot.title')` from
     `shared/i18n`; `electron/main.ts` sets the missing-key reporter at
     startup (field log in dev, silent when packaged).
   - Drey renderer: `src/app/i18n/` — `I18nService` (`providedIn: 'root'`,
     implements `I18n`, `isDevMode()` picks the reporter) and the `t` pipe
     (`{{ 'key' | t: params }}`).
   - Plugins: `api.i18n` (renderer) and `ctx.i18n` (main), both of type
     `PluginI18nApi = I18n`, **SDK 1.46**. The renderer hands the
     `I18nService`'s own facade; main hands the shared instance. A plugin
     never imports `shared/i18n` at runtime — the lint rule
     `NO_I18N_RUNTIME` in `eslint.config.mjs` says so (type imports stay
     allowed, so a plugin can type its keys with `MessageKey`), and the
     plugin build would fail on the package import regardless. Same
     principle as the CodeMirror modules: compose from the host's
     instance, never carry a copy.
   - Mission Control: `libs/mission-ui/src/i18n/` — `McI18n`
     (`providedIn: 'root'`) and the `t` pipe (`McI18nPipe`). The shell
     needs no provider.

3. **Key naming: `<area>.<thing>[.<state>]`**, lower snake case, dots
   between segments, at least two segments — `autopilot.state.on`,
   `autopilot.resume_at`, `state.ready_to_try`, `cost.estimate.range`,
   `decision.send_back_with_comments`. The grammar is
   `MESSAGE_KEY_PATTERN`; the catalog spec holds every key to it. A key
   names *what the string is for*, never its English text (`cost.so_far`,
   not `cost.so_far_label`; `decision.accept`, not `accept_button`), so
   a wording change does not rename the key. Parameters are ICU
   placeholders in the message: `{time}` takes a string the caller has
   formatted with `formatTime`, `{n, plural, one {# run} other {# runs}}`
   takes the number. **A sentence is one message**: a caller never joins
   two messages or glues a word onto one.

4. **Missing key: the key comes back, reported once.** `t` and `lookup`
   never throw into the UI. A key the catalog lacks, or a message whose
   placeholder the call did not fill, yields the key text (visible in
   a screenshot, found by the guard) and calls the reporter the first
   time per key. The default reporter is one `console.warn`; the
   bindings pass it in dev and `silentMissingKey` in production.

5. **`Intl` for every number, date and amount.** `formatNumber`,
   `formatCurrency` (`$3.00`), `currencyRange` (`$3.00–5.20`: the
   currency once, on the low end, an en dash, no spaces — the high end is
   the locale's own rendering with its currency part removed, so a
   suffix-currency locale needs no path of its own), `formatDuration`
   (`1 hr 4 min`, two largest units, `Intl` unit words joined by
   `Intl.ListFormat`), `formatDate` (short / medium / long), `formatTime`,
   `formatDateTime`, `formatRelative` (`in 2 hours`, `yesterday`). The
   older `shared/duration.ts` (`2m 05s`, assembled) stays for the assistant
   panel until that area migrates.

6. **The guard: a spec, scoped to the new surfaces.**
   `shared/i18n/literal-guard.spec.ts` scans every `.ts` / `.html` file
   (no specs, no `.d.ts`) under the directories in
   `shared/i18n/guarded-paths.json` and every file under `src/`, `libs/`,
   `apps/`, `plugins/` or `packages/tickets-engine/src/` that opts in with
   `// i18n: catalog` in its first lines. It fails the suite on (a) a
   string literal that reads like text a person sees — a capitalised word
   (`Accept`) or two letter-only words (`in total`), outside import
   specifiers, property names, element-access keys, `case` labels,
   equality comparisons, `console.*` arguments and the decorator's
   `selector` / `templateUrl` / `styleUrl`; in a template, a text node
   with a word or a plain `title` / `aria-label` / `aria-description` /
   `placeholder` / `alt` / `label` attribute — and (b) a key passed to
   `t(..)` / `lookup(..)` / `has(..)` or a `'key' | t` pipe that the
   catalog does not have. An unavoidable literal (a product name, a mono
   id shown verbatim) is exempted per line with `i18n-ignore` in a
   comment on the same or the preceding line. The guarded directories at
   the time of this decision (every one a surface of the canvas round;
   add a directory here and in the JSON when a new surface gets one):
   `libs/mission-ui/src/autopilot/`, `libs/mission-ui/src/decision/`,
   `libs/mission-ui/src/cost/`, `libs/mission-ui/src/notes/`,
   `libs/mission-ui/src/ipad/`, `libs/mission-ui/src/i18n/`,
   `libs/mission-ui/src/shell/`, `libs/mission-ui/src/app-bar/`,
   `libs/mission-ui/src/phone/`,
   `apps/mission-control/src/app/notes/`, `src/app/i18n/`,
   `plugins/tickets/renderer/autopilot/`,
   `plugins/tickets/renderer/decision/`, `plugins/tickets/renderer/cost/`,
   `packages/tickets-engine/src/autopilot/`,
   `packages/tickets-engine/src/notes/`; migrated areas (req-106):
   `plugins/git/renderer/`, `plugins/outline/renderer/` (milestone 211,
   req-162). The spec also checks that this
   list and the JSON agree. Nothing outside the list is scanned, so the
   existing UI does not fail.

7. **The rule for new work.** Every user-visible string of the
   canvas-2026-11-06 surfaces (roadmap req-95 to req-101, and whatever is
   added to the guarded paths later) is a catalog key read through the
   runtime's binding — labels, buttons, tooltips, `aria-label`s,
   placeholders, empty states, status and error texts a user reads,
   native dialog titles and text, the names of states and verbs. Layouts
   of those surfaces are built for labels 40 percent longer than the
   English text (wrapping or truncation decided, no fixed widths sized to
   a word). A new key is added to `en.json` in the same change as its
   first use.

## What this does not do

- **The existing UI is not migrated.** Settings, the editor chrome, the
  Files panel, the Work panel, Mission Control's existing pages and every
  native dialog keep their literal English strings. They move area by
  area as they are touched — roadmap follow-up **req-106** ("migrate the
  existing UI strings into the catalog, area by area"), each area
  extending the guarded paths when it is done.
- **No second locale ships.** `SUPPORTED_LOCALES` is `['en']`; a second
  locale is one JSON file, one entry in `loadCatalog` and a locale
  setting that does not exist yet (the facade is built per locale, so
  the setting would pick the instance). No language switcher, no
  per-device locale detection, no plural rules beyond what `Intl` gives.
- **No lazy loading, no runtime catalog editing**, no translation memory,
  no extraction tool: the catalog is a hand-kept JSON file in the repo.
- **No Angular `$localize` / `i18n` attributes** (see Alternatives).

## Alternatives considered

- **Angular's built-in i18n (`i18n` attributes, `$localize`, per-locale
  builds).** Rejected: it covers two of the four runtimes (the Drey
  renderer and Mission Control) and nothing for main or the plain-DOM
  plugins; it bakes the locale in at build time (one build per locale);
  its message ids are extracted, not authored, so a plugin cannot share a
  key with the base. One runtime for all four was the owner's point.
- **A per-runtime library** (e.g. `@angular/localize` in the Angular
  apps, a hand-rolled formatter in plugins and main). Rejected: four
  places to keep in step, two plural implementations, and a plugin bundle
  carrying its own copy — the exact duplication ADR-0044 rule 1 forbids.
- **A message-format library without ICU** (template strings with
  `{name}` only). Rejected: plurals and ordinals are the common case
  (`from 3 runs`, `with 1 comment`) and ICU is the one notation
  translators already know; `intl-messageformat` is small (the parser and
  the formatter over the platform's `Intl`), pure JS, dual ESM/CJS, no
  native code.
- **Nested JSON (`autopilot: { state: { on } }`).** Rejected for a flat
  file: the key as written in code is the key in the file, greppable both
  ways; `keyof typeof en` gives the typed `MessageKey` union directly.
- **The guard as an ESLint rule (`no-restricted-syntax` selectors).**
  Considered: it would run in the editor. Rejected for this round: the
  lint runs over `.ts` only (no Angular template parser is installed) and
  a selector regex cannot know the catalog; one detector in a spec covers
  `.ts` and `.html`, checks keys against the catalog, and runs in the
  same `test:plugins` suite as every other guard (`mission-ui-language.spec`
  is its model). An ESLint rule may be added later for faster feedback.
- **Guarding the whole repo at once.** Rejected: thousands of findings
  on the first run, none of which this item fixes; the owner's scope is
  "the new surfaces first, the older ones as they are touched".

## Consequences

- Positive: one place for every new string; a typo in a key is a compile
  error (`MessageKey`) in main, the renderer and Mission Control and a
  spec failure in a plugin (`unknown-key`); plurals and number formats
  are right on the first run; a second locale is a file, not a code
  change; a reviewer can grep `en.json` for everything a surface says.
- Negative: two kinds of strings live side by side until req-106 lands —
  a reader has to know which area has migrated (the guarded-paths list
  says). The guard is a heuristic: a text literal shaped like code
  (`'px'`, a one-word lowercase label such as `'now'`) slips past, a
  code literal shaped like text (`'Pascal Case Key'`) needs an
  `i18n-ignore`. Both are accepted in exchange for zero false positives
  on an ordinary component.
- `intl-messageformat` joins the shipped dependencies (about 50 kB
  minified with its parser). It needs `Intl.PluralRules`,
  `Intl.NumberFormat`, `Intl.DateTimeFormat`, `Intl.ListFormat` and
  `Intl.RelativeTimeFormat` — all present in Electron's Chromium, Node 24
  and every browser Mission Control targets.
- `resolveJsonModule` is on in the root `tsconfig.json` and the two
  plugin tsconfigs (the main one already had it); the catalog import is a
  typed JSON module everywhere.
- The SDK grows a minor (1.46); the `I18n` type is the SDK's `PluginI18nApi`.
  `plugins/AUTHORING.md` documents it.
- `shared/i18n` is a barrel module like `shared/llm`: outside it, import
  `shared/i18n`, never a file inside (lint).
