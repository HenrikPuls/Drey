/**
 * The phone client's screens (req-66, ADR-0084): Needs you, the board
 * one column at a time, a ticket, the Move sheet, Capture and pairing.
 * Each view draws from the app state and calls back through `Ctx`; the
 * rules behind the buttons live in `model.ts` and on the desk.
 */
import type { FleetSnapshot } from '../main/fleet-client';
import type { NeedKind } from '../shared/remote-protocol';
import {
  ageOf,
  parseHandover,
  TICKET_PRIORITIES,
  type BoardColumn,
  type BoardSnapshot,
  type CreateResult,
  type TicketCard,
  type TicketPriority,
} from '../shared/tickets';
import type { Ctx, View } from './context';
import { armedButton, button, chip, empty, h, icon, present, sheet, toast } from './dom';
import {
  blocksOf,
  claimActionOf,
  commitLineOf,
  isBusy,
  latestRunOf,
  liveRunOf,
  nextColumnOf,
  placeOf,
  primaryActionOf,
  refineKeyOf,
  sectionsOf,
  swipeCommits,
  type Block,
} from './model';
import { columnSheet, masterSheet, waitActions } from './runs-views';

const runs = (ctx: Ctx): NonNullable<FleetSnapshot['runs']> => ctx.state.fleet?.runs ?? [];

// --- shared pieces ----------------------------------------------------------

export function prioClass(priority: TicketPriority): string {
  return `prio prio-${priority}`;
}

/** The header's fleet state; a tap opens the master switch. */
export function fleetChip(ctx: Ctx): HTMLElement {
  const { fleet, connected } = ctx.state;
  let label: string;
  let kind: string;
  if (!connected) {
    [label, kind] = ['Offline', 'chip-bad'];
  } else if ((fleet?.chain ?? null) === null) {
    [label, kind] = ['Runner off', ''];
  } else {
    const live = (fleet?.runs ?? []).filter((r) => ['starting', 'running', 'stopping', 'detached'].includes(r.state)).length;
    [label, kind] = fleet!.chain!.master === 'run' ? [live > 0 ? `Running · ${live} live` : 'Running', 'chip-ok'] : ['Halted', 'chip-warn'];
  }
  const canSwitch = connected && (fleet?.chain ?? null) !== null && !ctx.state.readOnly;
  return h('button', {
    class: `chip ${kind} chip-btn`.trim(),
    text: label,
    attrs: { type: 'button', 'aria-label': `Fleet: ${label}`, ...(canSwitch ? {} : { disabled: '' }) },
    on: { click: () => masterSheet(ctx) },
  });
}

// --- Needs you --------------------------------------------------------------

const NEED_LABEL: Readonly<Record<NeedKind, string>> = {
  question: 'Asks you',
  permission: 'Wants permission',
  'red-gate': 'Gate red',
  failed: 'Run failed',
  checkpoint: '',
};

export function needsView(ctx: Ctx): View {
  const { needs, board } = ctx.state;
  const phaseTitle = (id: string): string => board?.columns.find((c) => c.phase.id === id)?.phase.title ?? id;
  const waits = needs.filter((n) => n.kind !== 'checkpoint');
  const checkpoints = needs.filter((n) => n.kind === 'checkpoint');
  const body: Node[] = [];
  if (needs.length === 0) {
    body.push(empty('Nothing waits on you.'));
  }
  if (waits.length > 0) {
    body.push(
      h('h2', { class: 'sect', text: 'Waiting on you' }),
      ...waits.map((n) =>
        h(
          'div',
          { class: `need need-${n.kind}` },
          h(
            'button',
            { class: 'need-head', attrs: { type: 'button' }, on: { click: () => ctx.go(n.runId !== null ? `#run/${n.runId}` : `#ticket/${n.ticketId}`) } },
            h(
              'span',
              { class: 'row' },
              h('span', { class: 'id', text: n.ticketId }),
              chip(phaseTitle(n.phase)),
              h('span', { class: 'need-kind', text: `${NEED_LABEL[n.kind]}${n.since !== null ? ` · ${ageOf(n.since)}` : ''}` }),
            ),
            h('span', { class: 'title', text: n.title }),
            n.text !== '' ? h('span', { class: 'need-text', text: n.text }) : null,
          ),
          (n.kind === 'question' || n.kind === 'permission') && n.runId !== null
            ? waitActions(ctx, { runId: n.runId, kind: n.kind, text: n.text, ...(n.questions !== undefined ? { questions: n.questions } : {}) })
            : null,
        ),
      ),
    );
  }
  if (checkpoints.length > 0) {
    body.push(
      h('h2', { class: 'sect', text: 'Your checkpoints' }),
      ...checkpoints.map((n) =>
        h(
          'button',
          { class: 'listrow', attrs: { type: 'button' }, on: { click: () => ctx.go(`#ticket/${n.ticketId}`) } },
          h('span', { class: 'id', text: n.ticketId }),
          h('span', { class: 'grow', text: n.title }),
          chip(phaseTitle(n.phase)),
          h('span', { class: 'chev', text: '›' }),
        ),
      ),
    );
  }
  return { title: 'Needs you', body };
}

