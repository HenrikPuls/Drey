// i18n: catalog
import type { DreyPluginApi, PluginRendererModule } from '../../../shared/plugin-api/renderer';
import { createFindPanel, SEARCH_MODE } from './find-panel.js';
import { createSearchReplace } from './search-replace.js';
import { createSearchSession } from './search-session.js';
import { createSearchSummary } from './search-summary.js';
import { registerTagsSettingsPage } from './settings.js';

/**
 * The Tags plugin's renderer: the Find dock panel (req-161, SDK 1.54) — the
 * Search mode (scopes note/vault/all, match-case / whole-word / regex,
 * replace with a bundled per-file confirmation, results grouped per file)
 * plus a home for every mode other plugins register, Tasks first — through
 * the shared tag field, plus the `search.open` command (Mod+Shift+F, focus +
 * the `{ tag }` payload base tag pills send), `find.mode` and the
 * Settings → Tags page (prefix colors). Milestone 33 / 210; tag completion
 * and the pills themselves live in base.
 *
 * This file only wires the parts: `search-session.ts` (the query, the
 * hits, the run), `search-summary.ts`, `search-replace.ts`,
 * `find-panel.ts` (the DOM) and `find-menu.ts` (the `⋯` menu).
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
    const panel = createFindPanel(api, session, summary, replace, clear);

    // -- search.open: Mod+Shift+F, focus + the pills' `{ tag }` payload -------
    api.commands.register({
      id: 'search.open',
      label: api.i18n.t('find.command.search'),
      keybinding: 'Mod+Shift+F',
      run: (payload) => {
        const tag = (payload as { tag?: unknown } | undefined)?.tag;
        panel.showMode(SEARCH_MODE);
        if (typeof tag === 'string' && tag !== '') {
          // A base tag pill click: reset the query to this tag, reveal + run.
          clear();
          session.state.queryTags = [tag.toLowerCase().replace(/^#/, '')];
          panel.resetText();
        }
        api.ui.revealWidget('find');
        session.notify();
        if (typeof tag === 'string' && tag !== '') {
          void session.run();
        }
        panel.focus();
      },
    });

    // -- find.mode: reveal Find in a registered mode (the due-date reminders' click) --
    api.commands.register({
      id: 'find.mode',
      label: api.i18n.t('find.command.mode'),
      run: (payload) => {
        const mode = (payload as { mode?: unknown } | undefined)?.mode;
        if (typeof mode === 'string' && mode !== '') {
          panel.showMode(mode);
        }
        api.ui.revealWidget('find');
        session.notify();
      },
    });

    api.ui.registerWidget(panel.widget);
  },
};

export default plugin;
