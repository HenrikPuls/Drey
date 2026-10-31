/**
 * The Work panel (ADR-0087, req-75 W1/W1b; the kanban board of ADR-0076
 * before it): Needs you, Shaping, Running, Ideas and Done this week as
 * one list in the dock panel, and each ticket's thread beside its file.
 * Plain DOM (ADR-0044 rule 2); all data comes from `backend.invoke('board')`
 * snapshots — the renderer never parses a ticket file. One module-level
 * store serves every view; a view is just a DOM root plus a render call.
 */
import { createTranscriptView } from './transcript-view';
import { formatWatch, parseStreamEvents } from './watch-format';
import { newWaits } from './waiting';
import { interactiveEndMoves, interactiveModeFor, type InteractiveMode } from './end-moves';
import { asParagraphs, chainLogStamp, visibleChainLog } from './chain-log';
import { chainAlertsOf, newChainAlerts, type ChainAlert } from './chain-alerts';
import type { DreyPluginApi, PluginWidgetContrib } from '../../../shared/plugin-api/renderer';
import {
  branchForTicket,
  openTicketCount,
  TICKET_PRIORITIES,
  type BoardSnapshot,
  type CreateResult,
  type MutationResult,
  type ProjectRef,
  type TicketCard,
  type TicketPriority,
  type TicketTrack,
} from '../shared/tickets';
import { needsBlockedConfirm } from './blocked-view';
import { PRIORITY_LABEL, createGroupFoldStore, workListNode, type WorkPanelDeps } from './work-panel';
import { createRunComposer } from './run-composer';
import { THREAD_KEY, ticketPagePlan } from './ticket-page';
import { PENDING_HINT, dialogStarter } from './dialog-starters';
import { ageWords, checkpointActionOf, ideaPhaseIds, needKindLabel, queueTargetOf, workGroups } from './work-groups';
import { readyCardNode, storyNode } from './ready-view';
import type { ChangesReply } from '../shared/changes';
import { headerControls, liveStateWord, threadSteps, durationWords, type ThreadStep } from './thread-steps';
import type { WorktreeFile } from '../main/worktree-changes';
import { createTicketsSettingsPage } from './settings-page';
import { createFilesOperationsHandler, ticketsContextMenuItems } from './files-guard';
import { createTicketHeader, ticketLogFold } from './ticket-header';
import { boardIssuesChip, boardIssuesList, type BoardIssuesDeps } from './board-issues';
import type { ChainStatus, FleetHandoverConfig, RunInfo } from '../main/fleet/protocol';
import { DEFAULT_FLEET_HANDOVER, normalizeFleetHandover } from '../main/fleet/protocol';
import { handoverDialogState } from './handover-ui';
import type { HandoverCandidate } from '../main/fleet/handover';
import { parseWorkerValue } from '../main/fleet/assignment';
import {
  contextFill,
  contextLabel,
  execClockMs,
  fleetSummary,
  formatTokens,
  spanClock,
  telemetryParts,
  workerStatus,
} from './worker-status';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// --- the shared board store (one snapshot, any number of views) --------

let snapshot: BoardSnapshot | null = null;
let busy = false;
let note = '';
let inFlight: Promise<void> | null = null;

/**
 * What the board's message is (req-60): `busy` while an action runs,
 * `ok` a result that fades by itself, `warn` / `error` stay until the
 * owner closes them — a failure never disappears unseen.
 */
type NoteKind = 'busy' | 'ok' | 'warn' | 'error';
let noteKind: NoteKind = 'ok';
let noteTimer: ReturnType<typeof setTimeout> | null = null;
/** The message is the board pull's own failure (the next good pull clears it). */
let noteFromLoad = false;

/** How long an `ok` message stays in the status bar. */
const NOTE_FADE_MS = 6_000;

/** Sets the board's message; the caller repaints (`notifyViews`). */
function setNote(text: string, kind: NoteKind): void {
  note = text;
  noteKind = kind;
  noteFromLoad = false;
  if (noteTimer !== null) {
    clearTimeout(noteTimer);
    noteTimer = null;
  }
  if (kind === 'ok' && text !== '') {
    noteTimer = setTimeout(() => {
      noteTimer = null;
      note = '';
      notifyViews();
    }, NOTE_FADE_MS);
  }
}

interface BoardView {
  readonly root: HTMLElement;
  render(): void;
  dispose(): void;
}

const views = new Set<BoardView>();

/** Which Work groups are folded — one state for every view, persisted
 *  as pure view state (never in the repo). */
const folds = createGroupFoldStore(window.localStorage);

/** Repaints the board's view controls in every panel header (req-69). */
const headerViewPainters = new Set<() => void>();

/** Repaints the project switcher in every panel header (req-72). */
const projectPainters = new Set<(projects: readonly ProjectRef[]) => void>();

const notifyViews = (): void => {
  for (const view of views) {
    view.render();
  }
  for (const paint of headerViewPainters) {
    paint();
  }
};

/** Keeps the editor's ticket headers in step with each fresh board (set in activate). */
let afterBoardRefresh: (() => void) | null = null;

function refreshBoard(): Promise<void> {
  if (inFlight !== null) {
    return inFlight;
  }
  busy = true;
  notifyViews();
  inFlight = (async () => {
    try {
      snapshot = (await invokeBoard('board')) as BoardSnapshot;
      // A fresh board clears its own earlier load error; results and
      // failures of actions keep their own lifetime.
      if (noteFromLoad) {
        setNote('', 'ok');
      }
      // The worktree note rides along (own round, never blocks the board).
      void loadWorktreesStatus();
      // The project switcher follows its own round, too (req-72).
      void invokeBoard('projects')
        .then((projects) => {
          for (const paint of projectPainters) {
            paint(projects as readonly ProjectRef[]);
          }
        })
        .catch(() => undefined);
    } catch (error) {
      setNote(messageOf(error), 'error');
      noteFromLoad = true;
    } finally {
      busy = false;
      inFlight = null;
    }
    notifyViews();
    afterBoardRefresh?.();
  })();
  return inFlight;
}

/** Runs a mutation: busy line, error surfacing, then a fresh pull.
 *  Returns the backend's result (with `id`/`path` for `create`).
 *  An error keeps its note (no refresh would clear it into view). */
async function runMutation(label: string, invoke: () => Promise<unknown>): Promise<MutationResult> {
  busy = true;
  setNote(`${label}…`, 'busy');
  notifyViews();
  let result: MutationResult;
  try {
    result = (await invoke()) as MutationResult;
  } catch (error) {
    result = { ok: false, error: messageOf(error) };
  }
  busy = false;
  if (!result.ok) {
    // A refused action often means the screen is stale (a stop of a run
    // that has already ended): pull the real state, or the lane stays and
    // every click repeats the same refusal.
    await refreshBoard().catch(() => undefined);
    setNote(result.error ?? 'the action failed', 'error');
    notifyViews();
    return result;
  }
  await refreshBoard();
  setNote(result.warning ?? '', result.warning === undefined ? 'ok' : 'warn');
  notifyViews();
  return result;
}

// `backend` is set in activate(); the helpers above close over it.
let backend: DreyPluginApi['backend'] | null = null;

/** The board's IPC seam — one place, typed; activation precedes every call. */
function invokeBoard(method: string, payload?: unknown): Promise<unknown> {
  if (backend === null) {
    return Promise.reject(new Error('the tickets plugin is not active'));
  }
  return backend.invoke(method, payload);
}

/** Opens a ticket file in the editor (the tickets vault, wherever the
 *  active pane lives — a centre tab like any note). */
function openTicketFile(api: DreyPluginApi, path: string): void {
  if (snapshot?.vaultId != null) {
    void api.documents.open(path, undefined, { vaultId: snapshot.vaultId });
  }
}

/** Outlines the Work row whose ticket file (or thread) is the active tab. */
function markOpenCard(api: DreyPluginApi): void {
  const active = api.documents.active();
  const path =
    active === null
      ? null
      : active.kind === THREAD_KIND
        ? (boardCard(threadTicketId ?? '')?.path ?? null)
        : active.vaultId === snapshot?.vaultId
          ? active.path
          : null;
  for (const node of document.querySelectorAll<HTMLElement>('.work-row')) {
    node.classList.toggle('work-row-open', path !== null && node.dataset['path'] === path);
  }
}

// --- the fleet's live runs and the chain (M84/M85, ADR-0075/0077) ----------

const LIVE_RUN_STATES: readonly string[] = ['starting', 'running', 'stopping'];
let fleetRuns: RunInfo[] = [];
let chain: ChainStatus | null = null;

// --- the worktree home's status (T-0044, ADR-0080) ------------------------

interface WorktreesStatus {
  readonly base: string | null;
  readonly orphans: readonly string[];
  readonly legacyLeftovers: readonly string[];
}

let worktrees: WorktreesStatus | null = null;

/** The status note's data — refreshed beside the board, never blocking it. */
async function loadWorktreesStatus(): Promise<void> {
  try {
    worktrees = (await invokeBoard('worktreesStatus', {})) as WorktreesStatus;
  } catch {
    worktrees = null;
  }
  notifyViews();
}

const runForCard = (id: string): RunInfo | null =>
  fleetRuns.find((r) => r.ticketId === id && LIVE_RUN_STATES.includes(r.state)) ?? null;

/** A card by id from the current snapshot. */
const boardCard = (id: string): TicketCard | null => {
  for (const column of snapshot?.columns ?? []) {
    const found = column.tickets.find((t) => t.id === id);
    if (found !== undefined) {
      return found;
    }
  }
  return null;
};

const liveRuns = (): readonly RunInfo[] =>
  fleetRuns.filter((r) => LIVE_RUN_STATES.includes(r.state));

/** Keeps the header's master switch in step (the buttons live outside the board). */
const masterButtons: { run: HTMLButtonElement; halt: HTMLButtonElement; abort: HTMLButtonElement }[] = [];

const applyChainStatus = (status: ChainStatus | null): void => {
  chain = status;
  const master = status?.master ?? 'halted';
  for (const buttons of masterButtons) {
    buttons.run.classList.toggle('tickets-master-on', master === 'run');
    buttons.halt.classList.toggle('tickets-master-on', master === 'halted');
  }
  notifyViews();
};

/** Open takeover tabs repaint their banner when the fleet snapshot changes. */
const fleetListeners = new Set<() => void>();

/** Runs and their states: the runner moves tickets (git commits in the
 *  tickets repository) when a run starts or ends, without a vault event, so
 *  a change here is the board's cue to pull. */
const runSignature = (runs: readonly RunInfo[]): string =>
  runs.map((r) => `${r.id}:${r.state}`).join('|');
let lastRunSignature: string | null = null;

const applyFleetSnapshot = (payload: { runs?: RunInfo[]; chain?: ChainStatus | null }): void => {
  fleetRuns = Array.isArray(payload.runs) ? [...payload.runs] : [];
  const signature = runSignature(fleetRuns);
  if (lastRunSignature !== null && signature !== lastRunSignature) {
    void refreshBoard();
  }
  lastRunSignature = signature;
  applyChainStatus(payload.chain ?? null);
  for (const listener of fleetListeners) {
    listener();
  }
};

/** Whether the board issues are unfolded under the toolbar (req-73; view state, per session). */
let boardIssuesOpen = false;

function boardIssuesDeps(api: DreyPluginApi, issues: BoardSnapshot['issues']): BoardIssuesDeps {
  return {
    api,
    issues,
    open: boardIssuesOpen,
    onToggle: () => {
      boardIssuesOpen = !boardIssuesOpen;
      notifyViews();
    },
    openFile: (path: string) => openTicketFile(api, path),
  };
}

/** The board's view controls in the panel header (req-69): the board
 *  issues chip (req-73), whose messages unfold above the Work list. */
function boardViewControlsNode(api: DreyPluginApi): { node: HTMLElement; dispose: () => void } {
  const node = el('span', 'tickets-head-group tickets-head-view');
  const paint = (): void => {
    node.textContent = '';
    const snap = snapshot;
    node.hidden = snap === null || snap.vaultId === null;
    if (snap === null || snap.vaultId === null) {
      return;
    }
    const chip = boardIssuesChip(boardIssuesDeps(api, snap.issues));
    if (chip !== null) {
      node.append(chip);
    }
  };
  headerViewPainters.add(paint);
  paint();
  return { node, dispose: () => headerViewPainters.delete(paint) };
}

