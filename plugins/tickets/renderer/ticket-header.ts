/**
 * The ticket header in the editor (req-62, SDK 1.34): an opened ticket
 * shows its title as a headline and its fields as a chip row, in place of
 * the base's folded `▸ Frontmatter` pill — and its `## Log` opens folded.
 *
 * The header draws from the BUFFER's frontmatter, not the file on disk
 * (an unsaved edit shows at once). Reading and rewriting the YAML is the
 * plugin's main side (`header` / `headerEdit`, the `yaml` document
 * mutation of `ticket-files.ts` — the renderer bundles no package); the
 * result goes back into the editor as one change, so dirty state, undo,
 * save and the conflict merge stay the editor's.
 */
import type {
  DreyPluginApi,
  EditorSurfaceContext,
  FrontmatterViewContrib,
  FrontmatterViewInput,
} from '../../../shared/plugin-api/renderer';
import {
  branchForTicket,
  stripPhasePrefix,
  TICKET_PRIORITIES,
  type BoardSnapshot,
  type TicketCard,
  type TicketIssue,
  type TicketMeta,
  type TicketPriority,
} from '../shared/tickets';
import { interactiveModeFor, type InteractiveMode } from './end-moves';

/** A ticket file of the board: `tickets/<phase dir>/T-nnnn.md` (archive included). */
export function isTicketPath(path: string | null): boolean {
  return path !== null && /^tickets\/(?!_meta\/)[^/]+\/T-\d{4,}\.md$/.test(path);
}

/** The phase directory's id (`50-build` → `build`), or null off a ticket path. */
export function phaseOfTicketPath(path: string): string | null {
  const match = /^tickets\/([^/]+)\//.exec(path);
  return match === null ? null : stripPhasePrefix(match[1]!);
}

/**
 * What the Log fold hides: from the end of the `## Log` heading line to the
 * end of its section (the next heading of level 1–2, or the document end),
 * trailing blank lines left visible. Headings inside a code fence don't
 * count. Null when there is no Log section or it is empty.
 */
export function logSectionRange(text: string): { from: number; to: number } | null {
  let offset = 0;
  let fenced = false;
  let start: number | null = null;
  let end: number | null = null;
  for (const line of text.split('\n')) {
    const lineEnd = offset + line.length;
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
    } else if (!fenced && /^#{1,2}\s/.test(line)) {
      if (start !== null) {
        break;
      }
      if (/^##\s+Log\s*$/.test(line)) {
        start = lineEnd;
      }
    } else if (start !== null && line.trim() !== '') {
      end = lineEnd;
    }
    offset = lineEnd + 1;
  }
  return start !== null && end !== null && end > start ? { from: start, to: end } : null;
}

const PRIORITY_LABEL: Record<TicketPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

interface HeaderModel {
  readonly meta: TicketMeta;
  readonly issues: readonly TicketIssue[];
}

interface HeaderReply {
  readonly ok: boolean;
  readonly error?: string;
  readonly frontmatter?: string;
  readonly meta?: TicketMeta;
  readonly issues?: readonly TicketIssue[];
}

export interface TicketHeaderDeps {
  readonly api: DreyPluginApi;
  readonly snapshot: () => BoardSnapshot | null;
  readonly invoke: (method: string, payload?: unknown) => Promise<unknown>;
  readonly workers: ReadonlyArray<readonly [string, string]>;
  readonly onError: (message: string) => void;
  /**
   * Starts the owner's interactive dialog for this ticket (req-65) —
   * the board's one-click start, shared with the card menu.
   */
  readonly startInteractive: (card: TicketCard, mode: InteractiveMode) => void;
}

