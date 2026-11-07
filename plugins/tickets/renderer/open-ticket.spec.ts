import { describe, expect, it } from 'vitest';
import { openTicketDocument, type TicketDocumentReply, type TicketOpenDeps } from './open-ticket';

function harness(answer: TicketDocumentReply | Error): { deps: TicketOpenDeps; opened: [string, string][]; told: string[] } {
  const opened: [string, string][] = [];
  const told: string[] = [];
  return {
    opened,
    told,
    deps: {
      locate: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
      open: (path, vaultId) => {
        opened.push([path, vaultId]);
        return Promise.resolve();
      },
      showMessage: (text) => {
        told.push(text);
        return Promise.resolve();
      },
      boardVaultId: () => 'board',
    },
  };
}

describe('openTicketDocument (D-27)', () => {
  it('opens the store document, never the card path a store ticket does not have', async () => {
    const { deps, opened } = harness({ ok: true, document: { vaultId: 'checkout', path: 'tickets/t/0000/t-92/ticket.md' } });
    await openTicketDocument(deps, 'T-0092', 'tickets/inbox/T-0092.md');
    expect(opened).toEqual([['tickets/t/0000/t-92/ticket.md', 'checkout']]);
  });

  it('opens the vault file when the ticket is not a store ticket', async () => {
    const { deps, opened } = harness({ ok: true, document: null });
    await openTicketDocument(deps, 'T-0092', 'tickets/10-inbox/T-0092.md');
    expect(opened).toEqual([['tickets/10-inbox/T-0092.md', 'board']]);
  });

  it('tells a refusal once and opens nothing', async () => {
    const { deps, opened, told } = harness({ ok: false, error: 'The ticket checkout is not a vault' });
    await openTicketDocument(deps, 'T-0092', 'tickets/inbox/T-0092.md');
    expect(told).toEqual(['The ticket checkout is not a vault']);
    expect(opened).toEqual([]);
  });

  it('falls back to the vault file when the engine does not answer', async () => {
    const { deps, opened } = harness(new Error('no engine'));
    await openTicketDocument(deps, 'T-0092', 'tickets/10-inbox/T-0092.md');
    expect(opened).toEqual([['tickets/10-inbox/T-0092.md', 'board']]);
  });
});