function buildBoardView(api: DreyPluginApi): BoardView {
  const root = el('div', 'tickets-view');
  /** The list's scroll survives every re-render (the DOM is rebuilt). */
  const restoreScroll = (): (() => void) => {
    const top = root.querySelector<HTMLElement>('.work-list')?.scrollTop ?? 0;
    return () => {
      const list = root.querySelector<HTMLElement>('.work-list');
      if (list !== null) {
        list.scrollTop = top;
      }
    };
  };
  const render = (): void => {
    const restore = restoreScroll();
    try {
      draw();
      markOpenCard(api);
    } finally {
      restore();
    }
  };
  const draw = (): void => {
    root.textContent = '';
    const snap = snapshot;
    if (snap === null || snap.vaultId === null) {
      root.append(snap === null ? el('div', 'tickets-empty', 'Loading the board…') : emptyState(api, snap, runMutation));
      // A failed load or setup action still reports where every message does.
      const bar = statusBarNode(api, null);
      if (bar !== null) {
        root.append(bar);
      }
      return;
    }
    const issues = boardIssuesList(boardIssuesDeps(api, snap.issues));
    if (issues !== null) {
      root.append(issues);
    }
    root.append(workListNode(workPanelDeps(api), snap, fleetRuns, folds, notifyViews));
    const statusBar = statusBarNode(api, snap);
    if (statusBar !== null) {
      root.append(statusBar);
    }
    if (!snap.isGitRepo) {
      const warn = el('div', 'tickets-warn');
      warn.textContent =
        'The tickets vault is not a git repository — transitions are not versioned.';
      root.append(warn);
    }
  };
  const view: BoardView = { root, render, dispose: () => undefined };
  render();
  return view;
}

/** What the Work list may do — the store's actions, behind one seam. */
function workPanelDeps(api: DreyPluginApi): WorkPanelDeps {
  const deps: WorkPanelDeps = {
    api,
    openTicket: (card) => void openTicketPage(api, card),
    setPriority: (card, priority) =>
      void runMutation('Setting the priority', () => invokeBoard('setPriority', { id: card.id, priority })),
    setTrack: (card, track) => void runMutation('Setting the track', () => invokeBoard('setTrack', { id: card.id, track })),
    // The row menu shares the panel's seams (Track › / Priority ›).
    openMenu: (card, at) => openCardMenu(api, card, at, runMutation, deps),
    alerts: currentChainAlerts(),
    onAlertAction: (action) =>
      void (action.kind === 'play-column'
        ? runChainAction('chainColumn', { phase: action.phase, mode: 'playing' })
        : runChainAction('chainMaster', { mode: 'run' })),
  };
  return deps;
}

/** What stops the fleet right now, over the current snapshot and chain. */
function currentChainAlerts(): readonly ChainAlert[] {
  return snapshot === null || snapshot.vaultId === null ? [] : chainAlertsOf(chain, snapshot, fleetRuns, Date.now());
}

/** The breaker trips and quota pauses this window already announced. */
const announcedAlerts = new Set<string>();

/** One OS notification per new breaker trip or quota pause; a click shows the Work panel's alert. */
function announceChainAlerts(api: DreyPluginApi): void {
  for (const alert of newChainAlerts(currentChainAlerts(), announcedAlerts)) {
    void api.ui.notify({ title: alert.title, body: alert.text, tag: alert.key });
  }
}

/**
 * An owner move from the Work panel: the ordinary transition. A blocked
 * ticket moved into a machine phase asks first (T-0050) — the owner is
 * the final authority.
 */
function moveTicket(api: DreyPluginApi, card: TicketCard, to: string): void {
  const handover = snapshot?.columns.find((c) => c.phase.id === to)?.phase.handover ?? 'manual';
  if (needsBlockedConfirm(card, handover)) {
    openBlockedMoveConfirm(api, card, card.phase, to);
    return;
  }
  void runMutation(`Moving ${card.id}`, () => invokeBoard('transition', { id: card.id, from: card.phase, to }));
}


// --- the dock panel -------------------------------------------------------

export function createTicketsWidget(api: DreyPluginApi): PluginWidgetContrib {
  return {
    id: 'tickets',
    title: 'Work',
    icon: 'layers',
    defaultDock: 'left',
    defaultOpen: false,
    defaultFlex: 340,
    flush: true,
    status: () => {
      if (snapshot === null || snapshot.vaultId === null) {
        return null;
      }
      // Needs you beats open: what waits on the owner is the panel's point,
      // and a stopped fleet is part of it.
      const needs = workGroups(snapshot, liveRuns()).needs.length + currentChainAlerts().length;
      if (needs > 0) {
        return `${needs} need you`;
      }
      const open = openTicketCount(snapshot);
      return open > 0 ? `${open} open` : null;
    },
    headerActions: (host) => {
      // The project (req-72): which tickets repository this board reads —
      // one registered vault with a board each; the switch is one config
      // key and the board follows on the next refresh.
      const project = el('select', 'tickets-project-select') as HTMLSelectElement;
      project.title = 'Project — the tickets repository this board reads';
      project.setAttribute('aria-label', 'Project');
      const paintProjects = (projects: readonly ProjectRef[]): void => {
        project.replaceChildren();
        for (const entry of projects) {
          const option = document.createElement('option');
          option.value = entry.id;
          option.textContent = entry.name;
          project.append(option);
        }
        const active = projects.find((entry) => entry.active);
        if (active !== undefined) {
          project.value = active.id;
        }
        project.hidden = projects.length === 0;
      };
      projectPainters.add(paintProjects);
      project.addEventListener('change', () => {
        void runMutation('Switching the project', () => invokeBoard('switchProject', { id: project.value }));
      });

      const newButton = el('button', 'icon-btn');
      newButton.type = 'button';
      newButton.title = 'New idea';
      newButton.setAttribute('aria-label', 'New idea');
      newButton.append(api.ui.icon('plus', 14));
      newButton.addEventListener('click', () => {
        if (snapshot?.vaultId != null) {
          openCreateModal(api, snapshot);
        }
      });

      const refreshButton = el('button', 'icon-btn');
      refreshButton.type = 'button';
      refreshButton.title = 'Refresh the board';
      refreshButton.setAttribute('aria-label', 'Refresh the board');
      refreshButton.append(api.ui.icon('refresh-cw', 14));
      refreshButton.addEventListener('click', () => void refreshBoard());

      // req-75 W1b: project · fleet status · spacer · + · refresh · master · ⋯
      // (the fleet status came back with the chain alerts fix).
      const fleet = fleetHeaderNode();
      const viewControls = boardViewControlsNode(api);
      const actions = el('span', 'tickets-head-group');
      actions.append(newButton, refreshButton);
      host.classList.add('tickets-panel-head');
      host.append(project, fleet.node, viewControls.node, el('span', 'tickets-head-spacer'), actions, masterControlNode(api), headerMenuButton(api));
      return () => {
        projectPainters.delete(paintProjects);
        fleet.dispose();
        viewControls.dispose();
      };
    },
    mount: (panel) => {
      panel.classList.add('tickets-panel');
      // The board's messages live in its status bar (req-60), not above it.
      const view = buildBoardView(api);
      views.add(view);
      panel.append(view.root);
      view.render();
      // The header's fleet status follows the panel's width (req-60).
      const widthObserver = new ResizeObserver((entries) => {
        panelWidth = entries[0]?.contentRect.width ?? 0;
        for (const listener of panelWidthListeners) {
          listener();
        }
      });
      widthObserver.observe(panel);
      return () => {
        widthObserver.disconnect();
        views.delete(view);
      };
    },
  };
}

// --- the empty state ------------------------------------------------------

function emptyState(
  api: DreyPluginApi,
  snap: BoardSnapshot,
  run: (label: string, invoke: () => Promise<unknown>) => Promise<MutationResult>,
): HTMLElement {
  const box = el('div', 'tickets-empty');
  box.append(el('p', undefined, 'No tickets vault detected.'));
  const how = el('ol', 'tickets-empty-steps');
  for (const step of [
    'Create an empty git repository for tickets (its own repo — ADR-0076).',
    'Register its folder as a vault in the Files panel.',
    'Initialize the tickets board in that vault below.',
  ]) {
    how.append(el('li', undefined, step));
  }
  box.append(how);

  const target = snap.activeVaultName === null ? 'the active vault' : `"${snap.activeVaultName}"`;
  let armed = false;
  const button = el('button', 'tickets-init-btn');
  button.type = 'button';
  button.textContent = `Initialize the tickets board in ${target}`;
  button.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      button.textContent = `Creates tickets/_meta/{pipeline,repos}.md and the default prompts in ${target} — click again`;
      button.classList.add('tickets-init-armed');
      return;
    }
    void run('Initializing', () => invokeBoard('initialize', {}));
  });
  if (snap.activeVaultName === null) {
    button.disabled = true;
    button.title = 'Register a vault first';
  }
  box.append(button);
  return box;
}

// --- the create modal (opens the new file — T-0001) ------------------------

function openCreateModal(api: DreyPluginApi, snap: BoardSnapshot): void {
  const close = api.ui.showModal((host) => {
    const form = el('div', 'tickets-form');
    const title = el('input', 'tickets-form-title') as HTMLInputElement;
    title.type = 'text';
    title.setAttribute('aria-label', 'Title');
    title.spellcheck = true;

    const row = el('div', 'tickets-form-row');
    const priority = el('select') as HTMLSelectElement;
    priority.setAttribute('aria-label', 'Priority');
    for (const [value, label] of Object.entries(PRIORITY_LABEL)) {
      const option = el('option', undefined, label) as HTMLOptionElement;
      option.value = value;
      if (value === 'normal') {
        option.selected = true;
      }
      priority.append(option);
    }
    // req-72: the work repos as checkboxes — one ticket may name several;
    // the first checked one is the primary (the fleet's gate repo).
    const repoChecks = snap.repos.map((ref, index) => {
      const wrap = el('label', 'tickets-form-check');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = ref.name;
      if (index === 0 && snap.repos.length === 1) {
        input.checked = true;
      }
      wrap.append(input, el('span', undefined, ref.name));
      return input;
    });
    const repoGroup = el('div', 'tickets-form-checks');
    for (const input of repoChecks) {
      repoGroup.append(input.parentElement!);
    }
    const selectedRepos = (): string[] => repoChecks.filter((input) => input.checked).map((input) => input.value);
    row.append(priority, repoGroup);

    const description = el('textarea', 'tickets-form-desc') as HTMLTextAreaElement;
    description.rows = 4;
    description.setAttribute('aria-label', 'Description');

    const actions = el('div', 'tickets-form-actions');
    const cancel = el('button', undefined, 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => close());
    const create = el('button', 'tickets-form-create', 'Create ticket');
    create.type = 'button';
    const submit = (): void => {
      const text = title.value.trim();
      if (text === '') {
        title.focus();
        return;
      }
      const repos = selectedRepos();
      close();
      void runMutation('Creating', () =>
        invokeBoard('create', {
          title: text,
          priority: priority.value,
          repo: repos[0] ?? null,
          ...(repos.length > 0 ? { repos } : {}),
          description: description.value,
        }),
      ).then((result) => {
        // The file is pre-filled by the canonical writer — open it so
        // everything else can be filled in right away (T-0001).
        if (result.ok && (result as CreateResult).path !== undefined) {
          openTicketFile(api, (result as CreateResult).path as string);
        }
      });
    };
    create.addEventListener('click', submit);
    actions.append(cancel, create);

    const field = (label: string, control: HTMLElement): HTMLElement => {
      const wrap = el('label', 'tickets-form-field');
      wrap.append(el('span', 'tickets-form-label', label), control);
      return wrap;
    };
    const rowFields = el('div', 'tickets-form-row');
    rowFields.append(field('Priority', priority), field('Repositories', repoGroup));

    form.append(el('h3', 'tickets-form-heading', 'New ticket'));
    form.append(field('Title', title), rowFields, field('Description', description), actions);
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target === title) {
        event.preventDefault();
        submit();
      }
      if (event.key === 'Escape') {
        close();
      }
    });
    host.append(form);
    title.focus();
  });
}

// --- the chain's master switch (M85, ADR-0077) -------------------------------

/**
 * The chain controls in the panel header (req-60): run / halt as one
 * segmented switch whose active half is marked (run dispatches every
 * playing automatic column; halt is gentle — running work finishes),
 * then the emergency stop — every live run through the stop ladder and
 * halt, the red button, one click, nothing in the way.
 */
