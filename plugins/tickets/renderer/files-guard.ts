/**
 * The Files-panel wiring (T-0042, SDK 1.32): the operation handler that
 * vetoes or takes over the panel's operations in the `tickets/` subtree,
 * and the three context-menu rows ("Archive ticket", "Unarchive
 * ticket", "Remove worktree").
 *
 * Snapshot-driven: the board store feeds vault id and pipeline ids, the
 * verdict table lives in `shared/files-guard.ts` (pure, spec-covered).
 * A takeover runs the SAME single-writer backend mutations the board
 * runs — one transition is one structured commit (ADR-0076) — so
 * dragging a ticket in Files feels exactly like dragging it on the
 * board.
 */
import type {
  FilesContextMenuItem,
  FilesContextMenuTarget,
  VaultFileOperation,
  VaultFileOperationOutcome,
  VaultFileOperationsHandler,
} from '../../../shared/plugin-api/renderer';
import type { MutationResult } from '../shared/tickets';
import { filesVerdict, moveTarget, ticketFileOf } from '../shared/files-guard';
import { stripPhasePrefix } from '../shared/tickets';

/** What the bridge needs from the host: the cached snapshot, the backend
 *  seam and the message dialog for surfaced errors. */
export interface FilesBridgeDeps {
  readonly snapshot: () => { vaultId: string | null; pipeline: readonly { readonly id: string }[] } | null;
  readonly invoke: (method: string, payload?: unknown) => Promise<unknown>;
  readonly showMessage: (message: string, title?: string) => Promise<void>;
}

const outcomeOf = (result: MutationResult): VaultFileOperationOutcome =>
  result.ok
    ? { ok: true, ...(result.path !== undefined ? { path: result.path } : {}) }
    : { ok: false, error: result.error ?? 'the action failed' };

/** Runs one mutation and surfaces a failure in the panel's message dialog. */
async function runMutation(deps: FilesBridgeDeps, method: string, payload: unknown): Promise<VaultFileOperationOutcome> {
  let result: MutationResult;
  try {
    result = (await deps.invoke(method, payload)) as MutationResult;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result.ok) {
    await deps.showMessage(result.error ?? 'the action failed', 'Tickets');
  }
  return outcomeOf(result);
}

export function createFilesOperationsHandler(deps: FilesBridgeDeps): VaultFileOperationsHandler {
  return {
    check: (operation: VaultFileOperation) => {
      const snap = deps.snapshot();
      return Promise.resolve(
        filesVerdict({
          ticketsVaultId: snap?.vaultId ?? null,
          phaseIds: (snap?.pipeline ?? []).map((phase) => phase.id),
          operation,
        }),
      );
    },
    perform: async (operation: VaultFileOperation): Promise<VaultFileOperationOutcome> => {
      if (operation.kind !== 'move') {
        return { ok: false, error: 'the tickets plugin only takes over moves.' };
      }
      const snap = deps.snapshot();
      if (snap === null || snap.vaultId === null) {
        return { ok: false, error: 'no tickets vault detected' };
      }
      const target = moveTarget({
        fromPath: operation.fromPath,
        toDir: operation.toDir,
        phaseIds: snap.pipeline.map((phase) => phase.id),
      });
      switch (target.kind) {
        case 'refused':
          return { ok: false, error: target.reason };
        case 'archive':
          return runMutation(deps, 'archive', { id: target.id });
        case 'unarchive':
          return runMutation(deps, 'unarchive', { id: target.id, to: target.to });
        case 'transition':
          return runMutation(deps, 'transition', {
            id: target.id,
            from: target.from,
            to: target.to,
            index: null,
          });
      }
    },
  };
}

/**
 * The Files context rows: scoped to the tickets vault, re-evaluated per
 * open over the cached snapshot. "Archive ticket" on a board ticket,
 * "Unarchive ticket" on an archived one (to the first phase), "Remove
 * worktree" on `_worktrees/<id>` (dormant until T-0044 creates the
 * folder).
 */
export function ticketsContextMenuItems(deps: FilesBridgeDeps) {
  return (target: FilesContextMenuTarget): readonly FilesContextMenuItem[] => {
    const snap = deps.snapshot();
    if (snap === null || snap.vaultId === null || target.vaultId !== snap.vaultId) {
      return [];
    }
    const phaseIds = snap.pipeline.map((phase) => phase.id);

    if (target.type === 'directory') {
      if (/^_worktrees\/T-\d{4,}(\/.*)?$/.test(target.path)) {
        return [
          {
            label: 'Remove worktree',
            title: 'git worktree remove',
            run: () =>
              void runMutation(deps, 'removeWorktree', { folder: target.path }).then(() => undefined),
          },
        ];
      }
      return [];
    }

    const file = ticketFileOf(target.path);
    if (file === null) {
      return [];
    }
    if (file.dir === 'archive') {
      const first = phaseIds[0];
      if (first === undefined) {
        return [];
      }
      return [
        {
          label: 'Unarchive ticket',
          title: `Back into ${first}`,
          run: () => void runMutation(deps, 'unarchive', { id: file.id, to: first }).then(() => undefined),
        },
      ];
    }
    if (phaseIds.includes(stripPhasePrefix(file.dir))) {
      return [
        {
          label: 'Archive ticket',
          run: () => void runMutation(deps, 'archive', { id: file.id }).then(() => undefined),
        },
      ];
    }
    return [];
  };
}
