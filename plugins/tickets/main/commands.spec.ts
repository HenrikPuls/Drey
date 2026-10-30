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
  parseRefine,
  parseSend,
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

  it('floors a transition index and drops a negative one', () => {
    const base = { id: 'T-0001', from: 'build', to: 'review' };
    expect(parseTransition({ ...base, index: 2.7 })).toEqual({ ok: true, value: { ...base, index: 2 } });
    expect(parseTransition({ ...base, index: -1 })).toEqual({ ok: true, value: { ...base, index: null } });
  });

  it('defaults a run start to accept-edits and a fresh handover', () => {
    expect(parseStartRun({ id: 'T-0001', worker: ' ', handover: 'later' })).toEqual({
      ok: true,
      value: { ticketId: 'T-0001', workerChoice: null, permissionMode: 'accept-edits', handover: null },
    });
    expect(parseStartRun({ id: 'T-0001', permissionMode: 'bypass', handover: 'resume' })).toMatchObject({
      value: { permissionMode: 'bypass', handover: 'resume' },
    });
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
