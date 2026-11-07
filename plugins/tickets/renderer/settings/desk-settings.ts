/**
 * Settings → Tickets, the top of the page the boards show (E13-12, board
 * 7g): Crew, Flow, Autopilot, Budget and runners, Walkthrough videos. Every
 * setting is drawn as the board draws it — bold name, one description, then
 * its control. The devices and the pairing are the page's Remote section
 * (req-66) under its own heading, and the pipeline, prompts and workers keep
 * their sections below. Every value is read from what the engine answers;
 * the only things written here are `videos.inGit` and `videos.maxMb`,
 * through the engine's own settings guard (E12-3) — nothing is defined twice.
 */
import { autopilotViewOf, resumeAtOfTime, timeFieldOfResume, type AutopilotView } from '../../../../shared/autopilot';
import { writeAutopilot } from '../autopilot/controller';
import type { DreyPluginApi } from '../../../../shared/plugin-api/renderer';
import { WORKER_PROVIDERS } from '../../../../packages/tickets-engine/src/fleet/protocol';
import { fleetSettingDefault } from '../../shared/fleet-defaults';
import type { PersonaView } from '../../shared/remote-protocol';
import type { BoardSnapshot } from '../../shared/tickets';
import { RUNNER_LABEL } from '../settings-workers';
import { el, textButton } from '../settings-dom';
import { budgetLineOf, maxMbOf, parseDeskVideos, runnersLineOf, standardFlowOf, type DeskVideos } from './desk-model';

export interface DeskSettingsHooks {
  /** Opens the Team tab ("Edit crew"). */
  readonly openTeam: () => void;
  /** Opens the Flow tab of a ticket. */
  readonly openFlow: (ticketId: string) => void;
  /** Brings the page's runner settings into view ("Manage"). */
  readonly manageRunners: () => void;
  /** Opens the Autopilot popover over the status item ("Change…"). */
  readonly openAutopilot: () => void;
}

export interface DeskSettings {
  /** Crew, Flow, Autopilot and Budget and runners. */
  readonly root: HTMLElement;
  /** Walkthrough videos: the page places it after the runner settings. */
  readonly videos: HTMLElement;
  /** Repaints the rows that follow the board; refetches the engine's answers. */
  update(snapshot: BoardSnapshot): void;
}

/** One group of the page: the board's heading, then its settings. */
function section(id: string, title: string, anchor: string): { root: HTMLElement; list: HTMLElement } {
  const root = el('section', 'tset-section');
  root.setAttribute('aria-labelledby', id);
  root.dataset['settingsSection'] = anchor;
  const h = el('h3', undefined, title);
  h.id = id;
  const list = el('div', 'tset-sets');
  root.append(h, list);
  return { root, list };
}

/** One setting (board 7g): the name in bold, the description, then the control row. */
function setting(name: string, description: string, ...controls: Array<HTMLElement | string>): HTMLElement {
  const box = el('div', 'tset-set');
  box.append(el('b', 'tset-set-name', name), el('span', 'tset-set-desc', description));
  if (controls.length > 0) {
    const row = el('div', 'tset-set-controls');
    row.append(...controls.map((c) => (typeof c === 'string' ? el('span', undefined, c) : c)));
    box.append(row);
  }
  return box;
}

