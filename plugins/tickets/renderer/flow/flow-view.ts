/**
 * The Flow tab (E13-11, design boards 5i "Shape the flow" and 7a–7c): one
 * ticket's chain (or one plan part's) as a list of gates with `+`
 * connectors, an inspector for the selected gate (who, model, tell me,
 * runs after, remove), and a foot with "Ask Paul", reset and "Save flow".
 *
 * Nothing is written before "Save flow": the tab keeps a draft, and every
 * edit is a round trip to the engine (`flowEdit`) that returns the next
 * draft — the same grammar and guard the phone's editor goes through
 * (`core/flow-edit.ts`). This file is the DOM and the controller; the
 * wording and the rules about what may move are in `flow-model.ts`.
 */
import type { FlowOp } from '../../../../packages/tickets-engine/src/contracts/flow';
import type { DeskDeps } from '../desk-deps';
import { h, textButton } from '../desk-deps';
import {
  addablePhasesOf,
  changedIndicesOf,
  changesLabelOf,
  eyebrowOf,
  isDirty,
  marksOf,
  moveRoomOf,
  personasFor,
  runsAfterOf,
  whoOf,
  type FlowDraft,
  type FlowTarget,
} from './flow-model';

export type FlowDeps = Pick<DeskDeps, 'invoke' | 'subscribe' | 'titleOf'>;

interface FlowState {
  draft: FlowDraft | null;
  /** The flow as the file holds it; the dashed marks compare against it. */
  saved: FlowDraft | null;
  error: string;
  selected: number | null;
  adding: number | null;
  message: string;
  notice: string;
  busy: boolean;
  /** Paul's draft while it is the working draft: his reason and the draft before it. */
  paul: { readonly reason: string; readonly before: FlowDraft } | null;
}

type EditReply = { readonly ok: true; readonly [key: string]: unknown } | { readonly ok: false; readonly error: string };

