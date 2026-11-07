/**
 * req-96 — the iPad header: the left toggle at the far left, the segmented
 * Notes · Work · Crew switch (Notes only behind the flag), the Autopilot
 * slot, Settings and the right toggle; the toggles carry `aria-pressed`,
 * every control is 44 px.
 */
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ShellHeader, type ShellArea } from './header';

@Component({
  selector: 'mc-host',
  imports: [ShellHeader],
  template: `
    <mc-shell-header
      [area]="area()"
      [notesEnabled]="notes()"
      [left]="left()"
      [right]="right()"
      [settingsOn]="settingsOn()"
      (toggleLeft)="lefts = lefts + 1"
      (toggleRight)="rights = rights + 1"
      (areaChange)="picked = $event"
      (settings)="settings = settings + 1"
    >
      <span autopilot class="chip">Autopilot · On</span>
    </mc-shell-header>
  `,
})
class Host {
  readonly area = signal<ShellArea>('work');
  readonly notes = signal(false);
  readonly left = signal(true);
  readonly right = signal(false);
  readonly settingsOn = signal(false);
  lefts = 0;
  rights = 0;
  settings = 0;
  picked: ShellArea | null = null;
}

function mount() {
  TestBed.resetTestingModule();
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, host: fixture.componentInstance };
}

describe('ShellHeader (req-96)', () => {
  it('draws the toggles with aria-pressed at the far left and right, the switch between', () => {
    const { el } = mount();
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('.hdr button'));
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Left sidebar');
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(buttons.at(-1)!.getAttribute('aria-label')).toBe('Right sidebar');
    expect(buttons.at(-1)!.getAttribute('aria-pressed')).toBe('false');
    expect(buttons[0]!.querySelector('path')!.getAttribute('d')).toBe('M9 4v16');
    expect(buttons.at(-1)!.querySelector('path')!.getAttribute('d')).toBe('M15 4v16');
  });

  it('switch: Work and Crew, Notes only behind the flag; the active area is marked', () => {
    const { fixture, el, host } = mount();
    const labels = () => Array.from(el.querySelectorAll('.switch .sw')).map((b) => b.textContent!.replace(/\s+/g, ' ').trim());
    expect(labels()).toEqual(['Work', 'Crew']);
    expect(el.querySelector('.switch .sw.on')!.textContent).toContain('Work');
    host.notes.set(true);
    fixture.detectChanges();
    expect(labels()).toEqual(['Notes', 'Work', 'Crew']);
    expect(el.querySelector('.bdg')).toBeNull();
  });

  it('emits the area, the toggles and Settings', () => {
    const { fixture, el, host } = mount();
    el.querySelector<HTMLButtonElement>('button[aria-label="Left sidebar"]')!.click();
    el.querySelector<HTMLButtonElement>('button[aria-label="Right sidebar"]')!.click();
    el.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!.click();
    Array.from(el.querySelectorAll<HTMLButtonElement>('.switch .sw')).find((b) => b.textContent!.includes('Crew'))!.click();
    expect(host.lefts).toBe(1);
    expect(host.rights).toBe(1);
    expect(host.settings).toBe(1);
    expect(host.picked).toBe('crew');
    host.settingsOn.set(true);
    fixture.detectChanges();
    expect(el.querySelector('.switch .sw.on')).toBeNull();
    expect(el.querySelector('button[aria-label="Settings"]')!.getAttribute('aria-current')).toBe('page');
  });

  it('projects the Autopilot chip into its slot', () => {
    const { el } = mount();
    expect(el.querySelector('.autopilot-slot .chip')!.textContent).toBe('Autopilot · On');
  });
});
