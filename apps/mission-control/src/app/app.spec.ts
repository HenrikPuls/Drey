/**
 * req-96 — the shell's pure layout rules: which shell a width and pointer
 * get (phone below 768 px; from 768 px the iPad on a touch device, the
 * desktop web with its tab bar on a mouse device, G-37), how the wide
 * layouts read the phone-only menu tab, and the mapping between tabs,
 * the iPad header's areas and the phone menu's places.
 */
import { describe, expect, it } from 'vitest';
import { NOTES_ENABLED, areaOf, shellKindOf, tabOfPlace, wideTabOf } from './app';

describe('shellKindOf (req-96)', () => {
  it('phone below 768 px whatever the pointer', () => {
    expect(shellKindOf(false, true)).toBe('phone');
    expect(shellKindOf(false, false)).toBe('phone');
  });

  it('from 768 px: the iPad on touch, the desktop web on a mouse (G-37)', () => {
    expect(shellKindOf(true, true)).toBe('ipad');
    expect(shellKindOf(true, false)).toBe('desktop');
  });
});

describe('the tab mappings (req-96)', () => {
  it('the wide layouts read the phone-only menu as Work', () => {
    expect(wideTabOf('menu')).toBe('work');
    expect(wideTabOf('chat')).toBe('chat');
    expect(wideTabOf('settings')).toBe('settings');
  });

  it('an area for Notes, Work and Crew; none for the chat, Settings and the menu', () => {
    expect(areaOf('notes')).toBe('notes');
    expect(areaOf('work')).toBe('work');
    expect(areaOf('team')).toBe('crew');
    expect(areaOf('chat')).toBeNull();
    expect(areaOf('settings')).toBeNull();
    expect(areaOf('menu')).toBeNull();
  });

  it('a place or area leads to its tab', () => {
    expect(tabOfPlace('work')).toBe('work');
    expect(tabOfPlace('crew')).toBe('team');
    expect(tabOfPlace('notes')).toBe('notes');
    expect(tabOfPlace('settings')).toBe('settings');
  });

  it('Notes is shown since req-101 shipped its clients', () => {
    expect(NOTES_ENABLED).toBe(true);
  });
});
