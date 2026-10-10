import {
  RenameLinksPreview,
  RenameLinksRequest,
  RenameLinksResult,
  VaultFileEntry,
} from '../shared/ipc-api';
import { planRename } from '../shared/link-rewrite';
import type { RenamePlan } from '../shared/link-rewrite';
import { NOTE_FILE } from '../shared/wikilinks';
import { VaultManager } from './vault-manager';

/**
 * Carries a rename / move out WITH its links intact (milestone 59,
 * ADR-0059): reads the vault as it is right now, lets the pure planner
 * (`shared/link-rewrite.ts`) decide which notes need rewriting and which
 * attachments travel, renames, then applies the plan.
 *
 * There is no standing index behind this -- every plan is one fresh scan
 * of the source vault's notes. That is the same TOCTOU stance as the tag
 * rename (milestone 53): what gets written is computed at apply time, not
 * what a preview showed a moment earlier.
 */
export class LinkRewriter {
  constructor(private readonly vaults: VaultManager) {}

  /** What the rename would change. Touches nothing. */
  async preview(request: RenameLinksRequest): Promise<RenameLinksPreview> {
    const { plan } = await this.plan(request);
    return {
      files: plan.patches.map((p) => ({
        path: p.path,
        newPath: p.newPath,
        links: p.links,
        before: p.before,
        after: p.after,
      })),
      assets: plan.assets,
    };
  }

  /** Renames, then rewrites the planned notes and moves the planned attachments. */
  async apply(request: RenameLinksRequest): Promise<RenameLinksResult> {
    const { fromRel, toRel, fromVaultId, toVaultId } = request;
    const { plan, crlf, buffered } = await this.plan(request);
    const path = await this.vaults.renameEntry(fromRel, toRel, fromVaultId, toVaultId);

    const result: RenameLinksResult = { path, written: [], buffers: [], assets: [], failed: [] };
    const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

    for (const patch of plan.patches) {
      if (buffered.has(patch.path)) {
        result.buffers.push({ path: patch.newPath, content: patch.after });
        continue;
      }
      try {
        const content = crlf.has(patch.path) ? patch.after.replace(/\n/g, '\r\n') : patch.after;
        await this.vaults.writeFile(patch.newPath, content, fromVaultId);
        result.written.push(patch.newPath);
      } catch (error) {
        result.failed.push(`${patch.newPath}: ${message(error)}`);
      }
    }

    for (const asset of plan.assets) {
      try {
        if (asset.kind === 'move') {
          await this.vaults.renameEntry(asset.from, asset.to, fromVaultId, toVaultId);
          await this.vaults.removeDirIfEmpty(dirOf(asset.from), fromVaultId);
        } else {
          await this.vaults.copyEntry(asset.from, dirOf(asset.to), fromVaultId, toVaultId);
        }
        result.assets.push(asset);
      } catch (error) {
        result.failed.push(`${asset.from}: ${message(error)}`);
      }
    }
    return result;
  }

  private async plan(
    request: RenameLinksRequest,
  ): Promise<{ plan: RenamePlan; crlf: Set<string>; buffered: Set<string> }> {
    const { fromRel, toRel, fromVaultId, toVaultId } = request;
    const files = flattenFiles(await this.vaults.listFiles(fromVaultId));
    const buffers = new Map(request.buffers.map((b) => [b.path, b.content]));

    const contents = new Map<string, string>();
    const crlf = new Set<string>();
    for (const note of files.filter((p) => NOTE_FILE.test(p))) {
      const buffer = buffers.get(note);
      if (buffer !== undefined) {
        contents.set(note, buffer);
        continue;
      }
      try {
        const { content } = await this.vaults.readFile(note, fromVaultId);
        if (content.includes('\r\n')) {
          crlf.add(note);
        }
        contents.set(note, content.replace(/\r\n/g, '\n'));
      } catch {
        // Unreadable -- it contributes no links and is not rewritten.
      }
    }

    const targetFiles =
      fromVaultId === toVaultId ? undefined : flattenFiles(await this.vaults.listFiles(toVaultId));
    const plan = planRename({ files, fromRel, toRel, contents, targetFiles });
    return { plan, crlf, buffered: new Set(buffers.keys()) };
  }
}

function dirOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

function flattenFiles(entries: readonly VaultFileEntry[], out: string[] = []): string[] {
  for (const entry of entries) {
    if (entry.type === 'directory') {
      flattenFiles(entry.children ?? [], out);
    } else {
      out.push(entry.relativePath);
    }
  }
  return out;
}