// --- Board ------------------------------------------------------------------

let gestures = 0;

/** A swipe is under a finger: a redraw now would pull the card away from it. */
export function gestureInProgress(): boolean {
  return gestures > 0;
}

/** A drag elsewhere (the iPad kanban) holds redraws the same way a swipe does. */
export function beginGesture(): void {
  gestures++;
}

export function endGesture(): void {
  gestures = Math.max(0, gestures - 1);
}

const PHASE_KEY = 'drey.remote.phase';

function selectedPhase(board: BoardSnapshot, hashPhase: string | null): BoardColumn | null {
  let wanted = hashPhase;
  if (wanted === null) {
    try {
      wanted = localStorage.getItem(PHASE_KEY);
    } catch {
      wanted = null;
    }
  }
  return board.columns.find((c) => c.phase.id === wanted) ?? board.columns[0] ?? null;
}

export function boardView(ctx: Ctx, hashPhase: string | null): View {
  const board = ctx.state.board;
  if (board === null) {
    return { title: 'Board', body: [empty('Loading…')] };
  }
  if (board.columns.length === 0) {
    return { title: 'Board', body: [empty(board.pipelineError ?? 'No tickets vault on the desk.')] };
  }
  const column = selectedPhase(board, hashPhase)!;
  try {
    localStorage.setItem(PHASE_KEY, column.phase.id);
  } catch {
    // the choice is only a convenience
  }
  const chips = h(
    'div',
    { class: 'chipbar', attrs: { role: 'tablist', 'aria-label': 'Columns' } },
    ...board.columns.map((c) => {
      const on = c.phase.id === column.phase.id;
      const node = h(
        'button',
        {
          class: `pchip${on ? ' on' : ''}${c.unknown ? ' unknown' : ''}`,
          attrs: { type: 'button', role: 'tab', 'aria-selected': String(on) },
          on: { click: () => ctx.go(`#board/${c.phase.id}`) },
        },
        c.phase.title,
        h('b', { text: String(c.tickets.length) }),
      );
      return node;
    }),
  );
  // Keep the chosen chip in view after a redraw.
  requestAnimationFrame(() => chips.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' }));

  const mode = ctx.state.fleet?.chain?.columns[column.phase.id];
  const wip = column.phase.wip;
  const head = h(
    'div',
    { class: 'colhead' },
    h('span', { text: wip !== null ? `WIP ${column.tickets.length} / ${wip}` : `${column.tickets.length} tickets` }),
    board.checkpoints.includes(column.phase.id)
      ? chip('Checkpoint')
      : mode !== undefined || parseHandover(column.phase.handover).mode === 'agent'
        ? h('button', {
            class: `chip chip-btn ${mode === 'held' ? 'chip-warn' : 'chip-ok'}`,
            text: mode === 'held' ? 'Held' : 'Playing',
            attrs: { type: 'button', 'aria-label': `${column.phase.title}: ${mode === 'held' ? 'held' : 'playing'}`, ...(ctx.state.readOnly ? { disabled: '' } : {}) },
            on: { click: () => columnSheet(ctx, column.phase.id, column.phase.title) },
          })
        : null,
  );
  const next = nextColumnOf(board, column.phase.id);
  const cards = column.tickets.map((card) => boardCard(ctx, column, next, card));
  return {
    title: 'Board',
    body: present<Node>([
      chips,
      head,
      ...(cards.length === 0 ? [empty('No tickets in this column.')] : cards),
      next !== null && cards.length > 0 && !ctx.state.readOnly
        ? h('p', { class: 'hint', text: `Swipe a card left to move it to ${next.phase.title}.` })
        : null,
    ]),
  };
}

export function cardChips(ctx: Ctx, card: TicketCard): HTMLElement[] {
  const out: HTMLElement[] = [];
  const live = liveRunOf(card.id, runs(ctx));
  const latest = latestRunOf(card.id, runs(ctx));
  if (live !== null) {
    out.push(chip(live.waiting ? 'waiting' : live.state === 'running' ? 'running' : live.state, 'chip-acc'));
  } else if (latest !== null && (latest.gateResult === 'red' || latest.gateFailure !== null)) {
    out.push(chip('gate red', 'chip-bad'));
  }
  if (card.blocked.length > 0) {
    out.push(chip(`blocked by ${card.blocked.join(', ')}`, 'chip-warn'));
  }
  if (card.meta.claimedBy !== null) {
    out.push(chip(card.meta.claimedBy));
  }
  if (card.issues.some((i) => i.level === 'error')) {
    out.push(chip('issue', 'chip-bad'));
  }
  return out;
}

function boardCard(ctx: Ctx, column: BoardColumn, next: BoardColumn | null, card: TicketCard): HTMLElement {
  const inner = h(
    'div',
    { class: 'card' },
    h('span', { class: prioClass(card.meta.priority) }),
    h(
      'span',
      { class: 'card-main' },
      h('span', { class: 'row' }, h('span', { class: 'id', text: card.id }), ...cardChips(ctx, card)),
      h('span', { class: 'title', text: card.meta.title ?? card.id }),
      h('span', {
        class: 'small',
        text: [card.meta.repo, card.worker, ageOf(card.meta.entered[column.phase.id] ?? null)].filter((x) => x).join(' · '),
      }),
    ),
  );
  const canSwipe = next !== null && !ctx.state.readOnly && !isBusy(card, runs(ctx));
  const wrap = h(
    'div',
    { class: 'swipe', attrs: { role: 'button', tabindex: '0', 'aria-label': `${card.id} ${card.meta.title ?? ''}` } },
    canSwipe ? h('span', { class: 'swipe-act', text: `→ ${next.phase.title}` }) : null,
    inner,
  );
  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      ctx.go(`#ticket/${card.id}`);
    }
  });
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dragging = false;
  let tracking = false;
  wrap.addEventListener('pointerdown', (e) => {
    tracking = true;
    dragging = false;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!tracking || !canSwipe) {
      return;
    }
    dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      dragging = true;
      gestures++;
      wrap.setPointerCapture(e.pointerId);
    }
    if (dragging) {
      inner.style.transform = `translateX(${Math.min(0, dx)}px)`;
      wrap.classList.toggle('armed', swipeCommits(dx, dy, wrap.clientWidth));
    }
  });
  const end = (e: PointerEvent): void => {
    if (!tracking) {
      return;
    }
    tracking = false;
    const dy = e.clientY - startY;
    if (dragging) {
      dragging = false;
      gestures = Math.max(0, gestures - 1);
      if (canSwipe && swipeCommits(dx, dy, wrap.clientWidth)) {
        inner.style.transform = 'translateX(-100%)';
        void ctx
          .act(
            ctx.api.post(`/api/tickets/${card.id}/move`, { from: column.phase.id, to: next.phase.id }),
            `${card.id} → ${next.phase.title}`,
          )
          .then((ok) => {
            if (!ok) {
              inner.style.transform = '';
            }
          });
      } else {
        inner.style.transform = '';
      }
      wrap.classList.remove('armed');
      return;
    }
    if (Math.abs(e.clientX - startX) < 8 && Math.abs(dy) < 8) {
      ctx.go(`#ticket/${card.id}`);
    }
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', () => {
    if (dragging) {
      gestures = Math.max(0, gestures - 1);
    }
    tracking = false;
    dragging = false;
    inner.style.transform = '';
    wrap.classList.remove('armed');
  });
  return wrap;
}

