import { OverlayGuardService } from './overlay-guard.service';

describe('OverlayGuardService', () => {
  let svc: OverlayGuardService;

  beforeEach(() => {
    svc = new OverlayGuardService();
  });

  it('is not suppressed with no guards held', () => {
    expect(svc.suppressed()).toBe(false);
  });

  it('suppresses while at least one guard is held', () => {
    const release = svc.acquire();
    expect(svc.suppressed()).toBe(true);
    release();
    expect(svc.suppressed()).toBe(false);
  });

  it('needs every guard released before it clears', () => {
    const a = svc.acquire();
    const b = svc.acquire();
    a();
    expect(svc.suppressed()).toBe(true);
    b();
    expect(svc.suppressed()).toBe(false);
  });

  it('ignores a double release', () => {
    const a = svc.acquire();
    const b = svc.acquire();
    a();
    a(); // no-op
    expect(svc.suppressed()).toBe(true);
    b();
    expect(svc.suppressed()).toBe(false);
  });
});
