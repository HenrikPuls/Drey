import { describe, expect, it } from 'vitest';
import { initPhaseDirs, initScaffoldFiles as scaffold } from './init-scaffold';
import { parsePipeline } from './ticket-board';

describe('init scaffold (M112)', () => {
  it('writes exactly the pipeline and the repos into _meta', () => {
    expect(scaffold().map((file) => file.path)).toEqual([
      'tickets/_meta/pipeline.md',
      'tickets/_meta/repos.md',
    ]);
  });

  it('the pipeline carries the priority vocabulary explicitly — config beside the phases it governs', () => {
    const pipeline = scaffold()[0]!.text;
    expect(pipeline).toContain('priorities: [urgent, high, normal, low]');
    const parsed = parsePipeline(pipeline);
    expect(parsed.error).toBeNull();
    expect(parsed.priorities.order).toEqual(['urgent', 'high', 'normal', 'low']);
    expect(parsed.priorities.default).toBe('normal');
    expect(parsed.phases.map((phase) => phase.id)).toEqual([
      'inbox',
      'prioritized',
      'build',
      'commit',
      'done',
    ]);
  });

  it('the numbered phase directories follow the scaffold pipeline', () => {
    expect(initPhaseDirs()).toEqual([
      'tickets/10-inbox',
      'tickets/20-prioritized',
      'tickets/30-build',
      'tickets/40-commit',
      'tickets/50-done',
    ]);
  });

  it('the repos scaffold parses and names no repository', () => {
    const text = scaffold()[1]!.text;
    expect(text).toContain('repos: {}');
    expect(text).toContain('lariscus');
  });
});
