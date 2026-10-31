/**
 * The iPad board (req-66 R6): every column side by side, scrolling
 * sideways, and — on a landscape-wide screen — the selected ticket in a
 * detail pane beside it. A card is moved by pressing and holding it,
 * then dragging across columns — a transition (the order inside a
 * column is derived, req-74 dropped the pins). A tap selects. The Move… sheet stays for anyone who would rather not drag.
 */
import { ageOf, parseHandover, type BoardColumn, type TicketCard } from '../shared/tickets';
import type { Ctx, View } from './context';
import { chip, empty, h, present } from './dom';
import { dropActionOf, dropIndexOf, isBusy } from './model';
import { columnSheet } from './runs-views';
import { beginGesture, cardChips, endGesture, prioClass, ticketView, type TicketTab } from './views';

const HOLD_MS = 350;
const SLOP_PX = 8;
const EDGE_PX = 60;

/** The board's sideways scroll survives redraws. */
let rememberedScroll = 0;
/** A newly selected ticket is scrolled into view once, not on every redraw. */
let lastSelected: string | null = null;

export function kanbanView(ctx: Ctx, selected: string | null, tab: TicketTab, withDetail: boolean): View {
  const board = ctx.state.board;
  if (board === null) {
    return { title: 'Board', body: [empty('Loading…')] };
  }
  if (board.columns.length === 0) {
    return { title: 'Board', body: [empty(board.pipelineError ?? 'No tickets vault on the desk.')] };
  }
  const strip = h('div', { class: 'kanban', attrs: { role: 'list', 'aria-label': 'Columns' } }, ...board.columns.map((c) => kanbanColumn(ctx, c, selected)));
  strip.addEventListener('scroll', () => {
    rememberedScroll = strip.scrollLeft;
  });
  const reveal = selected !== null && selected !== lastSelected;
  lastSelected = selected;
  requestAnimationFrame(() => {
    strip.scrollLeft = rememberedScroll;
    if (reveal) {
      strip.querySelector('.kcard.selected')?.scrollIntoView({ inline: 'center', block: 'nearest' });
    }
  });
  if (!ctx.state.readOnly) {
    attachDrag(ctx, strip);
  }

  if (!withDetail) {
    return { title: 'Board', body: [strip], wide: true };
  }
  const detail = selected === null ? null : ticketView(ctx, selected, tab);
  const pane = h(
    'aside',
    { class: 'detail', attrs: { 'aria-label': 'Ticket' } },
    ...(detail === null ? [empty('Select a ticket.')] : [...detail.body, ...present([detail.actions ?? null])]),
  );
  return { title: 'Board', body: [h('div', { class: 'split' }, strip, pane)], wide: true };
}

function kanbanColumn(ctx: Ctx, column: BoardColumn, selected: string | null): HTMLElement {
  const board = ctx.state.board!;
  const mode = ctx.state.fleet?.chain?.columns[column.phase.id];
  const agent = parseHandover(column.phase.handover).mode === 'agent';
  const head = h(
    'div',
    { class: 'kcol-head' },
    h('span', { class: 'kcol-title', text: column.phase.title }),
    h('span', { class: 'small', text: column.phase.wip !== null ? `${column.tickets.length}/${column.phase.wip}` : String(column.tickets.length) }),
    board.checkpoints.includes(column.phase.id)
      ? chip('Checkpoint')
      : mode !== undefined || agent
        ? h('button', {
            class: `chip chip-btn ${mode === 'held' ? 'chip-warn' : 'chip-ok'}`,
            text: mode === 'held' ? 'Held' : 'Playing',
            attrs: { type: 'button', 'aria-label': `${column.phase.title}: ${mode === 'held' ? 'held' : 'playing'}`, ...(ctx.state.readOnly ? { disabled: '' } : {}) },
            on: { click: () => columnSheet(ctx, column.phase.id, column.phase.title) },
          })
        : null,
  );
  const list = h(
    'div',
    { class: 'kcol-list', attrs: { 'data-phase': column.phase.id } },
    ...column.tickets.map((card) => kanbanCard(ctx, column, card, card.id === selected)),
  );
  return h('section', { class: `kcol${column.unknown ? ' unknown' : ''}`, attrs: { role: 'listitem', 'aria-label': column.phase.title } }, head, list);
}

function kanbanCard(ctx: Ctx, column: BoardColumn, card: TicketCard, selected: boolean): HTMLElement {
  const node = h(
    'div',
    {
      class: `card kcard${selected ? ' selected' : ''}`,
      attrs: { role: 'button', tabindex: '0', 'data-id': card.id, 'data-phase': column.phase.id, 'aria-label': `${card.id} ${card.meta.title ?? ''}` },
    },
    h('span', { class: prioClass(card.meta.priority) }),
    h(
      'span',
      { class: 'card-main' },
      h('span', { class: 'row wrap' }, h('span', { class: 'id', text: card.id }), ...cardChips(ctx, card)),
      h('span', { class: 'title', text: card.meta.title ?? card.id }),
      h('span', { class: 'small', text: present([card.meta.repo, ageOf(card.meta.entered[column.phase.id] ?? null)]).join(' · ') }),
    ),
  );
  if (isBusy(card, ctx.state.fleet?.runs ?? [])) {
    node.dataset['busy'] = '1';
  }
  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      ctx.go(`#ticket/${card.id}`);
    }
  });
  return node;
}

