import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadShippedPrompts, SHIPPED_PROMPTS_DIR } from './default-prompts';

describe('shipped prompts', () => {
  it('ships a prompt file for every agent column the default pipeline can name', async () => {
    const prompts = await loadShippedPrompts();
    expect([...prompts.keys()]).toEqual([
      'build-default',
      'commit-default',
      'plan-default',
      'plan-interactive-default',
      'refine-interactive-default',
      'review-default',
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
    // The interactive defaults (req-65): interview first, never move the
    // ticket themselves.
    expect(prompts.get('plan-interactive-default')).toContain('QUESTION:');
    expect(prompts.get('refine-interactive-default')).toContain('QUESTION:');
    expect(prompts.get('refine-interactive-default')).toContain('Never move the ticket yourself');
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
