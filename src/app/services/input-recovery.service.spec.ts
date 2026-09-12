import { TestBed } from '@angular/core/testing';
import { InputRecoveryService } from './input-recovery.service';
import { ImageLightboxService } from '../image-viewer';

describe('InputRecoveryService', () => {
  let recovery: InputRecoveryService;
  let lightbox: ImageLightboxService;

  beforeEach(() => {
    recovery = TestBed.inject(InputRecoveryService);
    lightbox = TestBed.inject(ImageLightboxService);
  });

  afterEach(() => {
    recovery.stopWatchdog();
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    document.body.removeAttribute('data-drey-gesture');
    document.querySelectorAll('.ctx-backdrop').forEach((el) => el.remove());
    lightbox.close();
  });

  it('recover() clears a stuck lightbox flag, body styles and an orphan backdrop', () => {
    lightbox.open('data:image/png;base64,AAAA');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
    const backdrop = document.createElement('div');
    backdrop.className = 'ctx-backdrop';
    document.body.appendChild(backdrop);

    recovery.recover('test');

    expect(lightbox.src()).toBeNull();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
    expect(document.querySelector('.ctx-backdrop')).toBeNull();
  });

  it('recover() blurs whatever holds focus', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    recovery.recover('test');

    expect(document.activeElement).not.toBe(input);
    input.remove();
  });

  it('the watchdog auto-recovers a lightbox flagged open with no overlay painted', () => {
    const origHasFocus = document.hasFocus.bind(document);
    document.hasFocus = () => true;
    try {
      lightbox.open('data:image/png;base64,AAAA');
      // No <app-image-lightbox> in this bare TestBed -> the overlay is "missing".
      recovery['tick']();
      expect(lightbox.src()).toBeNull();
    } finally {
      document.hasFocus = origHasFocus;
    }
  });

  it('the watchdog leaves a body gesture (data-drey-gesture set) alone', () => {
    const origHasFocus = document.hasFocus.bind(document);
    document.hasFocus = () => true;
    try {
      document.body.style.userSelect = 'none';
      document.body.setAttribute('data-drey-gesture', 'dock');

      recovery['tick']();

      expect(document.body.style.userSelect).toBe('none');
    } finally {
      document.hasFocus = origHasFocus;
    }
  });

  it('recover() asks main to close a stuck native popup (bug-6)', async () => {
    const recoverInputFocus = vi.fn().mockResolvedValue(true);
    (window as { dreyApi?: unknown }).dreyApi = { recoverInputFocus };
    try {
      recovery.recover('test');
      expect(recoverInputFocus).toHaveBeenCalledTimes(1);
      await Promise.resolve(); // let the floating .then (logging) settle
    } finally {
      delete (window as { dreyApi?: unknown }).dreyApi;
    }
  });
});
