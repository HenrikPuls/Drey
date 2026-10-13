import { meetingWhen } from './when';

describe('meetingWhen', () => {
  it('formats a same-day timed meeting', () => {
    const when = meetingWhen({ start: '2026-09-15 14:00', end: '2026-09-15 15:00', allDay: false });
    expect(when).toMatchObject({
      date: '2026-09-15',
      end_date: '',
      start_time: '14:00',
      end_time: '15:00',
      when: '2026-09-15 · 14:00–15:00',
    });
  });

  it('formats a meeting that spans midnight', () => {
    const when = meetingWhen({ start: '2026-09-15 23:00', end: '2026-09-16 00:30', allDay: false });
    expect(when.end_date).toBe('2026-09-16');
    expect(when.when).toBe('2026-09-15 23:00 – 2026-09-16 00:30');
  });

  it('formats a single all-day meeting', () => {
    const when = meetingWhen({ start: '2026-10-02', end: '2026-10-02', allDay: true });
    expect(when.start_time).toBe('');
    expect(when.when).toBe('2026-10-02 (all day)');
  });

  it('formats a multi-day all-day meeting', () => {
    const when = meetingWhen({ start: '2026-10-02', end: '2026-10-04', allDay: true });
    expect(when.end_date).toBe('2026-10-04');
    expect(when.when).toBe('2026-10-02 – 2026-10-04 (all day)');
  });

  it('handles a start with no end', () => {
    const when = meetingWhen({ start: '2026-09-15 14:00', end: null, allDay: false });
    expect(when.when).toBe('2026-09-15 · 14:00');
  });

  it('returns empty strings when there is no start', () => {
    const when = meetingWhen({ start: null, end: null, allDay: false });
    expect(when).toMatchObject({ date: '', start_time: '', end_time: '', when: '' });
  });
});
