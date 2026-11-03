import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Capacity } from './capacity';
import { MC_WORK_STATE, type McWorkState } from '../work/work.model';

function render(runs: McWorkState['runs']): string {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: MC_WORK_STATE, useValue: { runs } as unknown as McWorkState }],
  });
  const fixture = TestBed.createComponent(Capacity);
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).textContent?.trim() ?? '';
}

describe('Capacity', () => {
  it('counts the live runs', () => {
    expect(render([{ state: 'running' }, { state: 'running' }, { state: 'done' }])).toBe('2 workers running');
    expect(render([{ state: 'running' }])).toBe('1 worker running');
  });

  it('says so when nothing runs or the desk sent no run data', () => {
    expect(render([])).toBe('No worker running');
    expect(render(null)).toBe('No run data');
  });
});
