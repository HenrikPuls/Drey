import * as base from '../../../shared/tag-grammar';
import * as twin from '../../../plugins/tags/shared/tags.js';

/**
 * `plugins/tags/shared/tags.ts` is a verbatim twin of `shared/tag-grammar.ts`
 * (plugin renderers load over `plugin://` and cannot reach top-level shared
 * files). This spec runs the same assertions over both copies so they cannot
 * drift silently — if you change one, change the other in the same commit.
 */

const CASES: string[] = [
  '#sailing and #kauf, then #Sailing again',
  '#project/frontend #project/2024',
  '#task #task/todo #real',
  'before `#code` after\n```\n#fenced\n```\n#real',
  '## 14:32\n### 2026-09-05',
  'see https://x.de/#frag and #!/bin/sh',
  '#42 #a',
  '',
  'text without tags',
  '#üngründ #Ñoño/-x #a_b-c/d_e',
];

describe('tag grammar parity (shared/tag-grammar ↔ plugins/tags/shared/tags)', () => {
  it('the twins export the same TAG_NAME_SOURCE', () => {
    expect(twin.TAG_NAME_SOURCE).toBe(base.TAG_NAME_SOURCE);
  });

  for (const body of CASES) {
    it(`agree on occurrences for ${JSON.stringify(body.slice(0, 40))}`, () => {
      expect(base.extractTagOccurrences(body)).toEqual(twin.extractTagOccurrences(body));
      expect(base.extractInlineTags(body)).toEqual(twin.extractInlineTags(body));
    });
  }
});
