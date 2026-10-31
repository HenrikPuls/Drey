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
import { answerText, type ShapedQuestion } from '../shared/question-shape';
import { formatTokens } from './worker-status';

const LIVE_RUN_STATES: readonly string[] = ['starting', 'running', 'stopping'];

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
  ['Continue', 'Continue where you left off.'],
  ['Status', 'Briefly summarise what you have done so far and what is left.'],
  ['Run checks', "Run the ticket's acceptance checks now and report the result."],
  ['Wrap up', 'Wrap up: finish the current step, update the ticket Log, and stop.'],
];

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
  readonly placeholder: string;
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
  const iconButton = (icon: string, label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = el('button', 'tickets-takeover-btn');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.append(api.ui.icon(icon, 13), document.createTextNode(label));
    b.addEventListener('click', onClick);
    return b;
  };
  const runId = (): string | null => deps.target()?.id ?? null;

  const promptWrap = el('div', 'tickets-takeover-prompt');
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
    const reopenable = target !== null && !active && target.state !== 'detached' && target.sessionRef !== null && deps.startFor === undefined;
    let id: string | null = active || reopenable ? (target?.id ?? null) : null;
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
      void send(text);
    },
  });
  prompt.element.classList.add('tickets-takeover-prompt-input');

  const composerBar = el('div', 'tickets-takeover-composer');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => {
    const picked = [...(fileInput.files ?? [])];
    fileInput.value = '';
    void addFiles(picked);
  });
  const plusBtn = el('button', 'tickets-takeover-plus');
  plusBtn.type = 'button';
  plusBtn.title = 'Attach files or pictures — the worker reads them from its worktree';
  plusBtn.setAttribute('aria-label', 'Attach files');
  plusBtn.append(api.ui.icon('plus', 15));
  plusBtn.addEventListener('click', () => fileInput.click());
  promptWrap.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files') === true) {
      event.preventDefault();
    }
  });
  promptWrap.addEventListener('drop', (event) => {
    const dropped = [...(event.dataTransfer?.files ?? [])];
    if (dropped.length > 0) {
      event.preventDefault();
      void addFiles(dropped);
    }
  });
  promptWrap.addEventListener(
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
  const composerSpacer = el('span', 'tickets-takeover-spacer');
  const stopBtn = iconButton('square', 'Stop', 'Stop the running turn — the session and its context stay, you can prompt it again', () => {
    const id = runId();
    if (id !== null) {
      void deps.mutate('Interrupting', () => deps.invoke('fleetControl', { action: 'interrupt', runId: id }));
    }
  });
  stopBtn.classList.add('tickets-takeover-btn-stop');
  const sendBtn = iconButton('corner-down-left', 'Send', 'Send the message — a working worker takes it into its turn', () => {
    void send(prompt.getContent());
  });
  sendBtn.classList.add('tickets-takeover-btn-primary');
  composerBar.append(plusBtn, fileInput, chips, composerSpacer, stopBtn, sendBtn);

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
  promptWrap.append(commandMenu, attachRow, prompt.element, composerBar);

  // What the worker waits on (req-64): its question — answered in the
  // prompt box below — or a tool call to approve with one of the buttons.
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
  // A question asked in the fixed shape (req-75 W2) renders as its parts
  // with one button per option — the prompt box below stays the free
  // answer, and an option tap sends through the same path.
  const waitShaped = el('div', 'tickets-question');
  waitShaped.hidden = true;
  const paintShaped = (shaped: ShapedQuestion): void => {
    waitShaped.replaceChildren(el('div', 'tickets-question-text', shaped.question));
    const lines: readonly (readonly [string, string | null])[] = [
      ['Ticket', shaped.context],
      ['Where', shaped.where],
      ['Why', shaped.why],
    ];
    for (const [label, value] of lines) {
      if (value !== null) {
        waitShaped.append(el('div', 'tickets-question-line', `${label}: ${value}`));
      }
    }
    const options = el('div', 'tickets-question-options');
    for (const option of shaped.options) {
      const b = el('button', `work-option${shaped.recommended === option.n ? ' work-option-recommended' : ''}`, option.label);
      b.type = 'button';
      if (option.consequence !== null) {
        b.append(document.createTextNode(' — '), el('span', 'work-option-why', option.consequence));
      }
      if (shaped.recommended === option.n) {
        b.append(el('span', 'work-option-flag', 'recommended'));
      }
      b.addEventListener('click', () => {
        for (const sibling of options.querySelectorAll('button')) {
          (sibling as HTMLButtonElement).disabled = true;
        }
        void send(answerText(option));
      });
      options.append(b);
    }
    waitShaped.append(options);
    if (shaped.recommended !== null) {
      const why = shaped.recommendationWhy !== null ? ` — ${shaped.recommendationWhy}` : '';
      waitShaped.append(el('div', 'tickets-question-rec', `Recommendation: ${shaped.recommended}${why}`));
    }
  };
  waitCard.append(waitLabel, waitText, waitShaped, waitQuestions, waitActions);
  let shownWait = '';
  const paintWait = (run: RunInfo | null): void => {
    const waiting = run !== null && LIVE_RUN_STATES.includes(run.state) ? (run.waiting ?? null) : null;
    waitCard.hidden = waiting === null;
    if (waiting === null) {
      shownWait = '';
      return;
    }
    const questions = waiting.questions ?? null;
    const shaped = questions === null && waiting.kind === 'question' ? (waiting.shaped ?? null) : null;
    waitLabel.textContent =
      waiting.kind === 'permission'
        ? 'The worker wants to do this — allow it?'
        : questions === null
          ? 'The worker asks you — answer below, it then goes on with its step'
          : questions.length > 1
            ? 'The worker asks you — pick the answers, or type your own below, one line per question'
            : 'The worker asks you — pick an answer, or type your own below';
    waitText.textContent = waiting.text;
    waitText.hidden = questions !== null || shaped !== null;
    waitShaped.hidden = shaped === null;
    waitQuestions.hidden = questions === null;
    waitActions.hidden = waiting.kind !== 'permission';
    const key = `${run?.id ?? ''}:${waiting.kind}@${waiting.since}`;
    if (key !== shownWait) {
      if (questions !== null) {
        paintQuestions(questions);
      }
      if (shaped !== null) {
        paintShaped(shaped);
      }
      if (waiting.kind === 'question') {
        prompt.focus();
      }
    }
    shownWait = key;
  };

  const paint = (): void => {
    const run = deps.target();
    const active = run !== null && LIVE_RUN_STATES.includes(run.state);
    const detached = run !== null && run.state === 'detached';
    // The takeover reopens an ended session on send; the thread starts a dialog instead.
    const reopenable = deps.startFor === undefined && run !== null && !active && !detached && run.sessionRef !== null;
    const startable = deps.startFor !== undefined && !active && (deps.canStart?.() ?? true);
    const typable = active || reopenable || startable;
    prompt.setReadOnly(!typable);
    const busy = active && run.turn !== 'idle';
    stopBtn.hidden = !busy;
    sendBtn.hidden = busy && prompt.getContent().trim() === '' && attached.length === 0;
    sendBtn.disabled = !typable;
    plusBtn.disabled = !(active || reopenable);
    for (const chip of chips.children) {
      (chip as HTMLButtonElement).disabled = !active;
    }
    paintWait(run);
    paintProgress(run);
  };

  wrap.append(progress, waitCard, promptWrap);
  paint();
  return {
    element: wrap,
    paint,
    dispose: () => prompt.dispose(),
  };
}
