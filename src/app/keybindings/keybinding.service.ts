import { Injectable, signal } from '@angular/core';
import { deepEqual } from '../../../shared/deep-equal';
import { effectiveChord } from '../../../shared/keybindings';
import { Chord, Command, formatChord, matchesChord, parseChord } from './command';

/**
 * The app's keyboard-command registry. Features `register()` a {@link Command}
 * with a default chord; this service owns the capture-phase `keydown`
 * listener that matches events against the chords in effect and invokes
 * the command, `preventDefault()`-ing so an editor keymap underneath never
 * also sees it.
 *
 * The chord in effect is the user's override if there is one (Settings →
 * Keyboard shortcuts, `keybindings.overrides`, ADR-0073), else the
 * command's own. `setOverrides()` feeds the stored overrides in; the
 * chord index is rebuilt from the commands on every change, and the
 * `revision` signal lets menus and tooltips that print a chord
 * (`hint()`) follow at once.
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
 * Base commands are registered from `App`; plugins register theirs
 * through the plugin API (ADR-0044).
 */
@Injectable({ providedIn: 'root' })
export class KeybindingService {
  /** Every command as registered — its `keybinding` is its default chord. */
  private readonly commands = new Map<string, Command>();
  private overrides: Readonly<Record<string, string | null>> = {};
  private bindings: Array<{ chord: Chord; command: Command }> = [];
  private mouseBindings = new Map<number, Command>();
  private pauses = 0;

  /** Bumped whenever a chord in effect may have changed. */
  private readonly revision = signal(0);

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeydown, { capture: true });
      window.addEventListener('mousedown', this.onMousedown, { capture: true });
      window.addEventListener('mouseup', this.onMouseup, { capture: true });
    }
  }

  /** Adds (or replaces, by `id`) a command. */
  register(command: Command): void {
    this.commands.set(command.id, command);
    this.reindex();
  }

  /** The user's overrides (`keybindings.overrides`); a no-op when unchanged. */
  setOverrides(overrides: Readonly<Record<string, string | null>>): void {
    if (deepEqual(this.overrides, overrides)) {
      return;
    }
    this.overrides = { ...overrides };
    this.reindex();
  }

  /**
   * All registered commands, each with the chord IN EFFECT as its
   * `keybinding` (undefined when it has none) — the palette and the
   * shortcuts page list these. Reactive.
   */
  all(): Command[] {
    this.revision();
    return [...this.commands.values()].map((command) => {
      const { keybinding: _default, ...rest } = command;
      const chord = this.resolve(command);
      return chord !== undefined ? { ...rest, keybinding: chord } : rest;
    });
  }

  /** Whether a command with this id is registered. Reactive. */
  isRegistered(id: string): boolean {
    this.revision();
    return this.commands.has(id);
  }

  /** The command's own chord, before any override. */
  defaultChord(id: string): string | undefined {
    return this.commands.get(id)?.keybinding;
  }

  /** The chord in effect for a command. Reactive. */
  chordFor(id: string): string | undefined {
    this.revision();
    const command = this.commands.get(id);
    return command ? this.resolve(command) : undefined;
  }

  /** The chord in effect as the menus print it (`Ctrl Shift F`), `''` for none. Reactive. */
  hint(id: string): string {
    return formatChord(this.chordFor(id));
  }

  /** A tooltip with the command's chord appended: `Toggle line numbers (Ctrl G)`. Reactive. */
  titled(label: string, id: string): string {
    const hint = this.hint(id);
    return hint ? `${label} (${hint})` : label;
  }

  /**
   * Stops matching chords until the returned function is called — the
   * Settings page's recorder needs the raw key press, not the command it
   * would run.
   */
  pause(): () => void {
    this.pauses++;
    let resumed = false;
    return () => {
      if (!resumed) {
        resumed = true;
        this.pauses--;
      }
    };
  }

  /**
   * Invokes a command by id (the palette / tests / cross-feature calls use
   * this). Unknown ids are a no-op; `payload` is passed through to the
   * command (see {@link Command.run}).
   */
  run(id: string, payload?: unknown): void {
    this.commands.get(id)?.run(payload);
  }

  private resolve(command: Command): string | undefined {
    return effectiveChord(command.id, command.keybinding, this.overrides);
  }

  /**
   * Rebuilds the chord and mouse indexes from the commands. A chord the
   * user chose wins over a default that names the same keys; between two
   * defaults the first registered wins. Rebuilding (rather than patching)
   * also drops the chord of a command re-registered without one — a
   * disabled plugin's inert stand-in.
   */
  private reindex(): void {
    const chosen: Array<{ chord: Chord; command: Command }> = [];
    const defaults: Array<{ chord: Chord; command: Command }> = [];
    const mouse = new Map<number, Command>();
    for (const command of this.commands.values()) {
      const chord = this.resolve(command);
      if (chord) {
        const list = Object.prototype.hasOwnProperty.call(this.overrides, command.id)
          ? chosen
          : defaults;
        list.push({ chord: parseChord(chord), command });
      }
      if (command.mouseButton !== undefined) {
        mouse.set(command.mouseButton, command);
      }
    }
    this.bindings = [...chosen, ...defaults];
    this.mouseBindings = mouse;
    this.revision.update((n) => n + 1);
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.repeat || this.pauses > 0) {
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
