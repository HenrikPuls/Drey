import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { SnippetConfig } from '../../../shared/config/schema';
import { BLOCKED_NODES, inFrontmatter, previewCard } from './slash.js';

/**
 * TWIN ALERT: this list is a verbatim twin of `SNIPPET_DEFAULTS` in
 * `shared/config/defaults.ts` — the seed the app config normalizer applies
 * to a missing key. Plugin renderers cannot value-import base `shared/`
 * (the module would resolve outside `plugin://<id>/` and the plugin
 * quarantines), so the restore button keeps its own copy. A parity spec
 * (`snippets.spec.ts`) asserts both lists stay equal; change them together.
 */
export const SNIPPET_DEFAULTS: SnippetConfig[] = [
  {
    trigger: 'tbl',
    label: 'Table',
    template: '| ${1:Column} | ${2:Column} | ${3:Column} |\n| --- | --- | --- |\n| ${4:} | ${5:} | ${6:} |',
  },
  {
    trigger: 'code',
    label: 'Code block',
    template: '```${1:ts}\n$0\n```',
  },
  {
    trigger: 'task',
    label: 'Checklist',
    template: '- [ ] ${1:First}\n- [ ] ${2:Second}\n- [ ] ${3:Third}',
  },
];

/**
 * Editor snippet completion (milestone 46): typing a trigger word — `tbl`,
 * `code`, `task`, or any user-defined one — offers a multi-line Markdown
 * block whose `${n:placeholder}` fields Tab walks (first-party
 * `snippetCompletion`; while a snippet is active its keymap is
 * `Prec.highest`, so `Tab` navigates fields and only otherwise falls
 * through to `editorIndentation`). The library is user-owned app config
 * (`templates.snippets`, ADR-0010): seeded with the three built-ins on a
 * missing key, then edited in Settings → Templates — defaults included.
 *
 * A plugin module (ADR-0044): built ONLY from `api.editor.cm.*` host
 * modules, mirroring the slash source's caret gate (`slash.ts`) — plus
 * every block-level structure, since a multi-line block inside a table
 * cell, heading, list item or quote is nonsense.
 */

/**
 * Syntax nodes the snippet source stays out of ON TOP of the slash gate's
 * inline set: block structures a multi-line insertion must not land in.
 */
const SNIPPET_BLOCKED_NODES = new Set([
  ...BLOCKED_NODES,
  'Table',
  'TableHeader',
  'TableRow',
  'TableCell',
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2',
  'ListItem',
  'BulletList',
  'OrderedList',
  'Blockquote',
]);

const SECTION = { name: 'Snippets', rank: 10 } as const;

/**
 * The snippet library as the renderer sees it: one mutable snapshot the
 * completion source reads synchronously (per keystroke) and the Settings
 * page writes through. `appConfig` has no change push, so the shared
 * store — not a re-read per popup — is what keeps the source current.
 */
export class SnippetStore {
  private items: readonly SnippetConfig[] = [];

  constructor(private readonly api: DreyPluginApi) {}

  get all(): readonly SnippetConfig[] {
    return this.items;
  }

  /** Loads the normalized library (seeded when the config key is absent). */
  async load(): Promise<void> {
    const config = await this.api.appConfig.get();
    this.items = config.templates.snippets;
  }

  /**
   * Persists the given library and publishes it to the source at once.
   * `appConfig.patch` merges only one level deep, so the whole
   * `templates` slice travels together (the dir setting does the same).
   */
  async replace(next: readonly SnippetConfig[]): Promise<void> {
    const current = await this.api.appConfig.get();
    await this.api.appConfig.patch({
      templates: { ...current.templates, snippets: [...next] },
    });
    this.items = [...next];
  }

  /** `dir` companion: persists the templates folder without losing snippets. */
  async replaceDir(dir: string): Promise<void> {
    const current = await this.api.appConfig.get();
    await this.api.appConfig.patch({
      templates: { ...current.templates, dir },
    });
  }
}

/** The template as the preview shows it: tabstop syntax stripped. */
export function expandForPreview(template: string): string {
  return template
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$\d+/g, '')
    .replace(/\\n/g, '\n');
}

/** True when one of `nodeNames` (caret → root) blocks a snippet insertion. */
export function snippetBlocked(nodeNames: readonly string[]): boolean {
  return nodeNames.some((name) => SNIPPET_BLOCKED_NODES.has(name));
}

/** The CodeMirror extension: a completion source on the Markdown language data. */
export function snippetExtension(api: DreyPluginApi, store: SnippetStore): unknown {
  const { language, langMarkdown, autocomplete } = api.editor.cm;

  const source = (context: CompletionContext): CompletionResult | null => {
    const token = context.matchBefore(/[\w-]+/);
    if (!token) {
      return null;
    }
    if (token.from > 0 && !/\s/.test(context.state.sliceDoc(token.from - 1, token.from))) {
      return null;
    }
    if (inFrontmatter(context.state.sliceDoc(), context.pos)) {
      return null;
    }
    const blocked: string[] = [];
    for (
      let node: { name: string; parent: unknown } | null = language
        .syntaxTree(context.state)
        .resolveInner(context.pos, -1);
      node !== null;
      node = node.parent as { name: string; parent: unknown } | null
    ) {
      blocked.push(node.name);
    }
    if (snippetBlocked(blocked)) {
      return null;
    }

    const query = token.text.toLowerCase();
    const matches = store.all.filter((snippet) => snippet.trigger.startsWith(query));
    if (matches.length === 0) {
      return null;
    }
    const options: Completion[] = matches.map((snippet) => ({
      ...autocomplete.snippetCompletion(snippet.template, {
        label: snippet.trigger,
        detail: snippet.label,
        type: 'snippet',
        boost: 5,
        section: SECTION,
        info: () => previewCard(snippet.label, expandForPreview(snippet.template)),
      }),
    }));
    return { from: token.from, options };
  };

  return langMarkdown.markdownLanguage.data.of({ autocomplete: source });
}