function masterControlNode(api: DreyPluginApi): HTMLElement {
  const box = el('span', 'tickets-head-group');
  const seg = el('span', 'seg tickets-master');
  const run = el('button', 'icon-btn');
  run.type = 'button';
  run.title = 'Run the chain — columns with a worker drain themselves';
  run.setAttribute('aria-label', 'Run the chain');
  run.append(api.ui.icon('play', 14));
  run.addEventListener('click', () => void runChainAction('chainMaster', { mode: 'run' }));

  const halt = el('button', 'icon-btn');
  halt.type = 'button';
  halt.title = 'Halt the chain — running work finishes, nothing new dispatches';
  halt.setAttribute('aria-label', 'Halt the chain');
  halt.append(api.ui.icon('pause', 14));
  halt.addEventListener('click', () => void runChainAction('chainMaster', { mode: 'halted' }));

  const abort = el('button', 'icon-btn tickets-master-abort');
  abort.type = 'button';
  abort.title = 'Emergency stop — abort every run and halt the chain';
  abort.setAttribute('aria-label', 'Emergency stop');
  abort.append(api.ui.icon('square', 13));
  abort.addEventListener('click', () => void runChainAction('chainAbort', {}));

  masterButtons.push({ run, halt, abort });
  seg.append(run, halt);
  box.append(seg, abort);
  return box;
}

/**
 * The header's overflow (req-60): the rarer tools behind one `⋯` —
 * the chain log as a readonly tab, and the worktree cleanup (T-0044:
 * every worktree whose ticket has no live run goes, real git, dirty
 * trees kept and reported, then one prune per mapped repo).
 */
