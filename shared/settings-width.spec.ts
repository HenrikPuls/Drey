import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = (path: string): string => readFileSync(resolve(__dirname, '..', path), 'utf8');

describe('one Settings page width (E13-22)', () => {
  const ui = css('src/app/settings/settings-ui.css');

  it('defines the width token once and the frame and the column use it', () => {
    expect(ui.match(/--set-page-w:/g)).toHaveLength(1);
    const frame = /\.pane-head \{[^}]*\}/.exec(ui)?.[0] ?? '';
    const column = /\.pane \{[^}]*\}/.exec(ui)?.[0] ?? '';
    expect(frame).toContain('max-width: var(--set-page-w)');
    expect(column).toContain('max-width: var(--set-page-w)');
  });

  it('grows past the old 640 px cap and does not cap the page by a fixed pixel width', () => {
    const token = /--set-page-w:\s*([^;]+);/.exec(ui)?.[1] ?? '';
    expect(token).toContain('100%');
    const px = Number(/(\d+)px/.exec(token)?.[1] ?? 0);
    expect(px).toBeGreaterThan(640);
  });

  it('the Tickets page sets no width of its own on its root', () => {
    const tickets = css('plugins/tickets/renderer/settings.css');
    const root = /\n\.tset \{[^}]*\}/.exec(tickets)?.[0] ?? '';
    expect(root).not.toMatch(/(?:max-)?width/);
  });
});
