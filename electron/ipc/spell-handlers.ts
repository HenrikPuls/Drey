import { dialog, ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppConfig, CustomDictionary, IPC_CHANNELS, SpellCheckResult, SpellLanguage } from '../../shared/ipc-api';
import { AppConfigStore } from '../app-config';
import { SpellcheckService } from '../spellcheck';
import { refocusRenderer } from '../focus';

export interface SpellHandlerDeps {
  appConfig: AppConfigStore;
  spellcheck: SpellcheckService;
}

/** Spellcheck IPC: check words, list languages, add a dictionary / a word. */
export function registerSpellHandlers({ appConfig, spellcheck }: SpellHandlerDeps): void {
  ipcMain.handle(IPC_CHANNELS.spellCheck, (_event, words: string[]): Promise<SpellCheckResult> =>
    spellcheck.check(words),
  );
  ipcMain.handle(IPC_CHANNELS.spellLanguages, (): Promise<SpellLanguage[]> =>
    spellcheck.listLanguages(),
  );
  ipcMain.handle(IPC_CHANNELS.spellAddDictionary, (): Promise<CustomDictionary | null> =>
    pickDictionary(),
  );
  ipcMain.handle(
    IPC_CHANNELS.spellAddWord,
    (_event, word: string, target: 'language' | 'personal'): AppConfig => {
      const trimmed = word.trim();
      const current = appConfig.get();
      const sc = current.spellcheck;
      const personalWords = [...sc.personalWords];
      const languageWords: Record<string, string[]> = {};
      for (const [id, list] of Object.entries(sc.languageWords)) {
        languageWords[id] = [...list];
      }
      if (trimmed !== '') {
        if (target === 'personal') {
          if (!personalWords.includes(trimmed)) {
            personalWords.push(trimmed);
          }
        } else {
          const list = languageWords[sc.language] ?? [];
          if (!list.includes(trimmed)) {
            languageWords[sc.language] = [...list, trimmed];
          }
        }
      }
      const stored = appConfig.set({
        ...current,
        spellcheck: { ...sc, personalWords, languageWords },
      });
      // This path doesn't go through the `config:set` handler, so reload
      // the checker here.
      spellcheck.invalidate();
      return stored;
    },
  );
}

/**
 * Asks for a Hunspell `.dic` and pairs it with the `.aff` of the same name
 * beside it -- the layout every Hunspell distribution uses, so one pick is
 * enough and the user is not walked through two dialogs. The language id
 * is the file's base name (`fr_FR.dic` -> `fr_FR`), which is also what
 * such files are conventionally named after.
 */
async function pickDictionary(): Promise<CustomDictionary | null> {
  const result = await dialog.showOpenDialog({
    title: 'Select a Hunspell dictionary (.dic)',
    properties: ['openFile'],
    filters: [{ name: 'Hunspell dictionary', extensions: ['dic'] }],
  });
  refocusRenderer();
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const dicPath = result.filePaths[0];
  const affPath = `${dicPath.slice(0, -'.dic'.length)}.aff`;
  if (!fs.existsSync(affPath)) {
    // Without the affix file nspell cannot build a checker at all, so
    // this is refused here rather than stored as a broken entry.
    await dialog.showMessageBox({
      type: 'warning',
      message: 'No matching .aff file found',
      detail: `Expected ${path.basename(affPath)} in the same folder as the .dic file.`,
    });
    refocusRenderer();
    return null;
  }
  const id = path.basename(dicPath, '.dic');
  return { id, label: id, affPath, dicPath };
}
