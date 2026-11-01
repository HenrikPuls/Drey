import { describe, expect, it } from 'vitest';
import { personaLoader, resolvePersonaForTicket, deriveWorkerModel } from './persona-loader';

const PIA = `---
title: Pia
role: planner
worker: claude-code
models:
  default: opus
  pool: [opus, sonnet]
  router: off
color: '#a78bfa'
skills: []
---
`;

function loaderWith(files: Record<string, string>) {
  return personaLoader(async (rel) => {
    const text = files[rel];
    if (text === undefined) {
      throw new Error(`missing ${rel}`);
    }
    return text;
  });
}

describe('personaLoader', () => {
  it('loads persona, prompt and memory through the reader', async () => {
    const loader = loaderWith({
      'tickets/_meta/personas/pia/persona.md': PIA,
      'tickets/_meta/personas/pia/prompt.md': 'Du bist Pia.',
      'tickets/_meta/personas/pia/memory.md': '- 2026-10-28 · T-0071 · rank-Felder haben Vorrang',
    });
    expect((await loader.load('pia'))!.title).toBe('Pia');
    expect(await loader.prompt('pia')).toBe('Du bist Pia.');
    expect(await loader.memory('pia')).toContain('T-0071');
  });

  it('reads absence as null/empty, never throws', async () => {
    const loader = loaderWith({});
    expect(await loader.load('ghost')).toBeNull();
    expect(await loader.prompt('ghost')).toBeNull();
    expect(await loader.memory('ghost')).toBe('');
  });
});

describe('resolvePersonaForTicket', () => {
  it('resolves the ladder end to end', async () => {
    const loader = loaderWith({ 'tickets/_meta/personas/pia/persona.md': PIA });
    const hit = await resolvePersonaForTicket(loader, { ticketPersona: null, phasePersona: 'pia', defaultPersona: 'ben' });
    expect(hit.persona!.id).toBe('pia');
    expect(hit.resolution.source).toBe('phase');
    const miss = await resolvePersonaForTicket(loader, { ticketPersona: 'ghost', phasePersona: null, defaultPersona: null });
    expect(miss.persona).toBeNull();
    expect(miss.resolution.source).toBe('ticket');
  });
});

describe('deriveWorkerModel', () => {
  it('feeds the worker and the model from the persona', async () => {
    const loader = loaderWith({ 'tickets/_meta/personas/pia/persona.md': PIA });
    const { persona } = await resolvePersonaForTicket(loader, { ticketPersona: 'pia', phasePersona: null, defaultPersona: null });
    expect(deriveWorkerModel(persona!, 50_000)).toEqual({ workerChoice: 'claude-code', model: 'opus' });
  });
});
