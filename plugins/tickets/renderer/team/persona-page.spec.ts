// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the spec stands in for the host, which owns the catalog at runtime
import { i18n } from '../../../../shared/i18n';
import type { PersonaView } from '../../shared/remote-protocol';
import type { BoardSnapshot } from '../../shared/tickets';
import type { DeskDeps } from '../desk-deps';
import { mountPersonaPage, personaWordCountOf } from './persona-page';
import type { TeamStore } from './team-store';

const view: PersonaView = { id: 'ben', title: 'Ben', role: 'builder', worker: 'opencode', model: 'qwen3-coder', pool: ['qwen3-coder', 'sonnet'], color: '#8ecbef', budget: 5, phases: ['build'] };

const OPEN_PROPOSAL = { id: 'imp-1', state: 'open', target: 'prompt.md', title: 'Add a line', evidence: ['a', 'b', 'c'], content: 'Suggested prompt', lesson: null, at: '', decidedAt: null };

let invoked: [string, unknown][];
let prompt: { text: string } | { error: Error };
let proposals: unknown[];
let replies: Record<string, unknown>;
let showDiff: ReturnType<typeof vi.fn>;
let opened: unknown[][];
let retitled: string[];
let backs: number;
let host: HTMLElement;
let dispose: (() => void) | null;

function depsOf(): DeskDeps {
  return {
    api: {
      i18n,
      vault: {
        readFile: async () => {
          if ('error' in prompt) {
            throw prompt.error;
          }
          return { content: prompt.text, modifiedMs: 1 };
        },
      },
      documents: {
        open: async (...args: unknown[]) => {
          opened.push(args);
        },
      },
      ui: { icon: () => document.createElementNS('http://www.w3.org/2000/svg', 'svg'), showDiff },
    } as unknown as DeskDeps['api'],
    snapshot: () => ({ vaultId: 'v1', pipeline: [{ id: 'plan', title: 'Plan', handover: 'agent plan-default' }, { id: 'build', title: 'Build', handover: 'agent build-default' }] }) as unknown as BoardSnapshot,
    runs: () => [],
    chain: () => ({ poolSize: { opencode: 2 } }) as never,
    invoke: async (method, payload) => {
      invoked.push([method, payload]);
      if (method === 'personaImprovements') {
        return { ok: true, persona: { skills: ['tdd'] }, proposals, openCount: proposals.length, frictionCount: 0 };
      }
      return replies[method] ?? { ok: true };
    },
    subscribe: () => () => undefined,
    mutate: async () => ({ ok: true }) as never,
    chainAction: async () => undefined,
    openTicket: () => undefined,
    newIdea: () => undefined,
    titleOf: () => null,
  };
}

