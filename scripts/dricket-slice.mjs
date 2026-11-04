// CLI probe for the E14-1 slice: drives the compiled DricketTicketStore
// against a dricket store and prints each step. Needs the plugin build
// (`npm run build:plugins`) so dist-electron/packages/ exists.
//
//   node scripts/dricket-slice.mjs --store <dir> [--dk <path>] [--data <dir>] [--claim] [--actor ben.probe]
//
// Read-only by default (list + show of the first ticket). With --claim it
// also claims the first OPEN ticket and releases it to `review` -- ONLY ever
// point it at a scratch store; it never defaults to anything.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1];
};

const storeDir = opt('store');
if (!storeDir) {
  console.error('usage: node scripts/dricket-slice.mjs --store <scratch store dir> [--dk <path>] [--data <dir>] [--claim] [--actor <id>]');
  process.exit(2);
}
const base = path.join(root, 'dist-electron', 'packages', 'tickets-engine', 'src', 'store');
const { DkProcess } = await import(pathToFileURL(path.join(base, 'dk-process.js')).href);
const { DricketTicketStore } = await import(pathToFileURL(path.join(base, 'dricket-ticket-store.js')).href);

const store = new DricketTicketStore(
  new DkProcess({ bin: opt('dk') ?? 'dk', store: path.resolve(storeDir), dataDir: opt('data') ?? null }),
);
const actor = opt('actor') ?? 'ben.probe';
const show = (label, value) => console.log(`\n# ${label}\n${JSON.stringify(value, null, 2)}`);

try {
  show('capabilities', await store.capabilities());
  const rows = await store.list();
  show(`list (${rows.length})`, rows.map((r) => ({ id: r.id, stage: r.stage, owner: r.owner, title: r.title })));
  if (rows.length === 0) {
    process.exit(0);
  }
  const first = rows[0];
  const detail = await store.show(first.id);
  show(`show ${first.id}`, { ...detail, text: undefined, body: detail.body.slice(0, 200) });
  if (args.includes('--claim')) {
    const open = rows.find((r) => r.stage === 'open' && r.owner === null);
    if (!open) {
      console.log('\nno open unclaimed ticket to claim');
      process.exit(0);
    }
    show(`claim ${open.id}`, await store.claim(open.id, { actor, size: 'S' }));
    show(`show ${open.id}`, { ...(await store.show(open.id)), text: undefined, body: undefined });
    try {
      await store.claim(open.id, { actor: `${actor}.second` });
    } catch (error) {
      show('second claimant', { kind: error.kind, exitCode: error.exitCode, message: error.message });
    }
    show(`release ${open.id}`, await store.release(open.id, { actor, stage: 'review', message: 'probe' }));
    show(`show ${open.id}`, { ...(await store.show(open.id)), text: undefined, body: undefined });
  }
} catch (error) {
  console.error(`\nfailed: [${error.kind ?? 'error'}] ${error.message}`);
  process.exit(1);
}