/** Mounts the Flow tab for one target; returns the dispose. */
export function mountFlow(deps: FlowDeps, host: HTMLElement, target: FlowTarget): () => void {
  const state: FlowState = { draft: null, saved: null, error: '', selected: null, adding: null, message: '', notice: '', busy: false, paul: null };
  let disposed = false;
  const payload = { id: target.ticketId, part: target.part };

  const root = h('section', 'flow-tab');
  root.setAttribute('aria-label', 'Flow editor');
  const head = h('header', 'flow-head');
  const main = h('div', 'flow-main');
  const body = h('div', 'flow-body');
  const inspector = h('aside', 'flow-inspector');
  inspector.setAttribute('aria-label', 'Gate settings');
  main.append(body, inspector);
  const foot = h('footer', 'flow-foot');
  const messageLine = h('p', 'flow-message');
  messageLine.setAttribute('role', 'alert');
  const ask = h('input', 'flow-input');
  ask.type = 'text';
  ask.placeholder = 'Ask Paul to change this flow';
  ask.setAttribute('aria-label', 'Ask Paul to change this flow');
  const askButton = textButton('Ask Paul', 'desk-btn', 'Paul reads the ticket and drafts a flow; nothing is saved', () => void askPaul());
  const resetButton = textButton('Reset to standard flow', 'desk-btn desk-btn-link', 'Drop every change and run the standard flow', () => void run({ op: 'reset' }));
  const saveButton = textButton('Save flow', 'desk-btn desk-btn-primary', 'Write this flow to the ticket', () => void save());
  ask.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void askPaul();
    }
  });
  const askRow = h('div', 'flow-ask');
  askRow.append(ask, askButton);
  const buttons = h('div', 'flow-buttons');
  buttons.append(resetButton, h('span', 'flow-grow'), saveButton);
  foot.append(messageLine, askRow, buttons);
  root.append(head, main, foot);
  host.replaceChildren(root);

  const readOnly = (): boolean => state.draft?.readOnly != null;

  const select = (index: number | null): void => {
    state.adding = null;
    state.message = '';
    state.selected = state.selected === index ? null : index;
    paint();
  };

  const toggleAdding = (after: number): void => {
    state.selected = null;
    state.message = '';
    state.adding = state.adding === after ? null : after;
    paint();
  };

  async function call(method: string, extra: Record<string, unknown>): Promise<EditReply> {
    try {
      return (await deps.invoke(method, { ...payload, ...extra })) as EditReply;
    } catch (failure) {
      return { ok: false, error: failure instanceof Error ? failure.message : String(failure) };
    }
  }

  async function load(): Promise<void> {
    const reply = await call('flow', {});
    if (disposed) {
      return;
    }
    if (reply.ok) {
      const flow = reply as unknown as FlowDraft;
      state.draft = flow;
      state.saved = flow;
      state.error = '';
      state.paul = null;
    } else {
      state.error = reply.error;
    }
    paint();
  }

  /** One engine round trip; the refusal comes back as text under the list. */
  async function guarded(work: () => Promise<boolean>): Promise<boolean> {
    if (state.busy) {
      return false;
    }
    state.busy = true;
    state.message = '';
    state.notice = '';
    paint();
    try {
      return await work();
    } finally {
      state.busy = false;
      if (!disposed) {
        paint();
      }
    }
  }

  function run(op: FlowOp): Promise<boolean> {
    return guarded(async () => {
      if (state.draft === null) {
        return false;
      }
      const reply = await call('flowEdit', { chain: state.draft.chain, edit: op });
      if (!disposed && reply.ok) {
        state.draft = reply as unknown as FlowDraft;
        return true;
      }
      state.message = reply.ok ? '' : reply.error;
      return false;
    });
  }

  function askPaul(): Promise<boolean> {
    return guarded(async () => {
      const text = ask.value.trim();
      const reply = await call('flowDraft', { ask: text === '' ? null : text });
      if (disposed || !reply.ok || state.draft === null) {
        state.message = reply.ok ? '' : reply.error;
        return false;
      }
      const drafted = reply as unknown as FlowDraft & { reason?: string };
      state.paul = { reason: drafted.reason ?? '', before: state.paul?.before ?? state.draft };
      state.draft = drafted;
      state.selected = null;
      state.adding = null;
      ask.value = '';
      return true;
    });
  }

  function save(): Promise<boolean> {
    return guarded(async () => {
      if (state.draft === null) {
        return false;
      }
      const reply = await call('flowSave', { chain: state.draft.chain });
      if (!reply.ok) {
        state.message = reply.error;
        return false;
      }
      const warning = typeof reply['warning'] === 'string' ? reply['warning'] : '';
      await load();
      state.notice = warning === '' ? 'Saved' : `Saved · ${warning}`;
      return true;
    });
  }

  // --- painting ---------------------------------------------------------------

  function paintHead(): void {
    const flow = state.draft;
    head.replaceChildren();
    head.append(h('span', 'flow-id', target.ticketId));
    const title = deps.titleOf(target.ticketId);
    if (title !== null && flow === null) {
      head.append(h('span', 'flow-head-title', title));
    }
    head.append(h('span', 'flow-grow'));
    if (flow !== null) {
      const dirty = isDirty(flow, state.saved);
      head.append(h('span', `flow-chip${dirty ? ' is-dirty' : ''}`, dirty ? `${changesLabelOf(flow.chain)} · not saved` : changesLabelOf(flow.chain)));
    }
  }

  function gateNode(flow: FlowDraft, index: number, changed: ReadonlySet<number>): HTMLElement {
    const gate = flow.steps[index]!;
    const item = h('li', 'flow-item');
    const persona = flow.personas.find((p) => p.id === gate.persona);
    const row = h('button', 'flow-gate');
    row.type = 'button';
    for (const [flag, name] of [
      [changed.has(gate.index), 'is-dashed'],
      [gate.skipped, 'is-struck'],
      [gate.inserted, 'is-added'],
      [gate.state === 'current', 'is-current'],
      [state.selected === gate.index, 'is-selected'],
    ] as const) {
      row.classList.toggle(name, flag);
    }
    row.setAttribute('aria-pressed', String(state.selected === gate.index));
    row.setAttribute('aria-label', `${gate.title}, ${whoOf(gate, flow)}${gate.state === 'current' ? ', current gate' : ''}`);
    const dot = h('span', 'flow-dot');
    dot.style.background = persona?.color ?? 'var(--text-3)';
    const text = h('span', 'flow-gate-main');
    text.append(h('b', 'flow-gate-title', gate.title), h('span', 'flow-gate-who', [whoOf(gate, flow), gate.model].filter((x) => x !== null && x !== '').join(' · ')));
    row.append(dot, text);
    if (gate.state === 'current') {
      row.append(h('span', 'flow-mark is-running', 'Current'));
    }
    for (const mark of marksOf(gate)) {
      row.append(h('span', 'flow-mark', mark));
    }
    row.addEventListener('click', () => select(gate.index));
    item.append(row);

    const plus = h('button', `flow-plus${state.adding === gate.index ? ' is-open' : ''}`);
    plus.type = 'button';
    plus.disabled = readOnly();
    plus.title = `Add a gate after ${gate.title}`;
    plus.setAttribute('aria-label', `Add a gate after ${gate.title}`);
    plus.setAttribute('aria-expanded', String(state.adding === gate.index));
    plus.append(h('span', 'flow-plus-line'), h('span', 'flow-plus-dot', '+'));
    plus.addEventListener('click', () => toggleAdding(gate.index));
    item.append(plus);
    if (state.adding === gate.index) {
      item.append(addNode(flow, gate.index));
    }
    return item;
  }

  function addNode(flow: FlowDraft, after: number): HTMLElement {
    const box = h('div', 'flow-add');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Add a gate');
    const phases = addablePhasesOf(flow);
    if (phases.length === 0) {
      box.append(h('span', 'flow-hint', 'Every phase is in this flow already.'));
    }
    for (const phase of phases) {
      const chip = textButton(phase.title, 'flow-chipbtn', `Add ${phase.title}`, () => {
        void run({ op: 'insert', phase: phase.id, after }).then((ok) => {
          if (ok) {
            state.adding = null;
            const added = state.draft?.steps.find((s) => s.inserted && s.phase === phase.id);
            state.selected = added?.index ?? null;
            paint();
          }
        });
      });
      chip.disabled = state.busy;
      box.append(chip);
    }
    return box;
  }

  function paintBody(): void {
    const flow = state.draft;
    body.replaceChildren();
    if (flow === null) {
      body.append(h('p', state.error === '' ? 'flow-note' : 'flow-note is-error', state.error === '' ? 'Loading…' : state.error));
      return;
    }
    const title = h('div', 'flow-title');
    title.append(h('span', 'flow-eyebrow', eyebrowOf(flow)), h('h2', 'flow-h', flow.scope.kind === 'part' ? flow.scope.title : flow.title));
    body.append(title);
    if (flow.readOnly != null) {
      body.append(h('p', 'flow-note', flow.readOnly));
    }
    if (state.paul !== null) {
      const paul = h('div', 'flow-paul');
      paul.setAttribute('role', 'status');
      paul.append(
        h('span', 'flow-paul-k', 'Paul drafted this flow'),
        h('span', 'flow-paul-t', state.paul.reason),
        textButton('Undo draft', 'desk-btn desk-btn-link', 'Back to the flow before his draft', () => {
          state.draft = state.paul?.before ?? state.draft;
          state.paul = null;
          state.selected = null;
          paint();
        }),
      );
      body.append(paul);
    }
    const changed = changedIndicesOf(flow, state.saved);
    const list = h('ol', 'flow-list');
    list.setAttribute('aria-label', 'Gates');
    flow.steps.forEach((_, index) => list.append(gateNode(flow, index, changed)));
    body.append(list);
  }

  function section(label: string): HTMLElement {
    const box = h('section', 'flow-sec');
    box.setAttribute('aria-label', label);
    box.append(h('h3', 'flow-sec-h', label));
    return box;
  }

  function paintInspector(): void {
    const flow = state.draft;
    inspector.replaceChildren();
    const gate = flow?.steps.find((s) => s.index === state.selected) ?? null;
    inspector.hidden = flow === null || gate === null;
    if (flow === null || gate === null) {
      return;
    }
    const editable = !gate.locked && !readOnly() && !state.busy;
    const top = h('div', 'flow-ins-head');
    top.append(h('h3', 'flow-ins-title', gate.title), textButton('×', 'desk-btn desk-btn-link', 'Close', () => select(gate.index)));
    top.lastElementChild?.setAttribute('aria-label', 'Close');
    inspector.append(top);
    if (gate.state === 'current') {
      inspector.append(h('p', 'flow-hint', 'This is the current gate. It stays as it is; changes reach the gates after it.'));
    } else if (gate.locked || readOnly()) {
      inspector.append(h('p', 'flow-hint', 'This flow cannot change.'));
    }

    const who = section('Who');
    if (gate.owner) {
      who.append(h('p', 'flow-val', 'You'));
    }
    const chips = h('div', 'flow-chips');
    chips.setAttribute('role', 'group');
    const choose = (label: string, on: boolean, persona: string | null, color: string | null): void => {
      const chip = h('button', `flow-chipbtn${on ? ' is-on' : ''}`);
      chip.type = 'button';
      chip.disabled = !editable;
      chip.setAttribute('aria-pressed', String(on));
      if (color !== null) {
        const dot = h('span', 'flow-dot is-small');
        dot.style.background = color || 'var(--text-3)';
        chip.append(dot);
      }
      chip.append(document.createTextNode(label));
      chip.addEventListener('click', () => void run({ op: 'persona', step: gate.index, persona }));
      chips.append(chip);
    };
    if (!gate.owner) {
      choose('Pipeline default', !gate.pinned, null, null);
    }
    for (const persona of personasFor(flow, gate)) {
      choose(persona.title, gate.pinned && gate.persona === persona.id, persona.id, persona.color);
    }
    who.append(chips);
    inspector.append(who);

    if (!gate.owner) {
      const model = section('Model');
      model.append(h('p', 'flow-val', gate.model ?? 'None'));
      inspector.append(model);
    }

    const notify = h('section', 'flow-sec flow-row');
    notify.append(h('span', 'flow-row-t', 'Tell me when it is done'));
    const toggle = h('button', `flow-switch${gate.notify ? ' is-on' : ''}`);
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(gate.notify));
    toggle.setAttribute('aria-label', 'Tell me when it is done');
    toggle.disabled = !editable;
    toggle.append(h('span', 'flow-knob'));
    toggle.addEventListener('click', () => void run({ op: 'notify', step: gate.index, on: !gate.notify }));
    notify.append(toggle);
    inspector.append(notify);

    const after = section('Runs after');
    const room = moveRoomOf(flow, gate);
    after.append(h('p', 'flow-val', runsAfterOf(flow, gate)?.title ?? 'The start of this flow'));
    const moves = h('div', 'flow-actions');
    const earlier = textButton('↑ Earlier', 'desk-btn', 'Run this gate one place earlier', () => void moveGate(-1));
    const later = textButton('↓ Later', 'desk-btn', 'Run this gate one place later', () => void moveGate(1));
    earlier.disabled = !editable || !room.earlier;
    later.disabled = !editable || !room.later;
    moves.append(earlier, later);
    after.append(moves);
    inspector.append(after);

    const actions = h('div', 'flow-actions');
    const addAfter = textButton('Add a gate after', 'desk-btn', 'Pick a phase to run after this gate', () => toggleAdding(gate.index));
    addAfter.disabled = readOnly() || state.busy;
    actions.append(addAfter, h('span', 'flow-grow'));
    if (gate.skipped) {
      const restore = textButton('Restore gate', 'desk-btn', 'Run this standard gate again', () => void run({ op: 'restore', step: gate.index }));
      restore.disabled = !editable;
      actions.append(restore);
    } else {
      const remove = textButton('Remove gate', 'desk-btn desk-btn-danger', gate.inserted ? 'Take this added gate out' : 'Strike this standard gate for this ticket', () => {
        void run({ op: 'remove', step: gate.index }).then((ok) => {
          if (ok) {
            state.selected = gate.inserted ? null : gate.index;
            paint();
          }
        });
      });
      remove.disabled = !editable;
      actions.append(remove);
    }
    inspector.append(actions);

    async function moveGate(dir: -1 | 1): Promise<void> {
      if (await run({ op: 'move', step: gate!.index, dir })) {
        // The gate sits where its neighbour was: follow it with the selection.
        const moved = state.draft?.steps.find((s) => s.phase === gate!.phase && s.inserted === gate!.inserted);
        state.selected = moved?.index ?? null;
        paint();
      }
    }
  }

  function paintFoot(): void {
    const flow = state.draft;
    foot.hidden = flow === null;
    const locked = readOnly() || state.busy;
    ask.disabled = locked;
    askButton.disabled = locked;
    resetButton.disabled = locked || (flow?.chain.length ?? 0) === 0;
    saveButton.disabled = locked || !isDirty(flow, state.saved);
    messageLine.textContent = state.message !== '' ? state.message : state.notice;
    messageLine.classList.toggle('is-error', state.message !== '');
    messageLine.hidden = messageLine.textContent === '';
  }

  function paint(): void {
    if (disposed) {
      return;
    }
    paintHead();
    paintBody();
    paintInspector();
    paintFoot();
  }

  // A board change reloads the flow while the draft has no edits of its own.
  const off = deps.subscribe(() => {
    if (!state.busy && !isDirty(state.draft, state.saved)) {
      void load();
    }
  });
  paint();
  void load();
  return () => {
    disposed = true;
    off();
  };
}