export interface TicketHeader {
  readonly view: FrontmatterViewContrib;
  /** Repaints every open header from the latest board snapshot (phase, repos, issues). */
  repaint(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls !== undefined) {
    node.className = cls;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
};

/** The surface shows a ticket of the board's vault. */
const showsTicket = (snapshot: BoardSnapshot | null, context: EditorSurfaceContext): boolean =>
  snapshot?.vaultId != null && context.vaultId() === snapshot.vaultId && isTicketPath(context.path());

export function createTicketHeader(deps: TicketHeaderDeps): TicketHeader {
  // Parsed frontmatter by its text: a header drawn again after its own edit
  // (or a tab switch) paints at once instead of waiting for main.
  const models = new Map<string, HeaderModel>();
  const remember = (frontmatter: string, model: HeaderModel): void => {
    models.delete(frontmatter);
    models.set(frontmatter, model);
    if (models.size > 64) {
      models.delete(models.keys().next().value as string);
    }
  };
  const live = new Set<{ node: HTMLElement; paint: () => void }>();

  const view: FrontmatterViewContrib = {
    matches: (context) => showsTicket(deps.snapshot(), context),
    render: (input) => renderHeader(input, input.path ?? ''),
  };

  function renderHeader(input: FrontmatterViewInput, path: string): HTMLElement {
    const root = el('div', 'tickets-head');
    const chips = el('div', 'tickets-head-chips');
    const title = el('input', 'tickets-head-title');
    title.type = 'text';
    title.spellcheck = true;
    title.setAttribute('aria-label', 'Ticket title');
    root.append(chips, title);

    let model: HeaderModel | null = models.get(input.frontmatter) ?? null;
    if (model === null) {
      // Until main answers: what the board read from disk.
      const card = deps.snapshot()?.columns.flatMap((c) => c.tickets).find((t) => t.path === path);
      if (card !== undefined) {
        model = { meta: card.meta, issues: card.issues };
      }
      void (deps.invoke('header', { path, frontmatter: input.frontmatter }) as Promise<HeaderReply>).then((reply) => {
        if (reply.ok && reply.meta !== undefined) {
          model = { meta: reply.meta, issues: reply.issues ?? [] };
          remember(input.frontmatter, model);
          paint();
        }
      });
    }

    const apply = async (patch: Record<string, string | readonly string[]>): Promise<void> => {
      const before = input.frontmatter;
      let reply: HeaderReply;
      try {
        reply = (await deps.invoke('headerEdit', { path, frontmatter: before, patch })) as HeaderReply;
      } catch (error) {
        deps.onError(error instanceof Error ? error.message : String(error));
        paint();
        return;
      }
      if (!reply.ok || reply.frontmatter === undefined || reply.meta === undefined) {
        deps.onError(reply.error ?? 'the ticket header could not be changed');
        paint();
        return;
      }
      if (input.view.state.sliceDoc(0, before.length) !== before) {
        deps.onError('The frontmatter changed in the meantime — try again');
        paint();
        return;
      }
      remember(reply.frontmatter, { meta: reply.meta, issues: reply.issues ?? [] });
      input.view.dispatch({
        changes: { from: 0, to: before.length, insert: reply.frontmatter },
        userEvent: 'input.ticket-header',
      });
    };

    const select = (
      label: string,
      options: ReadonlyArray<readonly [string, string]>,
      value: string,
      key: string,
    ): HTMLSelectElement => {
      const box = el('select', 'tickets-head-select');
      box.title = label;
      box.setAttribute('aria-label', label);
      for (const [optionValue, optionLabel] of options) {
        const option = el('option', undefined, optionLabel);
        option.value = optionValue;
        box.append(option);
      }
      box.value = value;
      box.addEventListener('change', () => void apply({ [key]: box.value }));
      return box;
    };

    function paint(): void {
      const snapshot = deps.snapshot();
      const meta = model?.meta ?? null;
      chips.replaceChildren();
      const id = meta?.id ?? /T-\d{4,}/.exec(path)?.[0] ?? '';
      chips.append(el('span', 'tickets-head-id', id));

      const phaseId = phaseOfTicketPath(path);
      const phase = snapshot?.pipeline.find((p) => p.id === phaseId);
      const phaseChip = el(
        'span',
        'tickets-head-chip tickets-head-phase',
        phaseId === 'archive' ? 'Archived' : phase?.title ?? phaseId ?? '',
      );
      phaseChip.title = 'Phase — move the card on the board to change it';
      chips.append(phaseChip);

      if (meta !== null) {
        const priority = select(
          'Priority',
          TICKET_PRIORITIES.map((p) => [p, PRIORITY_LABEL[p]] as const),
          meta.priority,
          'priority',
        );
        priority.classList.add(`tickets-head-prio-${meta.priority}`);
        chips.append(priority);

        // req-72: the work repos as checkboxes — one ticket may name
        // several; the first checked one is the primary (the fleet's
        // gate repo). Unknown names stay visible, not editable here.
        const repoGroup = el('span', 'tickets-head-checks');
        repoGroup.title = 'Work repositories — the first checked one is the primary';
        repoGroup.setAttribute('aria-label', 'Repositories');
        const current = new Set(meta.repos);
        for (const ref of snapshot?.repos ?? []) {
          const wrap = el('label', 'tickets-head-check');
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.value = ref.name;
          input.checked = current.has(ref.name);
          input.addEventListener('change', () => {
            const checked = Array.from(repoGroup.querySelectorAll<HTMLInputElement>('input:checked')).map((i) => i.value);
            void apply({ repos: checked });
          });
          wrap.append(input, el('span', undefined, ref.name));
          repoGroup.append(wrap);
        }
        for (const name of meta.repos) {
          if (snapshot?.repos.some((r) => r.name === name) !== true) {
            repoGroup.append(el('span', 'tickets-head-chip', `${name} (unknown)`));
          }
        }
        chips.append(repoGroup);

        const workerOptions: (readonly [string, string])[] = [
          ['', `Default worker (${snapshot?.defaultWorker ?? 'board'})`],
          ...deps.workers,
        ];
        if (meta.worker !== null && !deps.workers.some(([value]) => value === meta.worker)) {
          workerOptions.push([meta.worker, meta.worker]);
        }
        chips.append(select('Worker', workerOptions, meta.worker ?? '', 'worker'));
      }

      if (id !== '') {
        const branch = el('span', 'tickets-head-chip tickets-head-branch', branchForTicket(id));
        branch.title = 'Work branch';
        chips.append(branch);
      }

      // The one-click dialog (req-65, req-72): offered where the column
      // offers it — plan on the first automatic column, refine in every
      // manual column. A refused start (a live run, no repo) surfaces in
      // the board's status bar like any action.
      const card = snapshot?.columns.flatMap((c) => c.tickets).find((t) => t.path === path);
      const mode = snapshot !== null && phaseId !== null ? interactiveModeFor(phaseId, snapshot.columns) : null;
      if (card !== undefined && mode !== null) {
        const dialog = el('button', 'tickets-head-dialog', mode === 'plan' ? 'Plan with agent' : 'Refine with agent');
        dialog.type = 'button';
        dialog.title =
          mode === 'plan'
            ? 'Plan this ticket in a dialog with a fleet worker — the ticket and the dialog open side by side'
            : 'Refine this ticket in a dialog with a fleet worker — the ticket and the dialog open side by side';
        dialog.addEventListener('click', () => deps.startInteractive(card, mode));
        chips.append(dialog);
      }

      const issues = model?.issues ?? [];
      if (issues.length > 0) {
        const worst = issues.some((i) => i.level === 'error')
          ? 'error'
          : issues.some((i) => i.level === 'warning')
            ? 'warning'
            : 'noise';
        const badge = el('span', `tickets-issues tickets-issues-${worst}`, String(issues.length));
        badge.title = issues.map((i) => `[${i.level}] ${i.message}`).join('\n');
        chips.append(badge);
      }

      chips.append(el('span', 'tickets-head-spacer'));
      const raw = el('button', 'icon-btn tickets-head-raw');
      raw.type = 'button';
      raw.title = 'Edit the frontmatter as YAML';
      raw.setAttribute('aria-label', 'Edit the frontmatter as YAML');
      raw.append(deps.api.ui.icon('code', 13));
      raw.addEventListener('click', () => input.expandRaw());
      chips.append(raw);

      if (document.activeElement !== title) {
        title.value = meta?.title ?? '';
      }
    }

    // The headline commits on Enter or when it is left; Escape restores it.
    title.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        title.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        title.value = model?.meta.title ?? '';
        input.view.focus();
      }
    });
    title.addEventListener('blur', () => {
      const typed = title.value.replace(/\s+/g, ' ').trim();
      if (typed === '' || typed === (model?.meta.title ?? '')) {
        title.value = model?.meta.title ?? '';
        return;
      }
      void apply({ title: typed });
    });

    paint();
    const entry = { node: root, paint };
    live.add(entry);
    return root;
  }

  return {
    view,
    repaint: () => {
      for (const entry of [...live]) {
        if (entry.node.isConnected) {
          entry.paint();
        } else {
          live.delete(entry);
        }
      }
    },
  };
}

