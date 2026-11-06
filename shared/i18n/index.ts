/**
 * `shared/i18n` — the one message catalog and ICU runtime for every
 * user-visible string of the surfaces decided on 2026-11-06 (ADR-0091):
 * the loader, the `t(key, params)` facade, the `Intl` helpers and the
 * English catalog. Main imports the `i18n` instance below directly; the
 * Drey renderer (`src/app/i18n/`) and Mission Control
 * (`libs/mission-ui/src/i18n/`) wrap it in an Angular injectable; plugins
 * get it from the host as `api.i18n` / `ctx.i18n` and never import this
 * module at runtime (it carries the ICU library, which the plugin bundle
 * must not duplicate — the lint rule says so).
 *
 * This barrel is the module's only public surface.
 */

export type { Catalog, MessageKey, SupportedLocale } from './catalog';
export {
  DEFAULT_LOCALE,
  MESSAGE_KEY_PATTERN,
  SUPPORTED_LOCALES,
  catalogKeys,
  isMessageKey,
  loadCatalog,
  resolveLocale,
} from './catalog';
export type { CurrencyRange, DateStyle, I18n, MessageParams, MissingKeyReporter } from './types';
export type { I18nInstance, I18nOptions } from './facade';
export { createI18n, silentMissingKey, warnMissingKey } from './facade';
export { DEFAULT_CURRENCY } from './intl';

import { DEFAULT_LOCALE, loadCatalog } from './catalog';
import { createI18n } from './facade';

/**
 * The shared English instance — what the main process uses as is
 * (`i18n.t('autopilot.title')`), with `setMissingKeyReporter` for the
 * packaged/dev decision. The Angular bindings build their own instance
 * so a test can pass a spy reporter without touching this one.
 */
export const i18n = createI18n({ locale: DEFAULT_LOCALE, catalog: loadCatalog(DEFAULT_LOCALE) });
