import { describe, expect, it } from 'vitest';
import { parseHandover } from '../shared/tickets';
import { acceptanceCommands } from './ticket-files';

describe('parseHandover — the pipeline handover grammar', () => {
  it('reads the four plain modes', () => {
    expect(parseHandover('manual')).toEqual({ mode: 'manual', promptRef: null, worker: null });
    expect(parseHandover('none')).toEqual({ mode: 'none', promptRef: null, worker: null });
    expect(parseHandover('ci')).toEqual({ mode: 'ci', promptRef: null, worker: null });
  });

  it('reads the agent mode with prompt ref and optional worker pin', () => {
    expect(parseHandover('agent build-default')).toEqual({
      mode: 'agent',
      promptRef: 'build-default',
      worker: null,
    });
    expect(parseHandover('agent build-default@opencode')).toEqual({
      mode: 'agent',
      promptRef: 'build-default',
      worker: 'opencode',
    });
    expect(parseHandover('agent hotfix@claude-code/sonnet')).toEqual({
      mode: 'agent',
      promptRef: 'hotfix',
      worker: 'claude-code/sonnet',
    });
    expect(parseHandover('agent')).toEqual({ mode: 'agent', promptRef: null, worker: null });
  });

  it('degrades an unreadable spec to manual — never a guess', () => {
    expect(parseHandover('carrier-pigeon')).toEqual({ mode: 'manual', promptRef: null, worker: null });
    expect(parseHandover('')).toEqual({ mode: 'agent', promptRef: null, worker: null });
  });
});
