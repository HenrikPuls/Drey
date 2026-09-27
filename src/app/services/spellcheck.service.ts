import { Injectable, computed, inject, signal } from '@angular/core';
import { BUNDLED_DICTIONARIES } from '../../../shared/app-config';
import { CustomDictionary, SpellLanguage } from '../../../shared/ipc-api';
import { AddWordTarget, SpellcheckSource } from '../editor/spellcheck/spellcheck';
import {
  LanguageDetector,
  createLanguageDetector,
} from '../editor/spellcheck/language-detect';
import { SettingsService } from './settings.service';

/**
 * The renderer half of the inline spellchecker: turns the app config plus
 * the `spell:check` IPC channel into a `SpellcheckSource` the CodeMirror
 * extension can consume, and holds the dictionary list the Settings pane
 * shows.
 *
 * Two caches sit in the middle. Typing re-checks the whole field on every
 * pause, and the overwhelming majority of those words were already judged
 * a keystroke ago -- without the verdict cache each pause would ship the
 * entire text across the IPC boundary. Suggestions get their own cache (+
 * singleflight) because they are fetched lazily, per clicked word, and a
 * popup re-open must not re-pay the IPC round trip. Both are keyed by
 * language so switching dictionaries cannot serve a stale verdict -- the
 * same keying carries the per-paragraph auto-detect (ADR-0056), where one
 * document mixes verdicts from several dictionaries.
 *
 * Language detection itself lives in `language-detect.ts`; this service
 * owns its policy inputs (fallback language, installed dictionaries) and
 * the detector instance.
 */
@Injectable({ providedIn: 'root' })
export class SpellcheckService {
  private readonly settings = inject(SettingsService);

  /** `<language> <word>` -> whether the dictionary rejects it. */
  private readonly verdicts = new Map<string, boolean>();

  /** `<language> <word>` -> suggestions (popup fetch, cached). */
  private readonly suggestions = new Map<string, readonly string[]>();

  /** In-flight suggestion fetches, so a re-open joins the first request. */
  private readonly suggesting = new Map<string, Promise<readonly string[]>>();

  /** Bundled + custom dictionaries with their load state (Settings pane). */
  readonly languages = signal<SpellLanguage[]>([]);
  readonly languagesLoading = signal(false);

  /** The master switch from the persisted config (never the draft). */
  readonly enabled = computed<boolean>(() => this.settings.config()?.spellcheck.enabled ?? false);
  readonly language = computed<string>(() => this.settings.config()?.spellcheck.language ?? 'de');
  readonly autoDetect = computed<boolean>(
    () => this.settings.config()?.spellcheck.autoDetect ?? true,
  );

  /**
   * Paragraph language detection. Options are read live, so one instance
   * tracks the config; `invalidate()` clears its block cache because a
   * changed dictionary set or fallback language can change the verdict.
   */
  private readonly detector: LanguageDetector = createLanguageDetector({
    fallback: () => this.language(),
    installed: () => this.installedLanguages(),
  });

  /** The active dictionary's display label ("Deutsch"), falling back to its id. */
  readonly activeLanguageLabel = computed<string>(() => {
    const id = this.language();
    return this.languages().find((entry) => entry.id === id)?.label ?? id;
  });

  private get api() {
    return typeof window !== 'undefined' ? window.dreyApi : undefined;
  }

  /**
   * A source for the CodeMirror extension. `gate` is the caller's own
   * precondition -- the entry drawer passes "this draft has a topic,
   * person or meeting", which is where the drawer spec puts the rule.
   */
  makeSource(gate: () => boolean = () => true): SpellcheckSource {
    return {
      enabled: () => this.enabled() && gate(),
      check: (words, language) => this.check(words, language),
      suggest: (word, language) => this.suggest(word, language),
      addWord: (word, target, language) => this.addWord(word, target, language),
      wordTargets: (language) => ({
        language: this.languageLabel(language ?? this.language()),
        personal: 'personal words',
      }),
      blockLanguage: (block) => this.blockLanguage(block),
    };
  }

  /**
   * The dictionary id for one paragraph: the detected language's
   * dictionary when auto-detect is on, otherwise the configured one.
   * Detection and its cache are the detector's; the fallback inside it is
   * the configured language.
   */
  blockLanguage(block: string): string {
    if (!this.autoDetect()) {
      return this.language();
    }
    return this.detector.languageFor(block);
  }

