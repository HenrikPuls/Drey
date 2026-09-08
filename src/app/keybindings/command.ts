/**
 * A named, keyboard-invocable command. The keybinding module maps chords
 * onto these; a future command palette would list them by `label`.
 *
 * `keybinding` is a chord string: `+`-joined parts, case-insensitive, e.g.
 * `Mod+Shift+F`. `Mod` is Ctrl on Windows/Linux and Cmd on macOS; `Ctrl`,
 * `Alt`/`Option`, `Shift` and `Meta`/`Cmd` are also accepted. The last part
 * is the key itself (`KeyboardEvent.key`, matched case-insensitively).
 */
export interface Command {
  id: string;
  label: string;
  keybinding?: string;
  run: () => void;
}

/** A parsed chord: the modifier flags plus the lower-cased key. */
export interface Chord {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** Parses `Mod+Shift+F` into a {@link Chord}. Unknown parts become the key. */
export function parseChord(spec: string): Chord {
  const chord: Chord = { mod: false, shift: false, alt: false, key: '' };
  for (const raw of spec.split('+')) {
    const part = raw.trim().toLowerCase();
    switch (part) {
      case 'mod':
      case 'ctrl':
      case 'control':
      case 'cmd':
      case 'command':
      case 'meta':
        chord.mod = true;
        break;
      case 'shift':
        chord.shift = true;
        break;
      case 'alt':
      case 'option':
        chord.alt = true;
        break;
      default:
        chord.key = part;
    }
  }
  return chord;
}

/** True when `event` is exactly `chord` -- same modifiers, same key. */
export function matchesChord(event: KeyboardEvent, chord: Chord): boolean {
  return (
    (event.ctrlKey || event.metaKey) === chord.mod &&
    event.shiftKey === chord.shift &&
    event.altKey === chord.alt &&
    event.key.toLowerCase() === chord.key
  );
}