function headerMenuButton(api: DreyPluginApi): HTMLButtonElement {
  const more = el('button', 'icon-btn');
  more.type = 'button';
  more.title = 'More — chain log, clean up worktrees';
  more.setAttribute('aria-label', 'More actions');
  more.setAttribute('aria-haspopup', 'menu');
  more.append(api.ui.icon('more-horizontal', 14));
  more.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.tickets-menu')) {
      other.remove();
    }
    const menu = el('div', 'tickets-menu');
    menu.setAttribute('role', 'menu');
    const close = (): void => {
      menu.remove();
      window.removeEventListener('mousedown', outside, true);
      more.focus();
    };
    const outside = (e: Event): void => {
      if (!menu.contains(e.target as Node) && e.target !== more && !more.contains(e.target as Node)) {
        close();
      }
    };
    const item = (label: string, hint: string, onClick: () => void): void => {
      const button = el('button', 'tickets-menu-item', label);
      button.type = 'button';
      button.title = hint;
      button.setAttribute('role', 'menuitem');
      button.addEventListener('click', () => {
        close();
        onClick();
      });
      menu.append(button);
    };
    item('Chain log', 'What the fleet daemon did (dispatches, skips, gates), as a readonly editor tab', () => openChainLog(api));
    item('Clean up worktrees…', 'Removes every worktree whose ticket has no live run, then prunes', () => void runWorktreesCleanup());
    document.body.append(menu);
    const anchor = more.getBoundingClientRect();
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(anchor.right - rect.width, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.min(anchor.bottom + 4, window.innerHeight - rect.height - 8)}px`;
    menu.querySelector<HTMLButtonElement>('.tickets-menu-item')?.focus();
    window.addEventListener('mousedown', outside, true);
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        close();
      } else {
        cycleMenuFocus(menu, e);
      }
    });
  });
  return more;
}

/** Runs the global worktree cleanup and reports what it did (T-0044). */
async function runWorktreesCleanup(): Promise<void> {
  busy = true;
  setNote('Cleaning up worktrees…', 'busy');
  notifyViews();
  let result: {
    ok?: boolean;
    error?: string;
    report?: {
      removed: readonly string[];
      keptDirty: readonly string[];
      failed: readonly unknown[];
      leftovers?: readonly string[];
    };
  };
  try {
    result = (await invokeBoard('worktreesCleanup', {})) as typeof result;
  } catch (error) {
    result = { ok: false, error: messageOf(error) };
  }
  busy = false;
  if (result.ok === true) {
    const r = result.report;
    setNote(
      r === undefined
        ? ''
        : `Worktrees: ${r.removed.length} removed` +
            ((r.leftovers?.length ?? 0) > 0 ? `, ${r.leftovers?.length} leftover folder(s) cleared` : '') +
            (r.keptDirty.length > 0 ? `, ${r.keptDirty.length} kept dirty` : '') +
            (r.failed.length > 0 ? `, ${r.failed.length} failed` : ''),
      r !== undefined && (r.keptDirty.length > 0 || r.failed.length > 0) ? 'warn' : 'ok',
    );
  } else {
    setNote(result.error ?? 'the worktree cleanup failed', 'error');
  }
  notifyViews();
  void loadWorktreesStatus();
}

/** Runs a chain control and applies the runner's returned state. */
async function runChainAction(method: string, payload: unknown): Promise<void> {
  let result: unknown;
  try {
    result = await invokeBoard(method, payload);
  } catch (error) {
    setNote(messageOf(error), 'error');
    notifyViews();
    return;
  }
  const status = (result as { status?: ChainStatus; error?: string }).status ?? null;
  if (status === null) {
    setNote((result as { error?: string }).error ?? 'the chain control failed', 'error');
    notifyViews();
    return;
  }
  applyChainStatus(status);
}

// --- the fleet run controls (M84, ADR-0075) --------------------------------

const WORKER_LABEL: ReadonlyArray<readonly [string, string]> = [
  ['opencode', 'OpenCode'],
  ['claude-code', 'Claude Code'],
];

/**
 * The status bar under the board (req-59), one row: the cycle times on
 * the left — each non-empty column's average dwell from the tickets'
 * entered-* stamps (M85), so a stuck column is visible at a glance —
 * and the worktree home's note (T-0044) as a warning pill on the right:
 * legacy-root leftovers and orphan folders under the base, listed in
 * its tooltip, never auto-deleted (the Clean up worktrees control
 * collects them). The board's message (req-60) sits right-aligned, just
 * before that pill (req-61): an action in progress, a result that fades
 * by itself, a warning or failure that stays until closed — it comes and
 * goes in the free space, so the cycle times never move. Null when there
 * is nothing to say.
 */
function statusBarNode(api: DreyPluginApi, snap: BoardSnapshot | null): HTMLElement | null {
  const bar = el('div', 'tickets-statusbar');
  const right = el('span', 'tickets-statusbar-right');
  if (note !== '') {
    const message = el('span', 'tickets-statusbar-note');
    message.dataset['kind'] = noteKind;
    message.setAttribute('role', noteKind === 'error' ? 'alert' : 'status');
    message.title = note;
    if (noteKind === 'ok') {
      message.append(api.ui.icon('check', 12));
    } else if (noteKind !== 'busy') {
      message.append(api.ui.icon('triangle-alert', 12));
    }
    message.append(el('span', 'tickets-statusbar-note-text', note));
    if (noteKind === 'warn' || noteKind === 'error') {
      const close = el('button', 'icon-btn tickets-statusbar-note-close');
      close.type = 'button';
      close.title = 'Dismiss';
      close.setAttribute('aria-label', 'Dismiss the message');
      close.append(api.ui.icon('x', 11));
      close.addEventListener('click', () => {
        setNote('', 'ok');
        notifyViews();
      });
      message.append(close);
    }
    right.append(message);
  }
  if (snap === null) {
    if (right.childElementCount === 0) {
      return null;
    }
    bar.append(right);
    return bar;
  }
  const legacy = worktrees?.legacyLeftovers.length ?? 0;
  const orphans = worktrees?.orphans.length ?? 0;
  if (worktrees !== null && legacy + orphans > 0) {
    const parts: string[] = [];
    if (legacy > 0) {
      parts.push(`${legacy} legacy worktree${legacy === 1 ? '' : 's'}`);
    }
    if (orphans > 0) {
      parts.push(`${orphans} orphan${orphans === 1 ? '' : 's'}`);
    }
    const warn = el('span', 'tickets-statusbar-warn');
    warn.append(api.ui.icon('triangle-alert', 12), el('span', undefined, parts.join(' · ')));
    warn.title = [
      'Worktree folders to clean up — Clean up worktrees… in the header\'s ⋯ menu removes them',
      ...worktrees.legacyLeftovers.map((name) => `legacy: ${name}`),
      ...worktrees.orphans.map((p) => `orphan: ${p}`),
    ].join('\n');
    right.append(warn);
  }
  bar.append(fleetFooterNode(), right);
  return bar;
}

/** Below this panel width the header's fleet status drops its numbers (they stay in the tooltip). */
const HEAD_FLEET_NARROW_PX = 480;

/** Below this one it is its light alone. */
const HEAD_FLEET_TINY_PX = 380;

/** The Work panel's current width (its body is as wide as its header); 0 before the first measure. */
let panelWidth = 0;
const panelWidthListeners = new Set<() => void>();

/**
 * The fleet's status in the panel header (req-60, back with the chain
 * alerts fix): the worst light, the states in words, tokens in flight
 * and the oldest run's age — the long form in its tooltip. A standing
 * chain alert (breaker, hold, halt, quota) turns the light amber at
 * least and counts in the words, so a stopped fleet shows even with no
 * run alive. Repaints on every fleet update and once a second.
 */
function fleetHeaderNode(): { node: HTMLElement; dispose: () => void } {
  const node = el('span', 'tickets-head-fleet');
  const light = el('span', 'tickets-light');
  const label = el('span', 'tickets-head-fleet-label');
  const numbers = el('span', 'tickets-head-fleet-numbers');
  node.append(light, label, numbers);
  const paint = (): void => {
    const summary = fleetSummary(liveRuns(), Date.now());
    const alerts = currentChainAlerts();
    node.hidden = summary === null && alerts.length === 0;
    node.toggleAttribute('data-narrow', panelWidth > 0 && panelWidth < HEAD_FLEET_NARROW_PX);
    node.toggleAttribute('data-tiny', panelWidth > 0 && panelWidth < HEAD_FLEET_TINY_PX);
    if (node.hidden) {
      return;
    }
    const lit = summary?.light ?? 'idle';
    light.className = `tickets-light tickets-light-${alerts.length > 0 && (lit === 'idle' || lit === 'green') ? 'amber' : lit}`;
    const alertWords = alerts.length === 0 ? '' : alerts.length === 1 ? alerts[0]!.title : `${alerts.length} fleet alerts`;
    label.textContent = [summary?.label ?? '', alertWords].filter((part) => part !== '').join(' · ');
    const age = summary === null || summary.ageMs === null ? '' : spanClock(summary.ageMs);
    numbers.hidden = summary === null;
    numbers.textContent = summary === null ? '' : `${formatTokens(summary.tokens)} tok${age === '' ? '' : ` · ${age}`}`;
    const long = [
      ...(summary === null
        ? []
        : [
            summary.label,
            `${formatTokens(summary.tokens)} tokens in flight (in + out of all live runs)`,
            ...(age === '' ? [] : [`the oldest run has been at it for ${age}`]),
          ]),
      ...alerts.map((alert) => `${alert.title}: ${alert.text}`),
    ].join('\n');
    node.title = long;
    node.setAttribute('aria-label', long);
  };
  fleetListeners.add(paint);
  panelWidthListeners.add(paint);
  const tick = setInterval(paint, 1_000);
  paint();
  return {
    node,
    dispose: () => {
      fleetListeners.delete(paint);
      panelWidthListeners.delete(paint);
      clearInterval(tick);
    },
  };
}

/**
 * The footer's left half (req-75 W1b): the worst light of the live runs
 * and who is out there — one line per provider with a live run. Null
 * when nothing runs and no light is worth a dot.
 */
function fleetFooterNode(): HTMLElement {
  const runs = liveRuns();
  const left = el('span', 'tickets-statusbar-fleet');
  if (runs.length === 0) {
    left.append(el('span', 'tickets-light tickets-light-idle'), el('span', undefined, 'No workers running'));
    return left;
  }
  const summary = fleetSummary(runs, Date.now());
  left.append(el('span', `tickets-light tickets-light-${summary === null ? 'idle' : summary.light}`));
  const byProvider = new Map<string, number>();
  for (const run of runs) {
    byProvider.set(run.provider, (byProvider.get(run.provider) ?? 0) + 1);
  }
  const text = [
    `${runs.length} worker${runs.length === 1 ? '' : 's'}`,
    ...[...byProvider].map(([provider, n]) => `${workerLabelOf(provider)} ${n}`),
  ].join(' · ');
  left.append(el('span', undefined, text));
  const long = [text, summary === null ? '' : summary.label].filter((part) => part !== '').join(' · ');
  left.title = long;
  left.setAttribute('aria-label', long);
  return left;
}

/** A provider id as the footer names it (`opencode` → `OpenCode`). */
function workerLabelOf(provider: string): string {
  for (const [value, label] of WORKER_LABEL) {
    if (value === provider) {
      return label;
    }
  }
  return provider;
}

function openRunModal(api: DreyPluginApi, card: TicketCard): void {
  const close = api.ui.showModal((host) => {
    const form = el('div', 'tickets-form');
    form.append(el('h3', 'tickets-form-heading', `Run ${card.id} — ${card.meta.title ?? '(untitled)'}`));

    const field = (label: string, control: HTMLElement): HTMLElement => {
      const wrap = el('label', 'tickets-form-field');
      wrap.append(el('span', 'tickets-form-label', label), control);
      return wrap;
    };
    const worker = el('select') as HTMLSelectElement;
    worker.setAttribute('aria-label', 'Worker');
    for (const [value, label] of WORKER_LABEL) {
      const option = el('option', undefined, label) as HTMLOptionElement;
      option.value = value;
      if (value === card.worker.split('/')[0]) {
        option.selected = true;
      }
      worker.append(option);
    }
    const permission = el('select') as HTMLSelectElement;
    permission.setAttribute('aria-label', 'Permissions');
    for (const [value, label] of [
      ['accept-edits', 'Accept edits (asks before commands)'],
      ['bypass', 'Bypass permissions (unattended)'],
    ] as const) {
      const option = el('option', undefined, label) as HTMLOptionElement;
      option.value = value;
      if (value === 'accept-edits') {
        option.selected = true;
      }
      permission.append(option);
    }
    const rowFields = el('div', 'tickets-form-row');
    rowFields.append(field('Worker', worker), field('Permissions', permission));

    // --- the handover choice (T-0049): the pure rules over the fleet
    // snapshot decide the default and which options are legal at all;
    // nothing is persisted — each run asks anew.
    const handover = el('select') as HTMLSelectElement;
    handover.setAttribute('aria-label', 'Handover');
    const handoverStatus = el('p', 'tickets-form-hint', '');
    const candidate: HandoverCandidate | null = (() => {
      const newest = fleetRuns
        .filter((r) => r.ticketId === card.id && ['done', 'stopped', 'failed'].includes(r.state))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      if (newest === undefined) {
        return null;
      }
      return {
        phase: newest.phase ?? '',
        provider: newest.provider,
        model: newest.model ?? null,
        state: newest.state,
        sessionRef: newest.sessionRef,
        lastTurnContext: newest.lastTurnContext ?? null,
        endedAt: newest.endedAt,
      };
    })();
    const cardPin = parseWorkerValue(card.worker);
    let handoverConfig: FleetHandoverConfig = DEFAULT_FLEET_HANDOVER;
    const renderHandover = (): void => {
      const provider = worker.value;
      const state = handoverDialogState({
        phase: card.phase,
        candidate,
        provider,
        // The dialog offers no model pin of its own; the card's applies
        // while the worker stays the card's resolved one.
        model: cardPin !== null && cardPin.provider === provider ? cardPin.model : null,
        config: handoverConfig,
        nowMs: Date.now(),
      });
      handover.replaceChildren();
      for (const option of state.options) {
        const node = el('option', undefined, option.label) as HTMLOptionElement;
        node.value = option.mode;
        node.disabled = option.disabled;
        node.title = option.why;
        node.selected = option.mode === state.defaultMode;
        handover.append(node);
      }
      handover.title = state.options.find((o) => o.mode === handover.value)?.why ?? '';
      handoverStatus.textContent = state.statusLine;
    };
    renderHandover();
    worker.addEventListener('change', renderHandover);
    void (async () => {
      const raw: Record<string, number> = {};
      const base = await api.settings.get<number>('fleet.compactAboveTokens').catch(() => undefined);
      if (base !== undefined) {
        raw.compactAboveTokens = base;
      }
      const ttl = await api.settings.get<number>('fleet.resumePauseTtlMin').catch(() => undefined);
      if (ttl !== undefined) {
        raw.resumePauseTtlMin = ttl;
      }
      const providerOverride = await api.settings
        .get<number>(`fleet.compactAboveTokens.${worker.value}`)
        .catch(() => undefined);
      handoverConfig = normalizeFleetHandover({
        ...raw,
        ...(providerOverride !== undefined ? { compactAboveTokensOverrides: { [worker.value]: providerOverride } } : {}),
      });
      renderHandover();
    })();

    const hint = el(
      'p',
      'tickets-form-hint',
      'The instruction is composed from the ticket (description, plan, acceptance criteria) plus the phase handover’s prompt. ' +
        'On a green machine gate the runner moves the ticket to the next phase.',
    );

    const actions = el('div', 'tickets-form-actions');
    const cancel = el('button', undefined, 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => close());
    const start = el('button', 'tickets-form-create', 'Start run');
    start.type = 'button';
    start.addEventListener('click', () => {
      const workerValue = worker.value;
      const handoverValue = handover.value;
      close();
      void runMutation('Starting the run', () =>
        invokeBoard('fleetStart', {
          id: card.id,
          worker: workerValue,
          permissionMode: permission.value,
          handover: handoverValue,
        }),
      );
    });
    actions.append(cancel, start);

    form.append(rowFields, field('Handover', handover), handoverStatus, hint, actions);
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        close();
      }
    });
    host.append(form);
    worker.focus();
  });
}

/** The blocked-move ask (T-0050): a blocked ticket moved into a worker
 *  phase. The owner is the final authority — Cancel keeps the ticket
 *  where it is, Move anyway performs the ordinary transition. */
function openBlockedMoveConfirm(
  api: DreyPluginApi,
  card: TicketCard,
  from: string,
  to: string,
): void {
  const close = api.ui.showModal((host) => {
    const form = el('div', 'tickets-form');
    form.append(el('h3', 'tickets-form-heading', `Move ${card.id} — it is blocked`));
    form.append(
      el(
        'p',
        'tickets-form-hint',
        `${card.id} is blocked by ${card.blocked.join(', ')} — the blockers have not reached the ` +
          'terminal phase, so the worker column will not pick it up until they do. You stay the final authority.',
      ),
    );
    const actions = el('div', 'tickets-form-actions');
    const cancel = el('button', undefined, 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => close());
    const move = el('button', 'tickets-form-create', 'Move anyway');
    move.type = 'button';
    move.addEventListener('click', () => {
      close();
      void runMutation('Moving', () => invokeBoard('transition', { id: card.id, from, to }));
    });
    actions.append(cancel, move);
    form.append(actions);
    form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        close();
      }
    });
    host.append(form);
    cancel.focus();
  });
}

// --- the takeover tab (owner request, follow-up of M86; ADR-0078) -------------

const TAKEOVER_KIND = 'tickets-takeover';
const TAKEOVER_SCHEME = 'takeover://';

/**
 * Starts the owner's interactive dialog (req-65): one click — the
 * column's worker by the assignment ladder, the default permission
 * mode, no form. The ticket page opens (the file with its thread beside
 * it) unless the thread itself started the run (`open: false`).
 * Resolves to the new run's id, or null when none started.
 */
async function startInteractive(
  api: DreyPluginApi,
  card: TicketCard,
  mode: InteractiveMode,
  open = true,
): Promise<string | null> {
  const label = mode === 'plan' ? 'Starting the plan dialog' : 'Starting the refine dialog';
  const result = await runMutation(label, () =>
    invokeBoard('fleetStart', { id: card.id, worker: card.worker, permissionMode: 'accept-edits', interactive: mode }),
  );
  if (!result.ok) {
    return null;
  }
  const runId = (result as { runId?: string }).runId ?? null;
  // The thread follows the fleet snapshot; pull one so it shows the run now.
  await invokeBoard('fleetStatus')
    .then((status) => applyFleetSnapshot((status ?? {}) as { runs?: RunInfo[]; chain?: ChainStatus | null }))
    .catch(() => undefined);
  if (open) {
    await openTicketPage(api, card);
  }
  return runId;
}

/**
 * Ends an interactive dialog (req-65): the run stops (an ended run skips
 * this), then the owner move the button named — the ordinary transition,
 * exactly the move across the checkpoint the owner makes by hand.
 */
async function finishInteractiveMove(runId: string, ticketId: string, from: string, to: string): Promise<void> {
  const run = fleetRuns.find((r) => r.id === runId);
  if (run !== undefined && LIVE_RUN_STATES.includes(run.state)) {
    const stopped = await runMutation('Ending the dialog', () =>
      invokeBoard('fleetStop', { runId, reason: `the dialog ended — the owner moves the ticket to ${to}` }),
    );
    if (!stopped.ok) {
      return;
    }
  }
  await runMutation(`Moving ${ticketId} to ${to}`, () => invokeBoard('transition', { id: ticketId, from, to }));
}

/** The waits this window already announced (`newWaits` keeps it current). */
const announcedWaits = new Set<string>();

/** One OS notification per new wait; a click opens the ticket page (req-64). */
function announceWaits(api: DreyPluginApi): void {
  for (const notice of newWaits(fleetRuns, announcedWaits)) {
    void api.ui.notify({
      title: notice.title,
      body: notice.body,
      tag: notice.run.id,
      onClick: () => {
        // A run without a card on the board has no page to open — the
        // takeover tab it once fell back to is gone (W4a).
        const card = boardCard(notice.run.ticketId);
        if (card !== null) {
          void openTicketPage(api, card);
        }
      },
    });
  }
}
/**
 * The takeover tab is gone (req-75 W4a, ADR-0087 decision 3): the
 * worker lives on the ticket thread, which carries its controls. The
 * `tickets-takeover` doc kind stays registered below only so an old
 * session restores onto the ticket page instead of a dead tab.
 */

/**
 * The dialog's end moves (req-65): an interactive run is the owner's
 * conversation — when it is over, these buttons perform the owner move
 * that closes it (stop the run if it still lives, then the transition).
 */
function createEndMoves(): { element: HTMLElement; paint(run: RunInfo | null): void } {
  const element = el('div', 'tickets-takeover-endmoves');
  element.hidden = true;
  const paint = (run: RunInfo | null): void => {
    if (run === null || run.interactive === undefined || snapshot === null) {
      element.hidden = true;
      return;
    }
    // Where the ticket sits NOW — the owner may have moved it since the
    // run started, and a ticket off the board has nowhere to go.
    const card = boardCard(run.ticketId);
    const moves = card === null ? [] : interactiveEndMoves(run.interactive, card.phase, snapshot.columns);
    if (card === null || moves.length === 0) {
      element.hidden = true;
      return;
    }
    element.replaceChildren(
      el('span', 'tickets-takeover-endmoves-label', 'Dialog done? End it with a move:'),
      ...moves.map((move) => {
        const b = el('button', 'tickets-takeover-btn tickets-takeover-endmove', move.label);
        b.type = 'button';
        b.title = move.title;
        b.addEventListener('click', () => {
          void finishInteractiveMove(run.id, run.ticketId, card.phase, move.toPhase);
        });
        return b;
      }),
    );
    element.hidden = false;
  };
  return { element, paint };
}

// --- the ticket thread (req-75 W1, ADR-0087 decision 3) ----------------------

const THREAD_KIND = 'tickets-thread';
let threadTicketId: string | null = null;
const threadListeners = new Set<() => void>();
/**
 * A run to unfold when its ticket's thread shows (req-75 W4a): set by a
 * `Past runs` menu row before it opens the ticket page, consumed by the
 * next paint of that ticket's thread.
 */
let threadFocusRun: string | null = null;

function threadTitle(ticketId: string): string {
  const title = boardCard(ticketId)?.meta.title ?? null;
  return title === null ? `${ticketId} · thread` : `${ticketId} · ${title}`;
}

/** The run the thread talks to: the ticket's live run, else its newest. */
function threadRun(ticketId: string): RunInfo | null {
  let live: RunInfo | null = null;
  let newest: RunInfo | null = null;
  for (const run of fleetRuns) {
    if (run.ticketId !== ticketId) {
      continue;
    }
    if ((LIVE_RUN_STATES.includes(run.state) || run.state === 'detached') && (live === null || run.startedAt > live.startedAt)) {
      live = run;
    }
    if (newest === null || run.startedAt > newest.startedAt) {
      newest = run;
    }
  }
  return live ?? newest;
}

/**
 * The ticket page (ADR-0087 decision 3): the ticket file in one pane and
 * its thread beside it — since W4a the worker lives there in every state
 * (a live run's doings, an ended run's decisions: Ready card, approve,
 * accept, send back — and its next message; the run tab is gone). The
 * pair anchors on itself (the pure landing matrix: `ticketPagePlan`,
 * req-75): whatever pane is focused and whatever else is open, the two
 * tabs land in their own two panes, both re-activate on every ticket
 * switch and a third pane never appears; the focus ends on the file, so
 * the next ticket opens there.
 */
async function openTicketPage(api: DreyPluginApi, card: TicketCard): Promise<void> {
  if (snapshot?.vaultId == null) {
    return;
  }
  const side = { kind: THREAD_KIND, key: THREAD_KEY, title: threadTitle(card.id) };
  const plan = ticketPagePlan({
    fileOpen: api.documents.get(card.path) !== null,
    threadOpen: api.documents.get(side.key) !== null,
  });
  await api.documents.open(card.path, undefined, { vaultId: snapshot.vaultId, ...plan.fileOpts });
  threadTicketId = card.id;
  for (const listener of threadListeners) {
    listener();
  }
  if (plan.threadCall === 'reactivate') {
    // One thread tab follows the ticket opened last (req-75 W1):
    // the rename keeps its title true.
    api.documents.rename(THREAD_KEY, side.title);
    // addDoc on the open key reveals it -- a rename alone would leave the
    // side backgrounded in its pane; the pair re-activates as a whole.
    api.documents.addDoc(side.kind, side.key, side.title);
  } else {
    api.documents.addDoc(side.kind, side.key, side.title, {
      beside: card.path,
      split: 'right',
    });
  }
  if (plan.refocusFile) {
    // The side tab's landing or re-activation took the focus: hand it back
    // to the file, so the next ticket opens there and not beside the side.
    await api.documents.open(card.path, undefined, { vaultId: snapshot.vaultId });
  }
  markOpenCard(api);
}

/** The thread tab: rebuilt whenever it switches to another ticket. */
function mountThread(api: DreyPluginApi, host: HTMLElement): () => void {
  let shown: string | null | undefined;
  let dispose: (() => void) | null = null;
  const build = (): void => {
    if (threadTicketId === shown) {
      return;
    }
    dispose?.();
    dispose = null;
    host.replaceChildren();
    shown = threadTicketId;
    if (shown === null) {
      host.append(el('div', 'tickets-empty', 'Open a ticket from the Work panel'));
    } else {
      dispose = mountThreadOf(api, host, shown);
    }
  };
  threadListeners.add(build);
  build();
  return () => {
    threadListeners.delete(build);
    dispose?.();
  };
}

function mountThreadOf(api: DreyPluginApi, host: HTMLElement, ticketId: string): () => void {
  const wrap = el('div', 'tickets-takeover tickets-thread');
  // The header (req-75 W4a, canvas "3a · A ticket with its worker live"):
  // the run's dot, the bold state word, one muted meta line (the takeover
  // tab's telemetry in its tooltip), then the Ticket file link and the
  // worker's controls — pause, take over, stop; hand back and resume as
  // the run allows.
  const head = el('div', 'tickets-thread-head');
  const light = el('span', 'tickets-light');
  const stateWord = el('span', 'tickets-thread-state');
  const titleNode = el('span', 'tickets-thread-title');
  const metaNode = el('span', 'tickets-thread-meta');
  const fileLink = el('button', 'tickets-thread-filelink', 'Ticket file');
  fileLink.type = 'button';
  fileLink.title = 'Open the ticket file in the editor';
  fileLink.addEventListener('click', () => {
    const card = boardCard(ticketId);
    if (card !== null) {
      openTicketFile(api, card.path);
    }
  });
  const controls = el('span', 'tickets-takeover-controls');
  const iconButton = (icon: string, title: string, ariaLabel: string, onClick: () => void): HTMLButtonElement => {
    const b = el('button', 'tickets-takeover-btn tickets-thread-iconbtn');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', ariaLabel);
    b.append(api.ui.icon(icon, 13));
    b.addEventListener('click', onClick);
    return b;
  };
  const target = (): RunInfo | null => threadRun(ticketId);
  const control = (action: 'interrupt' | 'takeover' | 'release', label: string): void => {
    const run = target();
    if (run !== null) {
      void runMutation(label, () => invokeBoard('fleetControl', { action, runId: run.id }));
    }
  };
  const pauseRun = iconButton('pause', 'Pause after the current action', 'Pause', () => control('interrupt', 'Pausing'));
  const takeOverRun = iconButton('hand', 'Take over — the worker waits for your messages', 'Take over', () =>
    control('takeover', 'Taking over'),
  );
  const stopRun = iconButton('square', 'Stop the worker', 'Stop', () => {
    const run = target();
    if (run !== null) {
      void runMutation('Stopping the worker', () => invokeBoard('fleetStop', { runId: run.id, reason: null }));
    }
  });
  stopRun.classList.add('tickets-thread-stop');
  const handBackRun = iconButton('arrow-left', 'Hand the run back to the runner', 'Hand back', () =>
    control('release', 'Handing back'),
  );
  const resumeRun = iconButton(
    'rotate-ccw',
    'Pick this session up again in a new worker — it answers, then waits for your prompts',
    'Resume session',
    () => {
      const run = target();
      if (run === null) {
        return;
      }
      const runId = run.id;
      void runMutation('Resuming', () => invokeBoard('fleetControl', { action: 'resume', runId })).then((result) => {
        if (!result.ok) {
          return;
        }
        // The thread follows the ticket's newest run — pull the fleet so
        // the resumed run shows now (the takeover tab used to open it).
        void invokeBoard('fleetStatus')
          .then((status) => applyFleetSnapshot((status ?? {}) as { runs?: RunInfo[]; chain?: ChainStatus | null }))
          .catch(() => undefined);
      });
    },
  );
  // Start (W4a): the existing manual start — the phase's dialog (plan or
  // refine) in a worker, the same first-message path the composer takes.
  const startRun = iconButton('play', 'Start a worker on this ticket', 'Start', () => {
    const card = boardCard(ticketId);
    const mode = dialogMode();
    if (card !== null && mode !== null) {
      void startInteractive(api, card, mode, false);
    }
  });
  controls.append(pauseRun, takeOverRun, stopRun, handBackRun, resumeRun, startRun);
  head.append(light, stateWord, titleNode, metaNode, el('span', 'tickets-takeover-spacer'), fileLink, controls);

  const endMoves = createEndMoves();
  // --- the Ready card (req-75 W3) ---------------------------------------
  // The canvas's bordered card above the transcript, its story beside
  // it (a right column from 900 px pane width, below when narrower).
  const readyWrap = el('div', 'tickets-ready');
  readyWrap.hidden = true;
  const readyMain = el('div', 'tickets-ready-main');
  const readyStoryHost = el('aside', 'tickets-ready-story');
  readyWrap.append(readyMain, readyStoryHost);
  let readyPulledFor: string | null = null;
  let readyReply: ChangesReply | null = null;
  let readyKey = '';
  /** The section + story of the ticket file, once per path (a move re-pulls). */
  const pullReady = (): void => {
    const card = boardCard(ticketId);
    if (card === null || card.path === readyPulledFor) {
      return;
    }
    readyPulledFor = card.path;
    void invokeBoard('changes', { id: ticketId })
      .then((reply) => {
        readyReply = reply as ChangesReply;
        paintReady();
      })
      .catch(() => undefined);
  };
  /** The Send back… modal (canvas): one note, one move back to the agent. */
  const sendBackModal = (): void => {
    const close = api.ui.showModal((host) => {
      const box = el('div', 'tickets-sendback');
      const head = el('h3', undefined, `Send ${ticketId} back`);
      const field = el('label', 'tickets-sendback-field');
      field.append(el('span', undefined, 'What should change?'));
      const note = el('textarea', 'tickets-sendback-note');
      note.rows = 4;
      const actions = el('div', 'tickets-sendback-actions');
      const cancel = el('button', 'tickets-takeover-btn', 'Cancel');
      cancel.type = 'button';
      const send = el('button', 'tickets-takeover-btn tickets-takeover-btn-primary', 'Send back');
      send.type = 'button';
      send.disabled = true;
      note.addEventListener('input', () => {
        send.disabled = note.value.trim() === '';
      });
      cancel.addEventListener('click', close);
      send.addEventListener('click', () => {
        const text = note.value;
        close();
        void runMutation(`Sending ${ticketId} back`, () => invokeBoard('sendBack', { id: ticketId, note: text }));
      });
      actions.append(el('span', 'tickets-takeover-spacer'), cancel, send);
      field.append(note);
      box.append(head, field, actions);
      host.append(box);
      note.focus();
    });
  };
  /**
   * Shows the card for a Needs-you `Ready to try` / `Review` ticket and
   * for any ticket whose file carries a `## Changes` section; the
   * decision bar's Accept becomes the card's buttons.
   */
  const paintReady = (): void => {
    const card = boardCard(ticketId);
    const snap = snapshot;
    if (card === null || snap === null || snap.pipeline.length === 0) {
      readyWrap.hidden = true;
      readyKey = '';
      return;
    }
    const need = workGroups(snap, fleetRuns).needs.find((row) => row.card.id === ticketId)?.need ?? null;
    const kind = need !== null && need.kind === 'checkpoint' ? needKindLabel(need, snap) : null;
    const reply = readyReply;
    if (kind !== 'Ready to try' && kind !== 'Review' && (reply?.changes ?? null) === null) {
      readyWrap.hidden = true;
      readyKey = '';
      return;
    }
    const terminal = snap.pipeline[snap.pipeline.length - 1]!.id === card.phase;
    const key = JSON.stringify([card.id, card.meta.title, card.meta.track, card.meta.repo, terminal, reply]);
    if (!readyWrap.hidden && readyKey === key) {
      return;
    }
    readyKey = key;
    readyWrap.hidden = false;
    readyMain.replaceChildren(
      readyCardNode(
        {
          onLaunch: () =>
            void runMutation(`Launching ${ticketId}`, () => invokeBoard('launchVersion', { id: ticketId })),
          onAccept: () =>
            void runMutation(`Accepting ${ticketId}`, () => invokeBoard('acceptTicket', { id: ticketId })),
          onSendBack: () => sendBackModal(),
          icon: (name, size) => api.ui.icon(name, size),
        },
        {
          id: card.id,
          title: card.meta.title,
          track: card.meta.track,
          repo: card.meta.repo,
          terminal,
          changes: reply?.changes ?? null,
        },
      ),
    );
    readyStoryHost.replaceChildren(
      storyNode({ story: reply?.story ?? [], totals: reply?.totals ?? { minutes: null, tokens: null } }),
    );
  };
  // The quiet start's pending hint (req-75): under the status line while
  // a live run stands quiet — nothing happens until the first message.
  const pendingHint = el('div', 'tickets-thread-pending', PENDING_HINT);
  pendingHint.hidden = true;
  // The decision bar (req-75 W1b): the buttons W1 drew on a Needs-you
  // row, now above the composer where the ticket is read.
  const decisionBar = el('div', 'tickets-thread-decisions');
  decisionBar.hidden = true;
  const decisionButton = (label: string, title: string, primary: boolean, onClick: () => void): HTMLButtonElement => {
    const b = el('button', `tickets-takeover-btn${primary ? ' tickets-takeover-btn-primary' : ''}`, label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };
  const paintDecisions = (): void => {
    const card = boardCard(ticketId);
    if (card === null || snapshot === null) {
      decisionBar.hidden = true;
      return;
    }
    const need = workGroups(snapshot, fleetRuns)
      .needs.find((row) => row.card.id === ticketId)?.need ?? null;
    if (need === null || need.kind !== 'checkpoint') {
      decisionBar.hidden = true;
      return;
    }
    // The Ready card's buttons replace the bar while it shows (req-75 W3).
    if (!readyWrap.hidden) {
      decisionBar.hidden = true;
      return;
    }
    const action = checkpointActionOf(snapshot, need.phase);
    const live = runForCard(ticketId);
    decisionBar.replaceChildren();
    if (action.kind === 'accept') {
      decisionBar.append(
        decisionButton(action.label, 'Accept the result — the ticket goes to the archive', true, () =>
          void runMutation(`Accepting ${ticketId}`, () => invokeBoard('archive', { id: ticketId })),
        ),
      );
    } else {
      decisionBar.append(
        decisionButton(action.label, `Your review is done — move the ticket on to ${action.label.replace('Approve → ', '')}`, true, () =>
          moveTicket(api, card, action.to),
        ),
      );
      if (interactiveModeFor(need.phase, snapshot.columns) === 'refine' && live === null) {
        decisionBar.append(
          decisionButton('Refine with agent', 'Talk it through with a worker first', false, () =>
            void startInteractive(api, card, 'refine'),
          ),
        );
      }
    }
    decisionBar.hidden = false;
  };
  // --- the steps (req-75 W4a, canvas "3a"): one line per run of the
  // ticket, the live (or newest) one open at the bottom with the live
  // transcript. A finished run unfolds in place — its stream is pulled
  // once, never polled.
  const stepsBox = el('div', 'tickets-thread-steps');
  const shapedLine = el('div', 'tickets-thread-shaped');
  const stepsHost = el('div', 'tickets-thread-steplist');
  const openHead = el('div', 'tickets-step-line tickets-step-open');
  const openMark = el('span', 'tickets-step-mark', '●');
  const openLabel = el('span', 'tickets-step-text');
  openHead.append(openMark, openLabel, el('span', 'tickets-step-chevron', '⌄'));
  const transcript = createTranscriptView(api, '');
  transcript.element.classList.add('tickets-takeover-transcript');
  const empty = el('div', 'tickets-thread-empty');
  stepsBox.append(shapedLine, stepsHost, openHead, transcript.element, empty);
  // The column scrolls as one: the transcript's own scroller is neutral
  // here (CSS), and this follow keeps the live tail in view.
  let stepsFollow = true;
  stepsBox.addEventListener('scroll', () => {
    stepsFollow = stepsBox.scrollHeight - stepsBox.scrollTop - stepsBox.clientHeight <= 40;
  });
  const followSteps = (): void => {
    if (stepsFollow) {
      stepsBox.scrollTop = stepsBox.scrollHeight;
    }
  };
  const worktreeOf = (runId: string): string => fleetRuns.find((r) => r.id === runId)?.worktreePath ?? '';
  const stepText = (step: ThreadStep, actions: number | null): string =>
    `${step.label} · ${actions !== null ? `${actions} ${actions === 1 ? 'action' : 'actions'} · ` : ''}${step.duration}`;
  interface StepNode {
    wrap: HTMLElement;
    line: HTMLButtonElement;
    text: HTMLElement;
    body: HTMLElement;
    open: boolean;
    pulled: boolean;
    actions: number | null;
    view: { element: HTMLElement; update(v: unknown): void } | null;
  }
  const stepNodes = new Map<string, StepNode>();
  const stepNode = (step: ThreadStep): HTMLElement => {
    const known = stepNodes.get(step.runId);
    if (known !== undefined) {
      known.wrap.hidden = false;
      return known.wrap;
    }
    const node: StepNode = { wrap: el('div', 'tickets-step'), line: el('button', 'tickets-step-line'), text: el('span', 'tickets-step-text'), body: el('div', 'tickets-step-body'), open: false, pulled: false, actions: null, view: null };
    node.line.type = 'button';
    node.line.append(el('span', 'tickets-step-mark', step.mark), node.text, el('span', 'tickets-step-chevron', '›'));
    node.wrap.append(node.line, node.body);
    node.body.hidden = true;
    node.line.addEventListener('click', () => {
      node.open = !node.open;
      node.body.hidden = !node.open;
      node.line.querySelector('.tickets-step-chevron')!.textContent = node.open ? '⌄' : '›';
      if (node.open && !node.pulled) {
        node.pulled = true;
        void invokeBoard('fleetStream', { runId: step.runId })
          .then((result) => {
            const text = (result as { text?: string }).text ?? '';
            const view = formatWatch(parseStreamEvents(text));
            const tx = createTranscriptView(api, worktreeOf(step.runId));
            tx.element.classList.add('tickets-step-transcript');
            tx.update(view);
            node.view = tx;
            node.body.append(tx.element);
            node.actions = view.blocks.filter((block) => block.kind === 'step').length;
            node.text.textContent = stepText(step, node.actions);
          })
          .catch(() => undefined);
      }
    });
    stepNodes.set(step.runId, node);
    return node.wrap;
  };
  let foldedSig = '';
  const paintSteps = (): void => {
    const steps = threadSteps(ticketId, fleetRuns, Date.now());
    const openId = threadRun(ticketId)?.id ?? null;
    const folded = steps.filter((s) => s.runId !== openId);
    const sig = `${openId ?? ''}#${folded.map((s) => `${s.runId}:${s.mark}:${s.label}:${s.duration}`).join('|')}`;
    if (sig !== foldedSig) {
      foldedSig = sig;
      for (const node of stepNodes.values()) {
        node.wrap.hidden = true;
      }
      stepsHost.replaceChildren(...folded.map((step) => stepNode(step)));
    }
    for (const [id, node] of stepNodes) {
      const step = folded.find((s) => s.runId === id);
      if (step === undefined) {
        continue;
      }
      node.line.dataset['mark'] = step.mark;
      node.line.querySelector('.tickets-step-mark')!.textContent = step.mark;
      node.text.textContent = stepText(step, node.actions);
      if (step.detail !== null) {
        node.line.title = step.detail;
      }
    }
    const openStep = steps.find((s) => s.runId === openId) ?? null;
    openHead.hidden = openStep === null;
    if (openStep !== null) {
      openMark.textContent = openStep.mark;
      openHead.dataset['mark'] = openStep.mark;
      openLabel.textContent = `${openStep.label} · ${openStep.duration}`;
    }
    // A Past runs row asked for one run: unfold it and bring it into view.
    if (threadFocusRun !== null) {
      const node = stepNodes.get(threadFocusRun);
      if (node !== undefined) {
        if (!node.open) {
          node.line.click();
        }
        node.wrap.scrollIntoView({ block: 'nearest' });
        threadFocusRun = null;
      }
    }
  };

  // --- the Changes-so-far box (req-75 W4a): what the branch carries
  // against its base ref, committed and uncommitted.
  const changesBox = el('div', 'tickets-thread-changes');
  changesBox.hidden = true;
  let changesJson = '[]';
  const diffText = (file: WorktreeFile): string =>
    [file.added === null ? null : `+${file.added}`, file.removed === null ? null : `−${file.removed}`]
      .filter((part): part is string => part !== null)
      .join(' ');
  const paintChanges = (files: readonly WorktreeFile[]): void => {
    const card = boardCard(ticketId);
    const safe = el('div', 'tickets-changes-safe');
    safe.append(el('span', 'tickets-changes-tick', '✓'), document.createTextNode(` own worktree · ${card?.meta.branch ?? branchForTicket(ticketId)}`));
    changesBox.replaceChildren(
      el('div', 'tickets-changes-head', 'Changes so far'),
      ...files.map((file) => {
        const row = el('div', 'tickets-changes-file');
        const path = el('span', 'tickets-changes-path', file.path);
        path.title = file.path;
        row.append(el('span', `tickets-changes-status tickets-changes-status-${file.status}`, file.status), path, el('span', 'tickets-changes-diff', diffText(file)));
        return row;
      }),
      el('div', 'tickets-changes-head', 'Safe beside others'),
      safe,
    );
    changesBox.hidden = false;
  };
  const pullChanges = (): void => {
    void invokeBoard('worktreeChanges', { id: ticketId })
      .then((reply) => {
        const files = ((reply as { files?: unknown }).files ?? []) as WorktreeFile[];
        const json = JSON.stringify(files);
        if (json === changesJson) {
          return;
        }
        changesJson = json;
        if (files.length === 0) {
          changesBox.hidden = true;
          return;
        }
        paintChanges(files);
      })
      .catch(() => undefined);
  };
  stepsBox.prepend(changesBox);

  const dialogMode = (): InteractiveMode | null => {
    const card = boardCard(ticketId);
    return card === null || snapshot === null ? null : interactiveModeFor(card.phase, snapshot.columns);
  };
  const isLive = (run: RunInfo | null): boolean => run !== null && (LIVE_RUN_STATES.includes(run.state) || run.state === 'detached');
  const composer = createRunComposer({
    api,
    invoke: invokeBoard,
    mutate: runMutation,
    error: (message) => {
      setNote(message, 'error');
      notifyViews();
    },
    target: () => threadRun(ticketId),
    onReopened: () => undefined,
    othersLive: () => fleetRuns.filter((r) => LIVE_RUN_STATES.includes(r.state) && r.id !== threadRun(ticketId)?.id).length,
    // No live run: the first message starts the phase's dialog (plan or refine).
    startFor: async () => {
      const card = boardCard(ticketId);
      const mode = dialogMode();
      return card === null || mode === null ? null : startInteractive(api, card, mode, false);
    },
    canStart: () => dialogMode() !== null && !isLive(threadRun(ticketId)),
    placeholder: 'Message the worker — type / for commands',
    // The quiet start's pre-fill (req-75): while the dialog has seen no
    // owner message — no live run and one may start (the first message
    // starts it, quiet by the same wrap), or a live quiet run — the box
    // opens carrying the step and its meaning.
    prefill: () => {
      const mode = dialogMode();
      if (mode === null) {
        return null;
      }
      const run = threadRun(ticketId);
      return !isLive(run) || run?.quietStart === true ? dialogStarter(mode) : null;
    },
  });

  let pulledFor: string | null = null;
  let lastStream = '\u0000';
  let alive = true;
  let runStateSig = '';
  const pull = (): void => {
    const run = threadRun(ticketId);
    if (run === null) {
      return;
    }
    if (run.id !== pulledFor) {
      pulledFor = run.id;
      lastStream = '\u0000';
      transcript.setWorktree(run.worktreePath);
    }
    const runId = run.id;
    void invokeBoard('fleetStream', { runId }).then((result) => {
      if (!alive || pulledFor !== runId) {
        return;
      }
      const text = (result as { text?: string }).text ?? '';
      if (text !== lastStream) {
        lastStream = text;
        transcript.update(formatWatch(parseStreamEvents(text)));
        followSteps();
      }
    }).catch(() => undefined);
  };

  /** The takeover tab's telemetry lines, as the meta line's tooltip (W4a). */
  const telemetryTooltip = (run: RunInfo): string => {
    const cached = run.cacheReadTokens ?? 0;
    return [
      `Turn ${run.steerCount + 1} — the first prompt plus every message sent since`,
      contextLabel(run),
      `Tokens ${formatTokens(run.tokensIn)} in${cached > 0 ? ` (${formatTokens(cached)} cached)` : ''} · ${formatTokens(run.tokensOut)} out`,
      `Elapsed ${spanClock(execClockMs(run, Date.now()))} — waits for you and standing do not tick`,
      ...telemetryParts(run).map((part) => part.replace(/^ctx /, 'last turn context ')),
    ].join('\n');
  };

  const paint = (): void => {
    const card = boardCard(ticketId);
    const run = threadRun(ticketId);
    const live = isLive(run);
    titleNode.textContent = card?.meta.title ?? '(not on the board)';
    const status = run === null ? null : workerStatus(run, Date.now());
    // The dot: the run's light, amber the moment it waits on the owner.
    const waiting = live && run !== null && run.waiting != null;
    light.className = `tickets-light tickets-light-${waiting ? 'waiting' : live && status !== null ? status.light : 'idle'}`;
    light.hidden = run === null;
    // The state word (W4a): what the worker does now — without a live
    // run the word says so, and without any run there is no dot.
    stateWord.textContent = liveStateWord(run) ?? (run !== null ? 'Ended' : 'No run yet');
    // One muted line: provider · model · run time · context (parts without data stay out).
    const fill = run === null ? null : contextFill(run);
    metaNode.textContent = [
      run === null ? null : workerLabelOf(run.provider),
      run === null ? null : run.model ?? null,
      run === null ? null : durationWords(execClockMs(run, Date.now())),
      fill === null ? null : `context ${Math.round(fill * 100)}%`,
      run !== null && run.state === 'detached' ? 'not connected' : null,
    ]
      .filter((part): part is string => part !== null && part !== '')
      .join(' · ');
    metaNode.title = run === null ? '' : telemetryTooltip(run);
    fileLink.hidden = card === null;
    // The header's buttons come from the tested pure choice (W4a): the
    // same controls in every state, exactly one way on. Start shares
    // the composer's gate — only a dialog phase can start one by hand.
    const show = new Set(headerControls(run));
    pauseRun.hidden = !show.has('pause');
    takeOverRun.hidden = !show.has('takeover');
    stopRun.hidden = !show.has('stop');
    handBackRun.hidden = !show.has('handback');
    resumeRun.hidden = !show.has('resume');
    startRun.hidden = !show.has('start') || dialogMode() === null;
    // The quiet start's hint (req-75): the run waits for the first send.
    pendingHint.hidden = !(live && run !== null && run.quietStart === true);
    transcript.element.hidden = run === null;
    empty.hidden = run !== null;
    const mode = dialogMode();
    empty.textContent =
      mode === null
        ? 'No run on this ticket yet.'
        : mode === 'plan'
          ? 'No run yet — write below to plan this ticket with a worker.'
          : 'No run yet — write below to refine this ticket with a worker.';
    // The shaped-with-you line: the owner approved this ticket's plan.
    const approved = readyReply?.planApproved ?? null;
    shapedLine.hidden = approved === null;
    if (approved !== null) {
      shapedLine.textContent = `Shaped with you · plan approved ${ageWords(approved, Date.now())}`;
    }
    paintSteps();
    // The box follows the runs: a state change re-pulls, a live run every 30 s.
    const stateSig = fleetRuns
      .filter((r) => r.ticketId === ticketId)
      .map((r) => `${r.id}:${r.state}`)
      .join('|');
    if (stateSig !== runStateSig) {
      runStateSig = stateSig;
      pullChanges();
    }
    if (run !== null && run.id !== pulledFor) {
      pull();
    }
    pullReady();
    paintReady();
    paintDecisions();
    composer.paint();
    endMoves.paint(run);
  };

  fleetListeners.add(paint);
  // A board refresh repaints the thread too (the ticket may have moved).
  const view: BoardView = { root: wrap, render: paint, dispose: () => undefined };
  views.add(view);
  paint();
  const timer = setInterval(pull, 2_000);
  const tick = setInterval(paint, 1_000);
  // While a run is live the branch keeps moving: a slow look every 30 s.
  const changesTimer = setInterval(() => {
    if (isLive(threadRun(ticketId))) {
      pullChanges();
    }
  }, 30_000);
  wrap.append(head, readyWrap, pendingHint, stepsBox, endMoves.element, decisionBar, composer.element);
  host.append(wrap);
  return () => {
    alive = false;
    clearInterval(timer);
    clearInterval(tick);
    clearInterval(changesTimer);
    fleetListeners.delete(paint);
    views.delete(view);
    composer.dispose();
  };
}