export function createDeskSettings(api: DreyPluginApi, hooks: DeskSettingsHooks): DeskSettings {
  const root = el('div', 'tset-desk');
  let personas: readonly PersonaView[] = [];
  let snapshot: BoardSnapshot | null = null;
  let videos: DeskVideos | null = null;
  let videoError = '';
  let confirming = false;
  let asked = false;

  // --- Crew --------------------------------------------------------------
  const team = section('tset-team-head', 'Crew', 'crew');
  const teamNames = el('span');
  const editTeam = textButton('Edit crew');
  editTeam.addEventListener('click', hooks.openTeam);
  team.list.append(setting('Personas', 'Default crew for new tickets. Add more, for example a security reviewer.', teamNames, editTeam));
  // The owner's own name: the human persona's title, shown wherever the owner works a column.
  const humanName = el('input');
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
  team.list.append(setting('Your name', 'The human persona, shown wherever you work a column.', humanName));

  // --- Flow --------------------------------------------------------------
  const flow = section('tset-flow-head', 'Flow', 'flow');
  const flowStrip = el('span');
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
  flow.list.append(setting('Default flow', 'Steps a new ticket runs through unless its plan says otherwise.', flowStrip, ticketPick, openFlow));

  // --- Autopilot (req-95b, concept 6.1): the same three states the status item switches --
  const autopilot = section('tset-autopilot-head', 'Autopilot', 'autopilot');
  const autopilotState = el('span');
  autopilotState.id = 'tset-autopilot';
  autopilotState.dataset['settingKey'] = 'autopilot';
  const change = textButton('Change…');
  change.addEventListener('click', hooks.openAutopilot);
  const resumeAt = el('input');
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
      autopilotState.textContent = api.i18n.t(`autopilot.state.${view?.state ?? 'off'}`);
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
  resumeAt.addEventListener('change', () => {
    const at = resumeAtOfTime(resumeAt.value, new Date());
    if (at !== null) {
      void writeAutopilotRow({ state: 'paused', resumeAt: at });
    }
  });
  autopilot.list.append(
    setting(
      'Autopilot',
      'What starts next: On (workers pick up tickets by themselves), Paused (running steps finish, nothing new starts) or Off (you start every step). Also in the status bar and with Mod+Alt+P.',
      autopilotState,
      change,
    ),
    setting('Resume paused autopilot at', 'A paused autopilot switches itself on again at this time.', resumeAt, autopilotNote),
  );

  // --- Budget and runners --------------------------------------------------
  const budget = section('tset-budget-head', 'Budget and runners', 'budget');
  const budgetLine = el('span');
  const runnersLine = el('span');
  const manage = textButton('Manage');
  manage.addEventListener('click', hooks.manageRunners);
  budget.list.append(
    setting('Daily budget', "The personas' daily budgets added up, and what they spent today.", budgetLine),
    setting('Runners', 'Where builds run and how many at once.', runnersLine, manage),
  );

  // --- Walkthrough videos ------------------------------------------------
  const video = section('tset-videos-head', 'Walkthrough videos', 'videos');
  const keep = el('input');
  keep.type = 'checkbox';
  keep.id = 'tset-videos-in-git';
  const keepLabel = el('label', 'tset-set-check');
  keepLabel.htmlFor = keep.id;
  keepLabel.append(keep, el('span', undefined, 'Videos are large and stay in the history once committed. Off keeps them in tickets/videos only.'));
  const confirmBox = el('div', 'tset-desk-confirm');
  const limit = el('input');
  limit.type = 'number';
  limit.min = '1';
  limit.step = '1';
  limit.id = 'tset-videos-limit';
  limit.setAttribute('aria-label', 'Largest video in MB');
  const limitUnit = el('span', 'tset-muted', 'MB');
  const videoNote = el('span', 'field-hint');
  const keepSetting = el('div', 'tset-set');
  keepSetting.append(el('b', 'tset-set-name', 'Keep videos in Git'), keepLabel, confirmBox, videoNote);
  video.list.append(keepSetting, setting('Largest video', 'One limit per video. Nothing is removed automatically.', limit, limitUnit));

  root.append(team.root, flow.root, autopilot.root, budget.root);

  // --- painting ------------------------------------------------------------
  const paintTeam = (): void => {
    const crew = personas.filter((p) => p.kind !== 'human');
    teamNames.textContent = crew.length === 0 ? 'No crew yet' : crew.map((p) => p.title).join(', ');
    const human = personas.find((p) => p.kind === 'human');
    if (human !== undefined && document.activeElement !== humanName) {
      humanName.value = human.title;
    }
    budgetLine.textContent = budgetLineOf(personas);
  };

  const paintFlow = (): void => {
    const items = snapshot === null ? [] : standardFlowOf(snapshot.pipeline, personas);
    flowStrip.textContent = items.length === 0 ? 'No column runs an agent' : items.map((item) => item.title).join(' → ');
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
    videos: video.root,
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
