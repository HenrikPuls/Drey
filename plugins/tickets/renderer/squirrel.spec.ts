// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { SPRINT_MS, setSquirrelPose, squirrelNode, squirrelPose } from './squirrel';
import type { RunInfo } from '../../../packages/tickets-engine/src/fleet/protocol';

const NOW = Date.parse('2026-10-31T12:00:00Z');

const run = (over: Partial<RunInfo>): RunInfo =>
  ({
    id: 'R-1',
    ticketId: 'T-0001',
    provider: 'claude-code',
    state: 'running',
    startedAt: '2026-10-31T11:00:00Z',
    lastActivity: '2026-10-31T11:59:30Z', // 30 s before NOW
    turn: 'busy',
    ...over,
  }) as RunInfo;

describe('squirrelPose', () => {
  it('sits with no run, off a live state, standing idle, or waiting on the owner', () => {
    expect(squirrelPose(null, NOW)).toBe('sit');
    expect(squirrelPose(run({ state: 'stopped' }), NOW)).toBe('sit');
    expect(squirrelPose(run({ state: 'detached' }), NOW)).toBe('sit');
    expect(squirrelPose(run({ turn: 'idle' }), NOW)).toBe('sit');
    expect(squirrelPose(run({ turn: undefined }), NOW)).not.toBe('sit'); // the provider has not said
    expect(squirrelPose(run({ waiting: { kind: 'permission', text: 'run a tool', since: '2026-10-31T11:59:00Z' } }), NOW)).toBe('sit');
    expect(squirrelPose(run({ waiting: null }), NOW)).toBe('run');
  });

  it('sprints while the last activity is within SPRINT_MS, runs after it', () => {
    expect(squirrelPose(run({ lastActivity: '2026-10-31T11:59:57Z' }), NOW)).toBe('sprint');
    expect(squirrelPose(run({ lastActivity: '2026-10-31T11:56:00Z' }), NOW)).toBe('run');
    // Exactly SPRINT_MS old is no longer a sprint.
    expect(squirrelPose(run({ lastActivity: new Date(NOW - SPRINT_MS).toISOString() }), NOW)).toBe('run');
  });

  it('runs rather than sprints when the activity stamp cannot be read', () => {
    expect(squirrelPose(run({ lastActivity: '' }), NOW)).toBe('run');
    expect(squirrelPose(run({ lastActivity: 'not a date' }), NOW)).toBe('run');
  });
});

describe('squirrelNode', () => {
  it('wraps a sized, four-stroke SVG in a span carrying data-pose, role and label', () => {
    const node = squirrelNode(16);
    expect(node.classList.contains('tickets-squirrel')).toBe(true);
    expect(node.getAttribute('role')).toBe('img');
    expect(node.getAttribute('aria-label')).toBe('Worker idle');
    expect(node.dataset['pose']).toBe('sit');
    const svg = node.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg?.getAttribute('width')).toBe('16');
    expect(svg?.getAttribute('height')).toBe('16');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(node.querySelectorAll('path')).toHaveLength(4);
    for (const path of node.querySelectorAll('path')) {
      expect(path.getAttribute('fill')).toBe('none');
      expect(path.getAttribute('stroke')).toBe('currentColor');
      expect(path.getAttribute('stroke-width')).toBe('2');
      expect(path.getAttribute('stroke-linecap')).toBe('round');
      expect(path.getAttribute('stroke-linejoin')).toBe('round');
    }
  });

  it('marks the last stroke as the tail', () => {
    const paths = squirrelNode(12).querySelectorAll('path');
    expect(paths[3]?.getAttribute('class')).toBe('tickets-squirrel-tail');
    expect(paths[0]?.getAttribute('class')).toBeNull();
  });

  it('poses: data-pose and the label move together', () => {
    const node = squirrelNode(14);
    setSquirrelPose(node, 'sprint');
    expect(node.dataset['pose']).toBe('sprint');
    expect(node.getAttribute('aria-label')).toBe('Worker sprinting');
    setSquirrelPose(node, 'run');
    expect(node.dataset['pose']).toBe('run');
    expect(node.getAttribute('aria-label')).toBe('Worker running');
    setSquirrelPose(node, 'sit');
    expect(node.dataset['pose']).toBe('sit');
    expect(node.getAttribute('aria-label')).toBe('Worker idle');
  });
});