/**
 * The fleet daemon's chain log as a readonly editor tab: the same lines
 * land in `<userData>/plugins/fleet/runner.log` (T-0007 review finding 2).
 */
const CHAIN_LOG_KIND = 'tickets-chain-log';
const CHAIN_LOG_KEY = 'chain-log://fleet-daemon';

/** Lines stamped at or before this instant are hidden ("Clear"); the
 *  daemon's ring buffer and runner.log on disk stay untouched. */
let chainLogClearedAt = '';

/** Opens (or focuses) the fleet daemon's log tab. */
function openChainLog(api: DreyPluginApi): void {
  api.documents.addDoc(CHAIN_LOG_KIND, CHAIN_LOG_KEY, 'Fleet daemon log');
}

/**
 * The log's pane body: a readonly tail that follows the bottom while the
 * view is scrolled down. Scrolling up pauses the follow; scrolling back
 * to the bottom resumes it — the terminal behavior (owner ruling).
 */
function mountChainLog(api: DreyPluginApi, host: HTMLElement): () => void {
  const wrap = el('div', 'tickets-chain-log');
  const bar = el('div', 'tickets-chain-log-bar');
  const hint = el('div', 'tickets-chain-log-hint');
  hint.textContent =
    'Also on disk as <userData>/plugins/fleet/runner.log — follows the tail while you are at the bottom; scroll up to hold, back down to resume.';
  const clear = el('button', 'icon-btn');
  clear.type = 'button';
  clear.title = 'Clear the view — only lines logged from now on are shown (the file on disk is kept)';
  clear.setAttribute('aria-label', 'Clear log');
  clear.textContent = 'Clear';
  bar.append(hint, clear);
  let lastText = '';
  // The host's own Markdown editor, read-only: the log is one fenced block,
  // and the view itself follows the tail while it is scrolled to the bottom.
  const view = api.ui.createMarkdownView({ mode: 'view', readOnly: true, content: asParagraphs('Loading the daemon log…') });
  view.element.classList.add('tickets-chain-log-out');
  let alive = true;
  const pull = (): void => {
    void invokeBoard('fleetLog').then((result) => {
      if (!alive) {
        return;
      }
      lastText = (result as { text?: string }).text ?? '';
      render();
    });
  };
  const render = (): void => {
    const text = visibleChainLog(lastText, chainLogClearedAt);
    view.setContent(
      asParagraphs(
        text === ''
          ? chainLogClearedAt === ''
            ? '(the daemon has not logged anything yet)'
            : '(cleared — new lines appear here)'
          : text,
      ),
    );
  };
  clear.addEventListener('click', () => {
    const stamps = lastText.split('\n').map(chainLogStamp).filter((x) => x !== '');
    const newest = stamps[stamps.length - 1];
    if (newest !== undefined) {
      chainLogClearedAt = newest;
    }
    render();
  });
  pull();
  const timer = setInterval(pull, 2_000);
  wrap.append(bar, view.element);
  host.append(wrap);
  return () => {
    alive = false;
    clearInterval(timer);
    view.dispose();
  };
}

