import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, Extension } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import type { FrontmatterViewContrib, FrontmatterViewInput } from '../../../shared/plugin-api/renderer';
import { frontmatterFieldCount } from './markdown-frontmatter';
import {
  foldDecorations,
  frontmatterExpandedOf,
  frontmatterFold,
  refreshFrontmatterView,
  setFrontmatterExpanded,
} from './frontmatter-fold';

const FM = '---\ntype: notiz\ntags:\n  - a\n  - b\ntitle: "x: y"\n---\n\n# Heading\n';

function state(
  doc: string,
  extensions: Extension = markdown({ base: markdownLanguage }),
): EditorState {
  return EditorState.create({ doc, extensions: [extensions] });
}

interface Entry {
  from: number;
  to: number;
  deco: Decoration;
}

function entries(set: DecorationSet): Entry[] {
  const out: Entry[] = [];
  set.between(0, Number.MAX_SAFE_INTEGER, (from, to, deco) => {
    out.push({ from, to, deco });
  });
  return out;
}

describe('frontmatterFieldCount', () => {
  it('counts only top-level keys, stopping at the closing fence', () => {
    // type, tags, title -- the `- a` / `- b` list items don't count.
    expect(frontmatterFieldCount(FM)).toBe(3);
  });

  it('is 0 when there is no frontmatter', () => {
    expect(frontmatterFieldCount('# Just a heading\n')).toBe(0);
  });

  it('counts a key whose value itself contains a colon once', () => {
    expect(frontmatterFieldCount('---\nwhen: 10:30\n---\n')).toBe(1);
  });
});

describe('foldDecorations', () => {
  it('adds nothing when the document has no frontmatter', () => {
    expect(entries(foldDecorations(state('# Heading\n'), false))).toEqual([]);
  });

  it('collapsed: one block replace widget spanning the frontmatter lines', () => {
    const all = entries(foldDecorations(state(FM), false));
    expect(all).toHaveLength(1);
    expect(all[0].from).toBe(0);
    // Ends at the close of the `---` line (offset of the trailing newline).
    expect(all[0].to).toBe(FM.indexOf('---\n\n') + 3);
    expect(all[0].deco.spec['block']).toBe(true);
    expect(all[0].deco.spec['widget']).toBeTruthy();
  });

  it('expanded: header widget replaces the opening fence, hides the closing fence, dims the YAML lines', () => {
    const all = entries(foldDecorations(state(FM), true));

    // One dim line per YAML field line -- the `---` fences are replaced, not dimmed.
    const dimLines = all.filter((e) => e.deco.spec['class'] === 'cm-fm-line');
    expect(dimLines.map((e) => e.from)).toEqual([4, 16, 22, 28, 34]);

    // Exactly two replaces, both block, position-ordered by `entries`.
    const replaces = all.filter((e) => e.deco.spec['class'] === undefined);
    expect(replaces).toHaveLength(2);
    const [open, close] = replaces;

    // Opening `---` -> the `⌄ Frontmatter` header widget.
    expect(open.from).toBe(0);
    expect(open.to).toBe(3);
    expect(open.deco.spec['block']).toBe(true);
    expect(open.deco.spec['widget']).toBeTruthy();

    // Closing `---` + the newline before it -> hidden, no widget.
    expect(close.from).toBe(FM.indexOf('---\n\n') - 1);
    expect(close.to).toBe(FM.indexOf('---\n\n') + 3);
    expect(close.deco.spec['block']).toBe(true);
    expect(close.deco.spec['widget']).toBeUndefined();
  });
});

describe('frontmatterFold extension', () => {
  it('starts collapsed and flips on the setFrontmatterExpanded effect', () => {
    let s = state(FM, [markdown({ base: markdownLanguage }), frontmatterFold()]);
    expect(frontmatterExpandedOf(s)).toBe(false);

    s = s.update({ effects: setFrontmatterExpanded.of(true) }).state;
    expect(frontmatterExpandedOf(s)).toBe(true);

    s = s.update({ effects: setFrontmatterExpanded.of(false) }).state;
    expect(frontmatterExpandedOf(s)).toBe(false);
  });

  it('reports false when the extension is not loaded', () => {
    expect(frontmatterExpandedOf(state(FM))).toBe(false);
  });
});

describe('a plugin frontmatter view (SDK 1.34)', () => {
  const match = (contrib: FrontmatterViewContrib) => ({ contrib, path: 'tickets/inbox/T-0001.md', vaultId: 'v1' });
  const widgetOf = (s: EditorState, expanded = false, view: FrontmatterViewContrib | null = null): WidgetType =>
    entries(foldDecorations(s, expanded, view === null ? null : match(view)))[0].deco.spec['widget'] as WidgetType;

  function recordingView(): { contrib: FrontmatterViewContrib; inputs: FrontmatterViewInput[] } {
    const inputs: FrontmatterViewInput[] = [];
    return {
      inputs,
      contrib: {
        matches: () => true,
        render: (input) => {
          inputs.push(input);
          const el = document.createElement('div');
          el.className = 'ticket-head';
          return el;
        },
      },
    };
  }

  it('takes the collapsed pill\'s place and receives the whole block', () => {
    const { contrib, inputs } = recordingView();
    const host = new EditorView({ state: state(FM) });
    const dom = widgetOf(state(FM), false, contrib).toDOM(host);
    expect(dom.classList.contains('ticket-head')).toBe(true);
    expect(dom.classList.contains('cm-fm-view')).toBe(true);
    expect(inputs[0].path).toBe('tickets/inbox/T-0001.md');
    expect(inputs[0].vaultId).toBe('v1');
    expect(inputs[0].frontmatter).toBe(FM.slice(0, FM.indexOf('---\n\n') + 3));
    host.destroy();
  });

  it('expandRaw shows the base YAML; the expanded view stays the base\'s', () => {
    const { contrib, inputs } = recordingView();
    const host = new EditorView({
      state: state(FM, [markdown({ base: markdownLanguage }), frontmatterFold({ view: () => match(contrib) })]),
    });
    widgetOf(host.state, false, contrib).toDOM(host);
    inputs[0].expandRaw();
    expect(frontmatterExpandedOf(host.state)).toBe(true);
    expect(entries(foldDecorations(host.state, true, match(contrib))).some((e) => e.deco.spec['class'] === 'cm-fm-line')).toBe(true);
    host.destroy();
  });

  it('a render that throws falls back to the pill', () => {
    const broken: FrontmatterViewContrib = {
      matches: () => true,
      render: () => {
        throw new Error('boom');
      },
    };
    const host = new EditorView({ state: state(FM) });
    expect(widgetOf(state(FM), false, broken).toDOM(host).classList.contains('cm-fm-pill')).toBe(true);
    host.destroy();
  });

  it('draws again only when the frontmatter text changes', () => {
    const { contrib } = recordingView();
    const a = widgetOf(state(FM), false, contrib);
    expect(a.eq(widgetOf(state(FM + 'more body\n'), false, contrib))).toBe(true);
    expect(a.eq(widgetOf(state(FM.replace('notiz', 'ticket')), false, contrib))).toBe(false);
  });

  it('a refresh effect looks the view up again', () => {
    let current: FrontmatterViewContrib | null = null;
    const { contrib } = recordingView();
    let s = state(FM, [markdown({ base: markdownLanguage }), frontmatterFold({ view: () => (current === null ? null : match(current)) })]);
    current = contrib;
    s = s.update({ effects: refreshFrontmatterView.of(null) }).state;
    const host = new EditorView({ state: s });
    const dom = host.dom.querySelector('.ticket-head');
    expect(dom).not.toBeNull();
    host.destroy();
  });
});
