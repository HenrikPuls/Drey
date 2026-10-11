import type { DreyPluginApi, PluginRendererModule } from '../../../shared/plugin-api/renderer';
import { createSearchPanel } from './search-panel.js';
import { createSearchReplace } from './search-replace.js';
import { createSearchSession } from './search-session.js';
import { createSearchSummary } from './search-summary.js';
import { registerTagsSettingsPage } from './settings.js';

/**
 * The Tags plugin's renderer: the redesigned Search dock panel (scopes
 * file/vault/all, match-case / whole-word / regex toggles, a replace row
 * with a bundled per-file confirmation, tag chips through the shared tag
 * field, results grouped per file) plus the `search.open` command
 * (Mod+Shift+F, focus + the `{ tag }` payload base tag pills send) and the
 * Settings → Tags page (prefix colors). Milestone 33; tag completion and
 * the pills themselves live in base now.
 *
 * This file only wires the parts: `search-session.ts` (the query, the
 * hits, the run), `search-summary.ts`, `search-replace.ts` and
 * `search-panel.ts` (the DOM).
 */
const plugin: PluginRendererModule = {
  activate(api: DreyPluginApi) {
    registerTagsSettingsPage(api);

    const session = createSearchSession(api);
    const summary = createSearchSummary(api, session);
    const replace = createSearchReplace(api, session);
    const clear = (): void => {
      summary.cancel();
      session.clear();
    };
    const panel = createSearchPanel(api, session, summary, replace, clear);

    // -- search.open: Mod+Shift+F, focus + the pills' `{ tag }` payload -------
    api.commands.register({
      id: 'search.open',
      label: 'Search all notes',
      keybinding: 'Mod+Shift+F',
      run: (payload) => {
        const tag = (payload as { tag?: unknown } | undefined)?.tag;
        if (typeof tag === 'string' && tag !== '') {
          // A base tag pill click: reset the query to this tag, reveal + run.
          clear();
          session.state.queryTags = [tag.toLowerCase().replace(/^#/, '')];
          panel.resetText();
        }
        api.ui.revealWidget('search');
        session.notify();
        if (typeof tag === 'string' && tag !== '') {
          void session.run();
        }
        panel.focus();
      },
    });

    api.ui.registerWidget(panel.widget);
  },
};

export default plugin;
