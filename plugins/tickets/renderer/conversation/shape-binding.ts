/**
 * Shape in Drey (E13-9): the glue between the Assistant's Mission Control
 * target and the ticket document in the editor. The target asks this
 * binding which ticket is in focus, to save it before a message goes out
 * (Paul reads the file, so the owner's edits must be on disk), to lock it
 * while Paul writes and to look at the plan again when the turn ended.
 *
 * Paul's own edit reaches the open tab the way every engine write does:
 * the engine commits the `## Plan` chapter and announces the file, the
 * base reloads the clean tab (ADR-0045 round, milestone 140).
 */
import type { DreyPluginApi } from '../../../../shared/plugin-api/renderer';
import type { BoardSnapshot } from '../../shared/tickets';
import type { PlanStatusStore } from '../ticket-document/shape-state';
import { shapeTargetOf } from '../ticket-document/shape';
import type { ShapeBinding } from './targets';

export interface ShapeBindingDeps {
  readonly api: DreyPluginApi;
  readonly snapshot: () => BoardSnapshot | null;
  /** True while a fleet run works on the ticket (Paul does not shape under a running worker). */
  readonly runLive: (ticketId: string) => boolean;
  readonly status: PlanStatusStore;
  /** Fires after every board or fleet change; returns the unsubscribe. */
  readonly onBoardChange: (listener: () => void) => () => void;
  /** Pulls a fresh board (the ticket may have moved). */
  readonly refreshBoard: () => Promise<void>;
}

export function createShapeBinding(deps: ShapeBindingDeps): ShapeBinding {
  const { api } = deps;
  return {
    current: () => {
      const active = api.documents.active();
      return active === null || active.kind !== 'text'
        ? null
        : shapeTargetOf(deps.snapshot(), { path: active.path, vaultId: active.vaultId }, deps.runLive);
    },
    flush: async (target) => {
      if (api.documents.get(target.path)?.dirty !== true) {
        return null;
      }
      try {
        await api.documents.save(target.path);
      } catch (error) {
        return `${target.label} could not be saved: ${error instanceof Error ? error.message : String(error)}`;
      }
      return api.documents.get(target.path)?.dirty === true
        ? `${target.label} still has unsaved changes. Save it, then send again.`
        : null;
    },
    lock: (target, locked) => {
      api.documents.setEditLock(target.path, locked);
    },
    settled: (target) => {
      deps.status.refresh(target.id);
      // "Keep as one ticket" moves the file; the board shows where it went.
      void deps.refreshBoard();
    },
    subscribe: (listener) => {
      const offDocuments = api.documents.onChange((event) => {
        if (event.type === 'active-changed' || event.type === 'docs-changed') {
          listener();
        }
      });
      const offBoard = deps.onBoardChange(listener);
      return () => {
        offDocuments();
        offBoard();
      };
    },
  };
}
