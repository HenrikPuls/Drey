/**
 * `vault_edit`, `vault_write`, `vault_move` and `vault_delete` (ADR-0071):
 * everything that changes the vault. One path for all of them — resolve
 * the vault inside the call's scope, refuse the app's own folders, ask
 * the user where the write rule says so, write through the vault manager
 * (history, own-write ledger) and announce the change.
 */
import { applyTextEdits, TextEdit } from '../../../shared/text-edit';
import { cleanPath, ScopedVault, ToolScope } from './scope';
import {
  fail,
  McpToolResult,
  ok,
  plural,
  VaultCallOptions,
  VaultToolDeps,
  VaultWriteRule,
} from './types';

interface WriteContext {
  deps: VaultToolDeps;
  scope: ToolScope;
  rule: VaultWriteRule;
  origin: NonNullable<VaultCallOptions['origin']>;
}

const WRITES_OFF =
  'Error: changing files is switched off for the assistant (Settings → Assistant tools). Tell the user what you would have changed instead.';

function refuseProtected(path: string): McpToolResult {
  return fail(
    `Error: ${path} belongs to the app (chat notes and drafts) and cannot be changed with this tool.`,
  );
}

/** A file's text with `\n` line ends, and whether it used `\r\n`; `null` when there is no such file. */
async function readText(
  ctx: WriteContext,
  path: string,
  vault: ScopedVault,
): Promise<{ text: string; crlf: boolean } | null> {
  try {
    const { content } = await ctx.deps.vault.readFile(path, vault.id);
    return { text: content.replace(/\r\n/g, '\n'), crlf: content.includes('\r\n') };
  } catch {
    return null;
  }
}

/** Asks where the rule says so, writes, announces. `null` = written; otherwise the refusal. */
async function commit(
  ctx: WriteContext,
  vault: ScopedVault,
  path: string,
  before: string,
  after: string,
  crlf: boolean,
  mode: 'overwrite' | 'append',
): Promise<McpToolResult | null> {
  if (ctx.rule === 'confirm') {
    const approved = await ctx.deps.confirmWrite({
      path,
      before,
      after,
      mode,
      vaultId: vault.id,
      vaultName: vault.name,
      ...(ctx.origin === 'assistant' ? { origin: 'assistant' as const } : {}),
    });
    if (!approved) {
      return fail(
        'Error: the user declined this change — nothing was written. Do not try again unless they ask.',
      );
    }
  }
  await ctx.deps.vault.writeFile(path, crlf ? after.replace(/\n/g, '\r\n') : after, vault.id, {
    origin: ctx.origin,
  });
  ctx.deps.announce({ vaultId: vault.id, changedPaths: [path], deletedPaths: [] });
  return null;
}

function parseEdits(raw: unknown): TextEdit[] | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      error:
        'Error: vault_edit needs `edits`: a non-empty array of {"old_text": "…", "new_text": "…"}.',
    };
  }
  const edits: TextEdit[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i] as Record<string, unknown> | null;
    const oldText = entry !== null && typeof entry === 'object' ? entry['old_text'] : undefined;
    const newText = entry !== null && typeof entry === 'object' ? entry['new_text'] : undefined;
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      return {
        error: `Error: edit ${i + 1} needs the strings "old_text" and "new_text" — e.g. {"old_text": "Fee: 10", "new_text": "Fee: 12"}.`,
      };
    }
    edits.push({
      oldText: oldText.replace(/\r\n/g, '\n'),
      newText: newText.replace(/\r\n/g, '\n'),
      replaceAll: entry?.['replace_all'] === true,
    });
  }
  return edits;
}

export async function vaultEdit(
  ctx: WriteContext,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  if (ctx.rule === 'off') {
    return fail(WRITES_OFF);
  }
  const located = ctx.scope.locate(args['path'], args['vault']);
  if ('error' in located) {
    return fail(located.error);
  }
  const { vault, path } = located;
  if (ctx.scope.isProtected(path)) {
    return refuseProtected(path);
  }
  const edits = parseEdits(args['edits']);
  if ('error' in edits) {
    return fail(edits.error);
  }
  const file = await readText(ctx, path, vault);
  if (file === null) {
    return fail(
      `Error: there is no file "${path}" in ${vault.name} to edit. Check the path with vault_list, or create the file with vault_write (mode "create").`,
    );
  }
  const result = applyTextEdits(file.text, edits);
  if (!result.ok) {
    return fail(result.error);
  }
  const refused = await commit(ctx, vault, path, file.text, result.text, file.crlf, 'overwrite');
  if (refused !== null) {
    return refused;
  }
  return ok(
    `Edited ${path}: ${plural(result.replacements, 'replacement')} at line${result.lines.length === 1 ? '' : 's'} ${result.lines.join(', ')}.`,
  );
}

