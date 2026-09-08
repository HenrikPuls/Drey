# 16. Feature-module convention (thin barrels + ESLint-enforced boundaries)

## Status

Accepted — introduced with the path-based-tags restructure (milestones
M0.1–M0.3), extended with the keybinding module.

## Context

The process split of [ADR-0001](0001-electron-process-split-contextbridge.md)
(main / renderer / `shared/`) is the only structural seam the codebase
had. Inside each layer, files that belong to one feature sat scattered
among unrelated ones, and any file could import any other. As the LLM /
Actions code and then the tag rewrite grew, this got in the way:
refactors touched files all over a layer, and there was no declared
"public surface" for a feature — every internal helper was fair game for
an outside import.

The project owner also wants the tag and LLM features to eventually be
the seed of a **plugin system**. That argues for drawing internal module
boundaries now, with that end state in mind — but _not_ for building a
plugin runtime yet.

## Decision

### One feature folder per layer, with a thin `index.ts` barrel

The barrel is the module's **only** public surface: the one service /
class, the types that cross into other modules, and a small number of
genuinely public pure functions. Internal helpers are not re-exported. A
module's own files import their siblings directly, not through the barrel.

Current modules:

| Layer    | Folder                                  |
| -------- | --------------------------------------- |
| main     | `electron/llm/`, `electron/tags/`       |
| shared   | `shared/llm/`, `shared/tags/`           |
| renderer | `src/app/tags/`, `src/app/keybindings/` |

`shared/ipc-api.ts` stays the cross-layer contract and is **not** moved
into a module — both sides import it directly.

### The boundary is CI-enforced, narrowly

`eslint.config.mjs` (flat config, `typescript-eslint`, run via
`npm run lint`) is deliberately not a full lint pass — it exists only for
this. `no-restricted-imports` patterns make a deep import into
`**/llm/**` or `**/tags/**` (and the relative `keybindings/`) from
outside the module a CI error; the module's own files opt out. Renderer
Angular components are still imported by path where Angular needs the
class, but a cross-module component import goes through the barrel (e.g.
`SearchPanel` is re-exported from `src/app/tags/index.ts` so `Sidebar`
can import it from `../tags`).

### Feature-owns-settings — the form now, the runtime later

A settings category is a descriptor `{ id, label, hint, component }`, and
the settings screen renders its category list from a **data array** via
`*ngComponentOutlet` instead of a fixed `@switch`
([ADR-0010](0010-app-settings-storage.md)). The fuller idea — each
feature module also exporting `defaultConfig` / `normalize` slices that
`normalizeAppConfig` composes — is scaffolded but deferred; `AppConfig`
stays **one statically-typed interface** (union of all feature slices),
so "explicit typing, no `any`" holds.

### Explicitly a modular monolith

No dynamic loading, no third-party modules, no runtime config extension.
The boundaries are for maintainability and to make a future plugin
runtime a smaller step — that runtime is a named future, not this
decision.

## Consequences

- New feature code has an obvious home and a declared surface; "what may
  the rest of the app use" is the barrel, checked by CI.
- Moving a file into or out of a module is now a visible change (the
  barrel plus the ESLint file lists), not a silent one.
- The ESLint config carries no style/quality rules — that is intentional;
  a broader pass can be added later without disturbing the boundary rule.
- A little duplication at the barrel (re-exporting a component for one
  outside importer) is accepted as the price of the seam.
