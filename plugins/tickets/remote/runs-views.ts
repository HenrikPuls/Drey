/**
 * The phone client's run screens (req-66 R4): answering a waiting
 * worker, the Runs list, one run's transcript with steer and stop, and
 * the chain's master and column switches. The transcript is the desk's
 * own watch view model (`renderer/watch-format.ts`); replies and
 * results render its Markdown (`markdown.ts`), the rest stays text.
 */
import type { RunInfo, WaitQuestion } from '../main/fleet/protocol';
import { formatWatch, parseStreamEvents, type WatchBlock } from '../renderer/watch-format';
import { ageOf } from '../shared/tickets';
import type { Ctx, View } from './context';
import { armedButton, button, chip, empty, h, present, sheet } from './dom';
import { renderMarkdown } from './markdown';
import { answersOf, isLive, runsForList, runStateLabel, tokensLabel } from './model';

/** What a worker waits on, from a run or a Needs-you entry. */
export interface Wait {
  readonly runId: string;
  readonly kind: 'question' | 'permission';
  readonly text: string;
  readonly questions?: readonly WaitQuestion[];
}

const runsOf = (ctx: Ctx): readonly RunInfo[] => ctx.state.fleet?.runs ?? [];

function titleOf(ctx: Ctx, ticketId: string): string {
  for (const column of ctx.state.board?.columns ?? []) {
    const card = column.tickets.find((t) => t.id === ticketId);
    if (card !== undefined) {
      return card.meta.title ?? ticketId;
    }
  }
  return ticketId;
}

// --- answering --------------------------------------------------------------

/** The answer controls under a waiting worker's question or permission request. */
export function waitActions(ctx: Ctx, wait: Wait): HTMLElement | null {
  if (ctx.state.readOnly) {
    return null;
  }
  const base = `/api/runs/${encodeURIComponent(wait.runId)}`;
  if (wait.kind === 'permission') {
    const decide = (decision: 'once' | 'always' | 'reject', label: string): HTMLButtonElement =>
      button(label, () => void ctx.act(ctx.api.post(`${base}/permission`, { decision }), `Answered: ${label.toLowerCase()}`), `btn grow${decision === 'reject' ? ' btn-danger' : ''}`);
    return h('div', { class: 'btns' }, decide('once', 'Once'), decide('always', 'Always'), decide('reject', 'Reject'));
  }

  const questions = wait.questions ?? [];
  if (questions.length === 0) {
    // A `QUESTION:` turn: the answer is the next message to the worker.
    const input = h('textarea', { attrs: { rows: '2', placeholder: 'Your answer', 'aria-label': 'Your answer' } });
    const send = button('Answer', () => {
      if (input.value.trim() !== '') {
        void ctx.act(ctx.api.post(`${base}/send`, { text: input.value }), 'Answer sent');
      }
    }, 'btn btn-primary');
    return h('div', { class: 'answer' }, input, send);
  }

  const picked = new Map<string, string[]>();
  const typed = new Map<string, string>();
  const direct = questions.length === 1 && !questions[0]!.multiple;
  const submit = (): void => {
    const answers = answersOf(questions, picked, typed);
    if (answers === null) {
      return;
    }
    void ctx.act(ctx.api.post(`${base}/answer`, { answers }), 'Answer sent');
  };
  const send = button('Send answer', submit, 'btn btn-primary');
  const refresh = (): void => {
    send.disabled = answersOf(questions, picked, typed) === null;
  };
  const fields = questions.map((q) => {
    const options = q.options.map((option, i) => {
      const node = button(`${i + 1} · ${option.label}`, () => {
        if (direct) {
          picked.set(q.key, [option.label]);
          submit();
          return;
        }
        const now = picked.get(q.key) ?? [];
        const next = q.multiple
          ? now.includes(option.label)
            ? now.filter((l) => l !== option.label)
            : [...now, option.label]
          : [option.label];
        picked.set(q.key, next);
        for (const sibling of Array.from(node.parentElement?.children ?? [])) {
          sibling.classList.toggle('on', next.includes((sibling as HTMLElement).dataset['label'] ?? ''));
        }
        refresh();
      }, 'btn option');
      node.dataset['label'] = option.label;
      if (option.description !== undefined) {
        node.title = option.description;
      }
      return node;
    });
    const own = h('input', { attrs: { type: 'text', placeholder: 'Or in your own words', 'aria-label': 'In your own words', enterkeyhint: 'send' } });
    own.addEventListener('input', () => {
      typed.set(q.key, own.value);
      refresh();
    });
    own.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        submit();
      }
    });
    return h(
      'div',
      { class: 'question' },
      questions.length > 1 || q.header !== undefined ? h('span', { class: 'small', text: q.header ?? q.question }) : null,
      questions.length > 1 ? h('span', { class: 'q-text', text: q.question }) : null,
      h('div', { class: 'btns wrap' }, ...options),
      own,
    );
  });
  refresh();
  return h('div', { class: 'answer' }, ...fields, direct ? button('Send own words', submit, 'btn') : send);
}

