// i18n: catalog
/**
 * The desktop Autopilot popover (req-95b, D-36, board Autopilot "Desktop ·
 * status bar"): anchored above the status item, a title row with the chord,
 * a segmented On | Paused | Off, the state's one sentence, chips for the
 * resume time and today's cost, and "Stop all running steps now…" below a
 * divider. Opened from the status item or `Mod+Alt+P`. Plain DOM over the
 * plugin's own classes, built once: `refresh()` only updates it from `view()`,
 * so the fleet's SSE-driven updates repaint it without polling and without
 * taking away a button under the pointer.
 */
import {
  AUTOPILOT_KINDS,
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
  /** The chord shown in the title row. */
  readonly chord: string;
  /** The status item's "$4.10 of $15 today"; null = nothing known (no chip). */
  readonly costText: () => string | null;
  /** The status item the popover sits above; null keeps the stylesheet's corner. */
  readonly anchor?: () => HTMLElement | null;
  readonly now?: () => Date;
}

export interface AutopilotPopover {
  readonly element: HTMLElement;
  /** Repaints from `view()`. */
  refresh(): void;
  close(): void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** On the board the popover's right edge stands this far right of the item's. */
const ANCHOR_OVERHANG_PX = 51;
const WINDOW_MARGIN_PX = 8;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  created.className = className;
  if (text !== undefined) {
    created.textContent = text;
  }
  return created;
}

/** The board's 16 px outline glyphs: play, pause, stop. */
function glyph(kind: AutopilotKind): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (kind === 'off') {
    const rect = document.createElementNS(SVG_NS, 'rect');
    for (const [name, value] of [['x', '6'], ['y', '6'], ['width', '12'], ['height', '12'], ['rx', '2']] as const) {
      rect.setAttribute(name, value);
    }
    svg.append(rect);
  } else {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', kind === 'on' ? 'M7 4l13 8-13 8z' : 'M8 5v14M16 5v14');
    svg.append(path);
  }
  return svg;
}

