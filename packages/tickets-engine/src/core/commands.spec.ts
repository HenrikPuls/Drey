import { describe, expect, it } from 'vitest';
import {
  chainResult,
  parseAnswer,
  parseAttachment,
  parseChainColumn,
  parseChainMaster,
  parseClaim,
  parseCreate,
  parsePermission,
  parsePlanPartsEdit,
  parsePlanRelease,
  parseRefine,
  parseSend,
  parseSendBack,
  parseSetTrack,
  parseStartRun,
  parseStopRun,
  parseTicketId,
  parseTransition,
} from './commands';

/**
 * req-66: the command layer both transports share. The refusals keep
 * the exact texts the IPC handlers returned before the move.
 */

describe('command parsers', () => {
  it('refuse a non-object payload with the handler-specific text', () => {
    expect(parseTransition(null)).toEqual({ ok: false, error: 'bad transition payload' });
    expect(parseClaim('x')).toEqual({ ok: false, error: 'bad claim payload' });
    expect(parseTicketId(undefined, 'archive')).toEqual({ ok: false, error: 'bad archive payload' });
    expect(parseChainMaster({ mode: 'go' })).toEqual({ ok: false, error: 'the master mode is "run" or "halted"' });
  });

  it('normalizes create: trimmed title, unknown priority -> normal, blank repo -> null', () => {
    expect(parseCreate({ title: '  ' })).toEqual({ ok: false, error: 'the title is empty' });
    expect(parseCreate({ title: ' Fix ', priority: 'huge', repo: ' ' })).toEqual({
      ok: true,
      value: { title: 'Fix', priority: 'normal', repo: null, description: '' },
    });
  });

  it('derives an empty create title from the description (req-75 W5b)', () => {
    expect(parseCreate({ title: '  ', description: ' the outline panel should scroll\nmore' })).toEqual({
      ok: true,
      value: { title: 'the outline panel should scroll', priority: 'normal', repo: null, description: ' the outline panel should scroll\nmore' },
    });
    expect(parseCreate({ title: '', description: '   ' })).toEqual({ ok: false, error: 'the title is empty' });
  });

  it('ignores a transition index from an older client — there are no pins (req-75)', () => {
    const base = { id: 'T-0001', from: 'build', to: 'review' };
    expect(parseTransition({ ...base, index: 2.7 })).toEqual({ ok: true, value: base });
    expect(parseTransition(base)).toEqual({ ok: true, value: base });
  });

  it('defaults a run start to accept-edits and a fresh handover', () => {
    expect(parseStartRun({ id: 'T-0001', worker: ' ', handover: 'later' })).toEqual({
      ok: true,
      value: { origin: '', ticketId: 'T-0001', workerChoice: null, permissionMode: 'accept-edits', handover: null, interactive: null },
    });
    expect(parseStartRun({ id: 'T-0001', permissionMode: 'bypass', handover: 'resume' })).toMatchObject({
      value: { permissionMode: 'bypass', handover: 'resume' },
    });
    expect(parseStartRun({ id: 'T-0001', interactive: 'plan' })).toMatchObject({ value: { interactive: 'plan' } });
    expect(parseStartRun({ id: 'T-0001', interactive: 'chat' })).toMatchObject({ value: { interactive: null } });
  });

  it('passes a create\'s repository list through only when it is all strings (req-72)', () => {
    expect(parseCreate({ title: 'X', repo: 'a', repos: ['a', 'b'] })).toMatchObject({ value: { repo: 'a', repos: ['a', 'b'] } });
    const mixed = parseCreate({ title: 'X', repos: ['a', 3] });
    expect(mixed.ok && 'repos' in mixed.value).toBe(false);
  });

  it('keeps a create\'s raw capture only when it is a non-empty string (req-75 W5c)', () => {
    expect(parseCreate({ title: 'X', raw: 'the palette flickers fix it' })).toMatchObject({
      value: { raw: 'the palette flickers fix it' },
    });
    const dropped = parseCreate({ title: 'X', raw: '   ' });
    expect(dropped.ok && 'raw' in dropped.value).toBe(false);
  });

  it('takes the track as auto, shape or null — nothing else (req-75 W1b)', () => {
    expect(parseSetTrack({ id: 'T-0001', track: 'auto' })).toEqual({ ok: true, value: { id: 'T-0001', track: 'auto' } });
    expect(parseSetTrack({ id: 'T-0001', track: 'shape' })).toEqual({ ok: true, value: { id: 'T-0001', track: 'shape' } });
    expect(parseSetTrack({ id: 'T-0001', track: null })).toEqual({ ok: true, value: { id: 'T-0001', track: null } });
    expect(parseSetTrack({ id: 'T-0001', track: 'fast' })).toEqual({ ok: false, error: 'track must be auto, shape or null' });
    expect(parseSetTrack({ track: 'auto' })).toEqual({ ok: false, error: 'bad track payload' });
  });

  it('checks the run controls', () => {
    expect(parseStopRun({ runId: 'r1', reason: '  ' })).toEqual({ ok: true, value: { runId: 'r1', reason: null } });
    expect(parseSend({ runId: 'r1', text: '   ' })).toEqual({ ok: false, error: 'bad fleet send payload' });
    expect(parseSend({ runId: 'r1', text: ' go ' })).toEqual({ ok: true, value: { runId: 'r1', text: 'go' } });
    expect(parsePermission({ runId: 'r1', decision: 'maybe' })).toEqual({ ok: false, error: 'bad fleet permission payload' });
    expect(parseAnswer({ runId: 'r1', answers: { q0: 'Yes' } })).toEqual({ ok: true, value: { runId: 'r1', answers: { q0: 'Yes' } } });
    expect(parseChainColumn({ phase: 'build', mode: 'held' })).toEqual({ ok: true, value: { phase: 'build', mode: 'held' } });
  });

  it('chainResult maps a missing status to "not running"', () => {
    expect(chainResult(null)).toEqual({ ok: false, error: 'the fleet runner is not running' });
    expect(chainResult({ master: 'run' })).toEqual({ ok: true, status: { master: 'run' } });
  });

  it('names one ticket for the Ready card: launch, accept, changes (req-75 W3)', () => {
    expect(parseTicketId({ id: 'T-0126' }, 'launch')).toEqual({ ok: true, value: { id: 'T-0126' } });
    expect(parseTicketId({ id: 'T-0126' }, 'accept')).toEqual({ ok: true, value: { id: 'T-0126' } });
    expect(parseTicketId({}, 'launch')).toEqual({ ok: false, error: 'bad launch payload' });
    expect(parseTicketId('x', 'changes')).toEqual({ ok: false, error: 'bad changes payload' });
  });

  it('send back: one trimmed note of at most 500 characters (req-75 W3)', () => {
    expect(parseSendBack({ id: 'T-0126', note: '  the palette still doubles  ' })).toEqual({
      ok: true,
      value: { id: 'T-0126', note: 'the palette still doubles' },
    });
    expect(parseSendBack({ id: 'T-0126', note: '   ' })).toEqual({ ok: false, error: 'the send-back note is empty' });
    expect(parseSendBack({ note: 'x' })).toEqual({ ok: false, error: 'bad send back payload' });
    expect(parseSendBack({ id: 'T-0126', note: 'x'.repeat(600) })).toMatchObject({
      ok: true,
      value: { note: expect.anything() },
    });
    const long = parseSendBack({ id: 'T-0126', note: 'x'.repeat(600) });
    expect(long.ok && long.value.note.length).toBe(500);
  });
});

