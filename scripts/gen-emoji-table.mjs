/**
 * Regenerates `shared/markdown/emoji-table.ts` from the `gemoji` dataset
 * (GitHub's emoji database, canonical names + aliases). The table is the
 * editor's and the markdown-it renders' ONE curated `:shortcode:` list:
 * only names in it ever match, which is what keeps timestamps like
 * `00:03:48` (`:03:`) plain text (the reason the built-in lezer Emoji
 * parser was removed).
 *
 * Run: `npm run emoji:table` (gemoji is a devDependency). The output is
 * checked in so a plain checkout builds without the script.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { gemoji } from 'gemoji';

/** @type {Map<string, string>} */
const byName = new Map();
for (const entry of gemoji) {
  if (!entry.emoji) {
    continue; // entries GitHub only documents, but renders no glyph for
  }
  for (const name of entry.names) {
    byName.set(name, entry.emoji);
  }
}

const names = [...byName.keys()].sort();
const lines = [];
// Eight entries per line keeps the generated file compact (a name plus a
// BMP/clusters emoji each) while staying diff-friendly.
for (let i = 0; i < names.length; i += 8) {
  const chunk = names
    .slice(i, i + 8)
    .map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(byName.get(name))},`)
    .join('\n');
  lines.push(chunk);
}

const out = `// GENERATED FILE — regenerate with \`npm run emoji:table\` (scripts/gen-emoji-table.mjs).
// GitHub's \`:shortcode:\` names (gemoji: canonical names + aliases, ${names.length} entries).
// Shared by the editor's Emoji extension and the markdown-it renders; see
// shared/markdown/emoji.ts.
export const EMOJI_TABLE: Readonly<Record<string, string>> = {
${lines.join('\n')}
};
`;

const target = new URL('../shared/markdown/emoji-table.ts', import.meta.url);
mkdirSync(new URL('.', target), { recursive: true });
writeFileSync(target, out, 'utf-8');
console.log(`emoji-table.ts: ${names.length} names written`);
