// i18n: catalog
/**
 * The desktop Autopilot popover (req-95b, board 10t): the three states as
 * rows (On / Paused with "Resume at {time}" / Off) and "Stop all running
 * steps now…" below, opened from the status item or `Mod+Alt+P`. Plain DOM
 * over the plugin's own classes; the state it shows is whatever `view()`
 * says when `refresh()` runs, so the fleet's SSE-driven updates repaint it
 * and nothing polls.
 */
import {
  AUTOPILOT_KINDS,
  autopilotToneOf,
  resumeAtOfTime,
  timeFieldOfResume,
  type AutopilotKind,
  type AutopilotView,
} from '../../../../shared/autopilot';
import type { Translate } from '../status-slot';
import type { AutopilotOutcome } from './controller';

export interface AutopilotPopoverDeps {
  readonly t: Translate;
  readonly view: () => AutopilotView | null;
  readonly set: (record: AutopilotView) => Promise<AutopilotOutcome>;
  readonly stopAll: () => Promise<AutopilotOutcome>;
  /** The locale's time of day (`api.i18n.formatTime`). */
  readonly formatTime: (date: Date) => string;
  readonly now?: () => Date;
}

export interface AutopilotPopover {
  readonly element: HTMLElement;
  /** Repaints from `view()`. */
  refresh(): void;
  close(): void;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  created.className = className;
  if (text !== undefined) {
    created.textContent = text;
  }
  return created;
}

export function openAutopilotPopover(deps: AutopilotPopoverDeps, onClosed: () => void = () => undefined): AutopilotPopover {
  const { t } = deps;
  const root = node('div', 'tickets-autopilot-pop');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', t('autopilot.title'));
  let armed = false;
  let error: string | null = null;
  let closed = false;

  const outside = (event: Event): void => {
    if (!root.contains(event.target as Node)) {
      close();
    }
  };
  const escape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      close();
    }
  };
  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    window.removeEventListener('mousedown', outside, true);
    window.removeEventListener('keydown', escape, true);
    root.remove();
    onClosed();
  }

  const settle = (outcome: AutopilotOutcome): boolean => {
    error = outcome.ok ? null : outcome.words;
    paint();
    return outcome.ok;
  };

  const pick = async (kind: AutopilotKind): Promise<void> => {
    if (deps.view()?.state === kind) {
      return;
    }
    const taken = settle(await deps.set({ state: kind }));
    if (taken && kind !== 'paused') {
      close();
    }
  };

  function paint(): void {
    const view = deps.view();
    root.replaceChildren();
    if (view === null) {
      return;
    }
    const rows = node('div', 'tickets-autopilot-rows');
    rows.setAttribute('role', 'radiogroup');
    rows.setAttribute('aria-label', t('autopilot.title'));
    for (const kind of AUTOPILOT_KINDS) {
      const row = node('button', `tickets-autopilot-row${view.state === kind ? ' tickets-autopilot-on' : ''}`);
      row.type = 'button';
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', String(view.state === kind));
      row.dataset['state'] = kind;
      const dot = node('span', 'tickets-autopilot-dot');
      dot.dataset['tone'] = autopilotToneOf(kind);
      row.append(dot, node('span', 'tickets-autopilot-label', t(`autopilot.state.${kind}`)));
      row.addEventListener('click', () => void pick(kind));
      rows.append(row);
      if (kind === 'paused' && view.state === 'paused') {
        const resume = node('div', 'tickets-autopilot-resume');
        const label = node(
          'label',
          'tickets-autopilot-resume-label',
          view.resumeAt === undefined
            ? t('autopilot.resume_time')
            : t('autopilot.resume_at', { time: deps.formatTime(new Date(view.resumeAt)) }),
        );
        const time = node('input', 'tickets-autopilot-time');
        time.type = 'time';
        time.id = 'tickets-autopilot-resume';
        label.htmlFor = time.id;
        time.value = timeFieldOfResume(view.resumeAt);
        time.setAttribute('aria-label', t('autopilot.resume_time'));
        time.addEventListener('change', () => {
          const at = resumeAtOfTime(time.value, (deps.now ?? (() => new Date()))());
          if (at !== null) {
            void deps.set({ state: 'paused', resumeAt: at }).then(settle);
          }
        });
        resume.append(label, time);
        rows.append(resume);
      }
    }
    const stop = node('button', `tickets-autopilot-row tickets-autopilot-stop${armed ? ' tickets-autopilot-armed' : ''}`);
    stop.type = 'button';
    stop.textContent = t(armed ? 'autopilot.stop_all.confirm' : 'autopilot.stop_all');
    stop.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        paint();
        return;
      }
      armed = false;
      void deps.stopAll().then((outcome) => {
        if (settle(outcome)) {
          close();
        }
      });
    });
    root.append(rows, stop);
    if (error !== null) {
      const note = node('p', 'tickets-autopilot-note', error);
      note.setAttribute('role', 'alert');
      root.append(note);
    }
  }

  paint();
  document.body.append(root);
  // Attached once the click that opened the popover has finished, so that click does not close it.
  setTimeout(() => {
    if (!closed) {
      window.addEventListener('mousedown', outside, true);
      window.addEventListener('keydown', escape, true);
    }
  }, 0);
  return { element: root, refresh: paint, close };
}
