import { describe, expect, it, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Settings, VIDEOS_IN_GIT_WARNING } from './settings';
import { MC_SETTINGS_STATE, parseSettings, type McSettingsState, type McSettingsView } from './settings.model';
import { Theme, THEME_ENV } from '../theme';

const VIEW: McSettingsView = {
  chat: {
    providerLabel: 'Z.ai GLM',
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'glm-5.3-flash',
    hasKey: true,
    problem: null,
  },
  devices: [
    { id: 'd1', name: 'Phone', readOnly: false, pairedAt: '2026-11-01T10:00:00Z', lastSeen: null, current: true },
    { id: 'd2', name: 'Tablet', readOnly: true, pairedAt: '2026-11-01T11:00:00Z', lastSeen: '2026-11-02T08:00:00Z', current: false },
  ],
  videos: { inGit: false, maxMb: 25, existing: 0 },
};

function mount(view: McSettingsView | null = VIEW) {
  const fake = {
    settings: signal(view),
    settingsError: signal<string | null>(null),
    load: vi.fn(() => Promise.resolve()),
    setVideoMaxMb: vi.fn(() => Promise.resolve({ ok: true as const })),
    setVideosInGit: vi.fn(() => Promise.resolve({ ok: true as const })),
    revokeDevice: vi.fn(() => Promise.resolve({ ok: true as const })),
    testChat: vi.fn(() => Promise.resolve({ ok: true, message: 'Connected to Z.ai GLM.' })),
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
      chat: null,
      devices: [{ id: 'a', name: 'A', readOnly: false, pairedAt: '', lastSeen: null, current: false }],
      videos: { inGit: true, maxMb: 25, existing: 0 },
    });
    expect(parseSettings({ ok: false })).toBeNull();
    expect(parseSettings(null)).toBeNull();
    expect(parseSettings({ ok: true, engine: {} })).toBeNull();
  });
});

describe('Settings - Chat row (D-1)', () => {
  it('reads the chat block without ever expecting a key', () => {
    const view = parseSettings({
      ok: true,
      devices: [],
      engine: {
        videos: {},
        chat: { providerLabel: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: 'm', hasKey: false, problem: 'no model is selected', apiKey: 'sk-leak' },
      },
    });
    expect(view?.chat).toEqual({ providerLabel: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: 'm', hasKey: false, problem: 'no model is selected' });
  });

  it('shows provider, endpoint and model, and tests the connection', async () => {
    const { el, go, fake, fixture } = mount();
    go('chat');
    const text = el.querySelector('.page-body')?.textContent ?? '';
    expect(text).toContain('Z.ai GLM');
    expect(text).toContain('https://api.z.ai/api/anthropic');
    expect(text).toContain('glm-5.3-flash');
    const test = Array.from(el.querySelectorAll('.page-body button')).find((b) => b.textContent?.includes('Test connection'));
    click(test ?? null);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fake.testChat).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Connected to Z.ai GLM.');
  });

  it('names the problem when the chat has no model', () => {
    const { el, go } = mount({
      ...VIEW,
      chat: { providerLabel: 'GitHub Copilot CLI', baseUrl: null, model: 'gpt', hasKey: false, problem: 'GitHub Copilot CLI: Mission Control cannot talk to this provider.' },
    });
    go('chat');
    expect(el.querySelector('.page-body .inline-error')?.textContent).toContain('cannot talk to this provider');
  });
});

describe('Settings', () => {
  it('lists the pages and loads the desk settings', () => {
    const { el, fake } = mount();
    expect(Array.from(el.querySelectorAll('.cats .row b')).map((b) => b.textContent)).toEqual(['Appearance', 'Chat', 'Devices', 'Engine']);
    expect(fake.load).toHaveBeenCalledTimes(1);
  });

  it('applies and persists an appearance choice at once', () => {
    const { el, go, theme, storage, fixture } = mount();
    go('appearance');
    click(el.querySelectorAll('.themes .tile')[1]!);
    fixture.detectChanges();
    expect(theme.name()).toBe('drey');
    expect(storage.get('mc.theme')).toBe('drey');
    click(el.querySelectorAll('.sizes .size')[3]!);
    expect(theme.textSize()).toBe('XL');
    fixture.detectChanges();
    expect(el.querySelector('.pv-line')?.textContent).toBe('XL · 19 px body text');
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
    expect(fake.setVideosInGit).toHaveBeenCalledWith(true, true, false);
  });

  it('offers to include the existing videos and sends the tick with the confirmation', () => {
    const { el, go, fake, fixture } = mount({ ...VIEW, videos: { inGit: false, maxMb: 25, existing: 3 } });
    go('engine');
    const sw = el.querySelectorAll<HTMLInputElement>('.sw')[0]!;
    sw.checked = true;
    sw.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(el.querySelector('.dialog')!.textContent).toContain('Include the 3 existing videos');
    const tick = el.querySelector<HTMLInputElement>('.dialog input[type="checkbox"]')!;
    tick.checked = true;
    tick.dispatchEvent(new Event('change'));
    click(el.querySelector('.dialog .btn:not(.ghost)'));
    expect(fake.setVideosInGit).toHaveBeenCalledWith(true, true, true);
  });

  it('labels the cap as the largest single video, default 25 MB', () => {
    const { el, go } = mount();
    go('engine');
    expect(el.textContent).toContain('Largest video');
    expect(el.textContent).not.toContain('Oldest videos');
    const input = el.querySelector<HTMLInputElement>('.num')!;
    expect(input.value).toBe('25');
    expect([input.min, input.max]).toEqual(['1', '200']);
  });

  it('ignores a typed cap outside 1 to 200 MB', () => {
    const { el, go, fake, fixture } = mount();
    go('engine');
    const input = el.querySelector<HTMLInputElement>('.num')!;
    for (const bad of ['0', '201', '1.5']) {
      input.value = bad;
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('blur'));
      fixture.detectChanges();
    }
    expect(fake.setVideoMaxMb).not.toHaveBeenCalled();
  });

  it('turns videos in git off at once, without a dialog', () => {
    const { el, go, fake, fixture } = mount({ ...VIEW, videos: { inGit: true, maxMb: 25, existing: 0 } });
    go('engine');
    const sw = el.querySelectorAll<HTMLInputElement>('.sw')[0]!;
    sw.checked = false;
    sw.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(fake.setVideosInGit).toHaveBeenCalledWith(false, false);
    expect(el.querySelector('.dialog')).toBeNull();
  });

  it('commits a typed largest-video cap when the field is left', () => {
    const { el, go, fake, fixture } = mount();
    go('engine');
    const input = el.querySelector<HTMLInputElement>('.num')!;
    input.value = '40';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(fake.setVideoMaxMb).toHaveBeenCalledWith(40);
  });
});
