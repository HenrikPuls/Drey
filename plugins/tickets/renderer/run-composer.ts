/**
 * The conversation's lower half, shared by the takeover tab and the
 * ticket thread (req-75 W1): what the worker waits on (its question, a
 * tool call to approve), its pulse while a turn runs, and the prompt box
 * with attachments, "/" commands and quick prompts. The run it talks to
 * is looked up anew on every paint, so the thread can follow the
 * ticket's newest run while the takeover tab keeps its one.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { MutationResult } from '../shared/tickets';
import type { RunInfo, WaitQuestion } from '../main/fleet/protocol';
import { createMessageQueue, readyToFlush, LIVE_RUN_STATES, type MessageQueue, type QueuedMessage } from './message-queue';
import { questionNode } from './wait-view';
import { formatTokens } from './worker-status';

/** The largest file the prompt box attaches (the runner enforces the same). */
const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

/** Short notes for the commands both workers share; others show their name only. */
const COMMAND_HINTS: Readonly<Record<string, string>> = {
  compact: 'Summarise the conversation to free context',
  clear: 'Start over with an empty context',
  context: 'Show what fills the context window',
  cost: 'Show the session cost',
  init: 'Write a CLAUDE.md for the project',
  review: 'Review the changes',
  help: 'List the available commands',
};

/** One-click starters for the prompt box: a label and the text it fills in. */
const QUICK_PROMPTS: ReadonlyArray<readonly [string, string]> = [
  ['What are you doing and why?', 'What are you doing and why?'],
  ['Stop after this step', 'Finish the current step, update the ticket Log, then stop and wait for me.'],
];

// The queue of messages the owner sent while the worker was in a turn
// (req-75 W4c). Module level, so both composers — the takeover tab and the
// thread — see the same queue for a run and a rebuilt composer keeps it;
// mirrored to localStorage per run id, so a reload keeps it too.
const queues = new Map<string, MessageQueue>();
/** Runs whose head was already sent this idle turn — one message per idle, the worker answers first. */
const sentThisIdle = new Set<string>();
/** Runs with a flush in flight — `paint()` runs every second and must not send twice. */
const flushing = new Set<string>();
/** Entries being inline-edited right now (both composers must hold their flush). */
const editingLocks = new Set<string>();
/** Queues dropped when their run ended: run id → the messages, for the notice. */
const endedQueues = new Map<string, readonly string[]>();

const queueKey = (runId: string): string => `drey.tickets.queue.${runId}`;

const readQueueStorage = (runId: string): unknown => {
  try {
    return localStorage.getItem(queueKey(runId));
  } catch {
    return undefined;
  }
};

const writeQueueStorage = (runId: string, queue: MessageQueue): void => {
  try {
    if (queue.list().length === 0) {
      localStorage.removeItem(queueKey(runId));
    } else {
      localStorage.setItem(queueKey(runId), queue.toJSON());
    }
  } catch {
    // storage blocked or full — the queue lives on for this session
  }
};

const dropQueueStorage = (runId: string): void => {
  try {
    localStorage.removeItem(queueKey(runId));
  } catch {
    // as above
  }
};

/** The message as it goes out — attachments ride after the text, like a direct send. */
const composeMessage = (entry: QueuedMessage): string =>
  entry.attachments.length === 0
    ? entry.text
    : `${entry.text === '' ? 'See the attached files.' : entry.text}\n\nAttached files:\n${entry.attachments.map((a) => `- ${a}`).join('\n')}`;

export interface RunComposerDeps {
  readonly api: DreyPluginApi;
  invoke(method: string, payload?: unknown): Promise<unknown>;
  mutate(label: string, invoke: () => Promise<unknown>): Promise<MutationResult>;
  error(message: string): void;
  /** The run the composer talks to right now; null when there is none. */
  target(): RunInfo | null;
  /** A message to an ended run reopened its session as a new run. */
  onReopened(run: RunInfo, newRunId: string): void;
  /**
   * The thread's case: no run takes the message, so one is started for it
   * (an interactive dialog). Resolves to the new run's id, or null when
   * none could be started. Absent = the box is read-only without a run.
   */
  startFor?: () => Promise<string | null>;
  /** Whether `startFor` may start a run now (a dialog phase, no live run). */
  canStart?: () => boolean;
  /** How many other runs are live right now — the question's meta line. */
  othersLive?: () => number;
  readonly placeholder: string;
  /**
   * The thread's quiet start (req-75): fills the box once, at creation,
   * with the current processing step and its meaning — the owner
   * completes it with their question. Absent/null keeps the box empty.
   */
  prefill?: () => string | null;
}

