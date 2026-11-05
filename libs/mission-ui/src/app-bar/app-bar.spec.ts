/**
 * E13-24 — the one app bar: the leading control is the ☰ menu on a top-level
 * page and the ‹ back control on a sub-page, in the same single row as the
 * title and the page's own end slot; the row carries the status-bar inset and
 * sticks to the top so only the content below scrolls.
 */
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AppBar, MC_APP_NAV } from './app-bar';

@Component({
  selector: 'mc-host',
  imports: [AppBar],
  template: `
    <mc-app-bar [title]="title()" [sub]="sub()" [back]="back()" (backed)="backs = backs + 1">
      <span bar-end class="status">1 active</span>
    </mc-app-bar>
  `,
})
class Host {
  readonly title = signal('Work');
  readonly sub = signal<string | null>('drey-tickets');
  readonly back = signal<string | null>(null);
  backs = 0;
}

function mount(openMenu = vi.fn()) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: MC_APP_NAV, useValue: { openMenu } }],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, openMenu };
}

describe('AppBar (E13-24)', () => {
  it('is one row: leading control, title and the end slot together', () => {
    const { el } = mount();
    expect(el.querySelectorAll('header').length).toBe(1);
    const row = el.querySelector('header.bar')!;
    expect(row.querySelector('.lead')).not.toBeNull();
    expect(row.querySelector('.ttl')!.textContent).toBe('Work');
    expect(row.querySelector('.sub')!.textContent).toBe('drey-tickets');
    expect(row.querySelector('.end .status')!.textContent).toBe('1 active');
  });

  it('top-level page: the leading control is the menu, and it asks the shell to open it', () => {
    const { el, openMenu } = mount();
    expect(el.querySelector('.back')).toBeNull();
    const menu = el.querySelector<HTMLButtonElement>('button.menu-btn')!;
    expect(menu.getAttribute('aria-label')).toBe('Menu and chat history');
    expect(menu.getAttribute('title')).toBe('Menu and chat history');
    menu.click();
    expect(openMenu).toHaveBeenCalledTimes(1);
  });

  it('sub-page: the leading control becomes the back control with the parent name', () => {
    const { fixture, el, openMenu } = mount();
    fixture.componentInstance.back.set('Settings');
    fixture.componentInstance.title.set('Appearance');
    fixture.componentInstance.sub.set(null);
    fixture.detectChanges();

    expect(el.querySelector('button.menu-btn')).toBeNull();
    expect(el.querySelectorAll('header').length).toBe(1);
    const back = el.querySelector<HTMLButtonElement>('button.back')!;
    expect(back.getAttribute('aria-label')).toBe('Back to Settings');
    expect(back.textContent).toContain('Settings');
    expect(el.querySelector('.ttl')!.textContent).toBe('Appearance');

    back.click();
    expect(fixture.componentInstance.backs).toBe(1);
    expect(openMenu).not.toHaveBeenCalled();
  });
});
