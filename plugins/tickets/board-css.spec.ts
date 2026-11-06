// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/** What only the stylesheet decides, against the real `renderer/board.css` (D-11, D-21, D-22). Beside the renderer: its specs may not read files (lint). */
describe('the board stylesheet', () => {
  beforeAll(() => {
    const style = document.createElement('style');
    style.textContent = readFileSync(path.join(__dirname, 'renderer', 'board.css'), 'utf8');
    document.head.append(style);
  });

  it('D-22: the open step line takes no room while there is no run', () => {
    // `display: flex` on the line beats the [hidden] attribute in a browser (jsdom does not model
    // that), so the override must exist: without it a thread without a run draws an empty row.
    const css = readFileSync(path.join(__dirname, 'renderer', 'board.css'), 'utf8');
    expect(css).toMatch(/\.tickets-step-line\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.tickets-step-open\[hidden\][^{]*\{[^}]*display:\s*none/);
  });

  it('D-21: the Ready card gives way before the thread leaves its pane', () => {
    const css = readFileSync(path.join(__dirname, 'renderer', 'board.css'), 'utf8');
    expect(css).toMatch(/\.tickets-ready\s*\{[^}]*flex:\s*0 1 auto/);
    expect(css).toMatch(/\.tickets-ready-body-host\s*\{[^}]*flex:\s*0 1 auto/);
    expect(css).toMatch(/\.tickets-thread\s*\{[^}]*overflow:\s*hidden/);
  });

  it('D-11: the status bar shows a whole message, wrapped, not cut to "precon…"', () => {
    const text = document.createElement('span');
    text.className = 'tickets-statusbar-note-text';
    document.body.append(text);
    const style = getComputedStyle(text);
    expect(style.whiteSpace).toBe('normal');
    expect(style.textOverflow).not.toBe('ellipsis');
    const bar = document.createElement('div');
    bar.className = 'tickets-statusbar';
    document.body.append(bar);
    expect(getComputedStyle(bar).height).toBe('auto');
    expect(getComputedStyle(bar).minHeight).toBe('36px');
  });

  it('D-11: the store vocabulary\'s top priority wears the urgent chip', () => {
    const chip = document.createElement('span');
    chip.className = 'work-prio-mini work-prio-mini-critical';
    document.body.append(chip);
    expect(getComputedStyle(chip).color).toContain('--status-deleted');
  });
});
