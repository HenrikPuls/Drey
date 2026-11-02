import { initialsOf, runStateClass } from './team';

describe('initialsOf', () => {
  it('takes the first letter of each of the first two words', () => {
    expect(initialsOf('Claude Code')).toBe('CC');
  });

  it('upper-cases lowercase titles', () => {
    expect(initialsOf('docs steward')).toBe('DS');
  });

  it('keeps a single-word title to one initial', () => {
    expect(initialsOf('Scrutiny')).toBe('S');
  });

  it('tolerates surrounding and repeated whitespace', () => {
    expect(initialsOf('  QA   review ')).toBe('QR');
  });

  it('ignores words past the second', () => {
    expect(initialsOf('Claude Code Reviewer')).toBe('CC');
  });

  it('returns an empty string for an empty title', () => {
    expect(initialsOf('')).toBe('');
    expect(initialsOf('   ')).toBe('');
  });
});

describe('runStateClass', () => {
  it('colours a running run with the accent', () => {
    expect(runStateClass('running')).toBe('run-live');
  });

  it('colours a starting run with the accent', () => {
    expect(runStateClass('starting')).toBe('run-live');
  });

  it('colours a failed run with danger', () => {
    expect(runStateClass('failed')).toBe('run-failed');
  });

  it('colours a finished or stopped run dim', () => {
    expect(runStateClass('done')).toBe('run-dim');
    expect(runStateClass('stopped')).toBe('run-dim');
  });

  it('colours a waiting or unwatchable run dim', () => {
    expect(runStateClass('stopping')).toBe('run-dim');
    expect(runStateClass('detached')).toBe('run-dim');
  });
});
