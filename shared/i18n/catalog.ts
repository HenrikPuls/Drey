/**
 * The message catalogs (ADR-0091). One flat JSON file per locale under
 * `catalog/`: every key is `<area>.<thing>[.<state>]` in lower snake case,
 * every value an ICU MessageFormat string. English is the first and only
 * shipped locale; a locale this module does not know falls back to it,
 * so a caller never ends up without a catalog.
 *
 * The English file is also the **type** of a key: `MessageKey` is derived
 * from it, so a typo in `t('autopilot.state.onn')` is a compile error in
 * every runtime that imports this module (main, the Drey renderer,
 * Mission Control). Plugins reach the catalog through the host
 * (`api.i18n` / `ctx.i18n`) and may `import type { MessageKey }`.
 */
import en from './catalog/en.json';

/** The locales a catalog ships for. The first entry is the fallback. */
export const SUPPORTED_LOCALES = ['en'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** The locale every runtime starts in until a setting says otherwise. */
export const DEFAULT_LOCALE: SupportedLocale = 'en';

/** A key of the English catalog — the one every other locale must cover. */
export type MessageKey = keyof typeof en;

/** A loaded catalog: flat key → ICU message source. */
export type Catalog = Readonly<Record<string, string>>;

/**
 * The key grammar: areas and things in lower snake case, joined by dots,
 * at least two segments (`cost.so_far`, `autopilot.state.on`). The guard
 * spec and the catalog spec both hold every key to it.
 */
export const MESSAGE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$/;

/** True when `text` has the shape of a catalog key (not whether one exists). */
export function isMessageKey(text: string): text is MessageKey {
  return MESSAGE_KEY_PATTERN.test(text);
}

/**
 * Resolves a requested locale (`en`, `en-GB`, `de-DE`, …) to the shipped
 * catalog that serves it: the exact tag, then its language, then the
 * fallback. Never throws.
 */
export function resolveLocale(requested: string | null | undefined): SupportedLocale {
  if (requested === null || requested === undefined || requested === '') {
    return DEFAULT_LOCALE;
  }
  const lower = requested.toLowerCase();
  const exact = SUPPORTED_LOCALES.find((locale) => locale === lower);
  if (exact !== undefined) {
    return exact;
  }
  const language = lower.split(/[-_]/)[0];
  const byLanguage = SUPPORTED_LOCALES.find((locale) => locale === language);
  return byLanguage ?? DEFAULT_LOCALE;
}

/**
 * The catalog for a locale. Only `en` ships today; the function exists so
 * a second locale is one JSON file and one entry here, and so every
 * runtime loads its catalog the same way (a plain import — no fetch, no
 * file read, nothing asynchronous: the catalog is part of the bundle).
 */
export function loadCatalog(locale: string | null | undefined = DEFAULT_LOCALE): Catalog {
  switch (resolveLocale(locale)) {
    case 'en':
      return en;
  }
}

/** Every key of the English catalog, in file order. */
export function catalogKeys(): readonly MessageKey[] {
  return Object.keys(en) as MessageKey[];
}
