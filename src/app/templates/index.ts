/**
 * `src/app/templates` — the template library: the configured vault folder
 * of reusable Markdown, its dock panel, the `Mod+T` picker, and the
 * renderer-owned editor context menu that replaces the OS menu (ADR-0029,
 * ADR-0030).
 *
 * This barrel is the module's public surface — code outside the module
 * imports from `../templates`. (The boundary is not ESLint-enforced: a
 * plain `src/app/settings/templates/` folder already exists, so a
 * `templates` path pattern would flag innocent imports — same reason `llm`
 * is left out of `eslint.config.mjs`.)
 */

export {
  TemplateLibraryService,
  type TemplateCategory,
  type TemplateEntry,
} from './template-library.service';
export { TemplatesPanel } from './templates-panel/templates-panel';
export { TemplatePicker } from './template-picker/template-picker';
export { EditorContextMenu } from './editor-context-menu/editor-context-menu';
export { EditorContextMenuService } from './editor-context-menu/editor-context-menu.service';
