import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ToolbarContributionsService } from '../plugin-host';
import { MarkdownToolbar } from './markdown-toolbar';
import { ToolbarAction } from './toolbar-commands';

/**
 * The formatting strip (req-41): nine buttons with the rare commands
 * behind four menus, the pin, and the two places a plugin button can
 * take (an Insert-menu row, or an icon of its own with a popover).
 */
describe('MarkdownToolbar', () => {
  let fixture: ComponentFixture<MarkdownToolbar>;
  let actions: ToolbarAction[];

  const host = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const button = (label: string): HTMLButtonElement =>
    host().querySelector(`.bar button[aria-label="${label}"]`) as HTMLButtonElement;
  const menuRows = (): string[] =>
    [...host().querySelectorAll('.menu > button')].map((b) =>
      (b.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
  const clickRow = (label: string): void => {
    const row = [...host().querySelectorAll<HTMLButtonElement>('.menu > button')].find((b) =>
      (b.textContent ?? '').trim().startsWith(label),
    );
    row!.click();
    fixture.detectChanges();
  };
  const open = (label: string): void => {
    button(label).click();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [MarkdownToolbar] }).compileComponents();
    fixture = TestBed.createComponent(MarkdownToolbar);
    actions = [];
    fixture.componentInstance.action.subscribe((a) => actions.push(a));
    fixture.detectChanges();
  });

  it('keeps the everyday commands as buttons and groups the rest behind menus', () => {
    const labels = [...host().querySelectorAll('.bar > button')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'Paragraph style',
      'Bold',
      'Italic',
      'More text formats',
      'List style',
      'Task list',
      'Insert link',
      'Insert table',
      'Insert',
    ]);
    expect(host().querySelector('.menu')).toBeNull();
  });

  it('a direct button emits its action at once', () => {
    button('Task list').click();
    expect(actions).toEqual([{ kind: 'list', style: 'task' }]);
  });

  it('the paragraph menu offers headings, blockquote and the callouts, and marks the caret line', () => {
    fixture.componentRef.setInput('currentLine', () => '## Plan');
    open('Paragraph style');
    expect(menuRows().slice(0, 5)).toEqual([
      'Body text',
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Blockquote',
    ]);
    expect(menuRows()).toHaveLength(10);
    const current = host().querySelector('.menu button.current') as HTMLElement;
    expect(current.textContent?.trim()).toBe('Heading 2');
    expect(current.getAttribute('aria-checked')).toBe('true');

    clickRow('Heading 3');
    expect(actions).toEqual([{ kind: 'heading', level: 3 }]);
    expect(host().querySelector('.menu')).toBeNull();
  });

  it('the text-format menu carries the wraps and the eraser', () => {
    let erased = 0;
    fixture.componentInstance.clearFormatting.subscribe(() => (erased += 1));
    open('More text formats');
    expect(menuRows().map((r) => r.split(' ')[0])).toEqual([
      'Strikethrough',
      'Highlight',
      'Superscript',
      'Subscript',
      'Clear',
    ]);
    clickRow('Highlight');
    expect(actions).toEqual([{ kind: 'highlight' }]);

    open('More text formats');
    clickRow('Clear formatting');
    expect(erased).toBe(1);
  });

  it('the table button opens the size grid', () => {
    open('Insert table');
    const cell = host().querySelector(
      '.menu .grid button[aria-label="Insert table 2 by 3"]',
    ) as HTMLButtonElement;
    cell.click();
    fixture.detectChanges();
    expect(actions).toEqual([{ kind: 'table', rows: 2, cols: 3 }]);
    expect(host().querySelector('.menu')).toBeNull();
  });

  it('the insert menu offers Image… only where images can be saved', () => {
    open('Insert');
    expect(menuRows()).not.toContain('Image…');
    expect(menuRows()).toEqual(['Emoji…', 'Footnote', 'Inline math $x^2$', 'Math block $$…$$']);
    expect(host().querySelector('.menu .grid')).toBeNull();
    open('Insert');

    fixture.componentRef.setInput('imagesEnabled', true);
    fixture.detectChanges();
    open('Insert');
    expect(menuRows()[0]).toBe('Image…');
  });

  it('the pin leads the docked bar, ends the floating one and is absent without a state', () => {
    expect(host().querySelector('button.pin')).toBeNull();

    let toggles = 0;
    fixture.componentInstance.pinToggle.subscribe(() => (toggles += 1));
    fixture.componentRef.setInput('pinned', true);
    fixture.detectChanges();
    const docked = [...host().querySelectorAll('.bar > button')];
    expect(docked[0].classList.contains('pin')).toBe(true);
    expect(docked[0].getAttribute('aria-pressed')).toBe('true');
    expect(docked[0].getAttribute('aria-label')).toBe('Unpin formatting toolbar');

    fixture.componentRef.setInput('pinned', false);
    fixture.componentRef.setInput('overlay', true);
    fixture.detectChanges();
    const floating = [...host().querySelectorAll('.bar > button')];
    const last = floating[floating.length - 1] as HTMLButtonElement;
    expect(last.classList.contains('pin')).toBe(true);
    expect(last.getAttribute('aria-label')).toBe('Pin formatting toolbar');
    expect(host().classList.contains('overlay')).toBe(true);
    last.click();
    expect(toggles).toBe(1);
  });

  it('a plugin button is an Insert-menu row by default', () => {
    let ran = 0;
    let done = 0;
    fixture.componentInstance.done.subscribe(() => (done += 1));
    TestBed.inject(ToolbarContributionsService).register([
      { icon: 'shapes', title: 'Insert diagram', run: () => (ran += 1) },
    ]);
    fixture.detectChanges();
    expect(button('Insert diagram')).toBeNull();
    open('Insert');
    expect(menuRows()).toContain('Insert diagram');
    clickRow('Insert diagram');
    expect(ran).toBe(1);
    expect(done).toBe(1);
  });

  it('a bar-placed plugin button leads the strip and mounts its popover', () => {
    let mounted: HTMLElement | null = null;
    let disposed = 0;
    let close: () => void = () => undefined;
    let done = 0;
    fixture.componentInstance.done.subscribe(() => (done += 1));
    TestBed.inject(ToolbarContributionsService).register([
      {
        icon: 'file-text',
        title: 'Insert template',
        placement: 'bar',
        popover: (mount, closePopover) => {
          mounted = mount;
          close = closePopover;
          mount.textContent = 'picker';
          return () => (disposed += 1);
        },
      },
    ]);
    fixture.detectChanges();
    const first = host().querySelector('.bar > button') as HTMLButtonElement;
    expect(first.getAttribute('aria-label')).toBe('Insert template');

    first.click();
    fixture.detectChanges();
    TestBed.tick();
    expect(mounted).toBe(host().querySelector('.menu.plugin-pop > div'));
    expect(host().querySelector('.plugin-pop')?.textContent).toBe('picker');

    // The plugin dismisses its own popover (a pick, Escape).
    close();
    fixture.detectChanges();
    TestBed.tick();
    expect(host().querySelector('.plugin-pop')).toBeNull();
    expect(disposed).toBe(1);
    expect(done).toBe(1);
  });

  it('switches plugin buttons off on a surface without a document', () => {
    TestBed.inject(ToolbarContributionsService).register([
      { icon: 'file-text', title: 'Insert template', placement: 'bar', popover: () => () => undefined },
      { icon: 'shapes', title: 'Insert diagram', run: () => undefined },
    ]);
    fixture.componentRef.setInput('pluginButtons', false);
    fixture.detectChanges();
    expect(button('Insert template')).toBeNull();
    open('Insert');
    expect(menuRows()).not.toContain('Insert diagram');
  });

  it('carries the host menu as its first menu: open at first, one menu at a time', () => {
    const fresh = TestBed.createComponent(MarkdownToolbar);
    const states: boolean[] = [];
    fresh.componentInstance.hostMenuToggled.subscribe((open) => states.push(open));
    fresh.componentRef.setInput('hostMenu', 'Clipboard and more');
    fresh.detectChanges();
    TestBed.tick();
    const el = fresh.nativeElement as HTMLElement;
    const first = el.querySelector('.bar > button') as HTMLButtonElement;
    expect(first.getAttribute('aria-label')).toBe('Clipboard and more');
    expect(first.getAttribute('aria-expanded')).toBe('true');
    // The host draws that menu -- the strip adds neither a box nor a backdrop.
    expect(el.querySelector('.menu')).toBeNull();
    expect(el.querySelector('.backdrop')).toBeNull();

    // Another menu takes its place ...
    (el.querySelector('.bar button[aria-label="Insert"]') as HTMLButtonElement).click();
    fresh.detectChanges();
    TestBed.tick();
    expect(el.querySelector('.menu')).toBeTruthy();
    // ... and its button brings it back.
    first.click();
    fresh.detectChanges();
    TestBed.tick();
    expect(el.querySelector('.menu')).toBeNull();
    expect(states).toEqual([true, false, true]);
  });
});
