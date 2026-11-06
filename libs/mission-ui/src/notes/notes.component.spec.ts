/**
 * req-101 — the Notes screens as rendered: the list (search, Recent, folders,
 * the vault in the header line), and the note (View by default, the pencil,
 * X and ✓ as icons, the 44 px View · Live · Source control, tags, the ticket
 * link, "Ask about this note", the discard sheet, the conflict view) — and
 * no pencil on a read-only device.
 */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { Note } from './note';
import { Notes } from './notes';
import { MC_NOTES_HOST, type McNotesApi, type McNotesHost, type NoteSaveReply } from './notes.model';
import { NotesStore } from './notes.store';

function setup(readOnly = false) {
  const api = {
    notesList: vi.fn(async () => ({
      ok: true as const,
      vault: 'Main vault',
      folder: '',
      folders: [{ path: 'ideas', name: 'ideas' }],
      notes: [{ path: 'a.md', name: 'Alpha', mtime: Date.now() - 3_600_000, size: 1 }],
    })),
    notesRecent: vi.fn(async () => ({
      ok: true as const,
      vault: 'Main vault',
      notes: [{ path: 'r.md', name: 'Recent one', mtime: Date.now(), size: 1 }],
    })),
    notesSearch: vi.fn(async () => ({ ok: true as const, query: 'q', hits: [], truncated: false })),
    notesRead: vi.fn(async (path: string) => ({
      ok: true as const,
      path,
      name: 'Alpha',
      text: '---\nticket: T-0042\n---\n# Alpha\n\nhello #idea\n',
      body: '# Alpha\n\nhello #idea\n',
      tags: ['idea'],
      mtime: 100,
    })),
    notesSave: vi.fn(async (path: string, text: string): Promise<NoteSaveReply> => ({ ok: true, path, text, mtime: 200 })),
    notesCreate: vi.fn(),
  };
  const asked: string[] = [];
  const tickets: string[] = [];
  const host: McNotesHost = {
    api: api as unknown as McNotesApi,
    readOnly: () => readOnly,
    changed: signal({ seq: 0, paths: [] as readonly string[] }).asReadonly(),
    askAbout: (p) => asked.push(p),
    openTicket: (id) => tickets.push(id),
    toast: () => undefined,
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: MC_NOTES_HOST, useValue: host }] });
  return { api, asked, tickets, store: TestBed.inject(NotesStore) };
}

