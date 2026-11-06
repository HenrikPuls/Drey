/**
 * Settings → Tickets, the top of the page the boards show (E13-12, board
 * 7g): Team, Default flow, Budget and runners, Walkthrough videos. The
 * devices and the pairing are the page's Remote section (req-66) under its
 * new heading, and the pipeline, prompts and workers keep their sections
 * below. Every value is read from what the engine answers; the only things
 * written here are `videos.inGit` and `videos.maxMb`, through the
 * engine's own settings guard (E12-3) — nothing is defined twice.
 */
import { autopilotViewOf, resumeAtOfTime, timeFieldOfResume, type AutopilotKind, type AutopilotView } from '../../../../shared/autopilot';
import { writeAutopilot } from '../autopilot/controller';
import type { DreyPluginApi } from '../../../../shared/plugin-api/renderer';
import { parseHandover } from '../../../../packages/tickets-engine/src/contracts/tickets';
import { WORKER_PROVIDERS } from '../../../../packages/tickets-engine/src/fleet/protocol';
import { fleetSettingDefault } from '../../shared/fleet-defaults';
import type { PersonaView } from '../../shared/remote-protocol';
import type { BoardSnapshot } from '../../shared/tickets';
import { RUNNER_LABEL } from '../settings-workers';
import { el, mutate, textButton } from '../settings-dom';
import { budgetLineOf, maxMbOf, parseDeskVideos, runnersLineOf, standardFlowOf, type DeskVideos } from './desk-model';

export interface DeskSettingsHooks {
  /** Opens the Team tab ("Edit crew"). */
  readonly openTeam: () => void;
  /** Opens the Flow tab of a ticket. */
  readonly openFlow: (ticketId: string) => void;
  /** Brings the page's runner settings into view ("Manage"). */
  readonly manageRunners: () => void;
}

export interface DeskSettings {
  readonly root: HTMLElement;
  /** Repaints the rows that follow the board; refetches the engine's answers. */
  update(snapshot: BoardSnapshot): void;
}

const row = (label: string, value: HTMLElement): HTMLElement[] => [el('div', 'tset-kv-label', label), value];

function section(id: string, title: string): { root: HTMLElement; grid: HTMLElement } {
  const root = el('section', 'tset-section');
  root.setAttribute('aria-labelledby', id);
  const head = el('div', 'tset-section-head');
  const h = el('h3', undefined, title);
  h.id = id;
  head.append(h);
  const grid = el('div', 'tset-kv');
  root.append(head, grid);
  return { root, grid };
}

const value = (...children: Array<HTMLElement | string>): HTMLElement => {
  const box = el('div', 'tset-kv-value');
  box.append(...children.map((c) => (typeof c === 'string' ? document.createTextNode(c) : c)));
  return box;
};

