import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { Pairing } from './pairing';

type PairFn = (code: string) => Promise<{ ok: true } | { ok: false; error: string }>;

function setup(pair?: PairFn) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({});
  const fixture = TestBed.createComponent(Pairing);
  fixture.componentRef.setInput('pair', pair ?? null);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const input = () => el.querySelector<HTMLInputElement>('.code')!;
  const button = () => el.querySelector<HTMLButtonElement>('.btn')!;
  const typeCode = (code: string): void => {
    input().value = code;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  return { fixture, el, input, button, typeCode, component: fixture.componentInstance };
}

async function click(fixture: ReturnType<typeof TestBed.createComponent<Pairing>>): Promise<void> {
  (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.btn')!.click();
  await fixture.whenStable();
  fixture.detectChanges();
}

describe('mc-pairing', () => {
  it('arms the button once a code is typed and an adapter is bound', () => {
    const s = setup(async () => ({ ok: true }));
    expect(s.button().disabled).toBe(true);
    s.typeCode('ABCD');
    expect(s.button().disabled).toBe(false);
  });

  it('without a bound adapter the button stays disabled — the honest placeholder', () => {
    const s = setup();
    s.typeCode('ABCD');
    expect(s.button().disabled).toBe(true);
  });

  it('submit exchanges the code; a refusal shows under the input', async () => {
    const seen: string[] = [];
    const s = setup(async (code) => {
      seen.push(code);
      return code === 'good' ? { ok: true } : { ok: false, error: 'the code is wrong or spent' };
    });
    s.typeCode('NOPE');
    await click(s.fixture);
    expect(seen).toEqual(['NOPE']);
    const error = s.el.querySelector('.error')?.textContent ?? '';
    expect(error).toContain('the code is wrong or spent');
  });

  it('an empty code submits nothing', async () => {
    const seen: string[] = [];
    const s = setup(async (code) => {
      seen.push(code);
      return { ok: true };
    });
    await click(s.fixture);
    expect(seen).toEqual([]);
  });

  it('the exchange phase relabels the button and disables it', () => {
    const s = setup(async () => ({ ok: true }));
    s.fixture.componentRef.setInput('phase', 'pairing');
    s.fixture.detectChanges();
    s.typeCode('ABCD');
    expect(s.button().textContent).toContain('Pairing…');
    expect(s.button().disabled).toBe(true);
  });

  it('the phase defaults to needs-code with the input visible', () => {
    const s = setup();
    expect(s.input()).not.toBeNull();
    expect(s.el.querySelector('.title')?.textContent).toContain('Pair this device');
  });
});
