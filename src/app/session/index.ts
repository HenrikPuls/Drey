/**
 * `src/app/session/` -- session history (ADR-0043): restore the editor's
 * exact pane layout + open tabs on launch, keeping the text of never-saved
 * buffers Notepad++-style. Thin barrel per the feature-module convention
 * (ADR-0016).
 */
export { SessionService } from './session.service';
export type { SessionSnapshot, SessionTab } from './session.service';
