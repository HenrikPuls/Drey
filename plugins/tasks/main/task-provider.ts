/**
 * The base `TaskQueryProvider` (SDK 1.11) over the plugin's task index —
 * what the assistant's `tasks_list` tool and MCP `tasks_list` read, and
 * what completes a task line. Extracted from `activate()` so the unit
 * suite can drive it with an in-memory vault.
 *
 * The grammar stays plugin-local: line resolution (`resolveTaskLine`) and
 * the done toggle (`setDoneOnLine`) come from `shared/tasks.ts` — a
 * consumer never edits task lines itself.
 */
import type {
  SdkTaskRecord,
  TaskQueryOptions,
  TaskQueryProvider,
} from '../../../shared/plugin-api';
import {
  resolveTaskLine,
  scanTasks,
  setDoneOnLine,
  sortTaskRecords,
  taskMatchesFilter,
  todayIso,
  type TaskRecord,
} from '../shared/tasks.js';

export interface TaskProviderPorts {
  read(path: string, vaultId: string): Promise<string>;
  writeAnnounced(path: string, content: string, vaultId: string): Promise<void>;
  /** Every indexed task across all vaults. */
  all(): readonly TaskRecord[];
  reindex(vaultId: string, path: string, content: string): void;
  /** The index-updated push (the panel re-pulls). */
  announce(): void;
}

export function createTaskQueryProvider(ports: TaskProviderPorts): TaskQueryProvider {
  return {
    async query(opts?: TaskQueryOptions): Promise<readonly SdkTaskRecord[]> {
      // Filter + order live HERE, at the data owner (57c): the assistant
      // block, the model's tool result and MCP see the same deterministic
      // view semantics the Tasks panel's fields implement.
      const today = todayIso();
      const status = opts?.status ?? (opts?.includeDone === true ? 'all' : 'open');
      const filtered = ports
        .all()
        .filter(
          (task) =>
            (status === 'all' || task.done === (status === 'done')) &&
            (opts?.vaultId === undefined || task.vaultId === opts.vaultId) &&
            taskMatchesFilter(
              task,
              {
                text: opts?.text,
                tag: opts?.tag,
                overdue: opts?.overdue,
                completedSince: opts?.completedSince,
              },
              today,
            ),
        );
      return sortTaskRecords(filtered, opts?.sort ?? 'file');
    },
    async setDone(task: SdkTaskRecord, done: boolean): Promise<SdkTaskRecord> {
      const raw = await ports.read(task.path, task.vaultId);
      const line = resolveTaskLine(raw, task as TaskRecord);
      if (line === null) {
        throw new Error(`The task could not be located in ${task.path} (moved or gone).`);
      }
      const next = setDoneOnLine(raw, line, done);
      if (next !== raw) {
        // Announced: the tree/indexes/open tabs see the toggle at once
        // (the same round the panel's own write-back uses).
        await ports.writeAnnounced(task.path, next, task.vaultId);
        // The announce round re-indexes asynchronously — record the new
        // state directly so a query right after the toggle is correct.
        ports.reindex(task.vaultId, task.path, next);
        ports.announce();
      }
      const rescanned = scanTasks(task.path, next, task.vaultId);
      const updated = rescanned.find((candidate) => candidate.line === line);
      return updated ?? { ...(task as TaskRecord), done };
    },
  };
}
