import { TestBed } from '@angular/core/testing';
import { LayoutService } from './layout.service';

describe('LayoutService', () => {
  beforeEach(() => {
    localStorage.removeItem('drey.layout');
  });

  afterEach(() => {
    localStorage.removeItem('drey.layout');
  });

  it('starts at the defaults', () => {
    const layout = TestBed.inject(LayoutService);
    expect(layout.sidebarWidth()).toBe(220);
    expect(layout.drawerHeight()).toBe(430);
  });

  it('clamps the entry drawer to its allowed range', () => {
    const layout = TestBed.inject(LayoutService);

    layout.setDrawerHeight(20);
    expect(layout.drawerHeight()).toBe(240);

    layout.setDrawerHeight(5000);
    expect(layout.drawerHeight()).toBe(680);
  });

  it('clamps a width drag to the allowed range', () => {
    const layout = TestBed.inject(LayoutService);

    layout.setSidebarWidth(40);
    expect(layout.sidebarWidth()).toBe(160);

    layout.setSidebarWidth(2000);
    expect(layout.sidebarWidth()).toBe(460);

    layout.setSidebarWidth(300.7);
    expect(layout.sidebarWidth()).toBe(301);
  });

  it('persists sizes to localStorage and reloads them', () => {
    const first = TestBed.inject(LayoutService);
    first.setSidebarWidth(320);
    first.setDrawerHeight(260);

    TestBed.resetTestingModule();
    const second = TestBed.inject(LayoutService);
    expect(second.sidebarWidth()).toBe(320);
    expect(second.drawerHeight()).toBe(260);
  });
});
