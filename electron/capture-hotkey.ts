import { globalShortcut } from 'electron';
import { chordToAccelerator } from '../shared/keybindings';
import type { CaptureHotkeyStatus } from '../shared/ipc-api';

/**
 * The system-wide quick-capture hotkey (milestone 4; rebindable since
 * milestone 75, ADR-0073). Holds the one `globalShortcut` registration
 * and whether it succeeded — another program may own the combo, which
 * the Settings page then shows.
 *
 * `sync()` runs at startup and after every `config:set`; it re-registers
 * only when the chord changed or the last attempt failed (the other
 * program may have let go since).
 */
export class CaptureHotkey {
  private accelerator: string | null = null;
  private current: CaptureHotkeyStatus = { chord: null, registered: false };

  constructor(private readonly onPress: () => void) {}

  status(): CaptureHotkeyStatus {
    return { ...this.current };
  }

  sync(chord: string | null): CaptureHotkeyStatus {
    if (chord === this.current.chord && (chord === null || this.current.registered)) {
      return this.status();
    }
    this.release();
    if (chord === null) {
      this.current = { chord: null, registered: false };
      return this.status();
    }
    const accelerator = chordToAccelerator(chord);
    let registered = false;
    if (accelerator !== null) {
      try {
        registered = globalShortcut.register(accelerator, this.onPress);
      } catch {
        // Electron throws on an accelerator it cannot parse.
        registered = false;
      }
    }
    if (registered) {
      this.accelerator = accelerator;
    } else {
      // Another program owns the combo. Non-fatal: the rest of the app
      // works, and Settings -> Keyboard shortcuts says so.
      console.warn(`Quick-capture hotkey ${chord} could not be registered (already in use).`);
    }
    this.current = { chord, registered };
    return this.status();
  }

  private release(): void {
    if (this.accelerator !== null) {
      globalShortcut.unregister(this.accelerator);
      this.accelerator = null;
    }
  }
}
