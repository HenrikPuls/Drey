import { Injectable } from '@angular/core';
import { Chord, Command, matchesChord, parseChord } from './command';

/**
 * The app's keyboard-command registry. Features `register()` a {@link Command}
 * with a chord string; this service owns the capture-phase `keydown`
 * listener that matches events against those chords and invokes the
 * command, `preventDefault()`-ing so an editor keymap underneath never
 * also sees it.
 *
 * Capture phase is deliberate: `Mod+Shift+F` must reach the search panel
 * even while focus is inside CodeMirror, whose own keymap runs on the
 * target during the bubble phase.
 *
 * Mouse side buttons ride the same registry: a {@link Command.mouseButton}
 * (3 = XButton1/back, 4 = XButton2/forward) is matched by a capture-phase
 * `mouseup` listener — `mouseup` rather than `mousedown` so a press in the
 * middle of a drag never fires mid-gesture, and the event is swallowed so
 * Chromium's own back/forward history default action never runs.
 *
 * The matching `mousedown` is swallowed too (`preventDefault()` +
 * `stopPropagation()`, no command): CodeMirror places the caret in its own
 * mousedown listener, which is a regular listener, not a default action —
 * only stopping the propagation in the capture phase keeps the press away
 * from the editor DOM, so the caret never moves and no selection starts.
 *
 * Commands are registered from `App` (the shell that already wires the
 * other app-lifetime concerns). This is a modular monolith, not a plugin
 * runtime -- nothing loads commands dynamically.
 */
@Injectable({ providedIn: 'root' })
export class KeybindingService {
  private readonly commands = new Map<string, Command>();
  private readonly bindings: Array<{ chord: Chord; command: Command }> = [];
  private readonly mouseBindings = new Map<number, Command>();

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeydown, { capture: true });
      window.addEventListener('mousedown', this.onMousedown, { capture: true });
      window.addEventListener('mouseup', this.onMouseup, { capture: true });
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
    if (command.mouseButton !== undefined) {
      this.mouseBindings.set(command.mouseButton, command);
    }
  }

  /** All registered commands, for a future command palette. */
  all(): Command[] {
    return [...this.commands.values()];
  }

  /**
   * Invokes a command by id (the palette / tests / cross-feature calls use
   * this). Unknown ids are a no-op; `payload` is passed through to the
   * command (see {@link Command.run}).
   */
  run(id: string, payload?: unknown): void {
    this.commands.get(id)?.run(payload);
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

  /** Swallows the press of a bound side button (caret stay, no selection
   * start); the command itself fires on `mouseup`. */
  private readonly onMousedown = (event: MouseEvent): void => {
    if (this.mouseBindings.has(event.button)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private readonly onMouseup = (event: MouseEvent): void => {
    const hit = this.mouseBindings.get(event.button);
    if (hit) {
      event.preventDefault();
      event.stopPropagation();
      hit.run();
    }
  };
}
