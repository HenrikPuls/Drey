import {
  ApplicationConfig,
  computed,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { McState } from './api/state';
import { MC_CHAT_STATE } from './chat/chat';
import { MC_TEAM_STATE, type McTeamPersona, type McTeamState } from './team/team';
import { MC_WORK_STATE, type McPersona, type McWorkState } from './work/work.model';

/** The pairing code arrives as `#pair=CODE` in the device's URL (req-66). */
function pairCodeFromLocation(): string | null {
  if (typeof location === 'undefined') {
    return null;
  }
  return /^#pair=([A-Za-z0-9-]+)$/.exec(location.hash)?.[1] ?? null;
}

/**
 * One shared McState for the whole shell: the chat tab consumes it
 * directly, Work and Team through the thin view adapters below — every
 * tab reads the same signals and writes through the same actions.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    McState,
    { provide: MC_CHAT_STATE, useExisting: McState },
    {
      provide: MC_WORK_STATE,
      useFactory: (): McWorkState => {
        const state = inject(McState);
        return {
          get needs() {
            return state.needs();
          },
          get board() {
            return state.board() as McWorkState['board'];
          },
          get personas() {
            return state.personas() as unknown as readonly McPersona[];
          },
          get readOnly() {
            return state.readOnly();
          },
          moveTicket: (ticketId, phaseId) => state.moveTicket(ticketId, phaseId),
        };
      },
    },
    {
      provide: MC_TEAM_STATE,
      useFactory: (): McTeamState => {
        const state = inject(McState);
        return {
          team: computed(() => state.team().personas as unknown as readonly McTeamPersona[] | null),
        };
      },
    },
    provideAppInitializer(() => inject(McState).boot(pairCodeFromLocation())),
  ],
};
