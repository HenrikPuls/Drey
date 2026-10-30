// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { markdownBlocks, renderMarkdown } from './markdown';
import { blocksOf } from './model';

const dom = (text: string, opts?: { log?: boolean }): HTMLElement =>
  markdownBlocks(blocksOf(text.split('\n')), opts)[0]! as HTMLElement;

describe('markdownBlocks', () => {
  it('renders bold, italic and code spans as nodes', () => {
    const p = dom('A **bold** word, an *italic* one and `code`.');
    expect(p.tagName).toBe('P');
    expect(p.querySelector('strong')?.textContent).toBe('bold');
    expect(p.querySelector('em')?.textContent).toBe('italic');
    expect(p.querySelector('code.ic')?.textContent).toBe('code');
    expect(p.textContent).toBe('A bold word, an italic one and code.');
  });

  it('builds a table with a scrolling wrapper, header row and inline cells', () => {
    const wrap = dom('| Decision | Reason |\n|---|---|\n| reuse `reorder` | **no** main changes |');
    expect(wrap.classList.contains('tablewrap')).toBe(true);
    expect(wrap.querySelector('thead th')?.textContent).toBe('Decision');
    expect(wrap.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(wrap.querySelector('td code.ic')?.textContent).toBe('reorder');
    expect(wrap.querySelector('td strong')?.textContent).toBe('no');
  });

  it('keeps the checkbox chrome and adds inline spans to list items', () => {
    const blocks = markdownBlocks(blocksOf(['- [x] Ship **it**', '- [ ] later', '- plain']));
    expect(blocks[0]!.querySelector('.box.done')).not.toBeNull();
    expect(blocks[0]!.querySelector('.box.done + span strong')?.textContent).toBe('it');
    expect(blocks[1]!.querySelector('.box:not(.done)')).not.toBeNull();
    expect(blocks[2]!.querySelector('.bullet')?.textContent).toBe('•');
  });

  it('renders rules and in-section headings', () => {
    const blocks = markdownBlocks(blocksOf(['Before', '---', '#### Sub title', 'After']));
    expect(blocks[1]!.tagName).toBe('HR');
    expect(blocks[2]!.tagName).toBe('H5');
    expect(blocks[2]!.textContent).toBe('Sub title');
  });

  it('never interprets HTML in ticket or worker text', () => {
    const p = dom('<img src=x onerror=alert(1)>');
    expect(p.querySelector('img')).toBeNull();
    expect(p.textContent).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('renderMarkdown', () => {
  it('renders one text into a whitespace-owning container of blocks', () => {
    const node = renderMarkdown('**Done.**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] checked');
    expect(node.classList.contains('mdr')).toBe(true);
    expect(node.querySelector('p strong')?.textContent).toBe('Done.');
    expect(node.querySelectorAll('tbody td')).toHaveLength(2);
    expect(node.querySelector('.box.done')).not.toBeNull();
  });
});