// --- the card context menu ----------------------------------------------------

/** ArrowUp / ArrowDown move the focus through a `.tickets-menu`'s enabled rows. */
function cycleMenuFocus(menu: HTMLElement, e: KeyboardEvent): void {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
    return;
  }
  e.preventDefault();
  const items = [...menu.querySelectorAll<HTMLButtonElement>('.tickets-menu-item:not(:disabled)')];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const step = e.key === 'ArrowDown' ? 1 : items.length - 1;
  items[(at === -1 ? (step === 1 ? 0 : step) : at + step) % items.length]?.focus();
}

interface SubmenuRow {
  readonly content: HTMLElement;
  readonly title: string;
  readonly onClick: () => void;
}

interface Submenu {
  close(): void;
  contains(node: Node): boolean;
}

/**
 * A row that opens further rows beside the menu (req-70): hover, click,
 * Enter or ArrowRight opens them, ArrowLeft / Escape goes back to the row.
 * `closeAll` closes the whole menu once a row was chosen.
 */
function appendSubmenu(
  menu: HTMLElement,
  label: string,
  rows: readonly SubmenuRow[],
  closeAll: () => void,
): Submenu {
  const trigger = el('button', 'tickets-menu-item has-sub');
  trigger.type = 'button';
  trigger.setAttribute('role', 'menuitem');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.append(el('span', 'tickets-menu-label', label), el('span', 'tickets-menu-chevron', '›'));
  let sub: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = (): void => {
    clearTimeout(timer);
    sub?.remove();
    sub = null;
    trigger.setAttribute('aria-expanded', 'false');
  };
  // A short grace period, so a diagonal move from the row into the
  // submenu does not cross a neighbouring row and close it on the way.
  const closeSoon = (): void => {
    clearTimeout(timer);
    timer = setTimeout(close, 250);
  };
  const open = (focusFirst: boolean): void => {
    clearTimeout(timer);
    if (sub === null) {
      const panel = el('div', 'tickets-menu tickets-submenu');
      panel.setAttribute('role', 'menu');
      for (const row of rows) {
        const button = el('button', 'tickets-menu-item');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.title = row.title;
        button.append(row.content);
        button.addEventListener('click', () => {
          closeAll();
          row.onClick();
        });
        panel.append(button);
      }
      panel.addEventListener('mouseenter', () => clearTimeout(timer));
      panel.addEventListener('mouseleave', closeSoon);
      panel.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'Escape') {
          e.preventDefault();
          close();
          trigger.focus();
        } else {
          cycleMenuFocus(panel, e);
        }
      });
      document.body.append(panel);
      const anchor = trigger.getBoundingClientRect();
      const rect = panel.getBoundingClientRect();
      const right = anchor.right + 2;
      const left = right + rect.width > window.innerWidth - 8 ? anchor.left - rect.width - 2 : right;
      panel.style.left = `${Math.max(0, left)}px`;
      panel.style.top = `${Math.max(0, Math.min(anchor.top - 4, window.innerHeight - rect.height - 8))}px`;
      trigger.setAttribute('aria-expanded', 'true');
      sub = panel;
    }
    if (focusFirst) {
      sub.querySelector<HTMLButtonElement>('.tickets-menu-item')?.focus();
    }
  };
  trigger.addEventListener('mouseenter', () => open(false));
  trigger.addEventListener('mouseleave', closeSoon);
  trigger.addEventListener('click', () => open(true));
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      open(true);
    }
  });
  // Any other row of the menu takes over from the submenu.
  menu.addEventListener('mouseover', (e) => {
    if (sub !== null && !trigger.contains(e.target as Node)) {
      closeSoon();
    }
  });
  menu.append(trigger);
  return { close, contains: (node) => sub?.contains(node) ?? false };
}

