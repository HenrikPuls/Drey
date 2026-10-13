import {
  buildTagSuggestionMessages,
  buildTaskMessages,
  normalizeTagToken,
  parseSuggestedTags,
  parseTagSuggestion,
  parseTaskClassification,
} from './index';

describe('normalizeTagToken', () => {
  it('lower-cases, transliterates umlauts, and single-words', () => {
    expect(normalizeTagToken('Segeln')).toBe('segeln');
    expect(normalizeTagToken('Team Neptun')).toBe('team-neptun');
    expect(normalizeTagToken('Übergabe')).toBe('uebergabe');
    expect(normalizeTagToken('  #Kauf!  ')).toBe('kauf');
  });
});

describe('parseSuggestedTags', () => {
  it('normalises, de-duplicates and caps the "Autotag" reply at four', () => {
    expect(
      parseSuggestedTags('{"tags":["Sailing","sailing","Team X","kauf","segeln","extra"]}'),
    ).toEqual(['sailing', 'team-x', 'kauf', 'segeln']);
  });

  it('returns [] for anything unparseable', () => {
    expect(parseSuggestedTags('no json')).toEqual([]);
    expect(parseSuggestedTags('{"tags":[]}')).toEqual([]);
    expect(parseSuggestedTags('{"other":1}')).toEqual([]);
  });
});

describe('parseTagSuggestion', () => {
  it('parses a clean reply', () => {
    expect(parseTagSuggestion('{"suggestions": ["sailing"], "new_tag": null}')).toEqual({
      suggestions: ['sailing'],
      new_tag: null,
    });
  });

  it('unwraps a fenced / prefixed reply and caps at three suggestions', () => {
    const reply = 'Here:\n```json\n{"suggestions":["a","b","c","d"],"new_tag":"kiel"}\n```';
    expect(parseTagSuggestion(reply)).toEqual({
      suggestions: ['a', 'b', 'c'],
      new_tag: 'kiel',
    });
  });

  it('de-duplicates and normalises suggested tokens', () => {
    expect(
      parseTagSuggestion('{"suggestions":["Sailing","sailing","Team X"],"new_tag":""}'),
    ).toEqual({
      suggestions: ['sailing', 'team-x'],
      new_tag: null,
    });
  });

  it('returns null when nothing usable came back', () => {
    expect(parseTagSuggestion('no json here')).toBeNull();
    expect(parseTagSuggestion('{"suggestions":[],"new_tag":null}')).toBeNull();
  });
});

describe('parseTaskClassification', () => {
  it('parses a task with due date and priority', () => {
    expect(parseTaskClassification('{"type":"task","due":"2026-09-10","priority":"high"}')).toEqual(
      { type: 'task', due: '2026-09-10', priority: 'high' },
    );
  });

  it('rejects a bad date and a bad priority to null', () => {
    expect(parseTaskClassification('{"type":"note","due":"soon","priority":"urgent"}')).toEqual({
      type: 'note',
      due: null,
      priority: null,
    });
  });

  it('returns null without a valid type', () => {
    expect(parseTaskClassification('{"due":null}')).toBeNull();
  });
});

describe('message builders', () => {
  it('injects the current date into the task prompt', () => {
    const [system] = buildTaskMessages('something', new Date('2026-09-06T10:00:00'));
    expect(system.content).toContain("Today's date: 2026-09-06");
  });

  it('injects the registry into the tag-suggestion system prompt', () => {
    const msgs = buildTagSuggestionMessages(
      'Tags:\n{registry_list}\nEnd',
      '- a (topic): x',
      'note text',
    );
    expect(msgs[0].content).toBe('Tags:\n- a (topic): x\nEnd');
    expect(msgs[1]).toEqual({ role: 'user', content: 'note text' });
  });
});
