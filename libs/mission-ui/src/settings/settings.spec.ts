import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Settings, VIDEOS_IN_GIT_WARNING } from './settings';
import { MC_SETTINGS_STATE, parseSettings, type McSettingsState, type McSettingsView } from './settings.model';
import { Theme, THEME_ENV } from '../theme';

const VIEW: McSettingsView = {
  devices: [
    { id: 'd1', name: 'Phone', readOnly: false, pairedAt: '2026-11-01T10:00:00Z', lastSeen: null, current: true },
    { id: 'd2', name: 'Tablet', readOnly: true, pairedAt: '2026-11-01T11:00:00Z', lastSeen: '2026-11-02T08:00:00Z', current: false },
  ],
  videos: { inGit: false, limitMb: 2000, existing: 0 },
};

function mount(view: McSettingsView | null = VIEW) {
  const fake = {
    settings: signal(view),
    settingsError: signal<string | null>(null),
    load: vi.fn(() => Promise.resolve()),
    setVideoLimit: vi.fn(() => Promise.resolve({ ok: true as const })),
    setVideosInGit: vi.fn(() => Promise.resolve({ ok: true as const })),
    revokeDevice: vi.fn(() => Promise.resolve({ ok: true as const })),
  };
  const storage = new Map<string, string>();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: MC_SETTINGS_STATE, useValue: fake as unknown as McSettingsState },
      {
        provide: THEME_ENV,
        useValue: {
          doc: null,
          storage: {
            getItem: (k: string) => storage.get(k) ?? null,
            setItem: (k: string, v: string) => void storage.set(k, v),
          } as unknown as Storage,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(Settings);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const vm = fixture.componentInstance as unknown as { open(page: string): void };
  const go = (page: string): void => {
    vm.open(page);
    fixture.detectChanges();
  };
  return { fake, fixture, el, go, theme: TestBed.inject(Theme), storage };
}

const click = (el: Element | null): void => (el as HTMLElement).click();

describe('parseSettings', () => {
  it('reads the desk answer tolerantly', () => {
    expect(parseSettings({ ok: true, devices: [{ id: 'a', name: 'A' }, 5], engine: { videos: { inGit: true } } })).toEqual({
      devices: [{ id: 'a', name: 'A', readOnly: false, pairedAt: '', lastSeen: null, current: false }],
      videos: { inGit: true, limitMb: 2000, existing: 0 },
    });
    expect(parseSettings({ ok: false })).toBeNull();
    expect(parseSettings(null)).toBeNull();
    expect(parseSettings({ ok: true, engine: {} })).toBeNull();
  });
});

describe('Settings', () => {
  it('lists the pages and loads the desk settings', () => {
    const { el, fake } = mount();
    expect(Array.from(el.querySelectorAll('.cats .row b')).map((b) => b.textContent)).toEqual(['Appearance', 'Devices', 'Engine']);
    expect(fake.load).toHaveBeenCalledTimes(1);
  });

  it('applies and persists an appearance choice at once', () => {
    const { el, go, theme, storage, fixture } = mount();
    go('appearance');
    click(el.querySelectorAll('.themes .tile')[1]!);
    fixture.detectChanges();
    expect(theme.name()).toBe('drey');
    expect(storage.get('mc.theme')).toBe('drey');
    click(el.querySelectorAll('.sizes .size')[4]!);
    expect(theme.textSize()).toBe('XXL');
    const compact = el.querySelectorAll<HTMLInputElement>('.sw')[0]!;
    compact.checked = true;
    compact.dispatchEvent(new Event('change'));
    expect(theme.compact()).toBe(true);
  });

  it('revokes a device only on the second press, and never the current one', () => {
    const { el, go, fake, fixture } = mount();
    go('devices');
    const buttons = el.querySelectorAll('.act');
    expect(buttons).toHaveLength(1);
    click(buttons[0]!);
    fixture.detectChanges();
    expect(fake.revokeDevice).not.toHaveBeenCalled();
    expect(el.querySelector('.act')!.textContent!.trim()).toBe('Confirm revoke');
    click(el.querySelector('.act'));
    expect(fake.revokeDevice).toHaveBeenCalledWith('d2');
  });

  it('asks before turning videos in git on', () => {
    const { el, go, fake, fixture } = mount();
    go('engine');
    const sw = el.querySelectorAll<HTMLInputElement>('.sw')[0]!;
    sw.checked = true;
    sw.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(fake.setVideosInGit).not.toHaveBeenCalled();
    expect(el.querySelector('.dialog-text')!.textContent).toBe(VIDEOS_IN_GIT_WARNING);
    click(el.querySelector('.dialog .btn.ghost'));
    fixture.detectChanges();
    expect(el.querySelector('.dialog')).toBeNull();
    expect(fake.setVideosInGit).not.toHaveBeenCalled();

    sw.checked = true;
    sw.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    click(el.querySelector('.dialog .btn:not(.ghost)'));
    expect(fake.setVideosInGit).toHaveBeenCalledWith(true, true);
  });

  it('turns videos in git off at once, without a dialog', () => {
    const { el, go, fake, fixture } = mount({ ...VIEW, videos: { inGit: true, limitMb: 2000, existing: 0 } });
    go('engine');
    const sw = el.querySelectorAll<HTMLInputElement>('.sw')[0]!;
    sw.checked = false;
    sw.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(fake.setVideosInGit).toHaveBeenCalledWith(false, false);
    expect(el.querySelector('.dialog')).toBeNull();
  });

  it('commits a typed size limit when the field is left', () => {
    const { el, go, fake, fixture } = mount();
    go('engine');
    const input = el.querySelector<HTMLInputElement>('.num')!;
    input.value = '800';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(fake.setVideoLimit).toHaveBeenCalledWith(800);
  });
});
