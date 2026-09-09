/**
 * `src/app/tasks` — the Tasks dock panel and its state service.
 *
 * This barrel is the module's only public surface — import from
 * `../tasks`, never a file inside it (enforced by `eslint.config.mjs`).
 */

export { TaskService } from './task.service';
export type { TaskScope } from './task.service';
export { TasksPanel } from './tasks-panel/tasks-panel';
