// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the spec stands in for the host, which owns the catalog at runtime
import { i18n } from '../../../shared/i18n';
import type { ConversationCard, DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { createDecisionCard } from './decision-card';
import type { TargetController } from './targets';

const api = { i18n } as unknown as DreyPluginApi;

function controller(card: ConversationCard | null, send = vi.fn(() => Promise.resolve(true))): TargetController {
  return {
    activeId: () => 'tickets.mission-control',
    choices: () => card,
    busy: () => false,
    send,
  } as unknown as TargetController;
}

const QUESTION: ConversationCard = {
  id: 'q-1',
  kind: 'choices',
  text: 'How many parts? **Pick one.**',
  choices: [
    { label: '2 parts' },
    { label: '3 parts', recommended: true },
    { label: 'Keep it as one' },
  ],
};

const click = (node: Element | null | undefined): void => {
  node?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
};

describe('the decision card (boards 7a, 7c)', () => {
  it('selects the recommended option and names it on the Send button', () => {
    const card = createDecisionCard(api, controller(QUESTION));
    card.render();
    expect(card.node.hidden).toBe(false);
    expect(card.node.querySelector('.decision-question b')?.textContent).toBe('Pick one.');
    const on = card.node.querySelector('.decision-option.on .decision-label');
    expect(on?.textContent).toBe('3 parts');
    expect(card.node.querySelector('.decision-tag')?.textContent).toBe('recommended');
    expect(card.node.querySelector('.decision-send')?.textContent).toBe('Send “3 parts”');
  });

  it('a click selects, only Send sends the pick as the next message', () => {
    const send = vi.fn(() => Promise.resolve(true));
    const card = createDecisionCard(api, controller(QUESTION, send));
    card.render();
    click(card.node.querySelectorAll('.decision-option')[0]);
    expect(send).not.toHaveBeenCalled();
    expect(card.node.querySelector('.decision-send')?.textContent).toBe('Send “2 parts”');
    click(card.node.querySelector('.decision-send'));
    expect(send).toHaveBeenCalledWith('2 parts');
  });

  it('is hidden without an open answer card', () => {
    const card = createDecisionCard(api, controller(null));
    card.render();
    expect(card.node.hidden).toBe(true);
  });

  it('offers "Send back with N comments" while a Review tab announced comments, and asks that tab to do it', () => {
    const card = createDecisionCard(api, controller(null));
    card.render();
    const asked: string[] = [];
    document.addEventListener('drey:tickets-review-send-back', (event) => {
      const detail = (event as CustomEvent<{ id: string; handled: boolean }>).detail;
      asked.push(detail.id);
      detail.handled = true;
    });
    document.addEventListener('drey:tickets-review-accept', (event) => {
      const detail = (event as CustomEvent<{ id: string; handled: boolean }>).detail;
      asked.push(`${detail.id}:accept`);
      detail.handled = true;
    });
    document.dispatchEvent(new CustomEvent('drey:tickets-review-comments', { detail: { id: 'T-0121', count: 2 } }));
    expect(card.node.hidden).toBe(false);
    expect(card.node.querySelector('.decision-question')?.textContent).toBe('Your review of T-0121: what next?');
    expect([...card.node.querySelectorAll('.decision-label')].map((n) => n.textContent)).toEqual(['Send back with 2 comments', 'Accept']);
    click(card.node.querySelector('.decision-send'));
    expect(asked).toEqual(['T-0121']);
    click(card.node.querySelectorAll('.decision-option')[1]);
    click(card.node.querySelector('.decision-send'));
    expect(asked).toEqual(['T-0121', 'T-0121:accept']);
    card.destroy();
  });

  it('drops the Review option when the comments are gone', () => {
    const card = createDecisionCard(api, controller(null));
    document.dispatchEvent(new CustomEvent('drey:tickets-review-comments', { detail: { id: 'T-0121', count: 1 } }));
    expect(card.node.hidden).toBe(false);
    document.dispatchEvent(new CustomEvent('drey:tickets-review-comments', { detail: { id: 'T-0121', count: 0 } }));
    expect(card.node.hidden).toBe(true);
    card.destroy();
  });
});