const flush = async (fixture: { detectChanges(): void; whenStable(): Promise<unknown> }) => {
  await fixture.whenStable();
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('mc-notes', () => {
  it('names the vault in the header, lists Recent, folders and notes, and opens a note', async () => {
    const { store } = setup();
    const fixture = TestBed.createComponent(Notes);
    await flush(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.ttl')!.textContent).toBe('Notes');
    expect(el.querySelector('.sub')!.textContent).toBe('Main vault');
    expect(el.textContent).toContain('Recent one');
    expect(el.textContent).toContain('ideas');
    const rows = Array.from(el.querySelectorAll<HTMLButtonElement>('button.row'));
    rows.find((r) => r.textContent!.includes('Alpha'))!.click();
    await flush(fixture);
    expect(store.path()).toBe('a.md');
  });

  it('has the new-note button, and not on a read-only device', async () => {
    setup(false);
    let fixture = TestBed.createComponent(Notes);
    await flush(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('[aria-label="New note"]')).not.toBeNull();
    setup(true);
    fixture = TestBed.createComponent(Notes);
    await flush(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('[aria-label="New note"]')).toBeNull();
  });

  it('shows the hits of a search', async () => {
    const { store, api } = setup();
    api.notesSearch.mockResolvedValueOnce({
      ok: true,
      query: 'plan',
      hits: [{ path: 'p.md', name: 'Plan note', mtime: 1, size: 1, lines: [{ line: 2, heading: 'Goals', text: 'the plan' }] }],
      truncated: false,
    } as never);
    const fixture = TestBed.createComponent(Notes);
    await flush(fixture);
    store.setQuery('plan');
    await store.searchNow();
    await flush(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Plan note');
    expect(el.textContent).toContain('Goals · the plan');
    expect(el.textContent).not.toContain('Recent one');
  });
});

describe('mc-note', () => {
  async function opened(readOnly = false) {
    const ctx = setup(readOnly);
    await ctx.store.open('a.md');
    const fixture = TestBed.createComponent(Note);
    await flush(fixture);
    return { ...ctx, fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('opens in View with the labelled back control, a pencil, tags, the ticket link and Ask', async () => {
    const { el, store, asked, tickets, fixture } = await opened();
    expect(store.mode()).toBe('view');
    expect(el.querySelector('.back-label')!.textContent).toBe('Notes');
    expect(el.querySelector('[aria-label="Edit note"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Cancel editing"]')).toBeNull();
    expect(el.textContent).toContain('#idea');
    const seg = Array.from(el.querySelectorAll<HTMLButtonElement>('.mdx-seg-btn'));
    expect(seg.map((b) => b.textContent!.trim())).toEqual(['View', 'Live', 'Source']);
    expect(el.querySelector('.mdx-seg-btn[aria-pressed="true"]')!.textContent!.trim()).toBe('View');
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('.actions .btn'));
    expect(buttons.map((b) => b.textContent!.trim())).toEqual(['Ticket T-0042 ›', 'Ask about this note']);
    buttons[0]!.click();
    buttons[1]!.click();
    expect(tickets).toEqual(['T-0042']);
    expect(asked).toEqual(['a.md']);
    fixture.destroy();
  });

  it('the pencil switches to Live with X and ✓ as icons; X on an unchanged note leaves without asking', async () => {
    const { el, store, fixture } = await opened();
    el.querySelector<HTMLButtonElement>('[aria-label="Edit note"]')!.click();
    await flush(fixture);
    expect(store.mode()).toBe('live');
    expect(el.querySelector('.mdx-seg-btn[aria-pressed="true"]')!.textContent!.trim()).toBe('Live');
    expect(el.querySelector('[aria-label="Save note"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Edit note"]')).toBeNull();
    el.querySelector<HTMLButtonElement>('[aria-label="Cancel editing"]')!.click();
    await flush(fixture);
    expect(el.querySelector('.sheet')).toBeNull();
    expect(store.editing()).toBe(false);
  });

  it('X on a changed note opens the discard sheet; ✓ saves', async () => {
    const { el, store, fixture, api } = await opened();
    store.startEdit();
    store.setDraft('# changed');
    await flush(fixture);
    el.querySelector<HTMLButtonElement>('[aria-label="Cancel editing"]')!.click();
    await flush(fixture);
    expect(el.querySelector('.sheet')!.textContent).toContain('Discard your changes?');
    el.querySelector<HTMLButtonElement>('.sheet .btn.primary')!.click(); // keep editing
    await flush(fixture);
    expect(el.querySelector('.sheet')).toBeNull();
    el.querySelector<HTMLButtonElement>('[aria-label="Save note"]')!.click();
    await flush(fixture);
    expect(api.notesSave).toHaveBeenCalledWith('a.md', '# changed', 100);
  });

  it('shows both versions on a conflict and lets the owner keep one', async () => {
    const { el, store, fixture, api } = await opened();
    api.notesSave.mockResolvedValueOnce({ ok: false, code: 'conflict', error: 'x', disk: { text: 'DISK', mtime: 400 } });
    store.startEdit();
    store.setDraft('MINE');
    await store.save();
    await flush(fixture);
    const conflict = el.querySelector('.conflict')!;
    expect(conflict.textContent).toContain('DISK');
    expect(conflict.textContent).toContain('MINE');
    expect(Array.from(conflict.querySelectorAll('.btn')).map((b) => b.textContent!.trim())).toEqual(["Keep mine", "Keep the desk's"]);
  });

  it('has no pencil, no mode switch and no editing on a read-only device', async () => {
    const { el, store } = await opened(true);
    expect(el.querySelector('[aria-label="Edit note"]')).toBeNull();
    expect(el.querySelector('.mdx-seg')).toBeNull();
    store.startEdit();
    expect(store.editing()).toBe(false);
  });
});
