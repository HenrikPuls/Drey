/**
 * The pure verdict table of the Files-panel seam (T-0042, SDK 1.32):
 * what the tickets plugin allows, refuses or takes over when the Files
 * panel is about to touch the `tickets/` subtree of the detected tickets
 * vault. Pure and snapshot-driven — the renderer bridge feeds it the
 * board's cached vault id and pipeline ids; nothing here touches disk
 * or IPC.
 *
 * Scope (decision 10): the `tickets/` subtree ONLY — the rest of the
 * dedicated vault (loose notes, `_worktrees/`) stays free, and with no
 * board detected everything is allowed.
 */
import type { VaultFileOperation, VaultFileOperationVerdict } from '../../../shared/plugin-api';
import { TICKETS_ARCHIVE_DIR, stripPhasePrefix } from './tickets';

/** What `filesVerdict` needs from the cached board snapshot. */
export interface FilesGuardInput {
  /** The detected tickets vault; null = no board, everything allowed. */
  readonly ticketsVaultId: string | null;
  /** The pipeline's phase ids in order, clean (prefix-stripped). */
  readonly phaseIds: readonly string[];
  /** The operation the Files panel is about to run. */
  readonly operation: VaultFileOperation;
}

/** Where a move should land, as the board would treat it. */
export type TicketMoveTarget =
  | { readonly kind: 'transition'; readonly id: string; readonly from: string; readonly to: string }
  | { readonly kind: 'archive'; readonly id: string }
  | { readonly kind: 'unarchive'; readonly id: string; readonly to: string }
  | { readonly kind: 'refused'; readonly reason: string };

// --- the refusal reasons (English, like everything the UI displays) ------

export const REASON_CREATE_FILE = 'Tickets are created on the board (New ticket).';
export const REASON_CREATE_DIR = 'Columns are managed in Settings → Tickets.';
export const REASON_RENAME_FILE = "The filename is the ticket's identity.";
export const REASON_RENAME_DIR = 'Phase folders are managed by the pipeline.';
export const REASON_DELETE = "Archive the ticket instead — deletion inside archive/ is the owner's manual act.";
export const REASON_COPY = "A ticket cannot be duplicated — the filename is the identity.";
export const REASON_META = 'The board files under tickets/_meta are managed by the settings dialog.';
export const REASON_MOVE_WITHIN = 'A ticket can only move between phase folders or into tickets/archive.';
export const REASON_NOT_A_PHASE = 'is not a phase folder — columns come from the pipeline.';
export const REASON_NOT_ON_BOARD = 'is not on the board — refresh the board and try again.';

// --- path shapes -----------------------------------------------------------

const TICKETS_DIR = 'tickets';
const META_PREFIX = 'tickets/_meta';

const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/** `tickets/<dir>/<T-nnnn>.md` — the ticket-file shape, any dir (incl. archive). */
export function ticketFileOf(path: string): { dir: string; id: string } | null {
  const match = /^tickets\/([^/]+)\/(T-\d{4,})\.md$/.exec(path);
  return match === null ? null : { dir: match[1]!, id: match[2]! };
}

/** The phase id a drop-target folder names, when it names one. */
function phaseFolderOf(toDir: string, phaseIds: readonly string[]): string | null {
  const match = /^tickets\/([^/]+)$/.exec(toDir);
  if (match === null) {
    return null;
  }
  const stripped = stripPhasePrefix(match[1]!);
  return phaseIds.includes(stripped) ? stripped : null;
}

// --- the verdict table -----------------------------------------------------

