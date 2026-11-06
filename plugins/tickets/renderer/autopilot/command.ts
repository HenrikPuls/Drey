// i18n: catalog
/**
 * The Autopilot command (`Mod+Alt+P`, also what a click on the status item
 * runs): opens the popover, or closes it when it is open. The popover reads
 * the chain through `view()`; the plugin's fleet listener calls `refresh()`
 * when the engine announces a change, so the open popover follows the state
 * without polling.
 */
import type { DreyPluginApi } from '../../../../shared/plugin-api/renderer';
import type { AutopilotView } from '../../../../shared/autopilot';
import type { ChainStatus } from '../../../../packages/tickets-engine/src/fleet/protocol';
import { stopAllNow, writeAutopilot, type AutopilotOutcome } from './controller';
import { openAutopilotPopover, type AutopilotPopover } from './popover';

export interface AutopilotCommandDeps {
  readonly api: DreyPluginApi;
  /** The chain's Autopilot as the plugin last heard it; null = no chain config. */
  readonly view: () => AutopilotView | null;
  /** A reply's fresh chain status goes to the plugin's one chain state. */
  readonly applyStatus: (status: ChainStatus) => void;
}

export interface AutopilotCommand {
  toggle(): void;
  refresh(): void;
}

export function createAutopilotCommand(deps: AutopilotCommandDeps): AutopilotCommand {
  const { api } = deps;
  const t = (key: string, params?: Record<string, string | number>): string => api.i18n.t(key as never, params as never);
  const io = { invoke: (method: string, payload?: unknown): Promise<unknown> => api.backend.invoke(method, payload) };
  let open: AutopilotPopover | null = null;

  const applied = (outcome: AutopilotOutcome): AutopilotOutcome => {
    if (outcome.ok && outcome.status !== null) {
      deps.applyStatus(outcome.status);
    }
    return outcome;
  };

  return {
    toggle() {
      if (open !== null) {
        open.close();
        return;
      }
      if (deps.view() === null) {
        return;
      }
      open = openAutopilotPopover(
        {
          t,
          view: deps.view,
          set: async (record) => applied(await writeAutopilot(io, t, record)),
          stopAll: async () => applied(await stopAllNow(io, t)),
          formatTime: (date) => api.i18n.formatTime(date),
        },
        () => {
          open = null;
        },
      );
    },
    refresh() {
      open?.refresh();
    },
  };
}
