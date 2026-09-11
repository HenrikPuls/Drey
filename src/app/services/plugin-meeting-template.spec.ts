import { renderTemplate } from '../../../plugins/meeting/main/template';

describe('renderTemplate (meeting mini-evaluator)', () => {
  it('interpolates scalars and leaves missing keys empty', () => {
    expect(renderTemplate('# {{title}} ({{missing}})', { title: 'Sync' })).toBe('# Sync ()');
  });

  it('keeps an {{#if}} body only when the value is truthy', () => {
    const tpl = 'a{{#if x}} B {{x}}{{/if}}c';
    expect(renderTemplate(tpl, { x: 'yes' })).toBe('a B yesc');
    expect(renderTemplate(tpl, { x: '' })).toBe('ac');
    expect(renderTemplate(tpl, {})).toBe('ac');
    expect(renderTemplate(tpl, { x: [] })).toBe('ac');
  });

  it('repeats an {{#each}} body per item with field access', () => {
    const tpl = '{{#each people}}\n- {{name}} <{{email}}>\n{{/each}}';
    const out = renderTemplate(tpl, {
      people: [
        { name: 'Ann', email: 'ann@x' },
        { name: 'Bo', email: 'bo@x' },
      ],
    });
    expect(out).toBe('- Ann <ann@x>\n- Bo <bo@x>');
  });

  it('supports {{this}} for a scalar list', () => {
    expect(renderTemplate('{{#each tags}}#{{this}} {{/each}}', { tags: ['a', 'b'] })).toBe('#a #b');
  });

  it('drops a block tag that sits alone on its line', () => {
    const tpl = '{{#if show}}\nkept\n{{/if}}\ntail';
    expect(renderTemplate(tpl, { show: true })).toBe('kept\ntail');
    expect(renderTemplate(tpl, { show: false })).toBe('tail');
  });

  it('collapses blank-line runs and trims the ends', () => {
    expect(renderTemplate('\n\n{{a}}\n\n\n{{b}}\n\n', { a: 'x', b: 'y' })).toBe('x\n\ny');
  });

  it('nests blocks', () => {
    const tpl = '{{#if outer}}[{{#each xs}}{{v}}{{/each}}]{{/if}}';
    expect(renderTemplate(tpl, { outer: true, xs: [{ v: '1' }, { v: '2' }] })).toBe('[12]');
    expect(renderTemplate(tpl, { outer: false, xs: [{ v: '1' }] })).toBe('');
  });
});
