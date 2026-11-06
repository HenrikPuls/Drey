/**
 * E13-24 / req-96 — the one app bar: the leading control is a labelled back
 * control on every page — "Menu" on a top-level page (the phone's root
 * screen, canvas decision 17), the parent's name on a sub-page — in the
 * same single row as the title and the page's own end slot; the row
 * carries the status-bar inset and sticks to the top so only the content
 * below scrolls. No page carries a hamburger on the phone; the chat's own
 * ☰ (its history) is a wide-screen control.
 */
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { AppBar, MC_APP_NAV } from './app-bar';

@Component({
  selector: 'mc-host',
  imports: [AppBar],
  template: `
    <mc-app-bar [title]="title()" [sub]="sub()" [back]="back()" [ownMenu]="ownMenu()" (backed)="backs = backs + 1" (menu)="menus = menus + 1">
      <span bar-end class="status">1 active</span>
    </mc-app-bar>
  `,
})
class Host {
  readonly title = signal('Work');
  readonly sub = signal<string | null>('drey-tickets');
  readonly back = signal<string | null>(null);
  readonly ownMenu = signal(false);
  backs = 0;
  menus = 0;
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

describe('AppBar (E13-24, req-96)', () => {
  it('is one row: leading control, title and the end slot together', () => {
    const { el } = mount();
    expect(el.querySelectorAll('header').length).toBe(1);
    const row = el.querySelector('header.bar')!;
    expect(row.querySelector('.lead')).not.toBeNull();
    expect(row.querySelector('.ttl')!.textContent).toBe('Work');
    expect(row.querySelector('.sub')!.textContent).toBe('drey-tickets');
    expect(row.querySelector('.end .status')!.textContent).toBe('1 active');
  });

  it('top-level page: the leading control is the labelled back control "Menu", and it asks the shell for the root menu', () => {
    const { el, openMenu } = mount();
    const back = el.querySelector<HTMLButtonElement>('button.back.menu-back')!;
    expect(back).not.toBeNull();
    expect(back.getAttribute('aria-label')).toBe('Back to Menu');
    expect(back.textContent).toContain('Menu');
    // No hamburger on a page that does not own one.
    expect(el.querySelector('button.menu-btn')).toBeNull();
    back.click();
    expect(openMenu).toHaveBeenCalledTimes(1);
  });

  it('a page with its own ☰ (the chat) keeps the "Menu" back control and emits its own menu from the ☰', () => {
    const { fixture, el, openMenu } = mount();
    fixture.componentInstance.ownMenu.set(true);
    fixture.detectChanges();
    expect(el.querySelector('button.menu-back')).not.toBeNull();
    const own = el.querySelector<HTMLButtonElement>('button.menu-btn')!;
    expect(own.getAttribute('aria-label')).toBe('Menu and chat history');
    own.click();
    expect(fixture.componentInstance.menus).toBe(1);
    expect(openMenu).not.toHaveBeenCalled();
  });

  it('sub-page: the leading control becomes the back control with the parent name', () => {
    const { fixture, el, openMenu } = mount();
    fixture.componentInstance.back.set('Settings');
    fixture.componentInstance.title.set('Appearance');
    fixture.componentInstance.sub.set(null);
    fixture.detectChanges();

    expect(el.querySelector('button.menu-btn')).toBeNull();
    expect(el.querySelector('button.menu-back')).toBeNull();
    expect(el.querySelectorAll('header').length).toBe(1);
    expect(el.querySelectorAll('button.back').length).toBe(1);
    const back = el.querySelector<HTMLButtonElement>('button.back')!;
    expect(back.getAttribute('aria-label')).toBe('Back to Settings');
    expect(back.textContent).toContain('Settings');
    expect(el.querySelector('.ttl')!.textContent).toBe('Appearance');

    back.click();
    expect(fixture.componentInstance.backs).toBe(1);
    expect(openMenu).not.toHaveBeenCalled();
  });
});