// --- Ticket -----------------------------------------------------------------

export type TicketTab = 'ticket' | 'log';

export function ticketView(ctx: Ctx, id: string, tab: TicketTab): View {
  const board = ctx.state.board;
  const placed = board === null ? null : placeOf(board, id);
  if (board === null || placed === null) {
    return { title: id, back: '#board', body: [empty(board === null ? 'Loading…' : `${id} is not on the board any more.`)] };
  }
  const { column, card } = placed;
  const reply = ctx.state.ticket;
  const text = reply !== null && reply.ok && reply.card.id === id ? reply.text : null;

  const chips = h(
    'div',
    { class: 'row wrap' },
    chip(card.meta.priority, `chip-prio-${card.meta.priority}`),
    chip(column.phase.title),
    card.meta.repo !== null ? chip(card.meta.repo) : null,
    chip(card.meta.claimedBy ?? 'unclaimed'),
    ...cardChips(ctx, card).filter((c) => c.textContent !== card.meta.claimedBy),
  );
  const tabs = h(
    'div',
    { class: 'seg', attrs: { role: 'tablist' } },
    ...(['ticket', 'log'] as const).map((t) =>
      h('button', {
        class: t === tab ? 'on' : '',
        text: t === 'ticket' ? 'Ticket' : 'Log',
        attrs: { type: 'button', role: 'tab', 'aria-selected': String(t === tab) },
        on: { click: () => ctx.go(`#ticket/${id}${t === 'log' ? '/log' : ''}`) },
      }),
    ),
    ...present([latestRunOf(card.id, runs(ctx))]).map((run) =>
      h('button', {
        text: 'Run',
        attrs: { type: 'button', role: 'tab', 'aria-selected': 'false' },
        on: { click: () => ctx.go(`#run/${run.id}`) },
      }),
    ),
  );
  const canRefine = !ctx.state.readOnly && !isBusy(card, runs(ctx));
  const content: Node[] = [];
  if (text === null) {
    content.push(empty(reply !== null && !reply.ok ? reply.error : 'Loading…'));
  } else {
    const sections = sectionsOf(text);
    const shown = sections.filter((s) => (tab === 'log' ? s.title === 'Log' : s.title !== 'Log'));
    if (shown.length === 0) {
      content.push(empty(tab === 'log' ? 'No Log yet.' : 'The ticket has no text yet.'));
    }
    if (tab === 'ticket' && canRefine) {
      const present_ = new Set(sections.map((s) => refineKeyOf(s.title)));
      const missing = (['description', 'plan', 'acceptance'] as const).filter((k) => !present_.has(k));
      if (missing.length > 0) {
        content.push(
          h('div', { class: 'row wrap add-sections' }, ...missing.map((k) => h('a', { class: 'chip chip-btn', text: `+ ${k === 'acceptance' ? 'Acceptance criteria' : k[0]!.toUpperCase() + k.slice(1)}`, attrs: { href: `#refine/${id}/${k}` } }))),
        );
      }
    }
    for (const section of shown) {
      if (tab === 'ticket' && section.title !== '') {
        const key = refineKeyOf(section.title);
        content.push(
          h(
            section.level <= 2 ? 'h3' : 'h4',
            { class: 'md-h' },
            h('span', { text: section.title }),
            key !== null && canRefine ? h('a', { class: 'edit', text: 'Edit', attrs: { href: `#refine/${id}/${key}`, 'aria-label': `Edit ${section.title}` } }) : null,
          ),
        );
      }
      content.push(...blocksOf(section.lines).map((b) => blockNode(b, tab === 'log')));
    }
  }
  const issues = card.issues.filter((i) => i.level !== 'noise');
  return {
    title: card.id,
    back: `#board/${column.phase.id}`,
    body: [
      h('h1', { class: 'ticket-title', text: card.meta.title ?? card.id }),
      chips,
      ...issues.map((i) => h('p', { class: `issue issue-${i.level}`, text: i.message })),
      tabs,
      h('div', { class: 'md' }, ...content),
    ],
    actions: ctx.state.readOnly ? null : ticketActions(ctx, board, column, card),
  };
}

