import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadShippedPrompts, promptVersion, SHIPPED_PROMPTS_DIR, stripPromptVersion } from './default-prompts';

describe('shipped prompts', () => {
  it('ships a prompt file for every agent column the default pipeline can name', async () => {
    const prompts = await loadShippedPrompts();
    expect([...prompts.keys()]).toEqual([
      'build-default',
      'commit-default',
      'plan-default',
      'plan-interactive-default',
      'qa-default',
      'review-default',
      'scout-default',
    ]);
  });

  it('reads the files as they are: newline-terminated, the working style included', async () => {
    const prompts = await loadShippedPrompts();
    for (const [ref, text] of prompts) {
      expect(text.endsWith('\n'), ref).toBe(true);
      expect(text, ref).toContain('How to work:');
      expect(text, ref).not.toContain('\r');
      expect(await fsp.readFile(path.join(SHIPPED_PROMPTS_DIR, `${ref}.md`), 'utf8')).toBe(text);
    }
    expect(prompts.get('plan-default')).toContain('`## Plan`');
    // The build step ends on the Changes section the Ready page reads (req-75 W3).
    expect(prompts.get('build-default')).toContain('## Changes');
    expect(prompts.get('build-default')).toContain('**What changed for you:**');
    // The commit step closes with the report the final card shows.
    expect(prompts.get('commit-default')).toContain('`## Result`');
    // The interactive default (req-65): interview first. (The refine twin
    // was removed in E13-9.)
    expect(prompts.get('plan-interactive-default')).toContain('QUESTION:');
    expect(prompts.has('refine-interactive-default')).toBe(false);
  });

  it('every shipped prompt carries a version marker the runner can compare', async () => {
    for (const [ref, text] of await loadShippedPrompts()) {
      expect(promptVersion(text), ref).toBeGreaterThan(0);
      expect(stripPromptVersion(text), ref).not.toContain('drey-prompt-version');
    }
  });

  it('reads and strips the marker; a text without one is version 0', () => {
    const marked = `<!-- drey-prompt-version: 7 -->${String.fromCharCode(10)}Body`;
    expect(promptVersion(marked)).toBe(7);
    expect(stripPromptVersion(marked)).toBe('Body');
    expect(promptVersion('Body')).toBe(0);
    expect(stripPromptVersion('Body')).toBe('Body');
  });

  it('reads a missing folder as no prompts and skips files that are not prompt names', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'drey-prompts-'));
    try {
      expect((await loadShippedPrompts(path.join(dir, 'absent'))).size).toBe(0);
      await fsp.writeFile(path.join(dir, 'a.md'), 'A\r\n', 'utf8');
      await fsp.writeFile(path.join(dir, '.hidden.md'), 'x', 'utf8');
      await fsp.writeFile(path.join(dir, 'notes.txt'), 'x', 'utf8');
      expect([...(await loadShippedPrompts(dir))]).toEqual([['a', 'A\n']]);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
