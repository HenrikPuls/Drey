/**
 * `src/app/i18n` — the renderer's binding of the message catalog
 * (ADR-0091): the `I18nService` injectable and the `t` pipe. The catalog,
 * the facade and the Intl helpers live in `shared/i18n`.
 */
export { I18nService } from './i18n.service';
export { I18nPipe } from './i18n.pipe';
