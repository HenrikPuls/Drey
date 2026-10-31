import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { createIconElement, Icon } from './icon';

@Component({
  imports: [Icon],
  template: `<app-icon name="settings" [size]="20" />`,
})
class Host {}

describe('Icon', () => {
  let fixture: ComponentFixture<Host>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Host] }).compileComponents();
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  });

  it('renders the named glyph as sized SVG primitives', () => {
    const svg = (fixture.nativeElement as HTMLElement).querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('20');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    // settings = one path + one circle
    expect(svg.querySelectorAll('path').length).toBe(1);
    expect(svg.querySelectorAll('circle').length).toBe(1);
  });

  it('renders every name added for req-75 as a non-empty SVG', () => {
    for (const name of ['external-link', 'messages-square', 'mic', 'rocket', 'hand', 'users']) {
      const svg = createIconElement(name, 14);
      expect(svg.childNodes.length, name).toBeGreaterThan(0);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });
});
