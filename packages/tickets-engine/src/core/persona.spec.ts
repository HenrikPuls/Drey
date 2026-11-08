import { describe, expect, it } from 'vitest';
import { inPipelineOrder, parsePersonaFile, personaFileText, personaMigrationFor, personaModelFor, personaRef, resolvePersona, type PersonaModelContext } from './persona';

const PIA = `---
title: Pia
role: planner
worker: claude-code
models:
  default: opus
  pool: [opus, sonnet, glm-5.2]
  router: off
color: '#a78bfa'
skills: [repo-recherche, fragen-formulieren]
---
Pia plant. Ton: knapp, fragt lieber einmal mehr.
`;

describe('inPipelineOrder (fidelity ruling O12)', () => {
  it('reads plan to test whatever the ids sort to, custom roles after, the human last', () => {
    const list = [
      { id: 'ben', role: 'builder', kind: 'agent' },
      { id: 'you', role: 'custom', kind: 'human' },
      { id: 'tessa', role: 'tester', kind: 'agent' },
      { id: 'zed', role: 'custom', kind: 'agent' },
      { id: 'anna', role: 'custom', kind: 'agent' },
      { id: 'paul', role: 'planner', kind: 'agent' },
      { id: 'ralf', role: 'reviewer', kind: 'agent' },
    ] as const;
    expect(inPipelineOrder(list).map((persona) => persona.id)).toEqual(['paul', 'ben', 'ralf', 'tessa', 'anna', 'zed', 'you']);
  });
});

describe('parsePersonaFile', () => {
  it('reads the frontmatter with the concept defaults', () => {
    expect(parsePersonaFile('pia', PIA)).toEqual({
      id: 'pia',
      kind: 'agent',
      title: 'Pia',
      role: 'planner',
      worker: 'claude-code',
      models: { default: 'opus', pool: ['opus', 'sonnet', 'glm-5.2'], router: 'off' },
      color: '#a78bfa',
      skills: ['repo-recherche', 'fragen-formulieren'],
      budget: null,
    });
  });

  it('tolerates a sparse file and degrades unknown values', () => {
    const persona = parsePersonaFile('ben', `---\nrole: wizard\nmodels:\n  router: chaos\n---\n`);
    expect(persona.role).toBe('custom');
    expect(persona.worker).toBe('opencode');
    expect(persona.models.default).toBe('opus');
    expect(persona.models.pool).toEqual(['opus']);
    expect(persona.models.router).toBe('off');
    expect(persona.budget).toBeNull();
  });

  it('rejects malformed ids', () => {
    expect(() => personaRef('Bad Id!')).toThrow('persona id');
  });

  it('round-trips through personaFileText', () => {
    const persona = parsePersonaFile('pia', PIA);
    expect(parsePersonaFile('pia', personaFileText(persona))).toEqual(persona);
  });

  it("personaFileText keeps the owner's prose below the fence when the patch passes it (U4)", () => {
    const persona = parsePersonaFile('pia', PIA);
    const withBody = personaFileText(persona, 'Pia plans carefully; no dependency bumps without asking.');
    expect(withBody).toContain('Pia plans carefully; no dependency bumps without asking.');
    expect(withBody).not.toContain(`Who ${persona.title} is: role, tone, limits`);
    // the frontmatter round-trips byte-for-byte above the prose
    expect(withBody.split('---\n')[1]).toBe(personaFileText(persona).split('---\n')[1]);
    expect(parsePersonaFile('pia', withBody)).toEqual(persona);
    // a fresh persona keeps the default prose line
    expect(personaFileText(persona)).toContain(`Who ${persona.title} is: role, tone, limits`);
  });
});

describe('budget — the daily spend limit (concept §4.3)', () => {
  it('reads the USD-per-day number', () => {
    const persona = parsePersonaFile('pia', `---\ntitle: Pia\nbudget: 25\n---\n`);
    expect(persona.budget).toBe(25);
  });

  it('tolerates a numeric string and rejects junk, fractions allowed', () => {
    expect(parsePersonaFile('pia', `---\nbudget: '12.5'\n---\n`).budget).toBe(12.5);
    expect(parsePersonaFile('pia', `---\nbudget: much\n---\n`).budget).toBeNull();
    expect(parsePersonaFile('pia', `---\nbudget: -3\n---\n`).budget).toBeNull();
    expect(parsePersonaFile('pia', `---\n---\n`).budget).toBeNull();
  });

  it('round-trips a set budget through personaFileText and omits a null one', () => {
    const rich = parsePersonaFile('pia', `---\ntitle: Pia\nbudget: 25\n---\n`);
    expect(personaFileText(rich)).toContain('budget: 25');
    expect(parsePersonaFile('pia', personaFileText(rich))).toEqual(rich);
    const poor = parsePersonaFile('pia', `---\ntitle: Pia\n---\n`);
    expect(personaFileText(poor)).not.toContain('budget');
    expect(parsePersonaFile('pia', personaFileText(poor))).toEqual(poor);
  });
});

