/**
 * `electron/session/` -- the main-process side of session history
 * (ADR-0043): a user-data backup store for the text of tabs that have
 * nothing on disk. Thin barrel per the feature-module convention
 * (ADR-0016).
 */
export { SessionBackupStore } from './session-backup-store';