export function createDeskSettings(api: DreyPluginApi, hooks: DeskSettingsHooks): DeskSettings {
  const root = el('div', 'tset-desk');
  let personas: readonly PersonaView[] = [];
  let snapshot: BoardSnapshot | null = null;
  let videos: DeskVideos | null = null;
  let videoError = '';
  let confirming = false;
  let asked = false;

  // --- Team --------------------------------------------------------------
  const team = section('tset-team-head', 'Crew');
  const teamChips = el('div', 'tset-desk-chips');
  const editTeam = textButton('Edit crew');
  editTeam.addEventListener('click', hooks.openTeam);
  team.grid.append(...row('Crew', value(teamChips, editTeam)));
  // The owner's own name: the human persona's title, shown wherever the owner works a column.
  const humanName = el('input', 'mono-input');
  humanName.type = 'text';
  humanName.spellcheck = false;
  humanName.id = 'tset-human-name';
  humanName.setAttribute('aria-label', 'Your name');
  humanName.addEventListener('change', () => {
    const name = humanName.value.trim();
    void (async () => {
      try {
        await api.settings.set('personas.humanName', name);
        await api.backend.invoke('setHumanName', { name });
      } catch {
        // The field repaints from the engine's answer below.
      }
      await loadPersonas();
    })();
  });
  team.grid.append(...row('Your name', value(humanName)));

  // --- Default flow ------------------------------------------------------
  const flow = section('tset-flow-head', 'Default flow');
  const flowStrip = el('ol', 'tset-desk-flow');
  flowStrip.setAttribute('aria-label', 'Standard flow');
  const ticketPick = el('select');
  ticketPick.setAttribute('aria-label', 'Ticket to edit the flow of');
  const openFlow = textButton('Open flow editor');
  openFlow.title = "Changes are per ticket: pick a ticket, edit its flow. The standard flow itself is the pipeline's columns below.";
  openFlow.addEventListener('click', () => {
    if (ticketPick.value !== '') {
      hooks.openFlow(ticketPick.value);
    }
  });
  const flowTools = el('div', 'tset-desk-tools');
  flowTools.append(ticketPick, openFlow);
  // Two rows on purpose (D-17): the steps offer workers; which ticket's flow to edit is another question.
  flow.grid.append(...row('Standard flow', value(flowStrip)), ...row('Flow of one ticket', value(flowTools)));

  // --- Budget and runners ------------------------------------------------
  const budget = section('tset-budget-head', 'Budget and runners');
  const budgetLine = el('span');
  const runnersLine = el('span');
  const manage = textButton('Manage');
  manage.addEventListener('click', hooks.manageRunners);
  budget.grid.append(...row('Daily budget', value(budgetLine)), ...row('Runners', value(runnersLine, manage)));

  // Autopilot (req-95b, concept 6.1): the same three states the status item switches; a
  // refusal reads as words from the catalog, under the row.
  const autopilot = el('select');
  autopilot.id = 'tset-autopilot';
  autopilot.dataset['settingKey'] = 'autopilot';
  autopilot.setAttribute('aria-label', 'Autopilot');
  for (const id of ['on', 'paused', 'off'] as const) {
    autopilot.append(Object.assign(el('option', undefined, api.i18n.t(`autopilot.state.${id}`)), { value: id }));
  }
  const resumeAt = el('input', 'mono-input');
  resumeAt.type = 'time';
  resumeAt.id = 'tset-autopilot-resume';
  resumeAt.dataset['settingKey'] = 'autopilot.resumeAt';
  resumeAt.setAttribute('aria-label', 'Resume paused autopilot at');
  const autopilotNote = el('div', 'tset-kv-note');
  autopilotNote.setAttribute('role', 'alert');
  const autopilotT = (key: string, params?: Record<string, string | number>): string => api.i18n.t(key as never, params as never);
  const autopilotIo = { invoke: (method: string, payload?: unknown): Promise<unknown> => api.backend.invoke(method, payload) };
  const paintAutopilot = async (): Promise<void> => {
    try {
      const view = autopilotViewOf(await api.backend.invoke('chainStatus'));
      autopilot.value = view?.state ?? 'off';
      resumeAt.value = timeFieldOfResume(view?.resumeAt);
      resumeAt.disabled = view?.state !== 'paused';
    } catch {
      // The row keeps what it showed.
    }
  };
  const writeAutopilotRow = async (record: AutopilotView): Promise<void> => {
    const outcome = await writeAutopilot(autopilotIo, autopilotT, record);
    autopilotNote.textContent = outcome.ok ? '' : outcome.words;
    await paintAutopilot();
  };
  autopilot.addEventListener('change', () => void writeAutopilotRow({ state: autopilot.value as AutopilotKind }));
  resumeAt.addEventListener('change', () => {
    const at = resumeAtOfTime(resumeAt.value, new Date());
    if (at !== null) {
      void writeAutopilotRow({ state: 'paused', resumeAt: at });
    }
  });
  budget.grid.prepend(
    ...row('Autopilot', value(autopilot)),
    ...row('Resume paused autopilot at', value(resumeAt, autopilotNote)),
  );

  // --- Walkthrough videos ------------------------------------------------
  const video = section('tset-videos-head', 'Walkthrough videos');
  const keep = el('input');
  keep.type = 'checkbox';
  keep.id = 'tset-videos-in-git';
  const keepLabel = el('label', 'tset-desk-check');
  keepLabel.htmlFor = keep.id;
  keepLabel.append(keep, document.createTextNode('Keep in Git'));
  const confirmBox = el('div', 'tset-desk-confirm');
  const limit = el('input', 'mono-input');
  limit.type = 'number';
  limit.min = '1';
  limit.step = '1';
  limit.id = 'tset-videos-limit';
  limit.setAttribute('aria-label', 'Largest video in MB');
  const limitUnit = el('span', 'tset-muted', 'MB');
  const limitBox = el('div', 'tset-desk-tools');
  limitBox.append(limit, limitUnit);
  const videoNote = el('span', 'field-hint');
  video.grid.append(...row('Videos', value(keepLabel, confirmBox, videoNote)), ...row('Largest video', value(limitBox)));

  // The page's section anchors (settings-sections.ts).
  team.root.dataset['settingsSection'] = 'crew';
  flow.root.dataset['settingsSection'] = 'flow';
  budget.root.dataset['settingsSection'] = 'budget';
  root.append(team.root, flow.root, budget.root, video.root);

  // --- painting ------------------------------------------------------------
  const paintTeam = (): void => {
    teamChips.replaceChildren(
      ...personas.map((p) => {
        const chip = el('span', 'tset-desk-chip');
        const dot = el('span', 'tset-desk-dot');
        dot.style.background = p.color;
        chip.append(dot, document.createTextNode(p.title));
        return chip;
      }),
    );
    if (personas.length === 0) {
      teamChips.textContent = 'No crew yet';
    }
    const human = personas.find((p) => p.kind === 'human');
    if (human !== undefined && document.activeElement !== humanName) {
      humanName.value = human.title;
    }
    budgetLine.textContent = budgetLineOf(personas);
  };

  const paintFlow = (): void => {
    const items = snapshot === null ? [] : standardFlowOf(snapshot.pipeline, personas);
    flowStrip.replaceChildren(
      ...items.map((item) => {
        const li = el('li', 'tset-desk-step');
        li.append(el('b', undefined, item.title));
        if (item.who !== null) {
          li.append(document.createTextNode(` · ${item.who}`));
        }
        const phase = snapshot?.pipeline.find((candidate) => candidate.id === item.id);
        const worker = el('select');
        worker.setAttribute('aria-label', `Worker for ${item.title}`);
        for (const id of WORKER_PROVIDERS) {
          worker.append(Object.assign(el('option', undefined, RUNNER_LABEL[id]), { value: id }));
        }
        worker.value = phase?.worker ?? parseHandover(phase?.handover ?? '').worker ?? snapshot?.defaultWorker ?? WORKER_PROVIDERS[0]!;
        worker.addEventListener('change', () => void mutate(api, 'columns', { phase: item.id, worker: worker.value }));
        li.append(worker);
        return li;
      }),
    );
    if (items.length === 0) {
      flowStrip.textContent = 'No column runs an agent';
    }
    const tickets =
      snapshot === null
        ? []
        : snapshot.columns
            .filter((column) => column.phase.id !== snapshot!.pipeline[0]?.id)
            .flatMap((column) => column.tickets)
            .filter((card) => card.meta.title !== '');
    const previous = ticketPick.value;
    ticketPick.replaceChildren(
      ...tickets.map((card) => Object.assign(el('option', undefined, `${card.id} · ${card.meta.title}`), { value: card.id })),
    );
    if (tickets.some((card) => card.id === previous)) {
      ticketPick.value = previous;
    }
    ticketPick.hidden = tickets.length === 0;
    openFlow.disabled = tickets.length === 0;
  };

  const paintRunners = async (): Promise<void> => {
    const pools = await Promise.all(
      WORKER_PROVIDERS.map(async (id) => {
        const size = await api.settings.get<number>(`fleet.pool.${id}.size`);
        const fallback = fleetSettingDefault(`fleet.pool.${id}.size`);
        return { label: RUNNER_LABEL[id], size: typeof size === 'number' && size >= 1 ? size : typeof fallback === 'number' ? fallback : 1 };
      }),
    );
    runnersLine.textContent = runnersLineOf(pools);
  };

  const paintVideos = (): void => {
    keep.checked = videos?.inGit ?? false;
    keep.disabled = videos === null;
    limit.disabled = videos === null;
    if (document.activeElement !== limit) {
      limit.value = videos === null || videos.maxMb === 0 ? '' : String(videos.maxMb);
    }
    confirmBox.replaceChildren();
    confirmBox.hidden = !confirming;
    if (confirming && videos !== null) {
      const warn = el('p', 'field-hint', 'Videos are large files and stay in the history once committed.');
      const tools = el('div', 'tset-desk-tools');
      const on = textButton('Keep in Git', 'primary');
      on.addEventListener('click', () => void patchVideos({ inGit: true, confirm: true }));
      tools.append(on);
      if (videos.existing > 0) {
        const include = textButton(`Keep in Git and include the ${videos.existing} existing ${videos.existing === 1 ? 'video' : 'videos'}`);
        include.addEventListener('click', () => void patchVideos({ inGit: true, confirm: true, includeExisting: true }));
        tools.append(include);
      }
      const cancel = textButton('Cancel');
      cancel.addEventListener('click', () => {
        confirming = false;
        paintVideos();
      });
      tools.append(cancel);
      confirmBox.append(warn, tools);
    }
    videoNote.classList.toggle('tset-error', videoError !== '');
    videoNote.textContent = videoError !== '' ? videoError : (videos?.notice ?? '');
  };

  const loadVideos = async (): Promise<void> => {
    try {
      videos = parseDeskVideos(await api.backend.invoke('settingsRead'));
    } catch {
      videos = null;
    }
    paintVideos();
  };

  const patchVideos = async (patch: Record<string, unknown>): Promise<void> => {
    videoError = '';
    confirming = false;
    try {
      const reply = (await api.backend.invoke('settingsPatch', patch)) as { ok?: boolean; error?: string };
      if (reply.ok === false) {
        videoError = reply.error ?? 'The engine refused the change';
      }
      videos = parseDeskVideos(reply) ?? videos;
    } catch (failure) {
      videoError = failure instanceof Error ? failure.message : String(failure);
    }
    paintVideos();
  };

  keep.addEventListener('change', () => {
    if (keep.checked) {
      // Turning it on is a confirmed act (the engine refuses it otherwise).
      keep.checked = false;
      confirming = true;
      paintVideos();
    } else {
      void patchVideos({ inGit: false });
    }
  });
  limit.addEventListener('change', () => {
    const mb = maxMbOf(limit.value);
    if (mb === null) {
      videoError = 'The largest video is a whole number of megabytes';
      paintVideos();
      return;
    }
    void patchVideos({ maxMb: mb });
  });

  const loadPersonas = async (): Promise<void> => {
    try {
      const reply = await api.backend.invoke('personas');
      personas = Array.isArray(reply) ? (reply as PersonaView[]) : [];
    } catch {
      // The rows keep what they had.
    }
    paintTeam();
    paintFlow();
  };

  paintVideos();
  return {
    root,
    update: (next) => {
      snapshot = next;
      paintFlow();
      void loadPersonas();
      void paintRunners();
      void paintAutopilot();
      if (!asked || !confirming) {
        asked = true;
        void loadVideos();
      }
    },
  };
}
