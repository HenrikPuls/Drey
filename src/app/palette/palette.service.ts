import { Injectable, computed, inject, signal } from '@angular/core';
import { VaultFileEntry } from '../../../shared/ipc-api';
import { KeybindingService } from '../keybindings';
import { DocHistoryService } from '../services/doc-history.service';
import { EditorService, docKey } from '../services/editor.service';
import { VaultService } from '../vault';
import { fuzzyFilter, fuzzyScore } from './fuzzy';

/** Which list the palette opens on; typing or deleting a leading `>` switches. */
export type PaletteMode = 'files' | 'commands';

/** One row of the palette. */
export interface PaletteItem {
  readonly id: string;
  readonly label: string;
  /** Muted second column: a file's folder (and vault), nothing for a command. */
  readonly detail: string;
  /** Right-aligned: a command's shortcut. */
  readonly hint: string;
  /** `alongside`: Ctrl+Enter -- open beside the current tab instead of replacing it. */
  run(alongside: boolean): void;
}

interface FileItem {
  key: string;
  vaultId: string;
  path: string;
  name: string;
  detail: string;
}

/** The commands that open the palette itself -- pointless inside it. */
const OWN_COMMANDS = new Set(['palette.files', 'palette.commands']);
const LIMIT = 60;

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

/** `Mod+Shift+F` as the menus print it: `Ctrl Shift F`. */
export function formatChord(spec: string | undefined): string {
  if (!spec) {
    return '';
  }
  return spec
    .split('+')
    .map((raw) => {
      const part = raw.trim();
      const lower = part.toLowerCase();
      if (lower === 'mod') {
        return IS_MAC ? 'Cmd' : 'Ctrl';
      }
      if (lower.startsWith('arrow')) {
        return part.slice(5);
      }
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(' ');
}

/**
 * The quick switcher and command palette (milestone 59): ONE overlay, two
 * lists, VS Code's model. `Mod+P` lists the files of every registered
 * vault -- the documents visited this session first, so a bare Enter flips
 * back to the previous one; a query that matches nothing offers to create
 * the note in the active vault. A leading `>` (or `Mod+Shift+P`) lists the
 * `KeybindingService` commands with their shortcuts; plugin commands
 * register through the same service and show up on their own.
 *
 * Holds the state and the lists; `Palette` is the view.
 */
@Injectable({ providedIn: 'root' })
export class PaletteService {
  private readonly keys = inject(KeybindingService);
  private readonly vault = inject(VaultService);
  private readonly editor = inject(EditorService);
  private readonly history = inject(DocHistoryService);

  readonly open = signal(false);
  readonly query = signal('');

  /** What had focus before the palette took it -- handed back on close. */
  private previousFocus: HTMLElement | null = null;

  /** Bumped per `show`, so the command list is re-read each time it opens. */
  private readonly shown = signal(0);

  readonly mode = computed<PaletteMode>(() => (this.query().startsWith('>') ? 'commands' : 'files'));

  show(mode: PaletteMode): void {
    if (!this.open() && typeof document !== 'undefined') {
      this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    this.query.set(mode === 'commands' ? '>' : '');
    this.shown.update((n) => n + 1);
    this.open.set(true);
  }

  close(): void {
    if (!this.open()) {
      return;
    }
    this.open.set(false);
    this.previousFocus?.focus();
    this.previousFocus = null;
  }

  /** Every file of every registered vault, the active vault's first. */
  private readonly files = computed<FileItem[]>(() => {
    const vaults = this.vault.vaults();
    const trees = this.vault.trees();
    const several = vaults.length > 1;
    const out: FileItem[] = [];
    for (const vault of [...vaults].sort((a, b) => Number(b.active) - Number(a.active))) {
      const walk = (entries: readonly VaultFileEntry[]): void => {
        for (const entry of entries) {
          if (entry.type === 'directory') {
            walk(entry.children ?? []);
            continue;
          }
          const path = entry.relativePath;
          const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
          out.push({
            key: docKey(vault.id, path),
            vaultId: vault.id,
            path,
            name: entry.name,
            detail: several ? (dir ? `${vault.name} · ${dir}` : vault.name) : dir,
          });
        }
      };
      walk(trees[vault.id] ?? []);
    }
    return out;
  });

  readonly items = computed<PaletteItem[]>(() => {
    this.shown();
    const query = this.query();
    return query.startsWith('>') ? this.commandItems(query.slice(1).trim()) : this.fileItems(query.trim());
  });

  private commandItems(query: string): PaletteItem[] {
    const commands = this.keys
      .all()
      .filter((c) => !OWN_COMMANDS.has(c.id))
      .sort((a, b) => a.label.localeCompare(b.label));
    return fuzzyFilter(commands, query, (c, q) => fuzzyScore(q, c.label), LIMIT).map((command) => ({
      id: command.id,
      label: command.label,
      detail: '',
      hint: formatChord(command.keybinding),
      run: () => this.keys.run(command.id),
    }));
  }

  private fileItems(query: string): PaletteItem[] {
    const all = this.files();
    // Visited documents lead (most recent first), the one on screen last
    // among them -- so Mod+P, Enter returns to where you just were.
    const byKey = new Map(all.map((file) => [file.key, file]));
    const active = this.editor.activePath();
    const recent = this.history
      .recentKeys()
      .filter((key) => key !== active)
      .map((key) => byKey.get(key))
      .filter((file): file is FileItem => file !== undefined);
    const seen = new Set(recent.map((file) => file.key));
    const ordered = [...recent, ...all.filter((file) => !seen.has(file.key))];

    const hits = fuzzyFilter(
      ordered,
      query,
      (file, q) => {
        const name = fuzzyScore(q, file.name);
        return name !== null ? name + 50 : fuzzyScore(q, file.path);
      },
      LIMIT,
    );
    const items: PaletteItem[] = hits.map((file) => ({
      id: file.key,
      label: file.name,
      detail: file.detail,
      hint: '',
      run: (alongside) =>
        void this.editor.openFile(file.path, file.vaultId, alongside ? { keepFocused: true } : {}),
    }));
    if (items.length === 0 && query !== '' && this.vault.activeVaultId() !== null) {
      items.push({
        id: 'palette:create',
        label: `Create note "${query}"`,
        detail: '',
        hint: '',
        run: () => void this.createNote(query),
      });
    }
    return items;
  }

  /** Closes, hands focus back, then runs -- so the action lands in the app, not the overlay. */
  run(item: PaletteItem, alongside: boolean): void {
    this.close();
    item.run(alongside);
  }

  /** Creates `name` (`.md` appended when bare) in the active vault and opens it. */
  private async createNote(name: string): Promise<void> {
    const vaultId = this.vault.activeVaultId();
    const clean = name.trim().replace(/^\/+/, '');
    if (
      vaultId === null ||
      clean === '' ||
      clean.includes('\\') ||
      clean.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      this.editor.error.set(`Cannot create a note named "${name}".`);
      return;
    }
    const path = /\.[^/]+$/.test(clean) ? clean : `${clean}.md`;
    try {
      await this.vault.createEntry('file', path, vaultId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(message)) {
        this.editor.error.set(message);
        return;
      }
    }
    await this.editor.openFile(path, vaultId);
  }
}
