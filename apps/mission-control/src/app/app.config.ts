import {
  ApplicationConfig,
  computed,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  signal,
} from '@angular/core';
import { McState } from './api/state';
import { bootHintsFromLocation } from './api/client';
import { parsePriorities } from '@mission-ui/api/dto';
import { MC_CHAT_STATE } from '@mission-ui/chat/chat.model';
import { MC_APP_NAV, type McAppNav } from '@mission-ui/app-bar/app-bar';
import { MC_TEAM_DETAIL, type PersonaFacts, type TeamDetailVm } from '@mission-ui/team/detail';
import {
  MC_TICKET,
  type GatePhase,
  type TicketDoc,
  type TicketVm,
} from '@mission-ui/ticket/ticket.model';
import { MC_TEAM_STATE, type McTeamPersona, type McTeamState } from '@mission-ui/team/team';
import { MC_WORK_STATE, type McPersona, type McWorkState } from '@mission-ui/work/work.model';
import { MC_SETTINGS_STATE } from '@mission-ui/settings/settings.model';
import { MC_TOAST_STATE } from '@mission-ui/toast.model';
import { MC_PLAN_STATE, type McPlanState } from '@mission-ui/plan/plan.model';
import { MC_APPROVE_STATE, type McApproveState } from '@mission-ui/plan/approve.model';
import { MC_FLOW_STATE, type McFlowState } from '@mission-ui/flow/flow.model';