describe('parseRefine', () => {
  const base = { id: 'T-0001', baseRevision: '0123456789abcdef' };
  it('takes sections and header fields, and needs at least one change', () => {
    expect(parseRefine({ ...base, sections: { plan: 'P', log: 'x' }, header: { title: ' T ', priority: 'high' } })).toEqual({
      ok: true,
      value: { ...base, sections: { plan: 'P' }, header: { title: 'T', priority: 'high' } },
    });
    expect(parseRefine(base)).toEqual({ ok: false, error: 'nothing to refine' });
  });

  it('refuses a missing revision, an empty title, an unknown priority and an oversized text', () => {
    expect(parseRefine({ id: 'T-0001', sections: { plan: 'P' } })).toEqual({ ok: false, error: 'bad refine payload' });
    expect(parseRefine({ ...base, header: { title: '  ' } })).toMatchObject({ ok: false });
    expect(parseRefine({ ...base, header: { priority: 'asap' } })).toEqual({ ok: false, error: 'unknown priority' });
    expect(parseRefine({ ...base, sections: { plan: 'x'.repeat(20_001) } })).toMatchObject({ ok: false });
  });

  it('judges the header priority against the handed vocabulary', () => {
    const vocab = { order: ['p0', 'p1', 'p2'], default: 'p1' };
    expect(parseRefine({ ...base, header: { priority: 'p0' } }, vocab)).toEqual({
      ok: true,
      value: { ...base, sections: {}, header: { priority: 'p0' } },
    });
    expect(parseRefine({ ...base, header: { priority: 'high' } }, vocab)).toEqual({ ok: false, error: 'unknown priority' });
  });
});

describe('parseCreate with a configured vocabulary', () => {
  it('falls back to the vocabulary default instead of `normal`', () => {
    const vocab = { order: ['p0', 'p1', 'p2'], default: 'p1' };
    expect(parseCreate({ title: 'X', priority: 'p0' }, vocab)).toMatchObject({ value: { priority: 'p0' } });
    expect(parseCreate({ title: 'X', priority: 'urgent' }, vocab)).toMatchObject({ value: { priority: 'p1' } });
    expect(parseCreate({ title: 'X' }, vocab)).toMatchObject({ value: { priority: 'p1' } });
    // The shipped vocabulary stays the default parameter.
    expect(parseCreate({ title: 'X', priority: 'huge' })).toMatchObject({ value: { priority: 'normal' } });
  });
});

