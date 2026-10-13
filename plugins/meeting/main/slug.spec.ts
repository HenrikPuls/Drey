import { slugifyMeetingTitle } from './slug';

describe('slugifyMeetingTitle', () => {
  it('lower-cases and hyphenates', () => {
    expect(slugifyMeetingTitle('Q3 Roadmap Review')).toBe('q3-roadmap-review');
  });

  it('transliterates German umlauts and ß', () => {
    expect(slugifyMeetingTitle('Über Größe & Maß')).toBe('ueber-groesse-mass');
  });

  it('strips other accented Latin via NFKD', () => {
    expect(slugifyMeetingTitle('Café résumé sync')).toBe('cafe-resume-sync');
  });

  it('drops stacked reply / forward prefixes', () => {
    expect(slugifyMeetingTitle('RE: FW: Weekly Sync')).toBe('weekly-sync');
    expect(slugifyMeetingTitle('AW: Team Standup')).toBe('team-standup');
    expect(slugifyMeetingTitle('Updated: Board meeting')).toBe('board-meeting');
  });

  it('strips punctuation and emoji', () => {
    expect(slugifyMeetingTitle('📅 Q3 Review — Roadmap!!!')).toBe('q3-review-roadmap');
  });

  it('caps length on a hyphen boundary', () => {
    const slug = slugifyMeetingTitle('one two three four five six seven eight nine ten eleven twelve');
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.startsWith('one-two-three')).toBe(true);
  });

  it('falls back to "meeting" for an empty or punctuation-only title', () => {
    expect(slugifyMeetingTitle('')).toBe('meeting');
    expect(slugifyMeetingTitle('   ')).toBe('meeting');
    expect(slugifyMeetingTitle('!!! ??? ...')).toBe('meeting');
  });
});
