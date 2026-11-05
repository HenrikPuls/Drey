/**
 * The Flow tab's doc kind (E13-11): one tab per ticket (or plan part),
 * keyed `flow://T-0121[/<part>]`, titled `Flow · T-0121`. The session
 * snapshot stores the target; the flow is read again from the engine on
 * restore, so a draft that was never saved is not kept.
 */
import type { DreyPluginApi, Unsubscribe } from '../../../../shared/plugin-api/renderer';
import type { DeskDeps } from '../desk-deps';
import { flowKeyOf, flowTargetOfKey, flowTitleOf, type FlowTarget } from './flow-model';
import { mountFlow } from './flow-view';

export const FLOW_KIND = 'tickets-flow';

/** Opens (or reveals) the Flow tab of a ticket (or one plan part). */
export function openFlowTab(api: DreyPluginApi, ticketId: string, part: number | null = null): void {
  const target: FlowTarget = { ticketId, part };
  api.documents.addDoc(FLOW_KIND, flowKeyOf(target), flowTitleOf(target));
}

export function registerFlowKind(api: DreyPluginApi, deps: DeskDeps): Unsubscribe {
  return api.ui.registerDocKind({
    kind: FLOW_KIND,
    icon: 'git-branch',
    serialize: (path) => {
      const target = flowTargetOfKey(path);
      return target === null ? null : { ...target };
    },
    restore: (path) => {
      const target = flowTargetOfKey(path);
      if (target !== null) {
        api.documents.addDoc(FLOW_KIND, path, flowTitleOf(target));
      }
    },
    mount: (host, path) => {
      const target = flowTargetOfKey(path);
      if (target === null) {
        host.textContent = 'This tab shows no flow.';
        return () => undefined;
      }
      return mountFlow(deps, host, target);
    },
    statusText: (path) => flowTargetOfKey(path)?.ticketId ?? null,
  });
}