// --- the Runs tab -----------------------------------------------------------

export function runsView(ctx: Ctx): View {
  const { live, recent } = runsForList(runsOf(ctx));
  const row = (run: RunInfo): HTMLElement =>
    h(
      'button',
      { class: 'runrow', attrs: { type: 'button' }, on: { click: () => ctx.go(`#run/${run.id}`) } },
      h(
        'span',
        { class: 'row' },
        h('span', { class: 'id', text: run.ticketId }),
        chip(runStateLabel(run), isLive(run) ? (run.waiting ? 'chip-acc' : 'chip-ok') : run.gateResult === 'red' || run.state === 'failed' ? 'chip-bad' : ''),
        h('span', { class: 'need-kind', text: ageOf(run.startedAt) }),
      ),
      h('span', { class: 'title', text: titleOf(ctx, run.ticketId) }),
      h('span', {
        class: 'small',
        text: [run.provider, run.phase ?? null, tokensLabel(run.tokensIn) !== '' ? `${tokensLabel(run.tokensIn)} in` : null]
          .filter((x) => x)
          .join(' · '),
      }),
      isLive(run) && run.activity !== undefined ? h('span', { class: 'activity', text: run.activity }) : null,
    );
  const body: Node[] = [];
  if (ctx.state.fleet?.chain === null) {
    body.push(h('p', { class: 'issue', text: 'The fleet runner is not running on the desk.' }));
  }
  body.push(h('h2', { class: 'sect', text: 'Live' }), ...(live.length === 0 ? [empty('No run is live.')] : live.map(row)));
  if (recent.length > 0) {
    body.push(h('h2', { class: 'sect', text: 'Recent' }), ...recent.map(row));
  }
  return { title: 'Runs', body };
}

// --- one run ------------------------------------------------------------------

export function runView(ctx: Ctx, runId: string): View {
  const run = runsOf(ctx).find((r) => r.id === runId) ?? null;
  if (run === null) {
    return { title: 'Run', back: '#runs', body: [empty(ctx.state.fleet === null ? 'Loading…' : 'This run is not known on the desk any more.')] };
  }
  const live = isLive(run);
  const meta = h(
    'div',
    { class: 'row wrap small' },
    chip(runStateLabel(run), live ? (run.waiting ? 'chip-acc' : 'chip-ok') : run.gateResult === 'red' || run.state === 'failed' ? 'chip-bad' : ''),
    h('span', { text: present([run.provider, run.model ?? null, run.phase ?? null]).join(' · ') }),
    run.contextTokens ? h('span', { text: `ctx ${tokensLabel(run.contextTokens)}` }) : null,
    h('span', { text: `${tokensLabel(run.tokensIn)} in · ${tokensLabel(run.tokensOut)} out` }),
    typeof run.costUsd === 'number' && run.costUsd > 0 ? h('span', { text: `$${run.costUsd.toFixed(2)}` }) : null,
    h('span', { text: `started ${ageOf(run.startedAt)} ago` }),
  );
  const wait = live && run.waiting ? run.waiting : null;
  const stream = ctx.state.stream !== null && ctx.state.stream.runId === runId ? ctx.state.stream.text : null;
  const blocks = stream === null ? null : formatWatch(parseStreamEvents(stream)).blocks;

  const body: Node[] = present<Node>([
    h('h1', { class: 'ticket-title', text: titleOf(ctx, run.ticketId) }),
    meta,
    run.gateFailure !== null ? h('p', { class: 'issue issue-error', text: run.gateFailure }) : null,
    h(
      'div',
      { class: 'transcript', attrs: { 'aria-live': 'polite' } },
      ...(blocks === null ? [empty('Loading the transcript…')] : blocks.length === 0 ? [empty('Nothing streamed yet.')] : blocks.slice(-80).map(blockRow)),
    ),
    wait !== null
      ? h(
          'div',
          { class: `need need-${wait.kind}` },
          h(
            'div',
            { class: 'need-head' },
            h('span', { class: 'need-kind left', text: wait.kind === 'permission' ? 'Wants permission' : 'Asks you' }),
            h('span', { class: 'need-text full', text: wait.text }),
          ),
          waitActions(ctx, { runId: run.id, kind: wait.kind, text: wait.text, ...(wait.questions ? { questions: wait.questions } : {}) }),
        )
      : null,
  ]);

  let actions: HTMLElement | null = null;
  if (live && !ctx.state.readOnly) {
    const input = h('textarea', { class: 'composer-field', attrs: { rows: '1', placeholder: 'Steer the run…', 'aria-label': 'Steer the run', enterkeyhint: 'send' } });
    const send = (): void => {
      const text = input.value.trim();
      if (text === '') {
        return;
      }
      void ctx.act(ctx.api.post(`/api/runs/${encodeURIComponent(run.id)}/send`, { text }), 'Sent to the worker').then((ok) => {
        if (ok) {
          input.value = '';
        }
      });
    };
    actions = h(
      'div',
      { class: 'composer' },
      input,
      button('Send', send, 'btn btn-primary'),
      armedButton('Stop', 'Stop?', () => void ctx.act(ctx.api.post(`/api/runs/${encodeURIComponent(run.id)}/stop`, { reason: 'stopped from a device' }), 'Run stopped')),
    );
  }
  return { title: `${run.ticketId} · Run`, back: `#ticket/${run.ticketId}`, body, actions, followTail: true };
}

