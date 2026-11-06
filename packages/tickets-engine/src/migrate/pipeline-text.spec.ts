import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { STATE_IDS } from '../core/pipeline-states';
import { runMigrateCli } from './cli';
import { sixStagePipelineText } from './pipeline-text';

interface Front {
  readonly push?: string;
  readonly priorities?: readonly string[];
  readonly phases: readonly Record<string, unknown>[];
}

function frontOf(text: string): Front {
  return parse(/^---\n([\s\S]*?)\n---\n/.exec(text)![1]!) as Front;
}

const LIVE = readFileSync(path.join(__dirname, 'fixtures', 'legacy-vault', 'tickets', '_meta', 'pipeline.md'), 'utf8');

describe('the six-stage pipeline of a legacy vault', () => {
  it('lists the six stages, Building the only agent and claim column, and carries the build column over', () => {
    const { text, dropped } = sixStagePipelineText(LIVE);
    const phases = frontOf(text).phases;
    expect(phases.map((p) => p['id'])).toEqual([...STATE_IDS]);
    expect(phases.filter((p) => p['claim'] === true).map((p) => p['id'])).toEqual(['building']);
    expect(phases.filter((p) => String(p['handover']).startsWith('agent')).map((p) => p['id'])).toEqual(['building']);
    expect(phases.find((p) => p['id'] === 'building')).toMatchObject({ title: 'Building', wip: 3, handover: 'agent build-default', 'token-budget': 40000000, persona: 'build-default' });
    expect(phases.find((p) => p['id'] === 'ready')).toEqual({ id: 'ready', title: 'Ready to try', handover: 'manual', persona: 'you' });
    expect(dropped.join('\n')).toMatch(/column "commit": handover agent commit-default, token-budget/);
  });

  it('keeps the top-level keys and names a column it cannot place', () => {
    const legacy = ['---', 'push: origin', 'priorities: [hoch, normal]', 'phases:', '  - { id: inbox, handover: manual }', '  - { id: qa, handover: manual }', '  - { id: plan, handover: agent plan-default, color: "#123456" }', '  - { id: done, handover: none }', '---', 'old prose', ''].join('\r\n');
    const { text, dropped } = sixStagePipelineText(legacy);
    const front = frontOf(text);
    expect(front.push).toBe('origin');
    expect(front.priorities).toEqual(['hoch', 'normal']);
    expect(front.phases.find((p) => p['id'] === 'shaping')).toEqual({ id: 'shaping', title: 'Shaping', handover: 'manual', persona: 'you', color: '#123456' });
    expect(front.phases.find((p) => p['id'] === 'building')).toMatchObject({ handover: 'agent build-default', wip: 3, claim: true });
    expect(dropped.join('\n')).toMatch(/column "qa" has no stage/);
    expect(text).not.toContain('old prose');
  });

  it('the dry run writes it with --pipeline-out, the legacy vault only read', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'drey-pipeline-out-'));
    try {
      const allow = path.join(dir, 'allow.txt');
      writeFileSync(allow, 'T-0010\n');
      const out = path.join(dir, 'nested', 'pipeline.md');
      const lines: string[] = [];
      const code = await runMigrateCli(['--legacy', path.join(__dirname, 'fixtures', 'legacy-vault'), '--allow', allow, '--pipeline-out', out], { out: (t) => lines.push(t), err: (t) => lines.push(t) });
      expect(code).toBe(0);
      expect(frontOf(readFileSync(out, 'utf8')).phases.map((p) => p['id'])).toEqual([...STATE_IDS]);
      expect(lines.join('')).toMatch(/not carried: column "commit"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file without frontmatter or phases', () => {
    expect(() => sixStagePipelineText('no fence')).toThrow(/no frontmatter/);
    expect(() => sixStagePipelineText('---\npush: origin\n---\n')).toThrow(/no phases/);
  });
});
