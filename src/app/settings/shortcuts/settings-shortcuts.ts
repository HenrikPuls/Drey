import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import type { KeybindingsConfig } from '../../../../shared/app-config';
import type { CaptureHotkeyStatus } from '../../../../shared/ipc-api';
import { chordFromKeyPress, chordProblem, type ChordProblem } from '../../../../shared/keybindings';
import { formatChord, KeybindingService } from '../../keybindings';
import { FIXED_SHORTCUTS } from '../../help/shortcuts-doc';
import { SettingsService } from '../../services/settings.service';
import { SettingsPane } from '../settings-pane/settings-pane';
import {
  assignChord,
  CAPTURE_ROW_ID,
  conflictingIds,
  holderOf,
  replaceChord,
  resetChord,
  shortcutRows,
  type ShortcutRow,
} from './shortcut-model';

/** A chord that waits for the user's word because another row holds it. */
interface PendingReplace {
  rowId: string;
  chord: string;
  holder: ShortcutRow;
}

const PROBLEM_TEXT: Record<ChordProblem, string> = {
  'no-key': 'Press a key together with Ctrl or Alt.',
  'needs-modifier': 'A shortcut needs Ctrl or Alt, or a function key (F1–F12).',
  reserved: 'is used by the editor and cannot be assigned.',
};

/**
 * "Keyboard shortcuts" settings category (milestone 75, ADR-0073): every
 * registry command and the quick-capture hotkey, each rebindable by
 * pressing the new chord. The rows, conflicts and the resulting config
 * slice come from `shortcut-model.ts`; this component holds only the
 * recorder state and writes the slice into the self-saving draft.
 *
 * While a row records, a capture-phase `keydown` listener takes the press
 * and `KeybindingService` is paused, so the chord is read instead of run
 * (and Esc cancels instead of closing Settings).
 */
@Component({
  selector: 'app-settings-shortcuts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SettingsPane],
  templateUrl: './settings-shortcuts.html',
  styleUrls: ['./settings-shortcuts.css'],
})
export class SettingsShortcuts implements OnDestroy {
  protected readonly settings = inject(SettingsService);
  private readonly keys = inject(KeybindingService);

  protected readonly fixed = FIXED_SHORTCUTS;
  protected readonly captureId = CAPTURE_ROW_ID;
  protected readonly format = formatChord;

  private readonly config = computed(() => this.settings.draft()?.keybindings ?? null);

  protected readonly rows = computed<ShortcutRow[]>(() => {
    const config = this.config();
    if (!config) {
      return [];
    }
    const commands = this.keys.all().map((command) => ({
      id: command.id,
      label: command.label,
      defaultChord: this.keys.defaultChord(command.id),
    }));
    return shortcutRows(commands, config);
  });

  protected readonly conflicts = computed(() => conflictingIds(this.rows()));

  /** The row that waits for a key press. */
  protected readonly recording = signal<string | null>(null);
  protected readonly pending = signal<PendingReplace | null>(null);
  protected readonly problem = signal<{ rowId: string; text: string } | null>(null);
  protected readonly captureStatus = signal<CaptureHotkeyStatus | null>(null);

  private resume: (() => void) | null = null;

  constructor() {
    // Main re-registers the hotkey inside `config:set`, so by the time the
    // persisted config changes, its status is the new one.
    effect(() => {
      const capture = this.settings.config()?.keybindings.capture;
      if (capture !== undefined) {
        void this.refreshCaptureStatus();
      }
    });
  }

  ngOnDestroy(): void {
    this.stopRecording();
  }

  /** "In use by another program": the stored chord did not register. */
  protected readonly captureInUse = computed(() => {
    const status = this.captureStatus();
    const capture = this.settings.config()?.keybindings.capture ?? null;
    return status !== null && capture !== null && status.chord === capture && !status.registered;
  });

  protected startRecording(row: ShortcutRow): void {
    this.stopRecording();
    this.pending.set(null);
    this.problem.set(null);
    this.recording.set(row.id);
    this.resume = this.keys.pause();
    window.addEventListener('keydown', this.onKeydown, { capture: true });
  }

  protected stopRecording(): void {
    if (this.resume) {
      window.removeEventListener('keydown', this.onKeydown, { capture: true });
      this.resume();
      this.resume = null;
    }
    this.recording.set(null);
  }

  protected remove(row: ShortcutRow): void {
    this.clearNotes();
    this.write((config) => assignChord(config, row, null));
  }

  protected reset(row: ShortcutRow): void {
    this.clearNotes();
    const holder = row.defaultChord ? holderOf(this.rows(), row.defaultChord, row.id) : undefined;
    if (row.defaultChord && holder) {
      this.pending.set({ rowId: row.id, chord: row.defaultChord, holder });
      return;
    }
    this.write((config) => resetChord(config, row));
  }

  protected confirmReplace(): void {
    const pending = this.pending();
    const row = pending ? this.rows().find((r) => r.id === pending.rowId) : undefined;
    this.pending.set(null);
    if (pending && row) {
      this.write((config) => replaceChord(config, row, pending.holder, pending.chord));
    }
  }

  protected cancelReplace(): void {
    this.pending.set(null);
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) {
      return;
    }
    const rowId = this.recording();
    const row = rowId ? this.rows().find((r) => r.id === rowId) : undefined;
    if (!row) {
      this.stopRecording();
      return;
    }
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    if (event.key === 'Escape' && plain) {
      this.stopRecording();
      return;
    }
    const chord = chordFromKeyPress(event);
    if (chord === null) {
      return; // only modifiers so far
    }
    this.stopRecording();
    const problem = chordProblem(chord);
    if (problem !== null) {
      const text = PROBLEM_TEXT[problem];
      this.problem.set({
        rowId: row.id,
        text: problem === 'reserved' ? `${formatChord(chord)} ${text}` : text,
      });
      return;
    }
    const holder = holderOf(this.rows(), chord, row.id);
    if (holder) {
      this.pending.set({ rowId: row.id, chord, holder });
      return;
    }
    this.write((config) => assignChord(config, row, chord));
  };

  private clearNotes(): void {
    this.stopRecording();
    this.pending.set(null);
    this.problem.set(null);
  }

  private write(change: (config: KeybindingsConfig) => KeybindingsConfig): void {
    const config = this.config();
    if (config) {
      this.settings.setKeybindings(change(config));
    }
  }

  private async refreshCaptureStatus(): Promise<void> {
    const api = typeof window !== 'undefined' ? window.dreyApi : undefined;
    if (!api?.getCaptureHotkeyStatus) {
      return;
    }
    try {
      this.captureStatus.set(await api.getCaptureHotkeyStatus());
    } catch {
      this.captureStatus.set(null);
    }
  }
}