export function filesVerdict(input: FilesGuardInput): VaultFileOperationVerdict {
  const { ticketsVaultId, phaseIds, operation } = input;
  if (ticketsVaultId === null) {
    return { action: 'allow' };
  }
  const isTicketsVault = (vaultId: string): boolean => vaultId === ticketsVaultId;

  switch (operation.kind) {
    case 'create': {
      if (!isTicketsVault(operation.vaultId) || !under(operation.path, TICKETS_DIR)) {
        return { action: 'allow' };
      }
      return {
        action: 'refuse',
        reason: operation.type === 'directory' ? REASON_CREATE_DIR : REASON_CREATE_FILE,
      };
    }

    case 'rename': {
      if (!isTicketsVault(operation.vaultId) || !under(operation.fromPath, TICKETS_DIR)) {
        return { action: 'allow' };
      }
      if (under(operation.fromPath, META_PREFIX)) {
        return { action: 'refuse', reason: REASON_META };
      }
      return {
        action: 'refuse',
        reason: ticketFileOf(operation.fromPath) === null ? REASON_RENAME_DIR : REASON_RENAME_FILE,
      };
    }

    case 'copy': {
      const fromBoard = isTicketsVault(operation.fromVaultId) && under(operation.fromPath, TICKETS_DIR);
      const toBoard = isTicketsVault(operation.toVaultId) && under(operation.toDir, TICKETS_DIR);
      if (!fromBoard && !toBoard) {
        return { action: 'allow' };
      }
      return { action: 'refuse', reason: REASON_COPY };
    }

    case 'delete': {
      if (!isTicketsVault(operation.vaultId)) {
        return { action: 'allow' };
      }
      const onBoard = operation.paths.some((path) => under(path, TICKETS_DIR));
      if (!onBoard) {
        return { action: 'allow' };
      }
      const metaOnly = operation.paths.every((path) => under(path, META_PREFIX));
      return { action: 'refuse', reason: metaOnly ? REASON_META : REASON_DELETE };
    }

    case 'move': {
      if (!isTicketsVault(operation.fromVaultId)) {
        // INTO the board from outside: the tree's rows under tickets/ are
        // the board's ground — a stray file there corrupts the columns.
        if (
          isTicketsVault(operation.toVaultId) &&
          under(operation.toDir, TICKETS_DIR) &&
          !under(operation.toDir, META_PREFIX)
        ) {
          return { action: 'refuse', reason: REASON_CREATE_FILE };
        }
        return { action: 'allow' };
      }
      if (!under(operation.fromPath, TICKETS_DIR)) {
        return { action: 'allow' }; // a loose note of the dedicated vault
      }
      if (under(operation.fromPath, META_PREFIX)) {
        return { action: 'refuse', reason: REASON_META };
      }
      const file = ticketFileOf(operation.fromPath);
      if (file === null) {
        // A directory (a phase folder, archive/), or a stray non-ticket
        // file: neither is the Files tree's to move.
        return { action: 'refuse', reason: REASON_RENAME_DIR };
      }
      if (!isTicketsVault(operation.toVaultId)) {
        return { action: 'refuse', reason: REASON_MOVE_WITHIN };
      }
      const target = moveTarget({ fromPath: operation.fromPath, toDir: operation.toDir, phaseIds });
      return target.kind === 'refused' ? { action: 'refuse', reason: target.reason } : { action: 'handle' };
    }
  }
}

/** Maps a ticket-file move to the board treatment it must become. */
export function moveTarget(input: {
  readonly fromPath: string;
  readonly toDir: string;
  readonly phaseIds: readonly string[];
}): TicketMoveTarget {
  const file = ticketFileOf(input.fromPath);
  if (file === null) {
    return { kind: 'refused', reason: REASON_RENAME_DIR };
  }
  const fromPhase = stripPhasePrefix(file.dir);

  if (fromPhase === 'archive') {
    const to = phaseFolderOf(input.toDir, input.phaseIds);
    if (to !== null) {
      return { kind: 'unarchive', id: file.id, to };
    }
    return {
      kind: 'refused',
      reason: under(input.toDir, TICKETS_DIR)
        ? `"${input.toDir}" ${REASON_NOT_A_PHASE}`
        : REASON_MOVE_WITHIN,
    };
  }

  if (!input.phaseIds.includes(fromPhase)) {
    return { kind: 'refused', reason: `${file.id} ${REASON_NOT_ON_BOARD}` };
  }
  if (input.toDir === TICKETS_ARCHIVE_DIR) {
    return { kind: 'archive', id: file.id };
  }
  const to = phaseFolderOf(input.toDir, input.phaseIds);
  if (to === null) {
    const inTree = under(input.toDir, TICKETS_DIR);
    return {
      kind: 'refused',
      reason: inTree
        ? `"${input.toDir}" ${REASON_NOT_A_PHASE}`
        : REASON_MOVE_WITHIN,
    };
  }
  return { kind: 'transition', id: file.id, from: fromPhase, to };
}