export async function vaultWrite(
  ctx: WriteContext,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  if (ctx.rule === 'off') {
    return fail(WRITES_OFF);
  }
  const located = ctx.scope.locate(args['path'], args['vault']);
  if ('error' in located) {
    return fail(located.error);
  }
  const { vault, path } = located;
  if (ctx.scope.isProtected(path)) {
    return refuseProtected(path);
  }
  const mode = args['mode'];
  if (mode !== 'create' && mode !== 'append' && mode !== 'overwrite') {
    return fail(
      'Error: vault_write needs `mode`: "create" (a new file), "append" (add to the end) or "overwrite" (replace the whole file).',
    );
  }
  if (typeof args['content'] !== 'string') {
    return fail('Error: vault_write needs `content` as a string.');
  }
  const content = args['content'].replace(/\r\n/g, '\n');
  const file = await readText(ctx, path, vault);
  if (mode === 'create' && file !== null) {
    return fail(
      `Error: ${path} already exists — nothing was written. Change it with vault_edit, add to it with mode "append", or pick another path.`,
    );
  }
  const before = file?.text ?? '';
  const after =
    mode === 'append' && before !== ''
      ? `${before}${before.endsWith('\n') ? '' : '\n'}${content}`
      : content;
  if (file !== null && after === before) {
    return ok(`No change — ${path} already has this content.`);
  }
  const refused = await commit(
    ctx,
    vault,
    path,
    before,
    after,
    file?.crlf ?? false,
    mode === 'append' ? 'append' : 'overwrite',
  );
  if (refused !== null) {
    return refused;
  }
  const lines = after.split('\n').length;
  return ok(
    file === null
      ? `Created ${path} (${plural(lines, 'line')}).`
      : mode === 'append'
        ? `Appended to ${path} (now ${plural(lines, 'line')}).`
        : `Replaced the content of ${path} (${plural(lines, 'line')}).`,
  );
}

export async function vaultMove(
  ctx: WriteContext,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  if (ctx.rule === 'off') {
    return fail(WRITES_OFF);
  }
  const located = ctx.scope.locate(args['from'], args['vault']);
  if ('error' in located) {
    return fail(located.error.replace('"path"', '"from"'));
  }
  const { vault, path: from } = located;
  const to = cleanPath(args['to']);
  if (to === '') {
    return fail('Error: vault_move needs `to` — the full new path, including the file name.');
  }
  if (to === from) {
    return fail('Error: `from` and `to` are the same path — nothing to move.');
  }
  if (ctx.scope.isProtected(from) || ctx.scope.isProtected(to)) {
    return refuseProtected(ctx.scope.isProtected(from) ? from : to);
  }
  if (ctx.rule === 'confirm') {
    const approved = await ctx.deps.approve({ tool: 'vault_move', args: { from, to, vault: vault.name } });
    if (!approved) {
      return fail(
        'Error: the user declined the move — nothing was changed. Do not try again unless they ask.',
      );
    }
  }
  let result;
  try {
    result = await ctx.deps.rename({
      fromRel: from,
      toRel: to,
      fromVaultId: vault.id,
      toVaultId: vault.id,
      buffers: [],
    });
  } catch (err) {
    return fail(
      `Error: could not move ${from} — ${err instanceof Error ? err.message : String(err)}. Check both paths with vault_list.`,
    );
  }
  ctx.deps.announceRefresh(vault.id);
  const linked = result.written.length;
  return ok(
    [
      `Moved ${from} → ${result.path}.`,
      ...(linked > 0 ? [`Links updated in ${plural(linked, 'note')}.`] : []),
      ...(result.assets.length > 0 ? [`${plural(result.assets.length, 'attachment')} moved with it.`] : []),
      ...(result.failed.length > 0 ? [`Could not update: ${result.failed.join('; ')}.`] : []),
    ].join(' '),
  );
}

export async function vaultDelete(
  ctx: WriteContext,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  if (ctx.rule === 'off') {
    return fail(WRITES_OFF);
  }
  const located = ctx.scope.locate(args['path'], args['vault']);
  if ('error' in located) {
    return fail(located.error);
  }
  const { vault, path } = located;
  if (ctx.scope.isProtected(path)) {
    return refuseProtected(path);
  }
  try {
    // Files only: a folder cannot be read, and deleting one is not offered.
    await ctx.deps.vault.readFile(path, vault.id);
  } catch {
    return fail(
      `Error: there is no file "${path}" in ${vault.name}. vault_delete removes single files — check the path with vault_list.`,
    );
  }
  // Asked every time, whatever the write rule: a diff cannot show it.
  const approved = await ctx.deps.approve({ tool: 'vault_delete', args: { path, vault: vault.name } });
  if (!approved) {
    return fail(
      'Error: the user declined the deletion — nothing was changed. Do not try again unless they ask.',
    );
  }
  const { trashed } = await ctx.deps.vault.deleteEntry(path, vault.id);
  ctx.deps.announce({ vaultId: vault.id, changedPaths: [], deletedPaths: [path] });
  return ok(trashed ? `Moved ${path} to the recycle bin.` : `Deleted ${path}.`);
}

export type { WriteContext };
