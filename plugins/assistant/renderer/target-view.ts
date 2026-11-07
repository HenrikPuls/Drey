/**
 * The DOM of the conversation targets (E13-5): the segmented switcher in
 * the panel head, the thread of the active target (messages, relay chips,
 * proposal cards, error cards), the answer tray above the composer, and the
 * history list. Plain DOM over the controller; nothing here knows what a
 * target is (ADR-0044 rule 2).
 */
import type { ConversationCard, ConversationMessage, DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { createDecisionCard } from './decision-card.js';
import { el, icon, isIconName } from './dom.js';
import { renderRichBody } from './rich-text.js';
import type { TargetController } from './targets.js';
import { MODEL_TARGET, type TargetSegment } from './targets-model.js';

export interface TargetSwitcher {
  readonly node: HTMLElement;
  render(): void;
}

/** The segmented control: Model | one segment per target | a group's menu. */
export function createTargetSwitcher(api: DreyPluginApi, targets: TargetController): TargetSwitcher {
  const node = el('div', 'assistant-targets');
  node.setAttribute('role', 'tablist');
  node.setAttribute('aria-label', 'Conversation target');
  let menu: HTMLElement | null = null;
  let away: ((event: Event) => void) | null = null;
  const closeMenu = (): void => {
    menu?.remove();
    menu = null;
    if (away !== null) {
      document.removeEventListener('pointerdown', away, true);
      away = null;
    }
  };

  const openGroup = (segment: TargetSegment, anchor: HTMLElement): void => {
    closeMenu();
    const list = el('div', 'assistant-target-menu');
    for (const member of segment.targets) {
      const item = el('button', 'assistant-target-item' + (member.id === targets.activeId() ? ' on' : ''), member.label);
      (item as HTMLButtonElement).type = 'button';
      item.title = member.description ?? member.label;
      item.addEventListener('click', () => {
        closeMenu();
        targets.select(member.id);
      });
      list.appendChild(item);
    }
    node.appendChild(list);
    menu = list;
    list.style.left = `${anchor.offsetLeft}px`;
    away = (event: Event): void => {
      if (!list.contains(event.target as Node) && event.target !== anchor) {
        closeMenu();
      }
    };
    document.addEventListener('pointerdown', away, true);
  };

  return {
    node,
    render: () => {
      closeMenu();
      node.textContent = '';
      const segments = targets.segments();
      // Nothing registered besides the model: no switcher, the panel looks as before.
      node.hidden = segments.length < 2;
      const activeId = targets.activeId();
      for (const segment of segments) {
        const member = segment.targets.find((target) => target.id === activeId);
        const on = segment.key === MODEL_TARGET ? activeId === MODEL_TARGET : member !== undefined;
        const grouped = segment.key.startsWith('group:');
        const label = grouped && member !== undefined ? `${segment.label} · ${member.label}` : segment.label;
        const button = el('button', 'assistant-target' + (on ? ' on' : '')) as HTMLButtonElement;
        button.type = 'button';
        button.setAttribute('aria-label', label);
        const glyph = segment.key === MODEL_TARGET ? 'bubble' : (segment.targets[0]?.icon ?? 'sparkles');
        button.appendChild(isIconName(glyph) ? icon(glyph, 15) : api.ui.icon(glyph, 15));
        // The active segment names itself (boards 9a, 7a): the others stay icons.
        if (on) {
          button.appendChild(document.createTextNode(grouped && member !== undefined ? member.label : segment.label));
        }
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(on));
        button.title = grouped && member !== undefined ? label : segment.description;
        button.addEventListener('click', () => {
          if (grouped) {
            openGroup(segment, button);
          } else {
            targets.select(segment.key === MODEL_TARGET ? MODEL_TARGET : (segment.targets[0]?.id ?? MODEL_TARGET));
          }
        });
        node.appendChild(button);
      }
    },
  };
}

export interface TargetThreadView {
  readonly node: HTMLElement;
  /** The answer cards above the composer. */
  readonly tray: HTMLElement;
  render(): void;
}

