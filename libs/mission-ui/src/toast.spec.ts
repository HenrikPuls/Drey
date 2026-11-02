/**
 * Specs for the toast pill component (`@mission-ui`): it renders whatever
 * the bound `McToastState` exposes and follows it live. The state slice
 * itself — the 2.2 s auto-hide, one pill at a time — belongs to the host
 * app's state store and is spec'd there (mission-control's api/state.spec).
 */
import { describe, expect, it } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MC_TOAST_STATE, type ToastMessage } from './toast.model';
import { Toast } from './toast';

describe('Toast (component)', () => {
  it('renders the current toast from the bound state and follows it live', () => {
    const toastMessage = signal<ToastMessage | null>(null);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: MC_TOAST_STATE, useValue: { toastMessage } }],
    });
    const surface = TestBed.runInInjectionContext(
      () => new Toast(),
    ) as unknown as { toast(): ToastMessage | null };

    expect(surface.toast()).toBeNull();

    toastMessage.set({ message: 'Sent back to Build', kind: 'warn' });
    expect(surface.toast()).toEqual({ message: 'Sent back to Build', kind: 'warn' });

    toastMessage.set({ message: 'Theme: Anthracite', kind: 'ok' });
    expect(surface.toast()).toEqual({ message: 'Theme: Anthracite', kind: 'ok' });

    toastMessage.set(null);
    expect(surface.toast()).toBeNull();
  });
});