/**
 * One shared McState for the whole shell: the chat tab consumes it
 * directly, Work, Team and the ticket screen through the thin view
 * adapters below — every tab reads the same signals and writes through
 * the same actions.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    McState,
    { provide: MC_CHAT_STATE, useExisting: McState },
    {
      // The app bar's ☰ on every phone page: back to the chat with its history open (E13-24).
      provide: MC_APP_NAV,
      useFactory: (): McAppNav => {
        const state = inject(McState);
        return {
          openMenu: () => {
            state.chatMenu.set(true);
            state.ticketOpen.set(null);
            state.personaDetail.set(null);
            state.tab.set('chat');
          },
        };
      },
    },
    { provide: MC_TOAST_STATE, useExisting: McState },
    { provide: MC_SETTINGS_STATE, useExisting: McState },
    {
      provide: MC_PLAN_STATE,
      useFactory: (): McPlanState => {
        const state = inject(McState);
        return {
          ticket: () => state.shapedTicket(),
          doc: () => {
            const doc = state.shapeDoc();
            return doc !== null && doc.id === state.shapedTicket() ? doc : null;
          },
          status: () => {
            const ticket = state.shapedTicket();
            return ticket === null ? null : state.planOf(ticket);
          },
          proposal: () => state.splitProposal(),
          decide: async (choice) => {
            const file = state.chat().active?.file ?? null;
            return file === null ? { ok: false, error: 'no chat session is open' } : state.shapeDecide(file, choice);
          },
          save: (text) => state.saveShapeDoc(text),
          reload: async () => {
            const ticket = state.shapedTicket();
            if (ticket !== null) {
              await state.loadShapeDoc(ticket);
            }
          },
          setFlush: (flush) => state.setPlanFlush(flush),
          busy: state.shapeBusy,
        };
      },
    },
    {
      provide: MC_APPROVE_STATE,
      useFactory: (): McApproveState => {
        const state = inject(McState);
        return {
          open: () => state.approvalTicket(),
          approval: () => state.approval(),
          error: () => state.approvalError(),
          readOnly: () => state.readOnly(),
          estimate: (gate, persona) => state.estimateFor(gate, persona),
          edit: (edit) => state.editParts(edit),
          release: (scope) => state.releaseParts(scope),
          changeFlow: (part) => {
            const ticket = state.approvalTicket();
            if (ticket !== null) {
              void state.openFlow(ticket, part);
            }
          },
          changeSplit: () => {
            const ticket = state.approvalTicket();
            state.closeApproval();
            if (ticket !== null) {
              state.beginShape(ticket);
            }
          },
          close: () => state.closeApproval(),
          openTicket: (id) => state.openTicket(id),
        };
      },
    },
    {
      provide: MC_FLOW_STATE,
      useFactory: (): McFlowState => {
        const state = inject(McState);
        return {
          flow: () => state.flow(),
          saved: () => state.flowSaved(),
          error: () => state.flowError(),
          readOnly: () => state.readOnly(),
          edit: (op) => state.editFlow(op),
          draft: (ask) => state.draftFlow(ask),
          paulReason: () => state.flowReason(),
          undoDraft: () => state.undoFlowDraft(),
          save: () => state.saveFlow(),
          close: () => state.closeFlow(),
        };
      },
    },
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
          get runs() {
            return state.team().runs;
          },
          toast: (message, kind) => state.toast(message, kind),
          moveTicket: (ticketId, phaseId) => state.moveTicket(ticketId, phaseId),
          openTicket: (ticketId) => state.openTicket(ticketId),
          openTicketSendBack: (ticketId) => state.openTicketSendBack(ticketId),
          promote: (ticketId) => state.prefillChat(`promote ${ticketId}`),
          answer: (runId, text) => state.answerRun(runId, text),
          finishManual: (ticketId) => state.finishManualStep(ticketId),
          sendBackManual: (ticketId, note) => state.sendBackManualStep(ticketId, note),
          openPersona: (titleOrId) => {
            const byTitle = (
              state.personas() as unknown as readonly { id: string; title: string }[]
            ).find((p) => p.title === titleOrId || p.id === titleOrId);
            state.openPersona(byTitle?.id ?? titleOrId);
          },
        };
      },
    },
    {
      provide: MC_TEAM_STATE,
      useFactory: (): McTeamState => {
        const state = inject(McState);
        return {
          team: computed(() => state.team().personas as unknown as readonly McTeamPersona[] | null),
          chainMaster: computed(() => state.team().chainMaster ?? null),
          pausedPersonas: computed(() => state.team().pausedPersonas ?? []),
          openPersona: (id) => state.openPersona(id),
          openTicket: (ticketId) => state.openTicket(ticketId),
          toggleChainMaster: (paused) => state.chainMaster(paused),
          personaPause: (id, paused) => state.personaPause(id, paused),
          capacity: computed(() => state.team().capacity ?? []),
          ticketTitleOf: (id) => state.ticketTitleOf(id),
          nudgeRun: (runId) => state.nudgeRun(runId),
          handToClaude: (runId) => state.handToClaude(runId),
          stopRun: (runId) => state.stopRun(runId),
          stopAll: () => state.stopAll(),
        };
      },
    },
    {
      provide: MC_TEAM_DETAIL,
      useFactory: (): TeamDetailVm => {
        const state = inject(McState);
        const persona = computed((): PersonaFacts | null => {
          const open = state.personaDetail();
          if (open === null) {
            return null;
          }
          const found = (
            state.team().personas as unknown as readonly {
              id: string;
              title: string;
              role: string;
              color: string;
              worker?: string;
              model?: string;
              pool?: readonly string[];
              skills?: readonly string[];
              router?: PersonaFacts['router'];
            }[]
          ).find((p) => p.id === open.id);
          return found ?? { id: open.id, title: open.id, role: '', color: '' };
        });
        return {
          open: () => state.personaDetail(),
          persona: () => persona(),
          improvements: () => state.improvements(),
          loadError: () => state.improvementsError(),
          readOnly: () => state.readOnly(),
          reload: async () => {
            const open = state.personaDetail();
            if (open !== null) {
              await state.loadPersona(open.id);
            }
          },
          close: () => state.closePersona(),
          apply: (proposal) => state.applyImprovement(state.personaDetail()?.id ?? '', proposal.id),
          dismiss: (proposal) =>
            state.dismissImprovement(state.personaDetail()?.id ?? '', proposal.id),
          thread: () => state.personaThread(),
          threadError: () => state.personaThreadError(),
          sendThread: async (text) => {
            const open = state.personaDetail();
            if (open === null) {
              return { ok: false, error: 'no persona is open' };
            }
            const reply = await state.sendPersonaThread(open.id, text);
            return reply;
          },
          memory: () => state.personaMemory(),
          memoryError: () => state.personaMemoryError(),
          addMemory: async (text) => {
            const open = state.personaDetail();
            if (open === null) {
              return { ok: false, error: 'no persona is open' };
            }
            return state.appendPersonaMemory(open.id, text);
          },
          pinMemory: async (index, pinned) => {
            const open = state.personaDetail();
            if (open === null) {
              return { ok: false, error: 'no persona is open' };
            }
            return state.pinPersonaMemory(open.id, index, pinned);
          },
          patchPersona: async (patch) => {
            const open = state.personaDetail();
            if (open === null) {
              return { ok: false, error: 'no persona is open' };
            }
            return state.personaPatch(open.id, patch);
          },
          prefillChat: (text) => state.prefillChat(text),
          toast: (message, kind) => state.toast(message, kind),
        };
      },
    },
    {
      provide: MC_TICKET,
      useFactory: (): TicketVm => {
        const state = inject(McState);
        const editing = signal(false);
        const savedFlash = signal<string | null>(null);
        const checkpoints = computed(() => {
          const raw = state.board() as { checkpoints?: readonly string[] } | null;
          return new Set(raw?.checkpoints ?? []);
        });
        const phaseColors = computed(() => {
          const raw = state.board() as {
            columns?: readonly { phase: { id: string; color?: string | null } }[];
          } | null;
          const map = new Map<string, string>();
          for (const column of raw?.columns ?? []) {
            if (typeof column.phase.color === 'string' && column.phase.color !== '') {
              map.set(column.phase.id, column.phase.color);
            }
          }
          return map;
        });
        /** The vault's priority vocabulary — the raw board's `priorities`, tolerantly read. */
        const priorities = computed(() =>
          parsePriorities((state.board() as { priorities?: unknown } | null)?.priorities),
        );
        const doc = computed((): TicketDoc | null => {
          const detail = state.ticketDetail();
          if (detail === null) {
            return null;
          }
          const marks = checkpoints();
          const phases: GatePhase[] = detail.phases.map((phase) => ({
            id: phase.id,
            title: phase.title,
            checkpoint: marks.has(phase.id),
          }));
          return {
            id: detail.id,
            title: detail.title,
            text: detail.text,
            revision: detail.revision,
            phase: detail.phase,
            phases,
            chain: detail.chain,
            priority: detail.priority,
            priorities: priorities().order,
            blocked: detail.blocked,
            blockedBy: detail.blockedBy,
            usage: detail.usage,
            verlauf: detail.verlauf,
            ...(detail.comments === undefined ? {} : { comments: detail.comments }),
          };
        });
        return {
          doc: () => doc(),
          editing: () => editing(),
          enterEdit: () => editing.set(true),
          exitEdit: () => editing.set(false),
          savedFlash: () => savedFlash(),
          flashSaved: () => {
            savedFlash.set('Saved — one commit on the desk.');
            setTimeout(() => savedFlash.set(null), 4000);
          },
          loadError: () => state.ticketError(),
          reload: async () => {
            const open = state.ticketOpen();
            if (open !== null) {
              await state.loadTicket(open.id);
            }
          },
          phaseColor: () => {
            const detail = state.ticketDetail();
            return detail === null ? null : (phaseColors().get(detail.phase) ?? null);
          },
          diff: () => state.diff() as ReturnType<TicketVm['diff']>,
          readOnly: () => state.readOnly(),
          attachmentUrl: (name) => {
            const url = state.attachmentUrl(name);
            if (url === null) {
              void state.ensureAttachment(name);
            }
            return url;
          },
          wholeFile: (path) => state.wholeFile(path),
          plan: () => {
            const id = state.ticketOpen()?.id ?? null;
            return id === null ? null : state.planOf(id);
          },
          estimate: (gate, persona) => state.estimateFor(gate, persona),
          videoUrl: (name) => {
            const url = state.videoUrl(name);
            if (url === null) {
              void state.ensureVideo(name);
            }
            return url;
          },
          onClose: () => state.closeTicket(),
          shape: (ticketId) => state.beginShape(ticketId),
          openFlow: (ticketId) => {
            void state.openFlow(ticketId, null);
          },
          approvePlan: (ticketId) => {
            state.closeTicket();
            void state.openApproval(ticketId);
          },
          proposeChain: (text) => state.prefillChat(text),
          prefillChat: (text) => state.prefillChat(text),
          save: async (text) => {
            const reply = await state.saveTicket(text);
            return reply.ok ? { ok: true } : { ok: false, error: reply.error };
          },
          accept: () => state.acceptTicket(),
          sendBack: (note, comments) => state.sendBack(note, comments),
          sendBackOpen: () => {
            const pending = state.sendBackPending();
            return pending !== null && pending === state.ticketOpen()?.id;
          },
          dismissSendBack: () => state.clearSendBack(),
        };
      },
    },
    provideAppInitializer(() => inject(McState).boot(bootHintsFromLocation())),
  ],
};