/**
 * Press-and-hold drag over the whole strip (one listener set): a hold
 * without movement lifts the card; moving first is a scroll and cancels.
 * While lifted, a non-passive touchmove keeps Safari from scrolling, the
 * strip scrolls itself near its edges, and a marker shows the landing.
 */
function attachDrag(ctx: Ctx, strip: HTMLElement): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number; id: number } | null = null;
  let card: HTMLElement | null = null;
  let ghost: HTMLElement | null = null;
  let marker: HTMLElement | null = null;
  let target: { phase: string; index: number } | null = null;
  let pointer = { x: 0, y: 0 };
  let raf = 0;
  /** A finger is down on a card: no redraw may replace the strip under it. */
  let holding = false;

  const blockScroll = (e: TouchEvent): void => {
    if (ghost !== null) {
      e.preventDefault();
    }
  };

  const reset = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    cancelAnimationFrame(raf);
    ghost?.remove();
    marker?.remove();
    card?.classList.remove('placeholder');
    if (ghost !== null) {
      document.removeEventListener('touchmove', blockScroll);
    }
    if (holding) {
      holding = false;
      endGesture();
    }
    ghost = null;
    marker = null;
    card = null;
    start = null;
    target = null;
  };

  const lift = (): void => {
    if (card === null || start === null) {
      return;
    }
    document.addEventListener('touchmove', blockScroll, { passive: false });
    try {
      strip.setPointerCapture(start.id);
    } catch {
      // the pointer is already gone; the next pointerup/cancel resets
    }
    const rect = card.getBoundingClientRect();
    ghost = card.cloneNode(true) as HTMLElement;
    ghost.classList.add('ghost');
    ghost.style.width = `${rect.width}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.top = `${rect.top}px`;
    ghost.dataset['dx'] = String(start.x - rect.left);
    ghost.dataset['dy'] = String(start.y - rect.top);
    document.body.append(ghost);
    card.classList.add('placeholder');
    marker = h('div', { class: 'drop-marker' });
    navigator.vibrate?.(10);
    follow();
  };

  const follow = (): void => {
    if (ghost === null || card === null) {
      return;
    }
    ghost.style.left = `${pointer.x - Number(ghost.dataset['dx'])}px`;
    ghost.style.top = `${pointer.y - Number(ghost.dataset['dy'])}px`;
    const bounds = strip.getBoundingClientRect();
    if (pointer.x < bounds.left + EDGE_PX) {
      strip.scrollLeft -= 12;
    } else if (pointer.x > bounds.right - EDGE_PX) {
      strip.scrollLeft += 12;
    }
    const under = document.elementFromPoint(pointer.x, pointer.y);
    const list = under?.closest<HTMLElement>('.kcol-list') ?? under?.closest('.kcol')?.querySelector<HTMLElement>('.kcol-list') ?? null;
    if (list !== null && marker !== null) {
      const others = Array.from(list.querySelectorAll<HTMLElement>('.kcard')).filter((c) => c !== card);
      const index = dropIndexOf(others.map((c) => {
        const r = c.getBoundingClientRect();
        return r.top + r.height / 2;
      }), pointer.y);
      target = { phase: list.dataset['phase'] ?? '', index };
      const before = others[index] ?? null;
      list.insertBefore(marker, before);
      const lr = list.getBoundingClientRect();
      if (pointer.y > lr.bottom - EDGE_PX) {
        list.scrollTop += 10;
      } else if (pointer.y < lr.top + EDGE_PX) {
        list.scrollTop -= 10;
      }
    }
    raf = requestAnimationFrame(follow);
  };

  strip.addEventListener('pointerdown', (e) => {
    const hit = (e.target as HTMLElement).closest<HTMLElement>('.kcard');
    if (hit === null || e.button !== 0) {
      return;
    }
    reset();
    holding = true;
    beginGesture();
    card = hit;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    pointer = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      timer = null;
      lift();
    }, HOLD_MS);
  });

  strip.addEventListener('pointermove', (e) => {
    if (start === null || e.pointerId !== start.id) {
      return;
    }
    pointer = { x: e.clientX, y: e.clientY };
    if (ghost === null && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP_PX) {
      // Moving before the hold is a scroll, not a drag.
      reset();
    }
  });

  strip.addEventListener('pointerup', (e) => {
    if (start === null || e.pointerId !== start.id) {
      return;
    }
    if (ghost === null) {
      const id = card?.dataset['id'];
      reset();
      if (id !== undefined) {
        ctx.go(`#ticket/${id}`);
      }
      return;
    }
    const from = card!.dataset['phase']!;
    const id = card!.dataset['id']!;
    const landing = target;
    reset();
    if (landing === null) {
      return;
    }
    const action = dropActionOf(from, landing.phase);
    if (action === null) {
      return;
    }
    const title = ctx.state.board?.columns.find((c) => c.phase.id === landing.phase)?.phase.title ?? landing.phase;
    void ctx.act(ctx.api.post(`/api/tickets/${id}/move`, { from: action.from, to: action.to }), `${id} → ${title}`);
  });

  strip.addEventListener('pointercancel', () => reset());
  strip.addEventListener('contextmenu', (e) => e.preventDefault());
}
