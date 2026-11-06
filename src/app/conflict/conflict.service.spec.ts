import { ConflictService } from './conflict.service';

describe('ConflictService and the store counter (D-16)', () => {
  const ticket = (rev: number, body: string): string => `---\nid: t-3\nrev: ${rev}\n---\n${body}\n`;

  it('asks with the disk rev on my side, so the dialog shows only the text', async () => {
    const service = new ConflictService();
    const answer = service.ask({ path: 't.md', base: ticket(3, 'old'), disk: ticket(4, 'theirs'), mine: ticket(3, 'mine'), saving: true });
    expect(service.pending()?.mine).toBe(ticket(4, 'mine'));
    service.answer(ticket(4, 'merged'));
    expect(await answer).toBe(ticket(4, 'merged'));
  });

  it('asks nothing when the rev was all that differed', async () => {
    const service = new ConflictService();
    const answer = await service.ask({ path: 't.md', base: ticket(3, 'same'), disk: ticket(4, 'same'), mine: ticket(3, 'same'), saving: true });
    expect(answer).toBe(ticket(4, 'same'));
    expect(service.pending()).toBeNull();
  });
});