function blockNode(block: Block, log: boolean): HTMLElement {
  switch (block.kind) {
    case 'code':
      return h('pre', { class: 'code', text: block.text });
    case 'li':
      return h(
        'div',
        { class: `li${log ? ' li-log' : ''}` },
        block.checked === null ? h('span', { class: 'bullet', text: log ? '' : '•' }) : h('span', { class: `box${block.checked ? ' done' : ''}` }),
        h('span', { text: block.text }),
      );
    default:
      return h('p', { text: block.text });
  }
}

function ticketActions(ctx: Ctx, board: BoardSnapshot, column: BoardColumn, card: TicketCard): HTMLElement {
  const primary = primaryActionOf(board, column.phase.id, card, runs(ctx));
  const bar = h('div', { class: 'actionbar' });
  if (primary !== null) {
    const run = (): void => {
      if (primary.kind === 'run') {
        void ctx.act(ctx.api.post('/api/runs', { id: card.id }), `Run started for ${card.id}`);
      } else if (primary.kind === 'approve' || primary.kind === 'move') {
        void ctx.act(ctx.api.post(`/api/tickets/${card.id}/move`, { from: column.phase.id, to: primary.to }), `${card.id} moved`);
      }
    };
    const node = button(primary.label, run, 'btn btn-primary grow');
    node.disabled = primary.kind === 'busy';
    bar.append(node);
  }
  bar.append(
    button('Move…', () => moveSheet(ctx, board, column, card), 'btn'),
    h(
      'button',
      { class: 'btn btn-icon', attrs: { type: 'button', 'aria-label': 'More actions', title: 'More actions' }, on: { click: () => moreSheet(ctx, card) } },
      icon('more', 20),
    ),
  );
  return bar;
}

