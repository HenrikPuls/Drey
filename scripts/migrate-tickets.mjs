// CLI for the ticket migration (E14-3): dry run, apply into a SCRATCH dricket
// store, reverse converter. Needs the plugin build (`npm run build:plugins`)
// so dist-electron/packages/ exists. The legacy vault is only ever read.
//
//   node scripts/migrate-tickets.mjs --legacy <vault> --allow <ids.txt>
//   node scripts/migrate-tickets.mjs --legacy <vault> --allow <ids.txt> --apply --store <new dir> --dk <dk> [--report <file>]
//   node scripts/migrate-tickets.mjs --reverse --store <dricket store> --out <new dir> --dk <dk>
//
// The cut-over passes --include-archive (all tickets migrate, O-3); the exact
// sequence is docs/design/dricket/cutover-guide.md, section C.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist-electron', 'packages', 'tickets-engine', 'src', 'migrate', 'cli.js');
const { runMigrateCli } = await import(pathToFileURL(cli).href);
process.exitCode = await runMigrateCli(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