export function openAutopilotPopover(deps: AutopilotPopoverDeps, onClosed: () => void = () => undefined): AutopilotPopover {
  const { t } = deps;
  const root = node('div', 'tickets-autopilot-pop');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', t('autopilot.title'));
  const previousFocus = document.activeElement;
  let armed = false;
  let error: string | null = null;
  let closed = false;
  /** The open time field; while there is one, a repaint leaves the chips alone. */
  let timeField: HTMLInputElement | null = null;

  const settle = (outcome: AutopilotOutcome): boolean => {
    error = outcome.ok ? null : outcome.words;
    paint();
    return outcome.ok;
  };

  const pick = async (kind: AutopilotKind): Promise<void> => {
    if (deps.view()?.state !== kind) {
      settle(await deps.set({ state: kind }));
    }
  };

  /** What the field holds, as a write; null = nothing to change. */
  const recordOfField = (field: HTMLInputElement): AutopilotView | null => {
    const current = deps.view()?.resumeAt;
    if (field.validity.badInput || field.value === timeFieldOfResume(current)) {
      return null;
    }
    if (field.value === '') {
      return { state: 'paused' };
    }
    const resumeAt = resumeAtOfTime(field.value, (deps.now ?? (() => new Date()))());
    return resumeAt === null ? null : { state: 'paused', resumeAt };
  };

  const endTimeEdit = (commit: boolean): void => {
    const field = timeField;
    if (field === null) {
      return;
    }
    const record = commit ? recordOfField(field) : null;
    // Cleared first: taking the field out of the DOM fires its own blur.
    timeField = null;
    paint();
    if (record !== null) {
      void deps.set(record).then(settle);
    }
  };

  const outside = (event: Event): void => {
    const target = event.target as Node;
    // The status item toggles on its own click; closing here would reopen it there.
    if (!root.contains(target) && deps.anchor?.()?.contains(target) !== true) {
      close();
    }
  };
  const escape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') {
      return;
    }
    if (timeField !== null) {
      endTimeEdit(false);
      return;
    }
    close();
  };
  const place = (): void => {
    const anchor = deps.anchor?.() ?? null;
    if (anchor !== null) {
      const fromRight = window.innerWidth - anchor.getBoundingClientRect().right - ANCHOR_OVERHANG_PX;
      root.style.right = `${Math.max(WINDOW_MARGIN_PX, fromRight)}px`;
    }
  };
  function close(): void {
    if (closed) {
      return;
    }
    endTimeEdit(true);
    closed = true;
    window.removeEventListener('mousedown', outside, true);
    window.removeEventListener('keydown', escape, true);
    window.removeEventListener('resize', place);
    root.remove();
    if (previousFocus instanceof HTMLElement) {
      previousFocus.focus();
    }
    onClosed();
  }

  const head = node('div', 'tickets-autopilot-head');
  head.append(node('b', 'tickets-autopilot-title', t('autopilot.title')), node('span', 'tickets-autopilot-chord', deps.chord));

  const seg = node('div', 'tickets-autopilot-seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', t('autopilot.title'));
  const radios = AUTOPILOT_KINDS.map((kind) => {
    const radio = node('button', 'tickets-autopilot-radio');
    radio.type = 'button';
    radio.setAttribute('role', 'radio');
    radio.dataset['state'] = kind;
    radio.append(glyph(kind), t(`autopilot.state.${kind}`));
    radio.addEventListener('click', () => void pick(kind));
    return radio;
  });
  seg.append(...radios);
  seg.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    const at = radios.indexOf(document.activeElement as HTMLButtonElement);
    if (step === 0 || at < 0) {
      return;
    }
    event.preventDefault();
    const next = (at + step + radios.length) % radios.length;
    radios[next]!.focus();
    void pick(AUTOPILOT_KINDS[next]!);
  });

  const sentence = node('span', 'tickets-autopilot-sentence');
  const chips = node('div', 'tickets-autopilot-chips');
  const divider = node('div', 'tickets-autopilot-divider');
  const stopLabel = node('span', 'tickets-autopilot-stop-label');
  const stop = node('button', 'tickets-autopilot-stop');
  stop.type = 'button';
  stop.append(glyph('off'), stopLabel);
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
  const note = node('p', 'tickets-autopilot-note');
  note.setAttribute('role', 'alert');
  root.append(head, seg, sentence, chips, divider, stop, note);

  /** Paused only: the engine takes no resume time on any other state. */
  const resumeChip = (view: AutopilotView): HTMLElement => {
    const chip = node(
      'button',
      'tickets-autopilot-chip tickets-autopilot-resume',
      view.resumeAt === undefined
        ? t('autopilot.resume_time')
        : t('autopilot.resume_at', { time: deps.formatTime(new Date(view.resumeAt)) }),
    );
    chip.type = 'button';
    chip.addEventListener('click', () => {
      const field = node('input', 'tickets-autopilot-time');
      field.type = 'time';
      field.value = timeFieldOfResume(view.resumeAt);
      field.setAttribute('aria-label', t('autopilot.resume_time'));
      field.addEventListener('blur', () => endTimeEdit(true));
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          endTimeEdit(true);
        }
      });
      timeField = field;
      chip.replaceWith(field);
      field.focus();
    });
    return chip;
  };

  const paintChips = (view: AutopilotView): void => {
    if (timeField !== null && view.state !== 'paused') {
      timeField = null;
    }
    if (timeField !== null) {
      return;
    }
    chips.replaceChildren();
    if (view.state === 'paused') {
      chips.append(resumeChip(view));
    }
    const cost = deps.costText();
    if (cost !== null) {
      chips.append(node('span', 'tickets-autopilot-chip', cost));
    }
    chips.hidden = chips.childElementCount === 0;
  };

  function paint(): void {
    const view = deps.view();
    root.hidden = view === null;
    if (view === null) {
      return;
    }
    radios.forEach((radio, index) => {
      const checked = AUTOPILOT_KINDS[index] === view.state;
      radio.setAttribute('aria-checked', String(checked));
      radio.tabIndex = checked ? 0 : -1;
    });
    sentence.textContent = t(`autopilot.sentence.${view.state}`);
    paintChips(view);
    stop.classList.toggle('tickets-autopilot-armed', armed);
    stopLabel.textContent = t(armed ? 'autopilot.stop_all.confirm' : 'autopilot.stop_all');
    note.hidden = error === null;
    note.textContent = error ?? '';
  }

  paint();
  document.body.append(root);
  place();
  radios.find((radio) => radio.tabIndex === 0)?.focus();
  // Attached once the click that opened the popover has finished, so that click does not close it.
  setTimeout(() => {
    if (!closed) {
      window.addEventListener('mousedown', outside, true);
      window.addEventListener('keydown', escape, true);
      window.addEventListener('resize', place);
    }
  }, 0);
  return { element: root, refresh: paint, close };
}
