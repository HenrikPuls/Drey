import type { Command } from '../keybindings';
import { buildShortcutsMarkdown } from './shortcuts-doc';

const cmd = (id: string, label: string, keybinding?: string, mouseButton?: number): Command => ({
  id,
  label,
  ...(keybinding !== undefined ? { keybinding } : {}),
  ...(mouseButton !== undefined ? { mouseButton } : {}),
  run: () => undefined,
});

describe('buildShortcutsMarkdown', () => {
  it('lists the registry commands sorted by label with formatted chords', () => {
    const md = buildShortcutsMarkdown([
      cmd('note.save', 'Save', 'Mod+S'),
      cmd('note.new', 'New note', 'Mod+N'),
    ]);

    expect(md).toContain('# Keyboard shortcuts');
    expect(md.indexOf('| New note | Ctrl N |')).toBeGreaterThan(-1);
    expect(md).toContain('| Save | Ctrl S |');
    // Sorted: 'New note' before 'Save'.
    expect(md.indexOf('New note')).toBeLessThan(md.indexOf('| Save'));
  });

  it('marks the mouse side buttons next to the chord, and mouse-only rows without one', () => {
    const md = buildShortcutsMarkdown([
      cmd('doc.back', 'Go back', 'Alt+ArrowLeft', 3),
      cmd('doc.forward', 'Go forward', 'Alt+ArrowRight', 4),
      cmd('mouse.only', 'Mouse thing', undefined, 3),
    ]);

    expect(md).toContain('| Go back | Alt Left or the back mouse button |');
    expect(md).toContain('| Go forward | Alt Right or the forward mouse button |');
    expect(md).toContain('| Mouse thing | Back mouse button |');
  });

  it('prints an em dash for a command with no shortcut at all', () => {
    const md = buildShortcutsMarkdown([cmd('bare', 'Bare command')]);
    expect(md).toContain('| Bare command | — |');
  });

  it('carries the fixed editing rows (outside the registry) in their own section', () => {
    const md = buildShortcutsMarkdown([]);

    expect(md).toContain('## Editing');
    expect(md).toContain('| Ctrl F | Find in note |');
    expect(md).toContain('| Ctrl Alt N | Quick capture (system-wide, while Drey runs) |');
    // No commands: the Commands table holds only its header.
    const commandsSection = md.slice(md.indexOf('## Commands'), md.indexOf('## Editing'));
    expect(commandsSection).not.toContain('| New note');
  });
});