function blockRow(block: WatchBlock): HTMLElement {
  switch (block.kind) {
    case 'step': {
      const step = block.step;
      return h(
        'div',
        { class: `t-step${step?.failed ? ' failed' : ''}${block.live ? ' live' : ''}` },
        h('span', { class: 't-tool', text: step?.name ?? block.tool ?? 'Tool' }),
        h('span', { class: 't-target', text: step?.target ?? '' }),
        step?.outcome !== undefined ? h('span', { class: 't-outcome', text: step.outcome }) : null,
      );
    }
    case 'thinking':
      return h('div', { class: 't-muted', text: 'Thinking…' });
    case 'you':
      return h('div', { class: 't-you', text: `› ${block.text ?? ''}` });
    case 'setup':
      return h('div', { class: 't-muted', text: block.text ?? '' });
    case 'error':
      return h('div', { class: 't-error', text: block.text ?? block.markdown });
    case 'result':
      // The turn's own words are Markdown; the row keeps its rule look.
      return h('div', { class: 't-result' }, renderMarkdown(block.text ?? block.markdown));
    default:
      return h('div', { class: `t-text${block.live ? ' live' : ''}` }, renderMarkdown(block.markdown));
  }
}

// --- the chain's switches ---------------------------------------------------------

export function masterSheet(ctx: Ctx): void {
  const chain = ctx.state.fleet?.chain ?? null;
  if (chain === null || ctx.state.readOnly) {
    return;
  }
  const close = sheet('Fleet', [
    h('p', { class: 'small', text: chain.master === 'run' ? 'Columns with a worker pull and run tickets on their own.' : 'Halted: no column starts a new run. Live runs go on.' }),
    h(
      'div',
      { class: 'seg' },
      ...(['run', 'halted'] as const).map((mode) =>
        h('button', {
          class: chain.master === mode ? 'on' : '',
          text: mode === 'run' ? 'Run' : 'Halt',
          attrs: { type: 'button', 'aria-pressed': String(chain.master === mode) },
          on: {
            click: () => {
              close();
              if (chain.master !== mode) {
                void ctx.act(ctx.api.post('/api/chain/master', { mode }), mode === 'run' ? 'Fleet running' : 'Fleet halted');
              }
            },
          },
        }),
      ),
    ),
    armedButton('Stop every live run', 'Tap again to stop them all', () => {
      close();
      void ctx.act(ctx.api.post('/api/chain/abort'), 'Every run stopped');
    }),
  ]);
}

export function columnSheet(ctx: Ctx, phase: string, title: string): void {
  const chain = ctx.state.fleet?.chain ?? null;
  if (chain === null || ctx.state.readOnly) {
    return;
  }
  const mode = chain.columns[phase] ?? 'playing';
  const close = sheet(title, [
    h(
      'div',
      { class: 'seg' },
      ...(['playing', 'held'] as const).map((m) =>
        h('button', {
          class: mode === m ? 'on' : '',
          text: m === 'playing' ? 'Play' : 'Hold',
          attrs: { type: 'button', 'aria-pressed': String(mode === m) },
          on: {
            click: () => {
              close();
              if (mode !== m) {
                void ctx.act(ctx.api.post('/api/chain/column', { phase, mode: m }), `${title}: ${m === 'playing' ? 'playing' : 'held'}`);
              }
            },
          },
        }),
      ),
    ),
    h('p', { class: 'small', text: 'Hold keeps the column from starting new runs; Stop also ends the ones running in it.' }),
    armedButton(`Stop ${title}`, 'Tap again to stop the column', () => {
      close();
      void ctx.act(ctx.api.post('/api/chain/column-stop', { phase }), `${title} stopped`);
    }),
  ]);
}