  /**
   * Adds `word` to the given dictionary's list (default: the configured
   * one) or the personal list (main-process `spell:add-word`), then drops
   * cached verdicts so the next check sees it as correct.
   */
  async addWord(word: string, target: AddWordTarget, language?: string): Promise<void> {
    await this.api?.addSpellWord(word, target, language);
    this.invalidate();
  }

  /**
   * The misspelled subset of `words` under `language` -- the extension
   * passes the language each word's paragraph was detected as. Never
   * rejects.
   */
  async check(words: string[], language?: string): Promise<Set<string>> {
    const id = language ?? this.language();
    const out = new Set<string>();
    const unknown: string[] = [];

    for (const word of words) {
      const cached = this.verdicts.get(`${id} ${word}`);
      if (cached === undefined) {
        unknown.push(word);
      } else if (cached) {
        out.add(word);
      }
    }

    if (unknown.length === 0 || !this.api) {
      return out;
    }

    try {
      const result = await this.api.checkSpelling(unknown, id);
      // The config may have been switched mid-flight; a verdict from the
      // wrong dictionary must not enter the cache.
      if (result.language !== id) {
        return out;
      }
      const flagged = new Set(result.misspelled);
      for (const word of unknown) {
        const misspelled = flagged.has(word);
        this.rememberVerdict(`${id} ${word}`, misspelled);
        if (misspelled) {
          out.add(word);
        }
      }
    } catch {
      // Leave the unknown words unjudged rather than caching a failure --
      // the next pause tries again.
    }
    return out;
  }

  /**
   * Suggestions for one misspelled word under its flagging language,
   * fetched when its popup opens -- never during the bulk check, because
   * the main-process suggestion search costs tens of milliseconds per
   * word. Cached per language and single-flighted, so re-opening the
   * popup is free.
   */
  async suggest(word: string, language?: string): Promise<readonly string[]> {
    const id = language ?? this.language();
    const key = `${id} ${word}`;
    const cached = this.suggestions.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const inFlight = this.suggesting.get(key);
    if (inFlight) {
      return inFlight;
    }
    const request = this.api
      ? this.api.suggestSpelling(word, id).catch(() => [] as const)
      : Promise.resolve([] as const);
    this.suggesting.set(key, request);
    try {
      const result = await request;
      if (this.suggestions.size >= SUGGESTION_CACHE_LIMIT) {
        this.suggestions.clear();
      }
      this.suggestions.set(key, result);
      return result;
    } finally {
      this.suggesting.delete(key);
    }
  }

  async refreshLanguages(): Promise<void> {
    if (!this.api) {
      return;
    }
    this.languagesLoading.set(true);
    try {
      this.languages.set(await this.api.listSpellLanguages());
    } catch {
      this.languages.set([]);
    } finally {
      this.languagesLoading.set(false);
    }
  }

  /** Opens the picker and returns the dictionary to store, or null. */
  async pickDictionary(): Promise<CustomDictionary | null> {
    return (await this.api?.addSpellDictionary()) ?? null;
  }

  /** Drops cached verdicts -- after a language change or a new dictionary. */
  invalidate(): void {
    this.verdicts.clear();
    this.suggestions.clear();
    this.detector.invalidate();
  }

  /**
   * The dictionary ids detection may map onto: the bundled ones plus the
   * user's custom entries, straight from the persisted config -- no
   * round-trip to the main process, whose `loaded` state (files readable)
   * is orthogonal to what detection needs.
   */
  private installedLanguages(): readonly string[] {
    const config = this.settings.config();
    const custom = config?.spellcheck.dictionaries.map((entry) => entry.id) ?? [];
    return [...BUNDLED_DICTIONARIES.map((entry) => entry.id), ...custom];
  }

  private languageLabel(id: string): string {
    return this.languages().find((entry) => entry.id === id)?.label ?? id;
  }

  /** Bounded verdict cache: clear wholesale rather than grow without end. */
  private rememberVerdict(key: string, misspelled: boolean): void {
    if (this.verdicts.size >= VERDICT_CACHE_LIMIT) {
      this.verdicts.clear();
    }
    this.verdicts.set(key, misspelled);
  }
}

/** Verdict cache cap -- tens of thousands of short words, low MBs. */
const VERDICT_CACHE_LIMIT = 50_000;
/** Suggestion cache cap -- suggestions are per clicked word, far rarer. */
const SUGGESTION_CACHE_LIMIT = 5_000;
