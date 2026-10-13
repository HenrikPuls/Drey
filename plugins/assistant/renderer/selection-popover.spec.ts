// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSelectionPopover, openSelectionPopover } from './selection-popover';
import type { PromptEntry } from './prompts';

/**
 * The selection popover (milestone 74): a question field, the prompts and
 * the manual Actions; a choice closes it and reports what was chosen.
 */

const PROMPT: PromptEntry = {
  path: 'templates/prompts/kurz.md',
  title: 'Kurzfassung',
  description: 'Drei Sätze',
  body: 'Fasse das in drei Sätzen zusammen.',
};

const ANCHOR = { left: 40, top: 100, bottom: 118 };

function open(overrides?: { prompts?: PromptEntry[] }) {
  const onAsk = vi.fn();
  const onAction = vi.fn();
  const onDismiss = vi.fn();
  openSelectionPopover({
    anchor: ANCHOR,
    prompts: Promise.resolve(overrides?.prompts ?? [PROMPT]),
    actions: [{ triggerId: 'trigger:1', name: 'Reformat' }],
    onAsk,
    onAction,
    onDismiss,
  });
  const root = document.querySelector<HTMLElement>('.assistant-selection-popover');
  if (root === null) {
    throw new Error('popover not mounted');
  }
  return { root, onAsk, onAction, onDismiss };
}

const rowTitles = (root: HTMLElement): string[] =>
  Array.from(root.querySelectorAll('.selection-row .row-title')).map(
    (node) => node.textContent ?? '',
  );

const key = (target: Element, name: string): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
};

afterEach(() => {
  closeSelectionPopover();
});

describe('selection popover', () => {
  it('lists the prompts, then the manual actions, and focuses the question field', async () => {
    const { root } = open();
    await Promise.resolve();
    expect(rowTitles(root)).toEqual(['Kurzfassung', 'Reformat']);
    expect(root.querySelector('.selection-group')?.textContent).toBe('Actions');
    expect(document.activeElement).toBe(root.querySelector('.selection-question'));
  });

  it('shows the actions before the prompts have loaded', () => {
    const { root } = open();
    expect(rowTitles(root)).toEqual(['Reformat']);
  });

  it('sends a typed question on Enter and closes', () => {
    const { root, onAsk } = open();
    const input = root.querySelector<HTMLInputElement>('.selection-question')!;
    key(input, 'Enter');
    expect(onAsk).not.toHaveBeenCalled(); // empty field: nothing to send

    input.value = '  Was heißt das?  ';
    key(input, 'Enter');
    expect(onAsk).toHaveBeenCalledWith('Was heißt das?');
    expect(document.querySelector('.assistant-selection-popover')).toBeNull();
  });

  it('asks with a picked prompt body and runs a picked action', async () => {
    const first = open();
    await Promise.resolve();
    first.root.querySelector<HTMLButtonElement>('.selection-row')!.click();
    expect(first.onAsk).toHaveBeenCalledWith(PROMPT.body);

    const second = open({ prompts: [] });
    await Promise.resolve();
    second.root.querySelector<HTMLButtonElement>('.selection-row')!.click();
    expect(second.onAction).toHaveBeenCalledWith('trigger:1');
    expect(second.onDismiss).not.toHaveBeenCalled();
  });

  it('moves through the rows with the arrow keys', async () => {
    const { root } = open();
    await Promise.resolve();
    const input = root.querySelector<HTMLInputElement>('.selection-question')!;
    const rows = root.querySelectorAll<HTMLButtonElement>('.selection-row');
    key(input, 'ArrowDown');
    expect(document.activeElement).toBe(rows[0]);
    key(rows[0], 'ArrowDown');
    expect(document.activeElement).toBe(rows[1]);
    key(rows[1], 'ArrowUp');
    key(rows[0], 'ArrowUp');
    expect(document.activeElement).toBe(input);
  });

  it('dismisses on Escape and on a press outside', () => {
    const first = open();
    key(first.root, 'Escape');
    expect(first.onDismiss).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.assistant-selection-popover')).toBeNull();

    const second = open();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(second.onDismiss).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.assistant-selection-popover')).toBeNull();
  });

  it('keeps one popover at a time', () => {
    open();
    open();
    expect(document.querySelectorAll('.assistant-selection-popover')).toHaveLength(1);
  });
});
