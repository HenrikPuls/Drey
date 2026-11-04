import { statusSlotText } from './status-slot';

describe('statusSlotText', () => {
  it('is empty when nothing runs and nothing waits', () => {
    expect(statusSlotText(0, 0)).toBe('');
  });
  it('joins running and needs-you', () => {
    expect(statusSlotText(2, 3)).toBe('2 running · 3 need you');
  });
  it('shows either part alone', () => {
    expect(statusSlotText(1, 0)).toBe('1 running');
    expect(statusSlotText(0, 4)).toBe('4 need you');
  });
});