function proposalNode(targets: TargetController, card: ConversationCard): HTMLElement {
  const box = el('div', 'target-card');
  box.appendChild(el('p', 'target-card-text', card.text));
  if (card.note !== undefined) {
    box.appendChild(el('p', 'target-card-note', card.note));
  }
  if ((card.actions ?? []).length > 0) {
    const row = el('div', 'target-card-actions');
    for (const action of card.actions ?? []) {
      const button = el('button', 'target-card-btn' + (action.tone === 'primary' ? ' primary' : ''), action.label) as HTMLButtonElement;
      button.type = 'button';
      button.disabled = targets.busy();
      button.addEventListener('click', () => void targets.act(card.id, action.id));
      row.appendChild(button);
    }
    box.appendChild(row);
  }
  return box;
}

function messageNode(api: DreyPluginApi, targets: TargetController, message: ConversationMessage): HTMLElement | null {
  // An open question lives in the decision card above the composer, not twice (board 7a).
  const open = message.cards?.find((card) => card.kind === 'choices');
  if (open !== undefined && open.text === message.text && !targets.busy() && (open.choices ?? []).length > 0) {
    return null;
  }
  const article = el('article', `card ${message.role === 'user' ? 'q' : 'a'} target-message`);
  if (message.error !== undefined) {
    article.classList.add('target-error');
    article.appendChild(el('div', 'card-label', 'ERROR'));
    article.appendChild(el('p', 'target-error-title', message.error.title));
    for (const line of message.error.lines) {
      article.appendChild(el('p', 'target-error-line', line));
    }
    return article;
  }
  if (message.role === 'agent') {
    // "Paul via Mission Control": plain words above the answer, no pill (board 7a).
    const label = el('div', 'card-label', message.author ?? '');
    if (message.via !== undefined) {
      label.appendChild(document.createTextNode(message.author === undefined ? '' : ' '));
      label.appendChild(el('span', 'relay-chip', message.via));
    }
    if (label.textContent !== '') {
      article.appendChild(label);
    }
  }
  if (message.thought !== undefined) {
    const thought = el('details', 'target-thought');
    thought.appendChild(el('summary', undefined, 'Thinking'));
    thought.appendChild(el('p', 'card-body', message.thought));
    article.appendChild(thought);
  }
  if (message.text !== '') {
    article.appendChild(message.role === 'agent' ? renderRichBody(api, message.text) : el('p', 'card-body', message.text));
  }
  for (const card of message.cards ?? []) {
    // Answer cards live above the composer, not in the thread.
    if (card.kind !== 'choices') {
      article.appendChild(proposalNode(targets, card));
    }
  }
  return article;
}

export function createTargetThread(api: DreyPluginApi, targets: TargetController): TargetThreadView {
  const node = el('div', 'assistant-thread target-thread');
  const decision = createDecisionCard(api, targets);
  const tray = decision.node;
  return {
    node,
    tray,
    render: () => {
      const shown = targets.activeId() !== MODEL_TARGET;
      node.hidden = !shown;
      if (!shown) {
        // The Review tab's decision is offered on the Model's chat too.
        decision.render();
        return;
      }
      const wasAtEnd = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
      node.textContent = '';
      const thread = targets.thread();
      if (thread === null) {
        node.appendChild(el('p', 'empty', 'Loading …'));
      } else {
        if (thread.messages.length === 0) {
          node.appendChild(el('p', 'empty', thread.notice ?? 'No messages yet.'));
        }
        for (const message of thread.messages) {
          const shownMessage = messageNode(api, targets, message);
          if (shownMessage !== null) {
            node.appendChild(shownMessage);
          }
        }
        if (thread.messages.length > 0 && thread.notice !== undefined) {
          node.appendChild(el('p', 'empty target-notice', thread.notice));
        }
      }
      if (targets.busy()) {
        node.appendChild(el('p', 'working', 'Working …'));
      }
      if (wasAtEnd) {
        node.scrollTop = node.scrollHeight;
      }
      decision.render();
    },
  };
}
