/**
 * req-96 — the phone's root menu: no back control and no hamburger, the
 * search field narrows the chats, the places Work (with the needs count),
 * Crew, Settings (Notes only behind the flag), then New chat and the chats
 * grouped by day; a row opens its session, the active one is marked.
 */
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../api/dto';
import { McI18n } from '../i18n/i18n.service';
import { Menu, ageLabelOf, type MenuPlace } from './menu';

const NOW = Date.parse('2026-11-06T12:00:00Z');

const SESSIONS: readonly SessionMeta[] = [
  { file: 'a.md', title: 'Dark mode for the PDF export', createdAt: '2026-11-06T08:00:00Z', updatedAt: '2026-11-06T09:40:00Z', pending: 1 },
  { file: 'b.md', title: 'Why is T-0050 blocked?', createdAt: '2026-11-05T15:00:00Z', updatedAt: '2026-11-05T15:20:00Z', pending: 0 },
  { file: 'c.md', title: 'Plan the release notes', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:30:00Z', pending: 0 },
];

@Component({
  selector: 'mc-host',
  imports: [Menu],
  template: `
    <mc-menu
      [notesEnabled]="notes()"
      [needsCount]="needs()"
      [sessions]="sessions()"
      [activeFile]="active()"
      [now]="now"
      (place)="places.push($event)"
      (openChat)="opened.push($event.file)"
      (newChat)="fresh = fresh + 1"
    />
  `,
})
class Host {
  readonly notes = signal(false);
  readonly needs = signal(2);
  readonly sessions = signal<readonly SessionMeta[]>(SESSIONS);
  readonly active = signal<string | null>('b.md');
  readonly now = () => NOW;
  places: MenuPlace[] = [];
  opened: string[] = [];
  fresh = 0;
}

function mount() {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, host: fixture.componentInstance };
}

/** The element children's texts joined by one space (Angular keeps no whitespace between them). */
const texts = (el: HTMLElement, selector: string): string[] =>
  Array.from(el.querySelectorAll(selector)).map((n) =>
    n.children.length === 0
      ? n.textContent!.trim()
      : Array.from(n.children)
          .map((child) => child.textContent!.replace(/\s+/g, ' ').trim())
          .filter((text) => text !== '')
          .join(' '),
  );

describe('ageLabelOf (req-96)', () => {
  const i18n = new McI18n();
  const t = i18n.t.bind(i18n);
  it('reads minutes, hours or days; junk is empty', () => {
    expect(ageLabelOf('2026-11-06T11:48:00Z', NOW, t)).toBe('12 min');
    expect(ageLabelOf('2026-11-06T09:40:00Z', NOW, t)).toBe('2 h');
    expect(ageLabelOf('2026-11-01T10:30:00Z', NOW, t)).toBe('5 d');
    expect(ageLabelOf('never', NOW, t)).toBe('');
  });
});

describe('Menu (req-96, canvas decision 17)', () => {
  it('is the root: a title, a search field, no back control, no hamburger', () => {
    const { el } = mount();
    expect(el.querySelector('.ttl')!.textContent).toBe('Menu');
    expect(el.querySelector('input[type="search"]')!.getAttribute('aria-label')).toBe('Search');
    expect(el.querySelector('mc-app-bar')).toBeNull();
    expect(el.querySelector('.back')).toBeNull();
    expect(el.querySelector('.menu-btn')).toBeNull();
  });

  it('lists the places with the needs count, Notes only behind the flag, then the chats by day', () => {
    const { fixture, el, host } = mount();
    expect(texts(el, '.places .row')).toEqual(['Work 2 ›', 'Crew ›', 'Settings ›']);
    expect(texts(el, '.chats .group')).toEqual(['Today', 'Yesterday', 'Earlier']);
    expect(texts(el, '.chats .sess')).toEqual([
      'Dark mode for the PDF export 1 2 h',
      'Why is T-0050 blocked? 21 h',
      'Plan the release notes 5 d',
    ]);
    expect(el.querySelector('.chats .sess.cur')!.textContent).toContain('Why is T-0050 blocked?');
    host.notes.set(true);
    host.needs.set(0);
    fixture.detectChanges();
    expect(texts(el, '.places .row')).toEqual(['Notes ›', 'Work ›', 'Crew ›', 'Settings ›']);
  });

  it('emits the place, the chat and New chat', () => {
    const { el, host } = mount();
    const rows = Array.from(el.querySelectorAll<HTMLButtonElement>('.places .row'));
    rows[0]!.click();
    rows[2]!.click();
    el.querySelector<HTMLButtonElement>('.chats .sess')!.click();
    el.querySelector<HTMLButtonElement>('.chats .new')!.click();
    expect(host.places).toEqual(['work', 'settings']);
    expect(host.opened).toEqual(['a.md']);
    expect(host.fresh).toBe(1);
  });

  it('the search narrows the chats', () => {
    const { fixture, el } = mount();
    const input = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = 'release';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(texts(el, '.chats .sess')).toEqual(['Plan the release notes 5 d']);
    expect(texts(el, '.places .row').length).toBe(3);
  });

  it('says so when there is no chat yet', () => {
    const { fixture, el, host } = mount();
    host.sessions.set([]);
    fixture.detectChanges();
    expect(el.querySelector('.chats .hint')!.textContent).toBe('No chat yet.');
  });
});