describe('parseAttachment', () => {
  // Minimal real headers of each type — enough bytes for the sniff.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
  const gif = Buffer.from('GIF89a', 'latin1');
  const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBPVP8 ', 'latin1')]);

  it("takes an image by its magic bytes and derives the extension — never the client's name", () => {
    expect(parseAttachment({ dataBase64: png.toString('base64') })).toEqual({ ok: true, value: { bytes: png, ext: 'png' } });
    expect(parseAttachment({ dataBase64: jpeg.toString('base64'), name: 'photo.tif' })).toEqual({ ok: true, value: { bytes: jpeg, ext: 'jpeg' } });
    expect(parseAttachment({ dataBase64: gif.toString('base64') })).toEqual({ ok: true, value: { bytes: gif, ext: 'gif' } });
    expect(parseAttachment({ dataBase64: webp.toString('base64') })).toEqual({ ok: true, value: { bytes: webp, ext: 'webp' } });
  });

  it('refuses text bytes, empties and non-base64 with the four accepted types named', () => {
    expect(parseAttachment({ dataBase64: Buffer.from('just some text', 'utf8').toString('base64') })).toEqual({
      ok: false,
      error: 'the file is not a PNG, JPEG, GIF or WebP image',
    });
    expect(parseAttachment({})).toEqual({ ok: false, error: 'the image data is missing or not base64' });
    expect(parseAttachment({ dataBase64: '' })).toEqual({ ok: false, error: 'the image data is missing or not base64' });
    expect(parseAttachment({ dataBase64: 'not base64!' })).toEqual({ ok: false, error: 'the image data is missing or not base64' });
  });

  it('refuses a decoded image over 6 MB', () => {
    const big = Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024)]);
    expect(parseAttachment({ dataBase64: big.toString('base64') })).toEqual({ ok: false, error: 'the image is larger than 6 MB' });
  });
});

describe('the plan to accept commands (E10-4)', () => {
  it('reads the three list edits', () => {
    expect(parsePlanPartsEdit({ id: 'T-0130', op: 'persona', index: 1, persona: 'ben' })).toEqual({
      ok: true,
      value: { id: 'T-0130', edit: { op: 'persona', index: 1, persona: 'ben' } },
    });
    expect(parsePlanPartsEdit({ id: 'T-0130', op: 'persona', index: 0, persona: null })).toMatchObject({ ok: true });
    expect(parsePlanPartsEdit({ id: 'T-0130', op: 'move', from: 2, to: 0 })).toEqual({
      ok: true,
      value: { id: 'T-0130', edit: { op: 'move', from: 2, to: 0 } },
    });
    expect(parsePlanPartsEdit({ id: 'T-0130', op: 'delete', index: 3 })).toEqual({
      ok: true,
      value: { id: 'T-0130', edit: { op: 'delete', index: 3 } },
    });
  });

  it('refuses junk positions, persona ids and operations', () => {
    expect(parsePlanPartsEdit({ id: 'T-0130', op: 'move', from: -1, to: 0 })).toEqual({ ok: false, error: 'bad move' });
    expect(parsePlanPartsEdit({ id: 'T-0130', op: 'move', from: 1.5, to: 0 })).toEqual({ ok: false, error: 'bad move' });
    expect(parsePlanPartsEdit({ id: 'T-0130', op: 'delete', index: 'x' })).toEqual({ ok: false, error: 'bad delete' });
    expect(parsePlanPartsEdit({ id: 'T-0130', op: 'persona', index: 0, persona: '../x' })).toEqual({ ok: false, error: 'bad persona edit' });
    expect(parsePlanPartsEdit({ op: 'delete', index: 0 })).toEqual({ ok: false, error: 'bad parts payload' });
    expect(parsePlanPartsEdit({ id: 'T-0130', op: 'add' })).toEqual({ ok: false, error: 'parts op must be persona, move or delete' });
  });

  it('reads the release scope, all by default', () => {
    expect(parsePlanRelease({ id: 'T-0130' })).toEqual({ ok: true, value: { id: 'T-0130', scope: 'all' } });
    expect(parsePlanRelease({ id: 'T-0130', scope: 'first' })).toEqual({ ok: true, value: { id: 'T-0130', scope: 'first' } });
    expect(parsePlanRelease({ id: 'T-0130', scope: 'two' })).toEqual({ ok: false, error: 'release scope must be all or first' });
    expect(parsePlanRelease(null)).toEqual({ ok: false, error: 'bad release payload' });
  });
});
