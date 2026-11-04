import { describe, expect, it } from 'vitest';
import { parsePersonaFile, personaFileText, personaMigrationFor, personaModelFor, personaRef, resolvePersona } from './persona';

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

describe('personaModelFor', () => {
  const pia = parsePersonaFile('pia', PIA);

  it('runs the default with the router off', () => {
    expect(personaModelFor(pia, 100_000)).toEqual({ model: 'opus', viaRouter: false });
  });

  it('routes inside the pool only', () => {
    const budget = { ...pia, models: { ...pia.models, router: 'budget' as const } };
    expect(personaModelFor(budget, 12_000).model).toBe('opus'); // pool order = price order
    expect(personaModelFor(budget, 12_000).viaRouter).toBe(true);
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