function moveSheet(ctx: Ctx, board: BoardSnapshot, column: BoardColumn, card: TicketCard): void {
  const next = nextColumnOf(board, column.phase.id);
  const live = isBusy(card, runs(ctx));
  const commit = h('div', { class: 'commit', text: next !== null ? commitLineOf(card.id, column.phase.id, next.phase.id) : '' });
  const close = sheet(`Move ${card.id}`, present<Node>([
    h(
      'div',
      { class: 'phases' },
      ...board.columns
        .filter((c) => !c.unknown)
        .map((c, i) => {
          const current = c.phase.id === column.phase.id;
          const node = h(
            'button',
            {
              class: `phase${current ? ' cur' : ''}${next !== null && c.phase.id === next.phase.id ? ' next' : ''}`,
              attrs: { type: 'button' },
              on: {
                click: () => {
                  close();
                  void ctx.act(
                    ctx.api.post(`/api/tickets/${card.id}/move`, { from: column.phase.id, to: c.phase.id }),
                    `${card.id} → ${c.phase.title}`,
                  );
                },
              },
            },
            h('span', { class: 'n', text: String((i + 1) * 10) }),
            h('span', { class: 'grow', text: c.phase.title }),
            current ? h('span', { class: 'small', text: 'current' }) : next !== null && c.phase.id === next.phase.id ? h('span', { class: 'small', text: 'next' }) : null,
          );
          node.disabled = current;
          return node;
        }),
    ),
    live ? h('p', { class: 'banner', text: 'A run is live on this ticket.' }) : null,
    card.blocked.length > 0 ? h('p', { class: 'banner', text: `Blocked by ${card.blocked.join(', ')} — the move still goes through.` }) : null,
    commit,
  ]));
}

function moreSheet(ctx: Ctx, card: TicketCard): void {
  const claim = claimActionOf(card, ctx.state.actor);
  const close = sheet(card.id, [
    h(
      'div',
      { class: 'stack' },
      button(
        claim === 'release' ? 'Release claim' : card.meta.claimedBy !== null ? `Take over from ${card.meta.claimedBy}` : 'Claim',
        () => {
          close();
          void ctx.act(ctx.api.post(`/api/tickets/${card.id}/claim`, { mode: claim }), claim === 'release' ? 'Claim released' : 'Claim taken over');
        },
      ),
      button('Refine title, priority, repository', () => {
        close();
        ctx.go(`#refine/${card.id}/header`);
      }),
      armedButton('Archive', 'Tap again to archive', () => {
        close();
        void ctx.act(ctx.api.post(`/api/tickets/${card.id}/archive`), `${card.id} archived`).then((ok) => {
          if (ok) {
            ctx.go('#board');
          }
        });
      }),
    ),
  ]);
}

