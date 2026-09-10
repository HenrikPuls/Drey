/**
 * `shared/browser/` -- the cross-layer contract for the in-editor web
 * browser tab (ADR-0042). Thin barrel per the feature-module
 * convention (ADR-0016); `shared/ipc-api.ts` re-exports these types.
 */
export type {
  BrowserCreateArgs,
  BrowserEvent,
  BrowserFindArgs,
  BrowserNavigateArgs,
  BrowserOpenTabRequest,
  BrowserRect,
  BrowserSetBoundsArgs,
  BrowserSetVisibleArgs,
  BrowserStopFindArgs,
  BrowserTabId,
  BrowserTabRef,
  BrowserTabState,
} from './browser-ipc';