describe('resolvePersona', () => {
  it('runs the three-level ladder: ticket > phase > default', () => {
    expect(resolvePersona({ ticketPersona: 'tessa', phasePersona: 'pia', defaultPersona: 'ben' })).toEqual({
      persona: 'tessa',
      source: 'ticket',
    });
    expect(resolvePersona({ ticketPersona: null, phasePersona: 'pia', defaultPersona: 'ben' })).toEqual({
      persona: 'pia',
      source: 'phase',
    });
    expect(resolvePersona({ ticketPersona: '', phasePersona: null, defaultPersona: 'ben' })).toEqual({
      persona: 'ben',
      source: 'default',
    });
    expect(resolvePersona({ ticketPersona: null, phasePersona: null, defaultPersona: null })).toEqual({
      persona: null,
      source: 'none',
    });
  });
});

describe('personaModelFor (D-62: the pool and the router act at dispatch)', () => {
  const pia = parsePersonaFile('pia', PIA);
  const ctx = (over: Partial<PersonaModelContext> = {}): PersonaModelContext => ({
    phase: 'plan',
    provider: 'claude-code',
    freeSlots: { 'claude-code': 1, opencode: 1, kimi: 1 },
    failedRuns: 0,
    ...over,
  });

  it('without a fleet context the default stands (the Crew tab, estimates)', () => {
    expect(personaModelFor(pia, null)).toEqual({ model: 'opus', provider: null, viaRouter: false, reason: 'the default' });
  });

  it('router off: the default while its pool has a free slot', () => {
    expect(personaModelFor(pia, ctx())).toMatchObject({ model: 'opus', provider: null, viaRouter: false });
  });

  it("router off: the second pool entry when the first entry's pool is full", () => {
    const mixed = { ...pia, models: { ...pia.models, pool: ['opus', 'kimi/k2', 'sonnet'] } };
    const choice = personaModelFor(mixed, ctx({ freeSlots: { 'claude-code': 0, kimi: 1, opencode: 1 } }));
    expect(choice).toMatchObject({ model: 'k2', provider: 'kimi', viaRouter: false });
    expect(choice.reason).toContain('claude-code pool is full');
  });

  it('every pool full: the default is named and the provider gate makes the ticket wait', () => {
    const mixed = { ...pia, models: { ...pia.models, pool: ['opus', 'kimi/k2'] } };
    expect(personaModelFor(mixed, ctx({ freeSlots: { 'claude-code': 0, kimi: 0, opencode: 0 } }))).toMatchObject({ model: 'opus', provider: null });
  });

  it('an entry whose provider has no configured pool is skipped with a reason, never a crash', () => {
    const mixed = { ...pia, models: { ...pia.models, pool: ['kimi/k2', 'sonnet'], router: 'budget' as const } };
    const choice = personaModelFor(mixed, ctx({ freeSlots: { 'claude-code': 1 } })); // no kimi pool at all
    expect(choice).toMatchObject({ model: 'sonnet', provider: null });
    expect(choice.reason).toContain('k2: no kimi pool is configured');
  });

  it('a slash that names no worker provider is part of the model id (zai/glm-5.3)', () => {
    const glm = { ...pia, models: { default: 'zai/glm-5.3', pool: ['zai/glm-5.3'], router: 'off' as const } };
    expect(personaModelFor(glm, ctx())).toMatchObject({ model: 'zai/glm-5.3', provider: null });
  });

  it('budget router: the pool in order (cheapest first), skipping full pools', () => {
    const budget = { ...pia, models: { default: 'opus', pool: ['glm-5.2', 'sonnet', 'opus'], router: 'budget' as const } };
    expect(personaModelFor(budget, ctx())).toMatchObject({ model: 'glm-5.2', viaRouter: true });
    const kimiFirst = { ...budget, models: { ...budget.models, pool: ['kimi/k2', 'sonnet'] } };
    expect(personaModelFor(kimiFirst, ctx({ freeSlots: { kimi: 0, 'claude-code': 1 } }))).toMatchObject({ model: 'sonnet', provider: null, viaRouter: true });
  });

  it('escalate-on-fail: the default first, one pool step per failed run of the ticket in this phase', () => {
    const escalate = { ...pia, models: { default: 'sonnet', pool: ['glm-5.2', 'sonnet', 'opus'], router: 'escalate-on-fail' as const } };
    expect(personaModelFor(escalate, ctx())).toMatchObject({ model: 'sonnet', viaRouter: true });
    expect(personaModelFor(escalate, ctx({ failedRuns: 1 }))).toMatchObject({ model: 'opus', viaRouter: true });
    expect(personaModelFor(escalate, ctx({ failedRuns: 5 }))).toMatchObject({ model: 'opus' }); // the pool's end holds
  });
});

describe('personaMigrationFor', () => {
  it('builds a persona candidate from legacy column keys', () => {
    expect(personaMigrationFor({ phaseId: 'build', worker: 'claude-code', model: 'sonnet', prompt: 'build-default' })).toEqual({
      id: 'build-default',
      title: 'build default',
      worker: 'claude-code',
      model: 'sonnet',
      promptRef: 'build-default',
    });
  });

  it('slugifies odd prompt refs and falls back to the phase id', () => {
    expect(personaMigrationFor({ phaseId: 'qa', worker: null, model: 'glm', prompt: 'QA — Default!!' })!.id).toBe('qa-default');
    expect(personaMigrationFor({ phaseId: 'qa', worker: null, model: null, prompt: null })).toBeNull();
  });
});