// --- Capture ----------------------------------------------------------------

export function captureView(ctx: Ctx): View {
  const board = ctx.state.board;
  const title = h('input', { attrs: { id: 'cap-title', type: 'text', autocomplete: 'off', enterkeyhint: 'next', 'aria-label': 'Title' } });
  let priority: TicketPriority = 'normal';
  const prio = h(
    'div',
    { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': 'Priority' } },
    ...TICKET_PRIORITIES.map((p) => {
      const node = h('button', {
        class: p === priority ? 'on' : '',
        text: p,
        attrs: { type: 'button', role: 'radio', 'aria-checked': String(p === priority) },
      });
      node.addEventListener('click', () => {
        priority = p;
        prio.querySelectorAll('button').forEach((b) => {
          b.classList.toggle('on', b === node);
          b.setAttribute('aria-checked', String(b === node));
        });
      });
      return node;
    }),
  );
  const repo = h(
    'select',
    { attrs: { id: 'cap-repo', 'aria-label': 'Repository' } },
    h('option', { text: 'No repository', attrs: { value: '' } }),
    ...(board?.repos ?? []).map((r) => h('option', { text: r.name, attrs: { value: r.name } })),
  );
  const description = h('textarea', { attrs: { id: 'cap-desc', rows: '6', 'aria-label': 'Description' } });
  const create = button(
    'Create in Inbox',
    () => {
      if (title.value.trim() === '') {
        toast('Give the ticket a title.', 'error');
        title.focus();
        return;
      }
      create.disabled = true;
      ctx.api
        .post<CreateResult>('/api/tickets', { title: title.value, priority, repo: repo.value, description: description.value })
        .then((result) => {
          create.disabled = false;
          if (result.ok && result.id !== undefined) {
            toast(`Created ${result.id}`);
            ctx.go(`#ticket/${result.id}`);
          } else {
            toast(result.error ?? 'The ticket was not created.', 'error');
          }
        })
        .catch((error: unknown) => {
          create.disabled = false;
          toast(error instanceof Error ? error.message : String(error), 'error');
        });
    },
    'btn btn-primary',
  );
  return {
    title: 'Capture',
    body: [
      h('form', { class: 'form', on: { submit: (e) => e.preventDefault() } },
        h('label', { text: 'Title', attrs: { for: 'cap-title' } }),
        title,
        h('span', { class: 'label', text: 'Priority' }),
        prio,
        h('label', { text: 'Repository', attrs: { for: 'cap-repo' } }),
        repo,
        h('label', { text: 'Description', attrs: { for: 'cap-desc' } }),
        description,
      ),
    ],
    actions: ctx.state.readOnly ? h('div', { class: 'actionbar' }, h('p', { class: 'hint', text: 'This device is paired read only.' })) : h('div', { class: 'actionbar' }, create),
    form: true,
  };
}

// --- Pairing ----------------------------------------------------------------

export function pairView(onPair: (code: string) => void, message: string | null): View {
  const input = h('input', {
    attrs: { id: 'pair-code', type: 'text', autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Pairing code' },
  });
  const submit = (): void => onPair(input.value);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      submit();
    }
  });
  return {
    title: 'Drey Tickets',
    body: present<Node>([
      h('p', { text: 'Pair this device with the desk: scan the QR code under Settings → Tickets → Remote access, or type the code shown there.' }),
      message !== null ? h('p', { class: 'issue issue-error', text: message }) : null,
      h('form', { class: 'form', on: { submit: (e) => { e.preventDefault(); submit(); } } }, h('label', { text: 'Pairing code', attrs: { for: 'pair-code' } }), input),
    ]),
    actions: h('div', { class: 'actionbar' }, button('Pair', submit, 'btn btn-primary grow')),
  };
}
