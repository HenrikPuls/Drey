/**
 * The chord grammar of the keyboard shortcuts (ADR-0073), shared by the
 * renderer's `KeybindingService`, the Settings page that records chords,
 * `normalizeAppConfig` and the main process's quick-capture hotkey. Pure.
 *
 * A chord is a `+`-joined string: modifiers, then the key — `Mod+Shift+F`.
 * `Mod` is Ctrl on Windows/Linux and Cmd on macOS; `Ctrl`, `Cmd` and
 * `Meta` read as `Mod` too, `Option` as `Alt`. The key is a
 * `KeyboardEvent.key`, matched case-insensitively. The canonical spelling
 * (what is stored) orders the modifiers `Mod`, `Alt`, `Shift` and spells
 * the key with its first letter upper-case (`K`, `F6`, `ArrowLeft`,
 * `Space`).
 */

/** A parsed chord: the modifier flags plus the lower-cased key (`' '` for Space). */
export interface ChordParts {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** The quick-capture hotkey when the user never changed it. */
export const DEFAULT_CAPTURE_CHORD = 'Mod+Alt+N';

/** Named keys in their canonical spelling, by lower-cased name. */
const NAMED_KEYS: ReadonlyMap<string, string> = new Map(
  [
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Enter',
    'Escape',
    'Tab',
    'Backspace',
    'Delete',
    'Insert',
    'Home',
    'End',
    'PageUp',
    'PageDown',
  ].map((name) => [name.toLowerCase(), name]),
);

/** The key names `KeyboardEvent.key` reports for a modifier pressed on its own. */
const MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'altgraph', 'meta', 'os', 'capslock']);

const FUNCTION_KEY = /^f([1-9]|1[0-9]|2[0-4])$/;

/**
 * Chords the editor or Electron need — undo/redo, the clipboard, select
 * all, find, the task toggle, zoom, completion, the editor's line moves
 * and select line, closing the window. Canonical spelling.
 */
export const RESERVED_CHORDS: ReadonlySet<string> = new Set([
  'Mod+Z',
  'Mod+Shift+Z',
  'Mod+Y',
  'Mod+X',
  'Mod+C',
  'Mod+V',
  'Mod+A',
  'Mod+F',
  'Mod+L',
  'Mod+Enter',
  'Mod+=',
  'Mod++',
  'Mod+Shift++',
  'Mod+-',
  'Mod+0',
  'Mod+Space',
  'Alt+ArrowUp',
  'Alt+ArrowDown',
  'Alt+F4',
  'Alt+Tab',
]);

/** Parses `Mod+Shift+F` into {@link ChordParts}. Unknown parts become the key. */
export function parseChord(spec: string): ChordParts {
  const chord: ChordParts = { mod: false, shift: false, alt: false, key: '' };
  // `Mod++` names the plus key: the split leaves two empty parts at the end.
  const plusKey = spec.trim().endsWith('++') || spec.trim() === '+';
  const parts = spec.split('+');
  if (plusKey) {
    parts.splice(parts.length - 2, 2);
  }
  for (const raw of parts) {
    const part = raw.trim().toLowerCase();
    switch (part) {
      case '':
        break;
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
      case 'space':
        chord.key = ' ';
        break;
      default:
        chord.key = part;
    }
  }
  if (plusKey) {
    chord.key = '+';
  }
  return chord;
}

/** A lower-cased key in its canonical spelling: `k` → `K`, `arrowleft` → `ArrowLeft`. */
function canonicalKey(key: string): string {
  if (key === ' ') {
    return 'Space';
  }
  const named = NAMED_KEYS.get(key);
  if (named) {
    return named;
  }
  if (FUNCTION_KEY.test(key)) {
    return key.toUpperCase();
  }
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Writes {@link ChordParts} in the canonical spelling. */
export function formatChordParts(parts: ChordParts): string {
  const out: string[] = [];
  if (parts.mod) {
    out.push('Mod');
  }
  if (parts.alt) {
    out.push('Alt');
  }
  if (parts.shift) {
    out.push('Shift');
  }
  out.push(canonicalKey(parts.key));
  return out.join('+');
}

/** The canonical spelling of a chord string, or `null` when it names no key. */
export function canonicalChord(spec: string): string | null {
  const parts = parseChord(spec);
  return parts.key ? formatChordParts(parts) : null;
}

/** The fields of a `KeyboardEvent` a chord is read from. */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The chord a key press spells, canonical — or `null` while only
 * modifiers are held (the recorder keeps waiting for the key).
 */
export function chordFromKeyPress(press: KeyPress): string | null {
  const key = press.key.toLowerCase();
  if (!key || MODIFIER_KEYS.has(key) || key === 'dead' || key === 'unidentified') {
    return null;
  }
  return formatChordParts({
    mod: press.ctrlKey || press.metaKey,
    alt: press.altKey,
    shift: press.shiftKey,
    key,
  });
}

/** Why a chord cannot be assigned. */
export type ChordProblem = 'no-key' | 'needs-modifier' | 'reserved';

/**
 * Whether a chord may be assigned to a command or the quick-capture
 * hotkey: it needs Ctrl/Alt, or a function key (with or without
 * modifiers) — a bare letter would swallow typing — and must not be one
 * of the {@link RESERVED_CHORDS}. `null` = fine.
 */
export function chordProblem(spec: string): ChordProblem | null {
  const parts = parseChord(spec);
  if (!parts.key) {
    return 'no-key';
  }
  if (!parts.mod && !parts.alt && !FUNCTION_KEY.test(parts.key)) {
    return 'needs-modifier';
  }
  if (RESERVED_CHORDS.has(formatChordParts(parts))) {
    return 'reserved';
  }
  return null;
}

/**
 * The chord a command has, given its own default and the user's
 * overrides: an override wins, `null` there means "no shortcut", a
 * missing id keeps the default.
 */
export function effectiveChord(
  id: string,
  defaultChord: string | undefined,
  overrides: Readonly<Record<string, string | null>>,
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(overrides, id)) {
    return overrides[id] ?? undefined;
  }
  return defaultChord;
}

/** Two chord strings that name the same keys, whatever their spelling. */
export function sameChord(a: string, b: string): boolean {
  const left = canonicalChord(a);
  return left !== null && left === canonicalChord(b);
}

/** Electron accelerator names of keys that differ from the canonical key. */
const ACCELERATOR_KEYS: ReadonlyMap<string, string> = new Map([
  [' ', 'Space'],
  ['+', 'Plus'],
  ['arrowup', 'Up'],
  ['arrowdown', 'Down'],
  ['arrowleft', 'Left'],
  ['arrowright', 'Right'],
]);

/**
 * The chord as an Electron accelerator (`globalShortcut`), e.g.
 * `CommandOrControl+Alt+N` — or `null` for a key Electron cannot name.
 */
export function chordToAccelerator(spec: string): string | null {
  const parts = parseChord(spec);
  if (!parts.key) {
    return null;
  }
  let key = ACCELERATOR_KEYS.get(parts.key);
  if (key === undefined) {
    if (parts.key.length === 1 || FUNCTION_KEY.test(parts.key) || NAMED_KEYS.has(parts.key)) {
      key = canonicalKey(parts.key);
      if (key.length === 1) {
        key = key.toUpperCase();
      }
    } else {
      return null;
    }
  }
  const out: string[] = [];
  if (parts.mod) {
    out.push('CommandOrControl');
  }
  if (parts.alt) {
    out.push('Alt');
  }
  if (parts.shift) {
    out.push('Shift');
  }
  out.push(key);
  return out.join('+');
}
