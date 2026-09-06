/**
 * The dictionary side of the inline spellchecker. Lives in the main
 * process for two reasons: the Hunspell dictionaries are files on disk
 * (the renderer has no filesystem access, ADR-0001), and a loaded
 * dictionary is a multi-megabyte object that should exist once per app,
 * not once per editor surface.
 *
 * `nspell` is a pure-JS Hunspell implementation, so there is no native
 * module to rebuild per Electron version -- the reason it is preferred
 * here over a `nodehun`-style binding. German and English ship with the
 * app (`dictionary-de` / `dictionary-en`); anything else the user adds in
 * Settings is read from a `.aff`/`.dic` pair on disk.
 *
 * Everything is lazy and failure-tolerant: a dictionary that cannot be
 * loaded yields "no issues" rather than an exception, because a broken
 * checker must never break typing.
 */
import * as fsp from 'node:fs/promises';
import { BUNDLED_DICTIONARIES, CustomDictionary } from '../shared/app-config';
import { SpellCheckResult, SpellLanguage } from '../shared/ipc-api';
import { AppConfigStore } from './app-config';

// nspell ships no type declarations; the surface used here is small
// enough to describe locally rather than pull in a `@types` package.
interface NSpell {
  correct(word: string): boolean;
  suggest(word: string): string[];
}
type NSpellFactory = (aff: Uint8Array | string, dic: Uint8Array | string) => NSpell;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nspell = require('nspell') as NSpellFactory;

/** How many suggestions the popup offers. More than a few is a wall of text. */
const MAX_SUGGESTIONS = 5;

interface LoadedDictionary {
  spell: NSpell | null;
  error?: string;
}

export class SpellcheckService {
  /** Loaded (or failed) dictionaries by language id. */
  private readonly cache = new Map<string, LoadedDictionary>();

  constructor(private readonly config: AppConfigStore) {}

  /** Bundled + custom dictionaries, with their load state (Settings pane). */
  async listLanguages(): Promise<SpellLanguage[]> {
    const custom = this.config.get().spellcheck.dictionaries;
    const out: SpellLanguage[] = [];
    for (const bundled of BUNDLED_DICTIONARIES) {
      const loaded = await this.load(bundled.id);
      out.push({
        id: bundled.id,
        label: bundled.label,
        builtin: true,
        loaded: loaded.spell !== null,
        ...(loaded.error ? { error: loaded.error } : {}),
      });
    }
    for (const entry of custom) {
      const loaded = await this.load(entry.id);
      out.push({
        id: entry.id,
        label: entry.label,
        builtin: false,
        loaded: loaded.spell !== null,
        ...(loaded.error ? { error: loaded.error } : {}),
      });
    }
    return out;
  }

  /**
   * The words of `words` the active dictionary rejects, with suggestions.
   * Returns an empty list when spellcheck is off or the dictionary is
   * unavailable -- never throws.
   */
  async check(words: readonly string[]): Promise<SpellCheckResult> {
    const settings = this.config.get().spellcheck;
    if (!settings.enabled || words.length === 0) {
      return { language: settings.enabled ? settings.language : '', issues: [] };
    }
    const { spell } = await this.load(settings.language);
    if (!spell) {
      return { language: settings.language, issues: [] };
    }

    const issues: SpellCheckResult['issues'] = [];
    for (const word of words) {
      if (spell.correct(word)) {
        continue;
      }
      // A word that only fails on capitalisation ("montag" at the start of
      // a sentence is fine, "Montag" mid-sentence is too) is not worth a
      // squiggle -- offsets carry no sentence context up here.
      if (spell.correct(capitalize(word)) || spell.correct(word.toLowerCase())) {
        continue;
      }
      issues.push({ word, suggestions: spell.suggest(word).slice(0, MAX_SUGGESTIONS) });
    }
    return { language: settings.language, issues };
  }

  /** Drops cached dictionaries; called after the config changed. */
  invalidate(): void {
    this.cache.clear();
  }

  private async load(language: string): Promise<LoadedDictionary> {
    const cached = this.cache.get(language);
    if (cached) {
      return cached;
    }
    let loaded: LoadedDictionary;
    try {
      const custom = this.config
        .get()
        .spellcheck.dictionaries.find((entry) => entry.id === language);
      const files = custom
        ? await readPair(custom.affPath, custom.dicPath)
        : await loadBundled(language);
      loaded = { spell: nspell(files.aff, files.dic) };
    } catch (err) {
      loaded = { spell: null, error: err instanceof Error ? err.message : String(err) };
    }
    this.cache.set(language, loaded);
    return loaded;
  }
}

/**
 * `dictionary-de` / `dictionary-en` are ESM-only packages whose default
 * export is `{aff, dic}`; a dynamic `import()` is how a CommonJS main
 * process reaches them.
 */
async function loadBundled(language: string): Promise<{ aff: Uint8Array; dic: Uint8Array }> {
  const specifier =
    language === 'en' ? 'dictionary-en' : language === 'de' ? 'dictionary-de' : null;
  if (!specifier) {
    throw new Error(`Unknown dictionary: ${language}`);
  }
  const module = (await import(specifier)) as { default: { aff: Uint8Array; dic: Uint8Array } };
  return module.default;
}

async function readPair(
  affPath: string,
  dicPath: string,
): Promise<{ aff: Uint8Array; dic: Uint8Array }> {
  const [aff, dic] = await Promise.all([fsp.readFile(affPath), fsp.readFile(dicPath)]);
  return { aff, dic };
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
