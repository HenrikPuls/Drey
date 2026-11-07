// @vitest-environment jsdom
// The spec plays the host: these are the modules the host hands a plugin as `api.editor.cm`.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { foldedRanges, foldEffect, unfoldEffect, codeFolding } from '@codemirror/language';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { EditorState, RangeSet, StateEffect, StateField } from '@codemirror/state';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- a spec builds the real catalog; the plugin itself gets it as `api.i18n`
import { i18n } from '../../../../shared/i18n';
import { renderVerificationSection } from '../../../../packages/tickets-engine/src/core/verification';
import { renderVerlaufLine } from '../../../../packages/tickets-engine/src/core/verlauf';
import type { DreyPluginApi, EditorSurfaceContext, FrontmatterViewInput } from '../../../../shared/plugin-api/renderer';
import type { BoardSnapshot } from '../../shared/tickets';
import { createTicketHeader, ticketLogFold } from '../ticket-header';
import { createTicketDocumentExtension } from './extension';
import { createTicketStrip } from './strip';

/**
 * D-23: a real store document (`id: t-30`, the flat format, `tickets/t/0000/t-30/ticket.md`,
 * opened from the checkout vault) against a board whose card has the stand-in path a
 * dricket card has. The specs of milestone 184 proved only `showsTicketDocument`.
 */
const PATH = 'tickets/t/0000/t-30/ticket.md';
const FRONTMATTER = ['---', 'id: t-30', 'title: M77 follow-ups: cross-vault', 'stage: inbox', 'owner: ', 'x-legacy-id: T-0030', '---'].join('\n');
const DOCUMENT = [
  FRONTMATTER,
  '',
  '## Description',
  '',
  'Text.',
  '',
  renderVerificationSection({
    testedAt: '2026-11-04T10:00:00Z',
    tester: 'verify@box',
    environment: 'Electron 34.2.0 on win32',
    criteria: [{ command: 'It works', passed: true, screenshot: null, note: null }],
    findings: [],
    video: null,
    videoChapters: [],
  }),
  '',
  '## Verlauf',
  '',
  renderVerlaufLine({ phase: 'plan', persona: 'paul', model: 'sonnet', tokens: '21k', cost: 0.31, dauer: '4m', ausgang: 'handed-over' }),
  '',
  '## Log',
  '',
  "- '2026-11-04T10:00:00Z' owner — created in inbox",
  '',
].join('\n');

const card = {
  id: 'T-0030',
  path: 'tickets/inbox/T-0030.md',
  phase: 'inbox',
  meta: { id: 'T-0030', title: 'From the board' },
  issues: [],
};
const snapshot = {
  vaultId: 'board',
  pipeline: [{ id: 'inbox', title: 'Inbox', handover: 'manual' }],
  columns: [{ unknown: false, phase: { id: 'inbox', title: 'Inbox', handover: 'manual' }, tickets: [card] }],
} as unknown as BoardSnapshot;

const context: EditorSurfaceContext = { vaultId: () => 'checkout', path: () => PATH } as unknown as EditorSurfaceContext;

const api = {
  i18n,
  ui: { icon: () => document.createElement('span') },
  documents: { open: vi.fn() },
  editor: {
    cm: {
      state: { StateField, StateEffect, RangeSet },
      view: { Decoration, EditorView, ViewPlugin, WidgetType },
      language: { foldEffect, unfoldEffect, foldedRanges },
    },
  },
} as unknown as DreyPluginApi;

afterEach(() => {
  document.body.replaceChildren();
});

function mount(extension: unknown): EditorView {
  const host = document.createElement('div');
  document.body.append(host);
  return new EditorView({
    parent: host,
    state: EditorState.create({ doc: DOCUMENT, extensions: [codeFolding(), extension as never] }),
  });
}

describe('the ticket header on a store document', () => {
  function header(invoke: (method: string, payload?: unknown) => Promise<unknown>): HTMLElement {
    const strip = createTicketStrip({ i18n, snapshot: () => snapshot, rowOf: () => null, invoke, onThread: vi.fn(), onReview: vi.fn() });
    const made = createTicketHeader({ api, snapshot: () => snapshot, invoke, onError: () => undefined, strip });
    return made.view.render({
      view: { state: { sliceDoc: () => FRONTMATTER, doc: { toString: () => DOCUMENT } }, dispatch: vi.fn(), focus: vi.fn() },
      frontmatter: FRONTMATTER,
      path: PATH,
      vaultId: 'checkout',
      expandRaw: vi.fn(),
    } as unknown as FrontmatterViewInput);
  }

  it("shows the card's phase, not the path's first folder (`t`)", () => {
    const root = header(() => new Promise(() => undefined));
    expect(root.querySelector('.tickets-head-phase')?.textContent).toBe('Inbox');
  });

  it('shows the id and the title from the card before main answers, and no issue', () => {
    const root = header(() => new Promise(() => undefined));
    expect(root.querySelector('.tickets-head-id')?.textContent).toBe('T-0030');
    expect((root.querySelector('.tickets-head-title') as HTMLInputElement).value).toBe('From the board');
    expect(root.querySelector('.tickets-issues')).toBeNull();
  });
});

describe('the document extension on a store document', () => {
  it('draws the proof from `id: t-30`', () => {
    const extension = createTicketDocumentExtension({
      api,
      snapshot: () => snapshot,
      rowOf: () => null,
      matches: () => true,
      actions: { openThread: vi.fn() },
      invoke: async () => ({ ok: false }),
      openFlow: vi.fn(),
    });
    const view = mount(extension.factory(context));
    expect(view.dom.querySelector('.tickets-doc-proof')).not.toBeNull();
    // An Inbox ticket says its cost on the card; the table starts with the work (7j).
    expect(view.dom.querySelector('.tickets-doc-cost')).toBeNull();
    view.destroy();
  });

  it('draws nothing while the text is another ticket (a tab switch in flight)', () => {
    const extension = createTicketDocumentExtension({
      api,
      snapshot: () => snapshot,
      rowOf: () => null,
      matches: () => true,
      actions: { openThread: vi.fn() },
      invoke: async () => ({ ok: false }),
      openFlow: vi.fn(),
    });
    const other: EditorSurfaceContext = { vaultId: () => 'checkout', path: () => 'tickets/t/0000/t-31/ticket.md' } as unknown as EditorSurfaceContext;
    const view = mount(extension.factory(other));
    expect(view.dom.querySelector('.tickets-doc-proof')).toBeNull();
    view.destroy();
  });
});

describe('the Log fold on a store document', () => {
  it('folds the Log of `id: t-30`', async () => {
    const view = mount(ticketLogFold(api, () => snapshot)(context));
    await Promise.resolve();
    let folded = 0;
    foldedRanges(view.state).between(0, view.state.doc.length, () => {
      folded += 1;
    });
    expect(folded).toBe(1);
    view.destroy();
  });
});
