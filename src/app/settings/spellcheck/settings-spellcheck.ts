import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { BUNDLED_DICTIONARIES } from '../../../../shared/app-config';
import { SpellLanguage } from '../../../../shared/ipc-api';
import { SettingsService } from '../../services/settings.service';
import { SpellcheckService } from '../../services/spellcheck.service';
import { Icon } from '../../icons/icon';
import { SettingsPane } from '../settings-pane/settings-pane';

/**
 * "Spelling" settings category: the master switch, the active dictionary,
 * and the list of dictionaries -- German and English ship with the app,
 * anything else is a Hunspell `.aff`/`.dic` pair the user points at.
 *
 * The list comes from the main process rather than from the config alone,
 * because only it knows whether a dictionary actually *loads*: a custom
 * entry whose files were moved must show as broken here instead of quietly
 * checking nothing.
 */
@Component({
  selector: 'app-settings-spellcheck',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, SettingsPane],
  templateUrl: './settings-spellcheck.html',
  styleUrls: ['./settings-spellcheck.css'],
})
export class SettingsSpellcheck implements OnInit {
  protected readonly settings = inject(SettingsService);
  protected readonly spellcheck = inject(SpellcheckService);

  protected readonly config = computed(() => this.settings.draft()?.spellcheck ?? null);

  /**
   * What the language list shows: the load state from the main process,
   * merged with dictionaries the draft has added but not yet saved (the
   * main process learns of those a moment later, with the save).
   */
  protected readonly languages = computed<SpellLanguage[]>(() => {
    const known = this.spellcheck.languages();
    const draft = this.config();
    if (!draft) {
      return known;
    }
    const seen = new Set(known.map((entry) => entry.id));
    const pending = draft.dictionaries
      .filter((entry) => !seen.has(entry.id))
      .map<SpellLanguage>((entry) => ({
        id: entry.id,
        label: entry.label,
        builtin: false,
        loaded: true,
      }));
    const removed = new Set(
      known
        .filter((entry) => !entry.builtin)
        .map((entry) => entry.id)
        .filter((id) => !draft.dictionaries.some((entry) => entry.id === id)),
    );
    return [...known.filter((entry) => !removed.has(entry.id)), ...pending];
  });

  protected readonly bundledIds = new Set(BUNDLED_DICTIONARIES.map((entry) => entry.id));

  /** The global personal list, and the list pinned to the active dictionary. */
  protected readonly personalWords = computed<readonly string[]>(
    () => this.config()?.personalWords ?? [],
  );
  protected readonly languageWords = computed<readonly string[]>(() => {
    const draft = this.config();
    return draft ? (draft.languageWords[draft.language] ?? []) : [];
  });
  protected readonly activeLanguageLabel = computed<string>(() => {
    const id = this.config()?.language ?? 'de';
    return this.languages().find((entry) => entry.id === id)?.label ?? id;
  });

  ngOnInit(): void {
    void this.spellcheck.refreshLanguages();
  }

  protected onEnabledChange(on: boolean): void {
    this.settings.patchSpellcheck({ enabled: on });
    this.spellcheck.invalidate();
  }

  protected onAutoDetectChange(on: boolean): void {
    this.settings.patchSpellcheck({ autoDetect: on });
    // Cached verdicts are keyed by language, so they stay valid -- but the
    // paragraph cache maps blocks onto the old policy.
    this.spellcheck.invalidate();
  }

  protected onLanguageChange(language: string): void {
    this.settings.patchSpellcheck({ language });
    // Cached verdicts belong to the old dictionary.
    this.spellcheck.invalidate();
  }

  /** Opens the picker ("Add dictionary …") and adds the result to the draft. */
  protected async addDictionary(): Promise<void> {
    const dictionary = await this.spellcheck.pickDictionary();
    if (dictionary) {
      this.settings.addDictionary(dictionary);
    }
  }

  protected removeDictionary(id: string): void {
    this.settings.removeDictionary(id);
    this.spellcheck.invalidate();
  }

  protected addWord(input: HTMLInputElement, target: 'language' | 'personal'): void {
    const value = input.value.trim();
    if (value === '') {
      return;
    }
    this.settings.addSpellWord(value, target);
    input.value = '';
    this.spellcheck.invalidate();
  }

  protected removeWord(word: string, target: 'language' | 'personal'): void {
    this.settings.removeSpellWord(word, target);
    this.spellcheck.invalidate();
  }
}
