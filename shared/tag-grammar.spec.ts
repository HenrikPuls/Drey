import { TAG_NAME_SOURCE, extractInlineTags, extractTagOccurrences } from './tag-grammar';

describe('shared/tag-grammar', () => {
  describe('extractInlineTags', () => {
    it('finds lower-cased, de-duplicated tags in document order', () => {
      expect(extractInlineTags('#Sailing and #kauf, then #Sailing again')).toEqual([
        'sailing',
        'kauf',
      ]);
    });

    it('supports nested /-tags', () => {
      expect(extractInlineTags('#project/frontend #project/2024')).toEqual([
        'project/frontend',
        'project/2024',
      ]);
    });

    it('ignores #task and the whole #task/* subtree', () => {
      expect(extractInlineTags('#task #task/todo #real')).toEqual(['real']);
    });

    it('ignores code spans and fenced blocks but keeps offsets stable', () => {
      const body = 'before `#code` after\n```\n#fenced\n```\n#real';
      expect(extractInlineTags(body)).toEqual(['real']);
      const occ = extractTagOccurrences(body);
      expect(occ).toHaveLength(1);
      expect(body.slice(occ[0].index).startsWith('#real')).toBe(true);
    });

    it('never matches timestamp headings or URL fragments', () => {
      expect(extractInlineTags('## 14:32\n### 2026-09-05')).toEqual([]);
      expect(extractInlineTags('see https://x.de/#frag and #!/bin/sh')).toEqual([]);
    });

    it('requires a letter after the # run', () => {
      expect(extractInlineTags('#42 #a')).toEqual(['a']);
    });
  });

  describe('TAG_NAME_SOURCE', () => {
    it('is a valid partial-match source the editor completion can anchor', () => {
      const re = new RegExp(`^${TAG_NAME_SOURCE}$`, 'u');
      expect(re.test('sailing')).toBe(true);
      expect(re.test('projekt/frontend')).toBe(true);
      expect(re.test('projekt/2024')).toBe(true);
      expect(re.test('projekt/')).toBe(false);
      expect(re.test('42start')).toBe(false);
    });
  });
});
