import { globalShortcut } from 'electron';
import { chordToAccelerator } from '../shared/keybindings';
import type { GlobalChord, GlobalShortcutStatus } from '../shared/ipc-api';

/**
 * The system-wide chords of GLOBAL commands (SDK 1.37, req-75 W5a). The
 * renderer owns the command registry, so it pushes the chord list and
 * this class only registers and reports — it knows nothing about what
 * the commands do. A press is handed to `onPress` with the command id;
 * main raises the window and pushes the id to the renderer, which runs
 * the command (it has no in-window binding, so it fires exactly once).
 *
 * Same failure model as `CaptureHotkey`: a combo another program holds
 * (or one on the `reserved` list — the quick-capture accelerator) comes
 * back `registered: false` and is retried on the next sync; nothing
 * here is ever fatal. Only the accelerators this class registered are
 * unregistered — never `unregisterAll()`, which would drop the
 * quick-capture hotkey.
 */
export class GlobalShortcuts {
  /** The accelerators this class currently holds (accelerator -> command id). */
  private readonly held = new Map<string, string>();
  private current: readonly GlobalShortcutStatus[] = [];

  constructor(private readonly onPress: (id: string) => void) {}

  status(): GlobalShortcutStatus[] {
    return this.current.map((entry) => ({ ...entry }));
  }

  /**
   * Registers exactly `chords`; unregisters every earlier one first. A
   * chord another program owns (or one equal to a reserved accelerator)
   * comes back `registered: false`. A no-op when nothing changed and
   * everything registered — the renderer re-pushes on every registry
   * change, and re-registering would churn live shortcuts for nothing.
   */
  sync(chords: readonly GlobalChord[], reserved: readonly string[]): GlobalShortcutStatus[] {
    const desired = new Map(chords.map((chord) => [chord.id, chord.chord] as const));
    const unchanged =
      this.current.length === desired.size &&
      this.current.every((entry) => desired.get(entry.id) === entry.chord && entry.registered);
    if (unchanged) {
      return this.status();
    }
    this.release();
    const statuses: GlobalShortcutStatus[] = [];
    const taken = new Set<string>(); // accelerators this pass already gave out
    for (const [id, chord] of desired) {
      const accelerator = chordToAccelerator(chord);
      let registered = false;
      if (accelerator !== null && !reserved.includes(accelerator) && !taken.has(accelerator)) {
        try {
          registered = globalShortcut.register(accelerator, () => this.onPress(id));
        } catch {
          // Electron throws on an accelerator it cannot parse.
          registered = false;
        }
      }
      if (registered) {
        this.held.set(accelerator!, id);
        taken.add(accelerator!);
      } else {
        console.warn(`Global shortcut ${chord} (${id}) could not be registered (already in use).`);
      }
      statuses.push({ id, chord, registered });
    }
    this.current = statuses;
    return this.status();
  }

  /** Unregisters only what this class registered — the quick-capture hotkey stays. */
  private release(): void {
    for (const accelerator of this.held.keys()) {
      globalShortcut.unregister(accelerator);
    }
    this.held.clear();
  }
}
