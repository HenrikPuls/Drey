import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { EmojiPicker } from './emoji-picker';
import { EmojiPickerService } from './emoji-picker.service';

describe('EmojiPicker (component)', () => {
  let fixture: ComponentFixture<EmojiPicker>;
  let svc: EmojiPickerService;
  let view: EditorView;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({ imports: [EmojiPicker] }).compileComponents();
    svc = TestBed.inject(EmojiPickerService);
    fixture = TestBed.createComponent(EmojiPicker);
    view = new EditorView({
      state: EditorState.create({ doc: 'mood ', selection: { anchor: 5 } }),
      parent: document.body,
    });
    fixture.detectChanges();
  });

  afterEach(() => {
    view.destroy();
    localStorage.clear();
  });

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function cells(): HTMLButtonElement[] {
    return Array.from(root().querySelectorAll('.emoji-cell'));
  }

  function search(): HTMLInputElement {
    return root().querySelector('.emoji-search')!;
  }

  it('renders nothing while the service is closed', () => {
    expect(root().querySelector('.emoji-panel')).toBeNull();
  });

  it('shows the full grid on open, recents first once one was picked', () => {
    svc.open({ view, from: 5, to: 5 });
    fixture.detectChanges();
    expect(cells().length).toBeGreaterThan(1500);

    localStorage.setItem('drey.emoji.recent', JSON.stringify(['joy']));
    svc.close();
    svc.open({ view, from: 5, to: 5 });
    fixture.detectChanges();
    expect(cells()[0].textContent?.trim()).toBe('😂');
    expect(cells()[0].getAttribute('aria-label')).toBe(':joy:');
  });

  it('narrows the grid through the search field', () => {
    svc.open({ view, from: 5, to: 5 });
    fixture.detectChanges();
    search().value = 'fire';
    search().dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    const labels = cells().map((c) => c.getAttribute('aria-label'));
    expect(labels).toContain(':fire:');
    expect(labels.every((l) => l!.includes('fire'))).toBe(true);
  });

  it('an empty result explains itself instead of an empty grid', () => {
    svc.open({ view, from: 5, to: 5 });
    fixture.detectChanges();
    search().value = 'zzzz-no-such-emoji';
    search().dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    expect(cells()).toHaveLength(0);
    expect(root().querySelector('.emoji-empty')?.textContent).toContain('zzzz-no-such-emoji');
  });

  it('picking a cell inserts :name: into the view and closes', () => {
    svc.open({ view, from: 5, to: 5 });
    fixture.detectChanges();
    search().value = 'joy';
    search().dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    cells()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();
    expect(view.state.doc.toString()).toBe('mood :joy:');
    expect(svc.request()).toBeNull();
    expect(root().querySelector('.emoji-panel')).toBeNull();
  });

  it('Enter picks the active option and Escape closes without inserting', () => {
    svc.open({ view, from: 5, to: 5 });
    fixture.detectChanges();
    search().value = 'fire';
    search().dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    search().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    search().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(view.state.doc.toString()).toMatch(/^mood :[a-z_+-]*fire[a-z_+-]*:$/);

    svc.open({ view, from: view.state.doc.length, to: view.state.doc.length });
    fixture.detectChanges();
    search().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(svc.request()).toBeNull();
  });
});
