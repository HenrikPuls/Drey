import * as cmAutocomplete from '@codemirror/autocomplete';
import * as cmLangMarkdown from '@codemirror/lang-markdown';
import * as cmLanguage from '@codemirror/language';
import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';
import type { CodeMirrorModules } from '../../../shared/plugin-api/renderer';

/**
 * The HOST's `@codemirror/*` module instances, handed to plugins through
 * `api.editor.cm` (ADR-0044 rule 1). CodeMirror extensions only compose
 * from the same module instances the editor uses; a plugin bundling its
 * own copies would produce silently incompatible facets. This is the one
 * file that imports CM for value.
 */
export const HOST_CODEMIRROR: CodeMirrorModules = {
  state: cmState,
  view: cmView,
  autocomplete: cmAutocomplete,
  language: cmLanguage,
  langMarkdown: cmLangMarkdown,
};