export interface RunComposer {
  /** The wait card, the pulse and the prompt box, in that order. */
  readonly element: HTMLElement;
  /** Repaints from the current target run (call on every fleet change and once a second). */
  paint(): void;
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

export function createRunComposer(deps: RunComposerDeps): RunComposer {
  const { api } = deps;
  const wrap = el('div', 'tickets-composer');
  const iconButton = (icon: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = el('button', 'tickets-takeover-btn');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.append(api.ui.icon(icon, 13));
    b.addEventListener('click', onClick);
    return b;
  };
  const runId = (): string | null => deps.target()?.id ?? null;
  // An ended run with a session takes the message: it is reopened as a
  // new run that carries on the conversation (main's fix 2026-10-31);
  // only without one does the thread start a dialog.
  const isReopenable = (run: RunInfo | null): boolean =>
    run !== null && !LIVE_RUN_STATES.includes(run.state) && run.state !== 'detached' && run.sessionRef !== null;

  // The composer box (Claude Code's shape, req-75 W4a): one rounded box —
  // the prompt on top, a toolbar inside it below (attach left, stop and
  // send right); the two quick-prompt chips sit above it.
  const box = el('div', 'tickets-composer-box');
  const toolbar = el('div', 'tickets-composer-toolbar');
  const promptWrap = box;
  // Files and pictures for the worker: stored in its worktree, named in the message.
  const attached: { name: string; path: string }[] = [];
  const attachRow = el('div', 'tickets-takeover-attached');
  attachRow.hidden = true;
  const paintAttached = (): void => {
    attachRow.replaceChildren();
    for (const [index, file] of attached.entries()) {
      const chip = el('span', 'tickets-takeover-attachment');
      chip.title = file.path;
      const drop = el('button', 'tickets-takeover-attachment-x', '×');
      drop.type = 'button';
      drop.title = 'Remove from the message';
      drop.setAttribute('aria-label', `Remove ${file.name}`);
      drop.addEventListener('click', () => {
        attached.splice(index, 1);
        paintAttached();
        paint();
      });
      chip.append(document.createTextNode(file.name), drop);
      attachRow.append(chip);
    }
    attachRow.hidden = attached.length === 0;
  };
  const addFiles = async (files: Iterable<File>): Promise<void> => {
    const id = runId();
    if (id === null) {
      deps.error('Attach files once a run is there to read them');
      return;
    }
    for (const file of files) {
      if (file.size > MAX_ATTACH_BYTES) {
        deps.error(`${file.name} is larger than ${MAX_ATTACH_BYTES / 1024 / 1024} MB`);
        continue;
      }
      const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      const name = file.name !== '' ? file.name : `pasted.${(file.type.split('/')[1] ?? 'png').replace(/[^a-z0-9]/gi, '')}`;
      const result = (await deps.invoke('fleetAttach', { runId: id, name, data })) as { ok?: boolean; error?: string; path?: string };
      if (result.ok === true && typeof result.path === 'string') {
        attached.push({ name, path: result.path });
      } else {
        deps.error(result.error ?? `${name} could not be attached`);
      }
    }
    paintAttached();
    paint();
  };

  const send = async (text: string): Promise<void> => {
    const typed = text.trim();
    if (typed === '' && attached.length === 0) {
      return;
    }
    let target = deps.target();
    const active = target !== null && LIVE_RUN_STATES.includes(target.state);
    let id: string | null = active || isReopenable(target) ? (target?.id ?? null) : null;
    if (id === null && deps.startFor !== undefined && (deps.canStart?.() ?? true)) {
      id = await deps.startFor();
      target = deps.target();
    }
    if (id === null) {
      return;
    }
    // A slash command stays a command: attachments ride after it as plain text.
    const message =
      attached.length === 0
        ? typed
        : `${typed === '' ? 'See the attached files.' : typed}\n\nAttached files:\n${attached.map((a) => `- ${a.path}`).join('\n')}`;
    const sentTo = id;
    const result = await deps.mutate('Sending', () => deps.invoke('fleetSend', { runId: sentTo, text: message }));
    if (result.ok) {
      prompt.setContent('');
      attached.length = 0;
      paintAttached();
      prompt.focus();
      const reopened = (result as { runId?: string }).runId;
      if (reopened !== undefined && reopened !== sentTo && target !== null) {
        deps.onReopened(target, reopened);
      }
    }
  };

  // --- the queue (req-75 W4c) -------------------------------------------
  // Enter while the worker is in a turn queues instead of cutting into it.
  const busyTurn = (run: RunInfo | null): boolean =>
    run !== null && LIVE_RUN_STATES.includes(run.state) && run.turn === 'busy';
  const queueFor = (runId: string): MessageQueue => {
    let queue = queues.get(runId);
    if (queue === undefined) {
      queue = createMessageQueue(readQueueStorage(runId));
      queues.set(runId, queue);
    }
    return queue;
  };
  const enqueue = (text: string): void => {
    const typed = text.trim();
    const id = runId();
    if (id === null || (typed === '' && attached.length === 0)) {
      return;
    }
    const queue = queueFor(id);
    queue.add(typed, attached.map((a) => a.path), new Date().toISOString());
    writeQueueStorage(id, queue);
    attached.length = 0;
    paintAttached();
    prompt.setContent('');
    prompt.focus();
    paint();
  };
  // Send now keeps today's behaviour: interrupt the turn, then send.
  const sendNow = (text: string): void => {
    const run = deps.target();
    if (run !== null && busyTurn(run)) {
      void deps.mutate('Interrupting', () => deps.invoke('fleetControl', { action: 'interrupt', runId: run.id })).then(() => {
        void send(text);
      });
      return;
    }
    void send(text);
  };
  const sendTyped = (text: string): void => {
    if (busyTurn(deps.target())) {
      enqueue(text);
    } else {
      void send(text);
    }
  };

  // "/" lists the commands the worker accepts; anything typed goes through as it is.
  const commandMenu = el('div', 'tickets-takeover-commands');
  commandMenu.hidden = true;
  const paintCommands = (text: string): void => {
    const match = /^\/([\w.-]*)$/.exec(text);
    const known = deps.target()?.commands ?? [];
    const shown = match === null ? [] : known.filter((name) => name.toLowerCase().startsWith(match[1]!.toLowerCase())).slice(0, 12);
    commandMenu.replaceChildren();
    for (const name of shown) {
      const item = el('button', 'tickets-takeover-command');
      item.type = 'button';
      item.append(el('span', 'tickets-takeover-command-name', `/${name}`), el('span', 'tickets-takeover-command-hint', COMMAND_HINTS[name] ?? ''));
      item.addEventListener('click', () => {
        prompt.setContent(`/${name} `);
        commandMenu.hidden = true;
        prompt.focus();
      });
      commandMenu.append(item);
    }
    commandMenu.hidden = shown.length === 0;
  };
  const prompt = api.ui.createMarkdownView({
    compact: true,
    placeholder: deps.placeholder,
    onChange: (text) => {
      paintCommands(text);
      paint();
    },
    onSubmit: (text) => {
      commandMenu.hidden = true;
      sendTyped(text);
    },
  });
  prompt.element.classList.add('tickets-takeover-prompt-input');
  // Ctrl/Cmd+Enter sends now even while the box queues on Enter (req-75 W4c).
  prompt.element.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.stopPropagation();
        commandMenu.hidden = true;
        sendNow(prompt.getContent());
      }
    },
    true,
  );
  // The quiet start's pre-fill (req-75): the box opens carrying the
  // current step and its meaning — applied ONCE, at creation, so a later
  // paint never clobbers what the owner typed (or cleared after a send).
  const prefill = deps.prefill?.() ?? '';
  if (prefill !== '') {
    prompt.setContent(prefill);
  }

  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => {
    const picked = [...(fileInput.files ?? [])];
    fileInput.value = '';
    void addFiles(picked);
  });
  const plusBtn = el('button', 'tickets-composer-plus');
  plusBtn.type = 'button';
  plusBtn.title = 'Attach files or pictures — the worker reads them from its worktree';
  plusBtn.setAttribute('aria-label', 'Attach files');
  plusBtn.append(api.ui.icon('plus', 15));
  plusBtn.addEventListener('click', () => fileInput.click());
  box.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files') === true) {
      event.preventDefault();
    }
  });
  box.addEventListener('drop', (event) => {
    const dropped = [...(event.dataTransfer?.files ?? [])];
    if (dropped.length > 0) {
      event.preventDefault();
      void addFiles(dropped);
    }
  });
  box.addEventListener(
    'paste',
    (event) => {
      const pasted = [...(event.clipboardData?.files ?? [])];
      if (pasted.length > 0) {
        event.preventDefault();
        void addFiles(pasted);
      }
    },
    true,
  );
  const chips = el('span', 'tickets-takeover-chips');
  for (const [label, text] of QUICK_PROMPTS) {
    const chip = el('button', 'tickets-takeover-chip', label);
    chip.type = 'button';
    chip.title = `Puts "${text}" in the box — edit it, then send`;
    chip.addEventListener('click', () => {
      prompt.setContent(text);
      prompt.focus();
    });
    chips.append(chip);
  }
  // The design's quick prompts: pills in a row of their own above the box.
  const chipsRow = el('div', 'tickets-composer-chips');
  chipsRow.append(chips);
  const stopBtn = iconButton('square', 'Stop the running turn — the session and its context stay, you can prompt it again', () => {
    const id = runId();
    if (id !== null) {
      void deps.mutate('Interrupting', () => deps.invoke('fleetControl', { action: 'interrupt', runId: id }));
    }
  });
  stopBtn.classList.add('tickets-composer-stop');
  // The send button closes the toolbar inside the box. While the worker is
  // in a turn it becomes the queue button (req-75 W4c): the icon and title
  // swap, Enter queues too, and Send now beside it interrupts instead.
  const sendBtn = el('button', 'tickets-composer-send');
  sendBtn.type = 'button';
  sendBtn.title = 'Send the message — a working worker takes it into its turn';
  sendBtn.setAttribute('aria-label', 'Send');
  sendBtn.append(api.ui.icon('arrow-up', 14));
  let primaryQueues = false;
  const setPrimaryAction = (queue: boolean): void => {
    if (queue === primaryQueues) {
      return;
    }
    primaryQueues = queue;
    sendBtn.replaceChildren(api.ui.icon(queue ? 'corner-down-left' : 'arrow-up', 14));
    sendBtn.title = queue
      ? 'Queue the message — it is sent when the worker finishes its turn'
      : 'Send the message — a working worker takes it into its turn';
    sendBtn.setAttribute('aria-label', queue ? 'Queue' : 'Send');
  };
  sendBtn.addEventListener('click', () => sendTyped(prompt.getContent()));
  const sendNowBtn = el('button', 'tickets-takeover-btn tickets-composer-sendnow', 'Send now');
  sendNowBtn.type = 'button';
  sendNowBtn.title = 'Interrupt the turn and send now';
  sendNowBtn.hidden = true;
  sendNowBtn.addEventListener('click', () => {
    commandMenu.hidden = true;
    sendNow(prompt.getContent());
  });
  toolbar.append(plusBtn, fileInput, el('span', 'tickets-takeover-spacer'), stopBtn, sendNowBtn, sendBtn);

  // The queue above the prompt box (req-75 W4c): one row per message,
  // editable until it leaves, and under them what they wait for.
  const queueBlock = el('div', 'tickets-composer-queue');
  queueBlock.hidden = true;
  let editing: string | null = null;
  const beginEdit = (row: HTMLElement, runId: string, queue: MessageQueue, entry: QueuedMessage): void => {
    if (editing !== null) {
      return;
    }
    editing = entry.id;
    editingLocks.add(entry.id);
    const input = el('input', 'tickets-queue-edit');
    input.type = 'text';
    input.value = entry.text;
    let closed = false;
    const done = (save: boolean): void => {
      if (closed) {
        return;
      }
      closed = true;
      editing = null;
      editingLocks.delete(entry.id);
      const text = input.value.trim();
      if (save && text !== '') {
        queue.edit(entry.id, text);
        writeQueueStorage(runId, queue);
      }
      paintQueue(deps.target());
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        done(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        done(false);
      }
    });
    input.addEventListener('blur', () => done(false));
    row.replaceChildren(el('span', 'tickets-queue-label', 'Queued'), input);
    input.focus();
    input.select();
  };
  const queueRow = (runId: string, queue: MessageQueue, entry: QueuedMessage): HTMLElement => {
    const row = el('div', 'tickets-queue-row');
    row.append(el('span', 'tickets-queue-label', 'Queued'));
    const text = el('button', 'tickets-queue-text', entry.text === '' ? `${entry.attachments.length} attached files` : entry.text);
    text.type = 'button';
    text.title = 'Edit the queued message';
    text.addEventListener('click', () => beginEdit(row, runId, queue, entry));
    row.append(text);
    const drop = iconButton('x', 'Remove from the queue', () => {
      queue.remove(entry.id);
      writeQueueStorage(runId, queue);
      paintQueue(deps.target());
    });
    drop.classList.add('tickets-queue-x');
    row.append(drop);
    return row;
  };
  const endedRow = (dropped: readonly string[]): HTMLElement => {
    const row = el('div', 'tickets-queue-ended');
    const n = dropped.length;
    row.append(
      el(
        'span',
        'tickets-queue-ended-text',
        `The run ended — ${n} queued message${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} not sent.`,
      ),
    );
    row.append(
      iconButton('copy', 'Copy the unsent messages', () => {
        void navigator.clipboard.writeText(dropped.join('\n\n'));
      }),
    );
    return row;
  };
  const paintQueue = (run: RunInfo | null): void => {
    if (editing !== null) {
      return; // a repaint (every second) must not tear down the inline editor
    }
    queueBlock.replaceChildren();
    if (run === null) {
      queueBlock.hidden = true;
      return;
    }
    if (LIVE_RUN_STATES.includes(run.state)) {
      const queue = queueFor(run.id);
      const entries = queue.list();
      for (const entry of entries) {
        queueBlock.append(queueRow(run.id, queue, entry));
      }
      if (entries.length > 0) {
        queueBlock.append(el('div', 'tickets-queue-hint', 'Sends when the worker finishes its turn.'));
      }
    } else {
      // Ended (or detached): the queue can never be sent — drop it with a notice.
      const entries = queueFor(run.id).list();
      if (entries.length > 0) {
        endedQueues.set(run.id, entries.map(composeMessage));
        queues.delete(run.id);
        dropQueueStorage(run.id);
      }
      const dropped = endedQueues.get(run.id);
      if (dropped !== undefined) {
        queueBlock.append(endedRow(dropped));
      }
    }
    queueBlock.hidden = queueBlock.childElementCount === 0;
  };
  // The run went idle and waits on nothing: send the first queued message,
  // once — the guards keep a repaint (or the other composer) from sending
  // twice, and one message per idle turn: the worker answers each first.
  const maybeFlush = (run: RunInfo | null): void => {
    const id = run?.id;
    if (run !== null && run.turn === 'busy' && id !== undefined) {
      sentThisIdle.delete(id); // a new turn began — its end may send the next
    }
    if (id === undefined || !readyToFlush(run) || flushing.has(id) || sentThisIdle.has(id)) {
      return;
    }
    const queue = queueFor(id);
    const head = queue.head();
    if (head === null || editingLocks.has(head.id)) {
      return;
    }
    flushing.add(id);
    sentThisIdle.add(id);
    void deps
      .mutate('Sending', () => deps.invoke('fleetSend', { runId: id, text: composeMessage(head) }))
      .then((result) => {
        flushing.delete(id);
        if (result.ok) {
          queue.remove(head.id);
          writeQueueStorage(id, queue);
        }
        // A failure keeps the entry; mutate shows the error. The next try
        // waits for a busy turn first, so a dead runner is not hammered.
        paintQueue(deps.target());
      });
  };

  // The worker's pulse while a turn runs: what it does now and for how long.
  const progress = el('div', 'tickets-takeover-progress');
  progress.hidden = true;
  const spinner = el('span', 'tickets-takeover-spinner', '✻');
  const progressText = el('span', 'tickets-takeover-progress-text');
  progress.append(spinner, progressText);
  let busySince: number | null = null;
  let busyRun: string | null = null;
  const paintProgress = (run: RunInfo | null): void => {
    const working = run !== null && LIVE_RUN_STATES.includes(run.state) && run.turn !== 'idle';
    if (!working) {
      busySince = null;
      progress.hidden = true;
      return;
    }
    if (busyRun !== run.id) {
      busyRun = run.id;
      busySince = null;
    }
    busySince ??= run.steerCount === 0 && run.turn === undefined ? Date.parse(run.startedAt) || Date.now() : Date.now();
    const seconds = Math.max(0, Math.round((Date.now() - busySince) / 1000));
    const doing = (run.activity ?? '').trim();
    const verb = doing === '' || run.activity === undefined ? 'Thinking' : doing.length > 70 ? `${doing.slice(0, 69)}…` : doing;
    progressText.textContent = `${verb}… ${seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`} · ↓ ${formatTokens(run.tokensOut)} tokens`;
    progress.hidden = false;
  };
  box.append(commandMenu, attachRow, prompt.element, toolbar);

  // What the worker waits on (req-64): a tool call to approve with one
  // of the buttons, or a question asked as OpenCode's `question` form —
  // a `QUESTION:` turn is the conversation's, not the card's (W2b).
  const waitCard = el('div', 'tickets-takeover-wait');
  waitCard.hidden = true;
  const waitLabel = el('div', 'tickets-takeover-wait-label');
  const waitText = el('div', 'tickets-takeover-wait-text');
  const waitActions = el('div', 'tickets-takeover-wait-actions');
  const decide = (decision: 'once' | 'always' | 'reject', label: string): HTMLButtonElement => {
    const b = el('button', `tickets-takeover-btn${decision === 'once' ? ' tickets-takeover-btn-primary' : ''}`, label);
    b.type = 'button';
    b.addEventListener('click', () => {
      const id = runId();
      if (id !== null) {
        void deps.mutate(label, () => deps.invoke('fleetPermission', { runId: id, decision }));
      }
    });
    return b;
  };
  waitActions.append(decide('once', 'Allow once'), decide('always', 'Always allow'), decide('reject', 'Deny'));
  // A question asked with OpenCode's `question` tool comes with choices:
  // one click answers a single question, several are picked and sent.
  const waitQuestions = el('div', 'tickets-takeover-wait-questions');
  const picks = new Map<string, Set<string>>();
  const sendPicks = el('button', 'tickets-takeover-btn tickets-takeover-btn-primary', 'Send answer');
  sendPicks.type = 'button';
  const sendAnswers = (answers: Record<string, string | string[]>): void => {
    const id = runId();
    if (id !== null) {
      void deps.mutate('Answer', () => deps.invoke('fleetAnswer', { runId: id, answers }));
    }
  };
  sendPicks.addEventListener('click', () => {
    const answers: Record<string, string | string[]> = {};
    for (const [key, chosen] of picks) {
      if (chosen.size > 0) {
        answers[key] = [...chosen];
      }
    }
    sendAnswers(answers);
  });
  const paintQuestions = (questions: readonly WaitQuestion[]): void => {
    picks.clear();
    const oneClick = questions.length === 1 && !questions[0]!.multiple;
    waitQuestions.replaceChildren(
      ...questions.map((q) => {
        const block = el('div', 'tickets-takeover-wait-question');
        if (q.header !== undefined) {
          block.append(el('div', 'tickets-takeover-wait-header', q.header));
        }
        block.append(el('div', 'tickets-takeover-wait-text', q.question));
        const choices = el('div', 'tickets-takeover-wait-choices');
        for (const option of q.options) {
          const b = el('button', 'tickets-takeover-btn tickets-takeover-choice', option.label);
          b.type = 'button';
          b.title = option.description ?? option.label;
          b.addEventListener('click', () => {
            if (oneClick) {
              sendAnswers({ [q.key]: option.label });
              return;
            }
            const chosen = picks.get(q.key) ?? new Set<string>();
            if (!q.multiple) {
              chosen.clear();
              for (const sibling of choices.children) {
                sibling.classList.remove('tickets-takeover-choice-picked');
              }
            }
            if (chosen.has(option.label)) {
              chosen.delete(option.label);
            } else {
              chosen.add(option.label);
            }
            picks.set(q.key, chosen);
            b.classList.toggle('tickets-takeover-choice-picked', chosen.has(option.label));
            sendPicks.disabled = ![...picks.values()].some((s) => s.size > 0);
          });
          choices.append(b);
        }
        block.append(choices);
        return block;
      }),
    );
    sendPicks.hidden = oneClick;
    sendPicks.disabled = true;
    if (!oneClick) {
      waitQuestions.append(sendPicks);
    }
  };
  // A question asked in the fixed shape (req-75 W2) — or plain — is part
  // of the conversation (req-75 W2b): drawn with `questionNode` instead
  // of the card, the canvas look above the prompt box, which stays the
  // free answer; an option tap sends through the same path. Each option
  // pill carries a leading dot (T-0084); the recommended one's fills.
  const askSlot = el('div');
  askSlot.hidden = true;
  let askAnswered = false;
  const pickAnswer = (text: string): void => {
    askAnswered = true;
    void send(text);
  };
  waitCard.append(waitLabel, waitText, waitQuestions, waitActions);
  let shownWait = '';
  const paintWait = (run: RunInfo | null): void => {
    const waiting = run !== null && LIVE_RUN_STATES.includes(run.state) ? (run.waiting ?? null) : null;
    const questions = waiting?.questions ?? null;
    // A `QUESTION:` turn (shaped or plain) is the conversation's, not a
    // form; permission requests and OpenCode question forms keep the card.
    const ask = waiting !== null && waiting.kind === 'question' && questions === null ? waiting : null;
    const key = `${run?.id ?? ''}:${waiting?.kind ?? ''}@${waiting?.since ?? ''}`;
    const fresh = key !== shownWait;
    if (fresh) {
      askAnswered = false;
      if (waiting?.kind === 'question') {
        prompt.focus();
      }
    }
    shownWait = key;
    if (ask !== null) {
      askSlot.replaceChildren(questionNode({ onPick: pickAnswer, disabled: askAnswered }, ask, Date.now(), deps.othersLive?.() ?? 0));
      askSlot.hidden = false;
    } else {
      askSlot.replaceChildren();
      askSlot.hidden = true;
    }
    waitCard.hidden = ask !== null || waiting === null;
    if (waiting === null || ask !== null) {
      return;
    }
    waitLabel.textContent =
      waiting.kind === 'permission'
        ? 'The worker wants to do this — allow it?'
        : questions!.length > 1
          ? 'The worker asks you — pick the answers, or type your own below, one line per question'
          : 'The worker asks you — pick an answer, or type your own below';
    waitText.textContent = waiting.text;
    waitText.hidden = questions !== null;
    waitQuestions.hidden = questions === null;
    waitActions.hidden = waiting.kind !== 'permission';
    if (fresh && questions !== null) {
      paintQuestions(questions);
    }
  };

  const paint = (): void => {
    const run = deps.target();
    const active = run !== null && LIVE_RUN_STATES.includes(run.state);
    const detached = run !== null && run.state === 'detached';
    const reopenable = !detached && isReopenable(run);
    const startable = deps.startFor !== undefined && !active && (deps.canStart?.() ?? true);
    const typable = active || reopenable || startable;
    prompt.setReadOnly(!typable);
    const busy = active && run.turn !== 'idle';
    const queueing = busyTurn(run);
    const emptyBox = prompt.getContent().trim() === '' && attached.length === 0;
    stopBtn.hidden = !busy;
    setPrimaryAction(queueing);
    sendBtn.hidden = queueing && emptyBox;
    sendBtn.disabled = !typable;
    sendNowBtn.hidden = !queueing || emptyBox;
    plusBtn.disabled = !(active || reopenable);
    for (const chip of chips.children) {
      (chip as HTMLButtonElement).disabled = !typable;
    }
    paintWait(run);
    paintProgress(run);
    paintQueue(run);
    maybeFlush(run);
  };

  wrap.append(progress, askSlot, waitCard, chipsRow, queueBlock, box);
  paint();
  return {
    element: wrap,
    paint,
    dispose: () => {
      if (editing !== null) {
        editingLocks.delete(editing);
        editing = null;
      }
      prompt.dispose();
    },
  };
}
