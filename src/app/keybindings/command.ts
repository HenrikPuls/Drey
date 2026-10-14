import { ChordParts, parseChord } from '../../../shared/keybindings';

/**
 * A named, keyboard-invocable command. The keybinding module maps chords
 * onto these; the command palette lists them by `label`.
 *
 * `keybinding` is the command's DEFAULT chord (`shared/keybindings.ts`
 * grammar): `+`-joined parts, case-insensitive, e.g. `Mod+Shift+F`. `Mod`
 * is Ctrl on Windows/Linux and Cmd on macOS. The user may replace or
 * remove it in Settings → Keyboard shortcuts (ADR-0073); what is in effect
 * comes from `KeybindingService.chordFor` / `all()`.
 */
export interface Command {
  id: string;
  label: string;
  keybinding?: string;
  /**
   * A mouse button bound to this command (`MouseEvent.button`): `3` is
   * the back / XButton1 side button, `4` the forward / XButton2 side
   * button (VS Code-style history navigation). Triggered window-wide on
   * `mouseup`; the event is swallowed so Chromium's own back/forward
   * default action never fires. Not rebindable.
   */
  mouseButton?: number;
  /**
   * `payload` carries optional context from the invoker (SDK 1.9: a tag
   * pill click runs `search.open` with `{ tag }`); keyboard invocations
   * pass none.
   */
  run: (payload?: unknown) => void;
}

/** A parsed chord: the modifier flags plus the lower-cased key. */
export type Chord = ChordParts;

export { parseChord };

/** True when `event` is exactly `chord` -- same modifiers, same key. */
export function matchesChord(event: KeyboardEvent, chord: Chord): boolean {
  return (
    (event.ctrlKey || event.metaKey) === chord.mod &&
    event.shiftKey === chord.shift &&
    event.altKey === chord.alt &&
    event.key.toLowerCase() === chord.key
  );
}

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

/** `Mod+Shift+F` as the menus print it: `Ctrl Shift F`. */
export function formatChord(spec: string | undefined | null): string {
  if (!spec) {
    return '';
  }
  const chord = parseChord(spec);
  const parts: string[] = [];
  if (chord.mod) {
    parts.push(IS_MAC ? 'Cmd' : 'Ctrl');
  }
  if (chord.alt) {
    parts.push('Alt');
  }
  if (chord.shift) {
    parts.push('Shift');
  }
  const key = chord.key;
  if (key === ' ') {
    parts.push('Space');
  } else if (key.startsWith('arrow')) {
    parts.push(key.charAt(5).toUpperCase() + key.slice(6));
  } else if (key.length === 1) {
    parts.push(key.toUpperCase());
  } else if (/^f\d+$/.test(key)) {
    parts.push(key.toUpperCase());
  } else {
    parts.push(key.charAt(0).toUpperCase() + key.slice(1));
  }
  return parts.join(' ');
}
