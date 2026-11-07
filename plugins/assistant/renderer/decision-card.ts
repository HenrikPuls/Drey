// i18n: catalog
/**
 * The decision card above the composer (boards 7a, 7c, 7d): a question,
 * radio options (the recommended one first selected), "Or write your own
 * answer below" and one Send button that names the pick. Two sources:
 * the answer card of the active target's last message (a pick is sent as
 * the owner's next message), and the Review tab's own decision -- "Send
 * back with N comments", offered on every target, the Model's too, since
 * it asks the tab and not the model -- which the tab announces through a document
 * event (`plugins/tickets/renderer/review/events.ts`; the names are copied
 * here because a plugin never imports another plugin) and which a send
 * answers by asking the tab to do it.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { el } from './dom.js';
import type { TargetController } from './targets.js';
import { MODEL_TARGET } from './targets-model.js';

/** `drey:tickets-review-comments`: `detail` is `{ id, count }`. */
const REVIEW_COMMENTS = 'drey:tickets-review-comments';
/** `drey:tickets-review-send-back`: `detail` is `{ id, handled }`; a tab that took it sets `handled`. */
const REVIEW_SEND_BACK = 'drey:tickets-review-send-back';
/** `drey:tickets-review-accept`: the same shape; the tab runs the ticket's one accept. */
const REVIEW_ACCEPT = 'drey:tickets-review-accept';

interface DecisionOption {
  readonly label: string;
  readonly description?: string;
  readonly recommended: boolean;
  /** Runs the pick; resolves false when nothing took it. */
  readonly run: () => Promise<boolean>;
}

interface Decision {
  /** Stable while the same question stands, so the pick survives a re-render. */
  readonly key: string;
  readonly question: string;
  readonly options: readonly DecisionOption[];
}

export interface DecisionCard {
  /** The tray element the panel mounts above the composer. */
  readonly node: HTMLElement;
  render(): void;
  destroy(): void;
}

/** `**bold**` runs as <b>, everything else as text -- the question is one line of prose. */
function questionNode(text: string): HTMLElement {
  const line = el('p', 'decision-question');
  text.split('**').forEach((part, index) => {
    if (part === '') {
      return;
    }
    line.appendChild(index % 2 === 1 ? el('b', undefined, part) : document.createTextNode(part));
  });
  return line;
}

export function createDecisionCard(api: DreyPluginApi, targets: TargetController): DecisionCard {
  const node = el('div', 'target-tray');
  node.hidden = true;
  let selected: { key: string; index: number } | null = null;
  /** The ticket whose Review tab announced comments last, and how many. */
  let review: { id: string; count: number } | null = null;
  let sending = false;

  const onComments = (event: Event): void => {
    const detail = (event as CustomEvent<{ id: string; count: number }>).detail;
    review = detail.count > 0 ? { id: detail.id, count: detail.count } : review?.id === detail.id ? null : review;
    render();
  };
  document.addEventListener(REVIEW_COMMENTS, onComments);

  /** Asks the Review tab of `id` to do something; false when no such tab took it. */
  const askTab = (type: string, id: string): boolean => {
    const detail = { id, handled: false };
    document.dispatchEvent(new CustomEvent(type, { detail }));
    return detail.handled;
  };

  const current = (): Decision | null => {
    const answer = targets.activeId() === MODEL_TARGET ? null : targets.choices();
    if (answer !== null && (answer.choices ?? []).length > 0 && !targets.busy()) {
      return {
        key: answer.id,
        question: answer.text,
        options: (answer.choices ?? []).map((choice) => ({
          label: choice.label,
          recommended: choice.recommended === true,
          run: () => targets.send(choice.label),
        })),
      };
    }
    if (review !== null) {
      const { id, count } = review;
      return {
        key: `review:${id}:${count}`,
        question: api.i18n.t('assistant.review.question', { id }),
        options: [
          {
            label: api.i18n.t('decision.send_back_with_comments', { n: count }),
            description: api.i18n.t('assistant.review.send_back_hint'),
            recommended: true,
            run: () => Promise.resolve(askTab(REVIEW_SEND_BACK, id)),
          },
          {
            label: api.i18n.t('decision.accept'),
            description: api.i18n.t('assistant.review.accept_hint', { id }),
            recommended: false,
            run: () => Promise.resolve(askTab(REVIEW_ACCEPT, id)),
          },
        ],
      };
    }
    return null;
  };

  function render(): void {
    node.textContent = '';
    const decision = current();
    node.hidden = decision === null;
    if (decision === null) {
      selected = null;
      return;
    }
    if (selected === null || selected.key !== decision.key) {
      const recommended = decision.options.findIndex((option) => option.recommended);
      selected = { key: decision.key, index: Math.max(0, recommended) };
    }
    const pick = decision.options[selected.index] ?? decision.options[0];
    node.appendChild(questionNode(decision.question));
    const group = el('div', 'decision-options');
    group.setAttribute('role', 'radiogroup');
    decision.options.forEach((option, index) => {
      const row = el('button', 'decision-option' + (index === selected?.index ? ' on' : '')) as HTMLButtonElement;
      row.type = 'button';
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', String(index === selected?.index));
      row.appendChild(el('span', 'decision-radio')).appendChild(el('span', 'decision-dot'));
      row.appendChild(el('span', 'decision-label', option.label));
      if (option.description !== undefined) {
        const description = el('span', 'decision-description', option.description);
        description.title = option.description;
        row.appendChild(description);
      } else {
        row.appendChild(el('span', 'decision-description'));
      }
      if (option.recommended) {
        row.appendChild(el('span', 'decision-tag', api.i18n.t('assistant.decision.recommended')));
      }
      row.addEventListener('click', () => {
        selected = { key: decision.key, index };
        render();
      });
      group.appendChild(row);
    });
    node.appendChild(group);
    const foot = el('div', 'decision-foot');
    foot.appendChild(el('span', 'decision-own', api.i18n.t('assistant.decision.own_answer')));
    const send = el('button', 'decision-send', api.i18n.t('assistant.decision.send', { label: pick.label })) as HTMLButtonElement;
    send.type = 'button';
    send.disabled = sending || targets.busy();
    send.addEventListener('click', () => {
      sending = true;
      send.disabled = true;
      void pick.run().then((done) => {
        sending = false;
        if (!done && decision.key.startsWith('review:')) {
          review = null;
        }
        render();
      });
    });
    foot.appendChild(send);
    node.appendChild(foot);
  }

  return {
    node,
    render,
    destroy: () => document.removeEventListener(REVIEW_COMMENTS, onComments),
  };
}
