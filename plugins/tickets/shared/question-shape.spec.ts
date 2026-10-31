import { describe, expect, it } from 'vitest';
import { answerText, parseShapedQuestion } from './question-shape';

/** The exact example the worker prompt (`ASKING`) names — it must parse. */
const EXAMPLE = [
  'Should dragging a heading also move the text below it?',
  'Ticket: Outline — drag headings to reorder the note.',
  'Where: step 2 of 4, the drop handler; step 1 is green.',
  'Why: the plan says "reorder headings" but not whether the section body moves.',
  'Options:',
  '1. Move the whole section — one undo step, what other editors do',
  '2. Only the heading line — the text stays, structure usually breaks',
  'Recommendation: 1 — it keeps the note\'s structure intact.',
].join('\n');

describe('parseShapedQuestion — the fixed question shape (req-75 W2)', () => {
  it('parses the example: question, context, where, why, options, recommendation', () => {
    expect(parseShapedQuestion(EXAMPLE)).toEqual({
      question: 'Should dragging a heading also move the text below it?',
      context: 'Outline — drag headings to reorder the note.',
      where: 'step 2 of 4, the drop handler; step 1 is green.',
      why: 'the plan says "reorder headings" but not whether the section body moves.',
      options: [
        { n: 1, label: 'Move the whole section', consequence: 'one undo step, what other editors do' },
        { n: 2, label: 'Only the heading line', consequence: 'the text stays, structure usually breaks' },
      ],
      recommended: 1,
      recommendationWhy: "it keeps the note's structure intact.",
    });
  });

  it('fewer than two options is not a shape — the plain question path stays', () => {
    expect(parseShapedQuestion('Which one?\n1. A — fast')).toBeNull();
    expect(parseShapedQuestion('Which one?')).toBeNull();
  });

  it('five options is not a shape', () => {
    expect(parseShapedQuestion('Which?\nOptions:\n1. a\n2. b\n3. c\n4. d\n5. e')).toBeNull();
  });

  it('an empty first line is not a shape', () => {
    expect(parseShapedQuestion('\nTicket: t\nOptions:\n1. a\n2. b')).toBeNull();
    expect(parseShapedQuestion('   \nOptions:\n1. a\n2. b')).toBeNull();
  });

  it('accepts - list prefixes and lowercase labels', () => {
    const shaped = parseShapedQuestion(
      [
        'Which database?',
        '- ticket: the store',
        '- where: step 1',
        '- why: undecided',
        '- options:',
        '- 1. SQLite — no server, fine locally',
        '- 2. Postgres — one server for all',
        '- recommendation: 2 — it scales',
      ].join('\n'),
    );
    expect(shaped).toEqual({
      question: 'Which database?',
      context: 'the store',
      where: 'step 1',
      why: 'undecided',
      options: [
        { n: 1, label: 'SQLite', consequence: 'no server, fine locally' },
        { n: 2, label: 'Postgres', consequence: 'one server for all' },
      ],
      recommended: 2,
      recommendationWhy: 'it scales',
    });
  });

  it('a missing Why (or Ticket/Where) stays a shape with null fields', () => {
    const shaped = parseShapedQuestion('Which?\nOptions:\n1. a — x\n2. b — y');
    expect(shaped).toMatchObject({ question: 'Which?', context: null, where: null, why: null, recommended: null, recommendationWhy: null });
    expect(shaped?.options).toHaveLength(2);
  });

  it('separator variants: em dash, hyphen, colon, none', () => {
    const shaped = parseShapedQuestion(
      ['Pick', 'Options:', '1. One — em dash', '2. Two - hyphen', '3. Three: colon', '4. Four'].join('\n'),
    );
    expect(shaped?.options).toEqual([
      { n: 1, label: 'One', consequence: 'em dash' },
      { n: 2, label: 'Two', consequence: 'hyphen' },
      { n: 3, label: 'Three', consequence: 'colon' },
      { n: 4, label: 'Four', consequence: null },
    ]);
  });

  it('a recommendation pointing at a missing option is dropped', () => {
    const shaped = parseShapedQuestion('Which?\nOptions:\n1. a\n2. b\nRecommendation: 3 — nowhere');
    expect(shaped).toMatchObject({ recommended: null, recommendationWhy: null });
  });

  it('a recommendation without a why keeps its number', () => {
    const shaped = parseShapedQuestion('Which?\nOptions:\n1. a\n2. b\nRecommendation: 2');
    expect(shaped).toMatchObject({ recommended: 2, recommendationWhy: null });
  });

  it('never throws on garbage and caps every field at 500 chars', () => {
    expect(parseShapedQuestion('')).toBeNull();
    expect(parseShapedQuestion('%%%%\n\u0000\u0000\nOptions:\n1. \n2. b')).toBeNull(); // the empty option drops below two
    const long = 'x'.repeat(900);
    const shaped = parseShapedQuestion(
      `${long}\nTicket: ${long}\nWhere: ${long}\nWhy: ${long}\nOptions:\n1. ${long} — ${long}\n2. b\nRecommendation: 1 — ${long}`,
    );
    expect(shaped?.question).toHaveLength(500);
    expect(shaped?.context).toHaveLength(500);
    expect(shaped?.where).toHaveLength(500);
    expect(shaped?.why).toHaveLength(500);
    expect(shaped?.options[0]?.label).toHaveLength(500);
    expect(shaped?.options[0]?.consequence).toHaveLength(500);
    expect(shaped?.recommendationWhy).toHaveLength(500);
  });

  it('lines that match nothing are tolerated, not fatal', () => {
    const shaped = parseShapedQuestion('Which?\nsome prose line\nOptions:\n1. a — x\n2. b — y\ntrailing noise');
    expect(shaped).not.toBeNull();
    expect(shaped?.options).toHaveLength(2);
  });
});

describe('answerText — what an option tap sends (req-75 W2)', () => {
  it('is "<n>. <label>"', () => {
    expect(answerText({ n: 1, label: 'Move the whole section', consequence: null })).toBe('1. Move the whole section');
    expect(answerText({ n: 3, label: 'Three', consequence: 'colon' })).toBe('3. Three');
  });
});