/**
 * The Log fold: the first time a ticket shows in this session its `## Log`
 * section folds (a long log buries Description and Plan); the owner opens
 * it with the fold marker and it stays as they left it.
 */
export function ticketLogFold(
  api: DreyPluginApi,
  snapshot: () => BoardSnapshot | null,
): (context: EditorSurfaceContext) => unknown {
  const folded = new Set<string>();
  const { ViewPlugin } = api.editor.cm.view;
  const { foldEffect } = api.editor.cm.language;
  return (context) =>
    ViewPlugin.define((view) => {
      const consider = (): void => {
        if (!showsTicket(snapshot(), context) || view.state.doc.length === 0) {
          return;
        }
        const path = context.path() ?? '';
        const key = `${context.vaultId() ?? ''}:${path}`;
        if (folded.has(key)) {
          return;
        }
        // On a tab switch the text and the path arrive one after the other:
        // fold only when the text is this ticket's.
        const text = view.state.doc.toString();
        const id = /^id:\s*['"]?(T-\d{4,})/m.exec(text)?.[1];
        const range = logSectionRange(text);
        if (range === null || id === undefined || !path.endsWith(`/${id}.md`)) {
          return;
        }
        folded.add(key);
        // Not inside an update: dispatch on the next tick.
        queueMicrotask(() => view.dispatch({ effects: foldEffect.of(range) }));
      };
      consider();
      // Every update, not only text changes: the path can arrive after the
      // text (the surface then nudges the editor with an empty transaction).
      return { update: () => consider() };
    });
}
