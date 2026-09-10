/**
 * `electron/browser/` -- the main-process side of the in-editor web
 * browser tab (ADR-0042): a `WebContentsView` per tab, floated
 * over the Angular layout. Thin barrel per the feature-module convention
 * (ADR-0016).
 */
export { BrowserViewManager } from './browser-view-manager';