/** One finished run as a Past runs row: phase · how it ended · when. */
function pastRunRow(run: RunInfo): HTMLElement {
  const row = el('span', 'tickets-menu-run');
  row.append(
    el('span', 'tickets-menu-run-phase', run.column ?? run.provider),
    el('span', `tickets-menu-run-state is-${run.state}`, run.state),
    el('span', 'tickets-menu-run-when', run.startedAt.replace('T', ' ').slice(5, 16)),
  );
  return row;
}

/** A settings row (Track ›, Priority ›): the tick marks the current one. */
function menuRadioRow(label: string, checked: boolean): HTMLElement {
  const row = el('span', 'tickets-menu-radio');
  row.append(el('span', 'tickets-menu-check', checked ? '✓' : ''), el('span', 'tickets-menu-label', label));
  return row;
}

/**
 * A Work row's menu (req-75 W1/W1b): the moves first — queue an idea for
 * the fleet or take it back, any phase by name — then the ticket's own
 * settings (track, priority), then the runs, then the maintenance rows
 * behind "More", and Archive last.
 */
function openCardMenu(
  api: DreyPluginApi,
  card: TicketCard,
  at: { readonly x: number; readonly y: number },
  run: (label: string, invoke: () => Promise<unknown>) => Promise<MutationResult>,
  actions: { setPriority(card: TicketCard, priority: TicketPriority): void; setTrack(card: TicketCard, track: TicketTrack | null): void },
): void {
  for (const other of document.querySelectorAll('.tickets-menu')) {
    other.remove();
  }
  const menu = el('div', 'tickets-menu');
  const submenus: Submenu[] = [];
  const outside = (e: Event): void => {
    const target = e.target as Node;
    if (!menu.contains(target) && !submenus.some((sub) => sub.contains(target))) {
      close();
    }
  };
  const close = (): void => {
    for (const sub of submenus) {
      sub.close();
    }
    menu.remove();
    window.removeEventListener('mousedown', outside, true);
  };
  const item = (label: string, onClick: () => void, title?: string): void => {
    const button = el('button', 'tickets-menu-item', label);
    button.type = 'button';
    if (title !== undefined) {
      button.title = title;
    }
    button.addEventListener('click', () => {
      close();
      onClick();
    });
    menu.append(button);
  };
  const textRow = (label: string): HTMLElement => el('span', 'tickets-menu-label', label);

  item('Open ticket', () => void openTicketPage(api, card), 'The ticket file with its thread beside it');
  menu.append(el('div', 'tickets-menu-sep'));

  const live = runForCard(card.id);
  const columns = snapshot?.columns.filter((c) => !c.unknown) ?? [];
  const pipeline = columns.map((c) => c.phase);
  const firstPhase = pipeline[0]?.id ?? null;
  const queueTo = queueTargetOf(pipeline, card.phase);
  if (queueTo !== null && ideaPhaseIds(pipeline).includes(card.phase)) {
    item('Queue for the fleet', () => moveTicket(api, card, queueTo), 'The next free worker takes it');
  }
  // Back to ideas: a queued idea, or one the fleet has not picked up yet.
  const queuedAt = firstPhase === null ? null : queueTargetOf(pipeline, firstPhase);
  if (firstPhase !== null && card.phase !== firstPhase && live === null && (ideaPhaseIds(pipeline).includes(card.phase) || card.phase === queuedAt)) {
    item('Back to ideas', () => moveTicket(api, card, firstPhase), 'Out of the queue — back to the ideas');
  }
  const targets = columns.filter((c) => c.phase.id !== card.phase);
  if (targets.length > 0) {
    submenus.push(
      appendSubmenu(
        menu,
        'Move to',
        targets.map((c) => ({
          content: textRow(c.phase.title),
          title: `Move ${card.id} to ${c.phase.title}`,
          onClick: () => moveTicket(api, card, c.phase.id),
        })),
        close,
      ),
    );
  }
  menu.append(el('div', 'tickets-menu-sep'));

  // The ticket's own settings (req-75 W1b): the track from triage and
  // the priority — radio rows over the one-commit writers.
  submenus.push(
    appendSubmenu(
      menu,
      'Track',
      (
        [
          ['Auto', 'auto', 'Runs on its own — planned, built, tested and reviewed'],
          ['Shape', 'shape', 'A plan-mode dialog with you before anything runs'],
          ['Not triaged', null, 'No track yet — decide later'],
        ] as const
      ).map(([label, value, title]) => ({
        content: menuRadioRow(label, value === card.meta.track),
        title,
        onClick: () => actions.setTrack(card, value),
      })),
      close,
    ),
    appendSubmenu(
      menu,
      'Priority',
      TICKET_PRIORITIES.map((priority) => ({
        content: menuRadioRow(PRIORITY_LABEL[priority], priority === card.meta.priority),
        title: `Priority ${PRIORITY_LABEL[priority]}`,
        onClick: () => actions.setPriority(card, priority),
      })),
      close,
    ),
  );
  menu.append(el('div', 'tickets-menu-sep'));

  // The one-click interactive dialog (req-65, req-72): plan on the first
  // automatic phase, refine in every manual one — only without a live run.
  if (snapshot !== null && live === null) {
    const mode = interactiveModeFor(card.phase, snapshot.columns);
    if (mode !== null) {
      const action = mode === 'plan' ? 'Plan with agent' : 'Refine with agent';
      item(`${action} (${card.worker})`, () => void startInteractive(api, card, mode));
    }
  }
  if (live === null) {
    item(`Run agent (${card.worker})…`, () => openRunModal(api, card));
  } else {
    item('Open ticket', () => void openTicketPage(api, card));
    item('Stop run', () => {
      void run('Stopping the run', () => invokeBoard('fleetStop', { runId: live.id, reason: null }));
    });
  }
  // Earlier runs of this ticket: their transcripts stay on disk; the
  // thread shows them as steps, read-only (req-70, W4a).
  const past = fleetRuns
    .filter((r) => r.ticketId === card.id && !LIVE_RUN_STATES.includes(r.state))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 15);
  if (past.length > 0) {
    submenus.push(
      appendSubmenu(
        menu,
        `Past runs (${past.length})`,
        past.map((earlier) => ({
          content: pastRunRow(earlier),
          title: `${earlier.provider} · started ${earlier.startedAt.replace('T', ' ').slice(0, 16)} — opens the thread with that run unfolded`,
          onClick: () => {
            threadFocusRun = earlier.id;
            void openTicketPage(api, card);
          },
        })),
        close,
      ),
    );
  }
  menu.append(el('div', 'tickets-menu-sep'));

  // Maintenance rows (req-70: only the claim rows that apply).
  const more: SubmenuRow[] = [
    {
      content: textRow(`Copy branch (${branchForTicket(card.id)})`),
      title: 'Copies the ticket branch name',
      onClick: () => void navigator.clipboard.writeText(branchForTicket(card.id)),
    },
  ];
  // T-0004: jump to the work checkout. Needs the ticket's repo AND a local
  // `path:` for it in _meta/repos.md.
  const repoPath = card.meta.repo === null ? null : (snapshot?.repos.find((r) => r.name === card.meta.repo)?.path ?? null);
  if (card.meta.repo !== null && repoPath !== null) {
    const repo = card.meta.repo;
    more.push({
      content: textRow('Open work folder in terminal'),
      title: `Opens a terminal at ${repoPath}`,
      onClick: () => void runMutation('Opening terminal', () => invokeBoard('openRepoFolder', { repo })),
    });
  }
  const claimedBy = card.meta.claimedBy;
  if (claimedBy === null || !claimedBy.startsWith('owner@')) {
    more.push({
      content: textRow(claimedBy === null ? 'Claim' : 'Take over claim'),
      title: claimedBy === null ? 'Claim the ticket for yourself' : `Claimed by ${claimedBy}`,
      onClick: () => void run('Taking over', () => invokeBoard('claim', { id: card.id, mode: 'takeover' })),
    });
  }
  if (claimedBy !== null) {
    more.push({
      content: textRow('Release claim'),
      title: `Claimed by ${claimedBy}`,
      onClick: () => void run('Releasing', () => invokeBoard('claim', { id: card.id, mode: 'release' })),
    });
  }
  submenus.push(appendSubmenu(menu, 'More', more, close));
  {
    // T-0044: tidy this ticket's checkout — `git worktree remove`, the
    // branch stays (it carries the work). A dirty tree arms the button
    // for a confirming second click (the Archive pattern).
    const known = card.meta.repo !== null && (snapshot?.repos.some((r) => r.name === card.meta.repo) ?? false);
    const button = el('button', 'tickets-menu-item', 'Remove worktree…');
    button.type = 'button';
    button.disabled = !known;
    button.title = known
      ? 'Removes the ticket\'s worktree (git worktree remove) — the branch with the work stays'
      : 'This ticket names no repository';
    let armed = false;
    button.addEventListener('click', () => {
      if (!known) {
        return;
      }
      if (armed) {
        close();
        void run('Removing the worktree', () => invokeBoard('worktreeRemove', { id: card.id, force: true }));
        return;
      }
      button.disabled = true;
      button.textContent = 'Checking the worktree…';
      void invokeBoard('worktreeRemove', { id: card.id, force: false })
        .then((raw) => {
          const res = raw as { ok: boolean; error?: string; dirty?: boolean; status?: string };
          if (res.ok) {
            close(); // the Log line's announce refreshes the board
            return;
          }
          if (res.dirty === true) {
            armed = true;
            button.disabled = false;
            button.textContent = 'Worktree is dirty — remove anyway';
            button.title = `Uncommitted changes:\n${res.status ?? ''}`;
            return;
          }
          close();
          setNote(res.error ?? 'the worktree could not be removed', 'error');
          notifyViews();
        })
        .catch((error: unknown) => {
          close();
          setNote(messageOf(error), 'error');
          notifyViews();
        });
    });
    menu.append(button);
  }
  {
    // T-0041: archive instead of delete — armed two-step, so a single
    // click never sends a ticket to tickets/archive/. The first click
    // only relabels; the menu closing disarms.
    const button = el('button', 'tickets-menu-item', 'Archive…');
    button.type = 'button';
    button.title = 'Moves the ticket to tickets/archive/ — out of the list, kept in git';
    let armed = false;
    button.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        button.textContent = 'Archive — click again';
        return;
      }
      close();
      void run('Archiving', () => invokeBoard('archive', { id: card.id }));
    });
    menu.append(button);
  }

  menu.setAttribute('role', 'menu');
  for (const row of menu.querySelectorAll('.tickets-menu-item')) {
    row.setAttribute('role', 'menuitem');
  }
  document.body.append(menu);
  menu.querySelector<HTMLButtonElement>('.tickets-menu-item:not(:disabled)')?.focus();
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(at.x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(0, Math.min(at.y, window.innerHeight - rect.height - 8))}px`;

  window.addEventListener('mousedown', outside, true);
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      close();
    } else {
      cycleMenuFocus(menu, e);
    }
  });
}

// --- activation -------------------------------------------------------------

const plugin: { activate(api: DreyPluginApi): void } = {
  activate(api) {
    backend = api.backend;
    // A worker that waits on the owner says so outside the board too (req-64).
    fleetListeners.add(() => announceWaits(api));
    // So does a fleet that stopped by itself: a tripped breaker, a spent quota.
    fleetListeners.add(() => announceChainAlerts(api));
    api.ui.registerWidget(createTicketsWidget(api));
    api.ui.registerSettingsPage(createTicketsSettingsPage(api));

    // The Files-panel seam (T-0042, SDK 1.32): veto/takeover over the
    // board's ground, and the per-target context rows. Both read the
    // module-level board store, so they follow every board-changed
    // refresh — including a re-registered tickets vault.
    const filesDeps = {
      snapshot: () => snapshot,
      invoke: invokeBoard,
      showMessage: (message: string, title?: string) => api.ui.showMessage(message, title),
    };
    api.files.registerOperations(createFilesOperationsHandler(filesDeps));
    api.files.registerContextMenuItems(ticketsContextMenuItems(filesDeps));

    // The ticket header and the folded Log in the editor (req-62, SDK 1.34).
    // Both match on the board's vault, so they register again when that
    // vault becomes known or changes — the registration is what makes open
    // editors look again.
    const header = createTicketHeader({
      api,
      snapshot: () => snapshot,
      invoke: invokeBoard,
      workers: WORKER_LABEL,
      onError: (message) => {
        setNote(message, 'error');
        notifyViews();
      },
      startInteractive: (card, mode) => void startInteractive(api, card, mode),
    });
    let headerVault: string | null = null;
    let unregisterHeader: (() => void) | null = null;
    afterBoardRefresh = () => {
      const vaultId = snapshot?.vaultId ?? null;
      if (vaultId !== headerVault || unregisterHeader === null) {
        headerVault = vaultId;
        unregisterHeader?.();
        const offView = api.editor.registerFrontmatterView(header.view);
        const offFold = api.editor.registerExtension('document', ticketLogFold(api, () => snapshot));
        unregisterHeader = () => {
          offView();
          offFold();
        };
      }
      header.repaint();
    };

    // The fleet daemon's chain log: a readonly, tail-following editor tab
    // (T-0007 review finding 2). Stateless — the session snapshot reopens
    // it from the fixed key.
    api.ui.registerDocKind({
      kind: CHAIN_LOG_KIND,
      icon: 'scroll-text',
      serialize: () => null,
      restore: () => openChainLog(api),
      mount: (el) => mountChainLog(api, el),
      statusText: () => 'fleet daemon',
    });

    api.ui.registerDocKind({
      kind: THREAD_KIND,
      icon: 'messages-square',
      serialize: () => (threadTicketId === null ? null : { ticketId: threadTicketId }),
      restore: (_path, data) => {
        const saved = (data as { ticketId?: unknown } | null)?.ticketId;
        if (typeof saved === 'string' && saved !== '') {
          threadTicketId = saved;
          api.documents.addDoc(THREAD_KIND, THREAD_KEY, threadTitle(saved));
        }
      },
      mount: (el) => mountThread(api, el),
      statusText: () => {
        const run = threadTicketId === null ? null : threadRun(threadTicketId);
        return run === null ? null : run.waiting !== undefined ? 'waits for you' : run.state;
      },
    });

    api.ui.registerDocKind({
      kind: TAKEOVER_KIND,
      icon: 'message-circle',
      // The tab is gone (req-75 W4a): the kind stays registered only so
      // an old session restores onto the ticket page instead of a dead
      // tab. It is never written again, and a restore whose run is
      // unknown (the fleet snapshot may not have arrived yet) does
      // nothing — never a throw.
      serialize: () => null,
      restore: (path) => {
        const runId = path.startsWith(TAKEOVER_SCHEME) ? path.slice(TAKEOVER_SCHEME.length) : '';
        const run = fleetRuns.find((r) => r.id === runId);
        const card = run === undefined ? null : boardCard(run.ticketId);
        if (card !== null) {
          void openTicketPage(api, card);
        }
      },
      mount: (mountHost) => {
        mountHost.append(el('div', 'tickets-thread-empty', 'This tab moved into the ticket\'s thread.'));
        return () => undefined;
      },
      statusText: () => null,
    });

    api.documents.onChange((event) => {
      if (event.type === 'active-changed' || event.type === 'docs-changed') {
        markOpenCard(api);
      }
    });
    api.backend.on('board-changed', () => void refreshBoard());
    api.vault.onChanged(() => void refreshBoard());
    api.backend.on('fleet-changed', (payload) =>
      applyFleetSnapshot((payload ?? {}) as { runs?: RunInfo[]; chain?: ChainStatus | null }));
    void invokeBoard('fleetStatus').then((result) =>
      applyFleetSnapshot((result ?? {}) as { runs?: RunInfo[]; chain?: ChainStatus | null }));
    void refreshBoard();
  },
};

export default plugin;
