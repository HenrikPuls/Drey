import { describe, expect, it } from 'vitest';
import type { PipelinePhase } from '../../../../packages/tickets-engine/src/contracts/tickets';
import type { PersonaView } from '../../shared/remote-protocol';
import { autopilotStateOf, budgetLineOf, maxMbOf, missingShippedPrompts, parseDeskVideos, runnersLineOf, standardFlowOf, usd } from './desk-model';

const persona = (id: string, extra: Partial<PersonaView> = {}): PersonaView => ({
  id,
  title: id.charAt(0).toUpperCase() + id.slice(1),
  role: 'builds',
  worker: 'claude-code',
  model: 'sonnet',
  pool: [],
  color: '#abc',
  budget: null,
  ...extra,
});

const phase = (id: string, handover: string, who: string | null): PipelinePhase =>
  ({ id, title: id.charAt(0).toUpperCase() + id.slice(1), handover, persona: who }) as unknown as PipelinePhase;

describe('desk settings model', () => {
  it('strings the agent phases into the standard flow with their persona', () => {
    const flow = standardFlowOf(
      [phase('inbox', 'manual', null), phase('plan', 'agent plan', 'paul'), phase('build', 'agent build', 'ben'), phase('ready', 'manual', null), phase('review', 'agent review', null)],
      [persona('paul'), persona('ben')],
    );
    expect(flow).toEqual([
      { id: 'plan', title: 'Plan', who: 'Paul' },
      { id: 'build', title: 'Build', who: 'Ben' },
      { id: 'review', title: 'Review', who: null },
    ]);
  });

  it('adds the daily budgets up, leaves the owner out, and says when there are none', () => {
    expect(budgetLineOf([persona('a')])).toBe('No persona has a daily budget');
    expect(
      budgetLineOf([persona('a', { budget: 10, dailyCost: 4.1 }), persona('b', { budget: 5 }), persona('you', { kind: 'human', budget: 99 })]),
    ).toBe('$15 across 2 personas · $4.10 spent today');
    expect(budgetLineOf([persona('a', { budget: 2.5 })])).toBe('$2.50 across 1 persona · $0 spent today');
    expect(usd(7)).toBe('$7');
  });

  it('words the runners', () => {
    expect(runnersLineOf([{ label: 'Claude Code', size: 3 }, { label: 'OpenCode', size: 1 }])).toBe('Claude Code 3 · OpenCode 1');
  });

  it('reads the engine settings answer tolerantly', () => {
    expect(parseDeskVideos({ ok: true, devices: [], engine: { videos: { inGit: true, maxMb: 25, existing: 3, notice: 'x' } } })).toEqual({
      inGit: true,
      maxMb: 25,
      existing: 3,
      notice: 'x',
    });
    expect(parseDeskVideos({ ok: false })).toBeNull();
    expect(parseDeskVideos({ ok: true, engine: {} })).toBeNull();
    expect(parseDeskVideos(null)).toBeNull();
  });

  it('parses the largest-video field as whole megabytes', () => {
    expect(maxMbOf(' 25 ')).toBe(25);
    expect(maxMbOf('')).toBeNull();
    expect(maxMbOf('2.5')).toBeNull();
    expect(maxMbOf('-3')).toBeNull();
  });
});

describe('missingShippedPrompts (D-17)', () => {
  const listing = (entries: string[], shipped: string[]) => ({ folder: '/p', entries: entries.map((ref) => ({ ref, text: '', shipped: shipped.includes(ref) })), shipped });
  const phases = (...handovers: string[]): readonly PipelinePhase[] => handovers.map((handover, i) => ({ id: `p${i}`, handover, prompt: null })) as unknown as readonly PipelinePhase[];

  it('names a shipped prompt the pipeline uses and the vault lacks', () => {
    expect(missingShippedPrompts(phases('manual', 'agent build-default'), listing([], ['build-default', 'plan-default']))).toEqual(['build-default']);
  });

  it('leaves a prompt alone that is there, and one Drey does not ship', () => {
    expect(missingShippedPrompts(phases('agent build-default'), listing(['build-default'], ['build-default']))).toEqual([]);
    expect(missingShippedPrompts(phases('agent my-own'), listing([], ['build-default']))).toEqual([]);
  });
});

describe('autopilotStateOf', () => {
  it('reads the chain master: run is On, anything else Off', () => {
    expect(autopilotStateOf('run')).toBe('on');
    expect(autopilotStateOf('halted')).toBe('off');
    expect(autopilotStateOf(null)).toBe('off');
  });
});
