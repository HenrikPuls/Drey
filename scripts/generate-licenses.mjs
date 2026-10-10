// Regenerates src/assets/licenses.json: the license manifest the "About"
// settings pane shows. Runs as the `prebuild` hook so a shipped build can
// never carry a stale list.
//
// Scope: production dependencies only (`dependencies` in package.json, which
// holds both the Electron-main and the renderer packages -- there is one
// root manifest, not a per-process split). devDependencies are the
// toolchain and are not distributed, so they are left out.
//
// This is a superset of Angular's own `dist/drey/3rdpartylicenses.txt`
// (which the production build extracts, but only for the JS bundled into
// the renderer). The manifest here also covers main-process packages
// (yaml, nspell, chokidar, ...) and is structured (name / version /
// license / text) so the pane can render it as a list.

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// license-checker-rseidelsohn is a CommonJS module with no ESM default
// export -- pull it in through `require` from this .mjs script.
const require = createRequire(import.meta.url);
const checker = require('license-checker-rseidelsohn');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = resolve(repoRoot, 'src/assets/licenses.json');
const drawioPin = JSON.parse(
  readFileSync(resolve(repoRoot, 'plugins/drawio/drawio-version.json'), 'utf8'),
);

checker.init(
  {
    start: repoRoot,
    production: true,
    // Our own package is `private` -- keep it out of the third-party list.
    excludePrivatePackages: true,
  },
  (err, packages) => {
    if (err) {
      console.error('[licenses:generate] license-checker failed:', err);
      process.exit(1);
    }

    const list = Object.entries(packages)
      .map(([id, info]) => {
        // id is "name@version"; the name itself may be scoped ("@scope/x"),
        // so split on the last "@".
        const at = id.lastIndexOf('@');
        const name = id.slice(0, at);
        const version = id.slice(at + 1);

        let licenseText = '';
        if (info.licenseFile) {
          try {
            licenseText = readFileSync(info.licenseFile, 'utf8');
          } catch {
            // A missing license file is not fatal -- the name still tells
            // the reader which license applies.
          }
        }

        return {
          name,
          version,
          license: Array.isArray(info.licenses)
            ? info.licenses.join(' OR ')
            : (info.licenses ?? 'UNKNOWN'),
          repository: info.repository ?? null,
          publisher: info.publisher ?? null,
          licenseText,
        };
      })
      // Not an npm package: the draw.io web app the diagrams plugin embeds
      // (ADR-0064), fetched by scripts/fetch-drawio.mjs. A fixed text, not
      // the fetched file, so the list is the same with and without it.
      .concat([
        {
          name: 'draw.io (bundled diagram editor)',
          version: drawioPin.version,
          license: 'Apache-2.0',
          repository: 'https://github.com/jgraph/drawio',
          publisher: 'JGraph Ltd / draw.io AG',
          licenseText:
            'Licensed under the Apache License, Version 2.0. The full text ships with the ' +
            'app next to the editor files (plugins/drawio/webapp/LICENSE) and is available ' +
            'at https://www.apache.org/licenses/LICENSE-2.0\n\n' +
            'draw.io is a registered trademark of draw.io AG. Drey is not affiliated with, ' +
            'endorsed by or sponsored by draw.io.\n',
        },
      ])
      .sort((a, b) => a.name.localeCompare(b.name));

    // No timestamp on purpose: the file must be byte-stable when the
    // dependency tree is unchanged, so `prebuild` produces no git noise.
    const payload = { count: list.length, packages: list };

    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(`[licenses:generate] wrote ${list.length} packages to ${outFile}`);
  },
);
