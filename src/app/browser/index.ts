/**
 * `src/app/browser/` -- the in-editor web browser tab (ADR-0042):
 * `BrowserTab` (chrome only) over a main-process `WebContentsView` that
 * `BrowserViewService` drives. Thin barrel per the feature-module
 * convention (ADR-0016).
 */
export { BrowserTab } from './browser-tab';
export { BrowserViewService } from './browser-view.service';
export { normalizeAddress } from './normalize-address';
