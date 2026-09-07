import { Injectable } from '@angular/core';
import { Chord, Command, matchesChord, parseChord } from './command';

/**
 * The app's keyboard-command registry. Features `register()` a {@link Command}
 * with a chord string; this service owns the single capture-phase
 * `keydown` listener that matches events against those chords and invokes
 * the command, `preventDefault()`-ing so an editor keymap underneath never
 * also sees it.
 *
 * Capture phase is deliberate: `Mod+Shift+F` must reach the search panel
 * even while focus is inside CodeMirror, whose own keymap runs on the
 * target during the bubble phase.
 *
 * Commands are registered from `App` (the shell that already wires the
 * other app-lifetime concerns). This is a modular monolith, not a plugin
 * runtime -- nothing loads commands dynamically.
 */
@Injectable({ providedIn: 'root' })
export class KeybindingService {
  private readonly commands = new Map<string, Command>();
  private readonly bindings: Array<{ chord: Chord; command: Command }> = [];

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeydown, { capture: true });
    }
  }

  /** Adds (or replaces, by `id`) a command. A `keybinding` is indexed for matching. */
  register(command: Command): void {
    this.commands.set(command.id, command);
    if (command.keybinding) {
      const chord = parseChord(command.keybinding);
      const existing = this.bindings.findIndex((b) => b.command.id === command.id);
      if (existing !== -1) {
        this.bindings[existing] = { chord, command };
      } else {
        this.bindings.push({ chord, command });
      }
    }
  }

  /** All registered commands, for a future command palette. */
  all(): Command[] {
    return [...this.commands.values()];
  }

  /** Invokes a command by id (the palette / tests use this). */
  run(id: string): void {
    this.commands.get(id)?.run();
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.repeat) {
      return;
    }
    const hit = this.bindings.find((b) => matchesChord(event, b.chord));
    if (hit) {
      event.preventDefault();
      event.stopPropagation();
      hit.command.run();
    }
  };
}
