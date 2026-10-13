/**
 * `vault_list` (ADR-0071): what exists in the vault — paths, optionally
 * with each note's headings. A listing too long to be useful comes back
 * as folders with file counts, so the next call can narrow.
 */
import type { VaultFileEntry } from '../../../shared/ipc-api';
import { splitSections } from '../../../shared/note-sections';
import { cleanPath, isUnder, ResolvedVaults, ScopedVault, ToolScope } from './scope';
import { fail, McpToolResult, ok, plural, ToolVault } from './types';

/** Most files one listing shows. */
export const LIST_MAX_FILES = 200;
/** Most notes whose headings one listing shows. */
export const LIST_MAX_HEADING_FILES = 60;

/** Every file of a tree, vault-relative, in tree order. */
export function flattenFiles(entries: readonly VaultFileEntry[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly VaultFileEntry[]): void => {
    for (const entry of list) {
      if (entry.type === 'file') {
        out.push(entry.relativePath.replace(/\\/g, '/'));
      } else {
        walk(entry.children ?? []);
      }
    }
  };
  walk(entries);
  return out;
}

/**
 * A name pattern as a regular expression: `*` matches inside one path
 * segment, `**` across segments, `?` one character. A pattern without a
 * slash matches the file name in any folder.
 */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i++;
        if (glob[i + 1] === '/') {
          i++;
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(glob.includes('/') ? `^${source}$` : `(^|/)${source}$`, 'i');
}

function headingLines(content: string): string[] {
  return splitSections(content.replace(/\r\n/g, '\n'))
    .filter((section) => section.level > 0)
    .map((section) => `  ${section.line}: ${'#'.repeat(section.level)} ${section.heading}`);
}

/** The folders directly under `base` with how many files each holds, plus the files directly in it. */
function summarize(files: readonly string[], base: string): { folders: string[]; direct: string[] } {
  const counts = new Map<string, number>();
  const direct: string[] = [];
  for (const file of files) {
    const rest = base === '' ? file : file.slice(base.length + 1);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      direct.push(file);
    } else {
      const folder = (base === '' ? '' : `${base}/`) + rest.slice(0, slash);
      counts.set(folder, (counts.get(folder) ?? 0) + 1);
    }
  }
  return {
    folders: [...counts.entries()].map(([folder, count]) => `${folder}/ (${plural(count, 'file')})`),
    direct,
  };
}

async function listOne(
  vault: ToolVault,
  scope: ToolScope,
  target: ScopedVault,
  resolved: ResolvedVaults,
  folder: string,
  pattern: RegExp | null,
  withHeadings: boolean,
): Promise<string> {
  const all = flattenFiles(await vault.listFiles(target.id)).filter(
    (file) => isUnder(file, folder) && !scope.isProtected(file) && (pattern === null || pattern.test(file)),
  );
  const where = `${resolved.labelled ? `${target.name} (${target.id})` : target.name}${folder === '' ? '' : `, ${folder}/`}`;
  if (all.length === 0) {
    return `No files in ${where}.`;
  }
  const label = (file: string): string => scope.label(target, file, resolved.labelled);

  if (all.length > LIST_MAX_FILES) {
    const { folders, direct } = summarize(all, folder);
    const shown = direct.slice(0, LIST_MAX_FILES);
    return [
      `${plural(all.length, 'file')} in ${where} — too many to list. Folders:`,
      ...folders.map((line) => (resolved.labelled ? `${target.id}:${line}` : line)),
      ...(shown.length > 0 ? ['Files directly here:', ...shown.map(label)] : []),
      ...(direct.length > shown.length ? [`(+${direct.length - shown.length} more files here)`] : []),
      'Call vault_list again with `path` set to one of the folders, or with `glob`.',
    ].join('\n');
  }

  const lines: string[] = [`${plural(all.length, 'file')} in ${where}:`];
  let headed = 0;
  for (const file of all) {
    lines.push(label(file));
    if (withHeadings && /\.md$/i.test(file) && headed < LIST_MAX_HEADING_FILES) {
      headed++;
      try {
        lines.push(...headingLines((await vault.readFile(file, target.id)).content));
      } catch {
        // An unreadable note still has its path in the listing.
      }
    }
  }
  if (withHeadings && all.filter((file) => /\.md$/i.test(file)).length > LIST_MAX_HEADING_FILES) {
    lines.push(
      `(headings shown for the first ${LIST_MAX_HEADING_FILES} notes — narrow with \`path\` or \`glob\` for the others)`,
    );
  }
  return lines.join('\n');
}

export async function vaultList(
  vault: ToolVault,
  scope: ToolScope,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const resolved = scope.many(args['vault']);
  if ('error' in resolved) {
    return fail(resolved.error);
  }
  const folder = cleanPath(args['path']);
  const glob = typeof args['glob'] === 'string' ? args['glob'].trim() : '';
  const pattern = glob !== '' ? globToRegExp(glob) : null;
  const blocks: string[] = [];
  for (const target of resolved.vaults) {
    blocks.push(
      await listOne(vault, scope, target, resolved, folder, pattern, args['headings'] === true),
    );
  }
  return ok(blocks.join('\n\n'));
}
