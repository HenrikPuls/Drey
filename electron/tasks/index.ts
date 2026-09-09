/**
 * `electron/tasks` — the main-process task index (backs `tasks:list`).
 *
 * This barrel is the module's only public surface — import from `./tasks`,
 * never a file inside it (enforced by `eslint.config.mjs`).
 */

export { TaskIndex } from './task-index';
