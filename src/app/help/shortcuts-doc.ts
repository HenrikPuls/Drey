import type { Command } from '../keybindings';
import { formatChord } from '../palette';

/**
 * Rows that are real shortcuts but live outside the command registry:
 * CodeMirror's own keymap, menu-standard editing chords, the OS-wide
 * capture hotkey, and pure editor typing triggers. Kept in step with the
 * user manual's shortcut section; the registry table above them is
 * generated and can never go stale.
 */
const FIXED_ROWS: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: 'Ctrl Z', label: 'Undo' },
  { keys: 'Ctrl Shift Z', label: 'Redo' },
  { keys: 'Ctrl X', label: 'Cut' },
  { keys: 'Ctrl C', label: 'Copy' },
  { keys: 'Ctrl V', label: 'Paste' },
  { keys: 'Ctrl A', label: 'Select all' },
  { keys: 'Ctrl F', label: 'Find in note' },
  { keys: 'Ctrl Enter', label: 'Toggle task done (on a task line)' },
  { keys: 'Ctrl + / Ctrl - / Ctrl 0', label: 'Zoom editor content in / out / reset' },
  { keys: 'Ctrl Mouse wheel', label: 'Zoom editor content' },
  { keys: 'Ctrl Alt N', label: 'Quick capture (system-wide, while Drey runs)' },
  { keys: 'Esc', label: 'Close a menu, dialog or the palette' },
  { keys: '/', label: 'Open the block menu (at the start of an empty line)' },
  { keys: '[[', label: 'Autocomplete a note name (wikilink)' },
  { keys: '#', label: 'Autocomplete a tag' },
];

/** The mouse side buttons of a command, appended to its chord. */
function mouseHint(command: Command): string {
  if (command.mouseButton === 3) {
    return ' or the back mouse button';
  }
  if (command.mouseButton === 4) {
    return ' or the forward mouse button';
  }
  return '';
}

/** A mouse-only command's whole shortcut column. */
function mouseLabel(command: Command): string {
  if (command.mouseButton === 3) {
    return 'Back mouse button';
  }
  if (command.mouseButton === 4) {
    return 'Forward mouse button';
  }
  return '\u2014';
}

/**
 * Builds the in-app keyboard shortcuts document (ADR-0070): the command
 * registry as it exists RIGHT NOW -- base and plugin commands alike, so
 * the list always matches the command palette -- plus the fixed rows for
 * shortcuts that live outside the registry. Pure: the caller supplies the
 * commands, tests supply fakes.
 */
export function buildShortcutsMarkdown(commands: readonly Command[]): string {
  const rows = [...commands].sort((a, b) => a.label.localeCompare(b.label));
  const lines: string[] = [
    '# Keyboard shortcuts',
    '',
    'Generated from this app\u2019s command registry \u2014 the same list the',
    'command palette (Ctrl Shift P) shows, so it always matches what this',
    'build can do.',
    '',
    '## Commands',
    '',
    '| Command | Shortcut |',
    '| --- | --- |',
  ];
  for (const command of rows) {
    const shortcut = command.keybinding
      ? formatChord(command.keybinding) + mouseHint(command)
      : mouseLabel(command);
    lines.push(`| ${command.label} | ${shortcut} |`);
  }
  lines.push(
    '',
    '## Editing',
    '',
    'Shortcuts that live in the editor and the standard menu chords rather',
    'than the command registry:',
    '',
    '| Shortcut | Action |',
    '| --- | --- |',
  );
  for (const row of FIXED_ROWS) {
    lines.push(`| ${row.keys} | ${row.label} |`);
  }
  lines.push('');
  return lines.join('\n');
}
