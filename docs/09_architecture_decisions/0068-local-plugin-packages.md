# 68. Local plugin packages and the sample plugin out of the default scope

## Status

Accepted (milestone 70, owner request). Completes ADR-0044's
`<userData>/plugins/<id>/` discovery root with a first install path, and
demotes the `sample` plugin from the built-in set to a dev/test artifact
(loosening ADR-0044's packaging addendum, which already kept it out of
the installer).

## Context

ADR-0044 established runtime plugins and a discovery order — built-ins
from `dist-electron/plugins/`, user-installed from
`<userData>/plugins/<id>/` — but "user-installed" had no install path:
putting a folder there by hand was the only way. Two follow-ups arose
together:

- The **sample plugin** (the executable authoring reference) was built
  into `dist-electron/` on every build. The packaging already excluded it
  from the installer (ADR-0023's `electron-builder.yml` negation,
  asserted by `verify-pack.mjs`), but every dev run still discovered and
  activated it — an extra right-dock panel, a File-menu row and a
  `Mod+Alt+J` command nobody asked for outside e2e.
- Plugin **distribution** needed a first step: how does a plugin reach a
  real Drey without being merged into the repository?

The owner asked for: sample as test/SDK-reference only, an SDK tutorial
with the sample as the example, and local installation via a file pick.

## Decision

**1 · The sample plugin leaves the default build.**
`scripts/build-plugins.mjs` produces it only when
`DREY_BUILD_SAMPLE_PLUGINS=1` is set (the `npm run e2e` script sets it);
without the flag the script removes the tsc-emitted
`dist-electron/plugins/sample/` again — the tsconfigs keep compiling it,
so the reference stays type-checked. No ordinary dev run, `npm run app`
run or package discovers it. The `plugins/sample/` **source** stays in
the repository as the tutorial's running example; `plugins/TUTORIAL.md`
is the step-by-step guide (manifest → main → renderer → build → package
→ install), `plugins/AUTHORING.md` remains the reference.

**2 · A plugin package is a `.zip` of the built plugin folder.**
`plugin.json` at the archive root, the folder's contents as the
archive's contents — exactly what `build-plugins.mjs` emits into
`dist-electron/plugins/<id>/`. One format, one step, no manifest
checksums: validation reads what discovery would read anyway.

**3 · Install = validate, extract under the user root, apply on
restart.** Settings → Panels & plugins → "Install from file…" opens the
native `.zip` pick; `PluginInstaller`
(`electron/plugin-host/plugin-installer.ts`) then:

- reads the archive with a dependency-free central-directory reader (a
  TypeScript twin of `scripts/fetch-drawio.mjs`'s; stored + deflated,
  no zip64), size-capped (256 MB archive, 1 GB expanded);
- normalizes separators (PowerShell's `Compress-Archive` writes
  backslash entry names), skips archive junk (`__MACOSX`, resource
  forks, dot-files) and **refuses** every path that could leave the
  plugin folder (zip-slip), every absolute/drive/`..` form;
- validates the manifest with the discovery rules (`validateManifest`)
  and **rejects what could not load anyway**: a wrong `apiVersion`
  major, manifest entries (`main`, `renderer`, `css`) missing from the
  archive, an id colliding with a discovered **built-in** (built-ins
  win discovery; a shadowed install would only confuse);
- extracts to `<userData>/plugins/.staging-<id>/`, preserves an
  existing install's `config.json` (the plugin's own settings,
  ADR-0044's `PluginConfigStore` lives inside the plugin folder), then
  swaps the folder into place.

Like `plugins.disabled`, the change applies **on the next start** —
discovery and activation run once at boot; a live re-activation round
would touch every registry for a rare action. The dialog that follows
offers "Restart now" (`app:relaunch`: `app.relaunch()` + the window's
normal close path, so dirty tabs keep their exit prompt and will-quit
hooks run).

**4 · Remove mirrors install.** The Remove action on installed
(non-built-in) rows in the same settings page deletes
`<userData>/plugins/<id>/` (recycle bin first), also applying on
restart. Built-in ids are refused — their `config.json` lives in the
same tree and their code is not on this disk.

**5 · The trust model is unchanged.** A package is code the user
deliberately picked from their own disk; it runs in-process with full
rights exactly like a built-in (ADR-0044). No signature, no sandbox, no
permission enforcement — validation refuses only what could not load
anyway plus traversal attempts. There is no marketplace and no
auto-update in this step; "upgrade" is installing again.

## Consequences

- A plugin author needs no repository merge: build in a checkout, zip
  the built folder, install. Upgrades keep the plugin's config; the
  files are replaced wholesale (a stale file from an older version is
  gone, not left behind).
- An install/remove while the same plugin is active leaves the running
  instance untouched until restart — worst case its renderer modules
  404 for the remainder of the session; the restart offer makes that
  window short and deliberate.
- The e2e suite covers the installer without driving the native dialog:
  pick and install are separate IPC channels, and
  `e2e/plugins.spec.ts` writes packages with a small store-only zip
  maker (valid, broken-manifest, zip-slip, api-version, built-in
  collision, upgrade-keeps-config, removal).
- `npm run e2e` is the only entry that builds the sample plugin;
  `npm run e2e:run` against a plain `npm run build` fails fast in
  `plugins.spec.ts` with the remedy in the message.
- The zip reader exists twice (script + installer, different module
  systems); a parity note keeps them findable, mirroring the
  codebase's twin convention.
- Later steps can build on the format: a marketplace or an auto-updater
  would download the same package and hand it to the same installer;
  signatures would slot into validation without touching the layout.
