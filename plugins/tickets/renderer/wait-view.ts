/**
 * The waiting worker's question drawn as part of the conversation
 * (req-75 W2b): no card chrome — the canvas's centre column. A lead-in
 * sentence with the question in bold, the why as a muted paragraph, one
 * pill per option with its consequence after a dash (the recommended
 * one marked, its reason in the title), and a muted meta line saying
 * how long the worker has stood here and whether anyone else keeps
 * going. A plain question (no shape) renders the lead-in and its text;
 * the free answer is the caller's prompt box below.
 */
import type { RunWaiting } from '../main/fleet/protocol';
import { answerText } from '../shared/question-shape';

/** What the ask view needs from its host: the answer path, and whether
 *  an answer is already under way (the pills stand by). */
export interface QuestionViewDeps {
  onPick(text: string): void;
  disabled: boolean;
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

/** The wait's age in one short word: `1 min`, `4 min`, `2 h`. */
function ageText(sinceIso: string, nowMs: number): string {
  const since = Date.parse(sinceIso);
  const minutes = Number.isNaN(since) ? 0 : Math.max(0, Math.floor((nowMs - since) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

/** `<age> ago · the worker waits, nothing else is blocked` — or, with
 *  other live runs, `; <n> other worker(s) keep going`. */
function metaText(waiting: RunWaiting, nowMs: number, othersLive: number): string {
  const others =
    othersLive > 0 ? `; ${othersLive} other ${othersLive === 1 ? 'worker keeps' : 'workers keep'} going` : ', nothing else is blocked';
  return `${ageText(waiting.since, nowMs)} ago · the worker waits${others}`;
}

/**
 * The DOM of a waiting run's question (`kind: 'question'`, with or
 * without a `shaped` parse). Permission requests and OpenCode question
 * forms are not drawn here — they keep the wait card.
 */
export function questionNode(deps: QuestionViewDeps, waiting: RunWaiting, nowMs: number, othersLive: number): HTMLElement {
  const root = el('div', 'tickets-ask');
  const shaped = waiting.shaped ?? null;
  const lead = el('p', 'tickets-ask-lead');
  if (shaped === null) {
    lead.append(document.createTextNode('The worker asks: '), el('span', 'tickets-ask-question', waiting.text));
    root.append(lead);
  } else {
    lead.append(document.createTextNode('One decision before I go on: '), el('b', 'tickets-ask-question', shaped.question));
    root.append(lead);
    if (shaped.why !== null) {
      root.append(el('p', 'tickets-ask-why', shaped.why));
    }
    const options = el('div', 'tickets-ask-options');
    const pills: HTMLButtonElement[] = [];
    for (const option of shaped.options) {
      const recommended = shaped.recommended === option.n;
      const b = el('button', `tickets-pill${recommended ? ' tickets-pill-recommended' : ''}`);
      b.type = 'button';
      // The recommendation's reason rides the recommended pill's title (W2b).
      b.title = recommended
        ? (shaped.recommendationWhy ?? option.consequence ?? option.label)
        : (option.consequence ?? option.label);
      // A leading dot marks the option row (T-0084); the recommended
      // one's dot fills and takes an accent ring.
      b.append(el('span', 'work-option-dot'), el('span', 'tickets-pill-label', option.label));
      if (option.consequence !== null) {
        b.append(el('span', 'tickets-pill-why', ` — ${option.consequence}`));
      }
      if (recommended) {
        b.append(el('span', 'tickets-pill-flag', 'recommended'));
      }
      b.disabled = deps.disabled;
      b.addEventListener('click', () => {
        for (const pill of pills) {
          pill.disabled = true;
        }
        deps.onPick(answerText(option));
      });
      pills.push(b);
      options.append(b);
    }
    root.append(options);
  }
  root.append(el('div', 'tickets-ask-meta', metaText(waiting, nowMs, othersLive)));
  return root;
}
