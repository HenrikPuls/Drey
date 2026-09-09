/**
 * `shared/tasks` — the pure, IPC-crossing task logic: scanning a note for
 * checkbox / `#task` lines and flipping one line's done-state.
 *
 * This barrel is the module's only public surface — import from
 * `shared/tasks`, never a file inside it (enforced by `eslint.config.mjs`).
 */

export type { TaskKind, TaskRecord } from './tasks';
export { scanTasks, setDoneOnLine } from './tasks';