function storeOf(): TeamStore {
  return {
    personas: () => [view],
    nameOf: () => 'Ben',
    loaded: () => true,
    error: () => '',
    refresh: async () => undefined,
    subscribe: () => () => undefined,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mount(): Promise<void> {
  dispose = mountPersonaPage(depsOf(), storeOf(), host, 'ben', { back: () => (backs += 1), retitle: (title) => retitled.push(title) });
  await settle();
}

const q = <T extends HTMLElement>(selector: string): T => {
  const node = host.querySelector<T>(selector);
  if (node === null) {
    throw new Error(`no ${selector}`);
  }
  return node;
};
const buttonOf = (name: string): HTMLButtonElement => {
  const button = [...host.querySelectorAll('button')].find((entry) => entry.textContent === name);
  if (button === undefined) {
    throw new Error(`no button ${name}`);
  }
  return button;
};
const type = (node: HTMLInputElement | HTMLTextAreaElement, text: string): void => {
  node.value = text;
  node.dispatchEvent(new Event('input'));
};
const stateText = (): string => q('.persona-head > .persona-muted').textContent ?? '';
const patches = (): unknown[] => invoked.filter(([method]) => method === 'personaPatch').map(([, payload]) => payload);

beforeEach(() => {
  invoked = [];
  prompt = { text: 'You are Ben.' };
  proposals = [OPEN_PROPOSAL];
  replies = {};
  showDiff = vi.fn(async () => undefined);
  opened = [];
  retitled = [];
  backs = 0;
  host = document.createElement('div');
  document.body.append(host);
  dispose = null;
});

afterEach(() => {
  // A test leaves no draft behind for the next: Discard clears the page's memory of it.
  const discard = [...host.querySelectorAll('button')].find((entry) => entry.textContent === 'Discard');
  discard?.click();
  dispose?.();
  host.remove();
});

describe('the Persona page (board 7k)', () => {
  it('draws the record: head, profile, work, instructions, skills', async () => {
    await mount();
    expect(q('.persona-head-name').textContent).toBe('Ben');
    expect(q('.persona-avatar-head').textContent).toBe('BE');
    expect(q('.persona-head').textContent).toContain('personas/ben/persona.md');
    expect(q<HTMLInputElement>('[data-field="title"]').value).toBe('Ben');
    expect(q<HTMLInputElement>('[data-field="role"]').value).toBe('Builder');
    expect(q<HTMLTextAreaElement>('.persona-text').value).toBe('You are Ben.');
    expect([...host.querySelectorAll('.persona-step')].map((node) => node.textContent)).toEqual(['Plan', '✓ Build']);
    expect([...host.querySelectorAll('.persona-pool-row')].map((node) => node.textContent)).toEqual(['1Local · qwen3-coder2 slots', '2Local · sonnetwhen Local is full2 slots']);
    expect(q('.persona-skill').textContent).toContain('skills/tdd.md');
    expect(stateText()).toBe('Saved');
    expect(retitled).toEqual(['Ben']);
    expect(personaWordCountOf('ben')).toBe(3);
  });

  it('shows the daily budget read-only: the patch cannot write it', async () => {
    await mount();
    const field = [...host.querySelectorAll('label')].find((label) => label.textContent?.includes('Daily budget'));
    const input = field?.querySelector('input');
    expect(input?.value).toBe('$5.00');
    expect(input?.readOnly).toBe(true);
  });

  it('draws nothing the engine does not serve', async () => {
    await mount();
    const text = host.textContent ?? '';
    for (const absent of ['Allowed to', 'Tell me when', 'One line', 'Upload picture', 'tokens at start', 'Preview full prompt', 'Add skill', 'committed']) {
      expect(text, absent).not.toContain(absent);
    }
  });

  it('a missing prompt.md is an empty prompt and stays writable', async () => {
    prompt = { error: new Error("ENOENT: no such file or directory, open 'prompt.md'") };
    await mount();
    expect(q<HTMLTextAreaElement>('.persona-text').disabled).toBe(false);
    expect(q<HTMLTextAreaElement>('.persona-text').value).toBe('');
    expect(buttonOf('Save').disabled).toBe(false);
  });

  it('a failed read disables the editor and Save, so an unread prompt is never overwritten', async () => {
    prompt = { error: new Error('EISDIR: illegal operation on a directory') };
    await mount();
    expect(q<HTMLTextAreaElement>('.persona-text').disabled).toBe(true);
    expect(buttonOf('Save').disabled).toBe(true);
    expect(stateText()).toContain('Could not read the instructions');
    buttonOf('Save').click();
    await settle();
    expect(patches()).toEqual([]);
  });

  it('a clean Save sends nothing', async () => {
    await mount();
    expect(buttonOf('Save').disabled).toBe(false);
    buttonOf('Save').click();
    await settle();
    expect(patches()).toEqual([]);
  });

  it('Save sends the changed keys once and returns to Saved', async () => {
    await mount();
    type(q<HTMLInputElement>('[data-field="title"]'), 'Benno');
    type(q<HTMLTextAreaElement>('.persona-text'), 'New prompt');
    expect(stateText()).toBe('Changed · not saved');
    buttonOf('Save').click();
    await settle();
    expect(patches()).toEqual([{ persona: 'ben', title: 'Benno', prompt: 'New prompt' }]);
    expect(stateText()).toBe('Saved');
    expect(q('.persona-head-name').textContent).toBe('Benno');
    expect(retitled.at(-1)).toBe('Benno');
  });

  it('shows the engine\'s refusal and keeps the draft', async () => {
    replies['personaPatch'] = { ok: false, error: 'the role is one of planner, builder' };
    await mount();
    type(q<HTMLInputElement>('[data-field="role"]'), 'Wizard');
    buttonOf('Save').click();
    await settle();
    expect(patches()).toEqual([{ persona: 'ben', role: 'wizard' }]);
    expect(stateText()).toBe('the role is one of planner, builder');
    expect(q<HTMLInputElement>('[data-field="role"]').value).toBe('Wizard');
  });

  it('refuses to overwrite a prompt that moved on disk since the page read it', async () => {
    await mount();
    type(q<HTMLTextAreaElement>('.persona-text'), 'Mine');
    prompt = { text: 'Written by Mission Control' };
    buttonOf('Save').click();
    await settle();
    expect(patches()).toEqual([]);
    expect(stateText()).toContain('changed on disk');
    expect(q<HTMLTextAreaElement>('.persona-text').value).toBe('Mine');
  });

  it('keeps the draft across a remount: switching tabs remounts the page', async () => {
    await mount();
    type(q<HTMLTextAreaElement>('.persona-text'), 'Half typed');
    dispose?.();
    dispose = null;
    await mount();
    expect(q<HTMLTextAreaElement>('.persona-text').value).toBe('Half typed');
    expect(stateText()).toBe('Changed · not saved');
  });

  it('Discard returns to the record', async () => {
    await mount();
    type(q<HTMLTextAreaElement>('.persona-text'), 'Half typed');
    buttonOf('Discard').click();
    expect(q<HTMLTextAreaElement>('.persona-text').value).toBe('You are Ben.');
    expect(stateText()).toBe('Saved');
  });

  it('adds a model to the pool and removes a skill, both only on Save', async () => {
    await mount();
    buttonOf('Add a model').click();
    const input = q<HTMLInputElement>('.persona-pool input');
    input.value = 'opus';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    q<HTMLButtonElement>('.persona-skill button').click();
    expect(host.querySelectorAll('.persona-pool-row')).toHaveLength(3);
    expect(host.querySelector('.persona-skill')).toBeNull();
    expect(patches()).toEqual([]);
    buttonOf('Save').click();
    await settle();
    expect(patches()).toEqual([{ persona: 'ben', pool: ['qwen3-coder', 'sonnet', 'opus'], skills: [] }]);
  });

  it('the Friction card shows the first open proposal; Show diff and Dismiss act on it', async () => {
    await mount();
    expect(q('.persona-friction').textContent).toContain('Suggested change from Friction · 3');
    expect(q('.persona-friction').textContent).toContain('Add a line');
    buttonOf('Show diff').click();
    expect(showDiff).toHaveBeenCalledWith(expect.objectContaining({ before: 'You are Ben.', after: 'Suggested prompt', path: 'personas/ben/prompt.md' }));
    proposals = [];
    buttonOf('Dismiss').click();
    await settle();
    expect(invoked).toContainEqual(['personaImprovementDecide', { persona: 'ben', proposal: 'imp-1', decision: 'dismissed' }]);
    expect(host.querySelector('.persona-friction')).toBeNull();
  });

  it('offers no diff for a proposal that does not rewrite the prompt, and no card without one', async () => {
    proposals = [{ ...OPEN_PROPOSAL, target: 'memory' }];
    await mount();
    expect([...host.querySelectorAll('.persona-friction button')].map((node) => node.textContent)).toEqual(['Dismiss']);
    dispose?.();
    host.replaceChildren();
    proposals = [];
    await mount();
    expect(host.querySelector('.persona-friction')).toBeNull();
  });

  it('Open as Markdown opens the persona file in its vault; Back to Crew goes back', async () => {
    await mount();
    buttonOf('Open as Markdown').click();
    expect(opened[0]?.[0]).toBe('tickets/_meta/personas/ben/persona.md');
    expect(opened[0]?.[2]).toMatchObject({ vaultId: 'v1' });
    buttonOf('Back to Crew').click();
    expect(backs).toBe(1);
  });
});
