import { describe, expect, it, vi } from 'vitest';
import { TicketDocuments, type TicketDocumentsDeps } from './ticket-documents';

const CHECKOUT = '/data/tickets-store';
const LOCATION = { checkout: CHECKOUT, path: 'tickets/t/0000/t-63/ticket.md' };

function make(over: Partial<TicketDocumentsDeps> = {}) {
  const deps: TicketDocumentsDeps = {
    platform: 'linux',
    vaults: async () => [
      { id: 'meta', path: '/data/meta', exists: true },
      { id: 'co', path: CHECKOUT, exists: true },
    ],
    checkout: async () => CHECKOUT,
    locate: async () => LOCATION,
    saveDocument: async (input) => ({ ok: true, text: `${input.text}\r\nrev bumped\r\n`, rev: 4 }),
    registerCheckout: async () => false,
    modifiedMs: async () => 42,
    ...over,
  };
  return { documents: new TicketDocuments(deps), deps };
}

describe('TicketDocuments (E14-4c)', () => {
  it('owns the tickets tree of the checkout vault and nothing else', async () => {
    const { documents } = make();
    await documents.refresh();
    expect(documents.owns('co', 'tickets')).toBe(true);
    expect(documents.owns('co', 'tickets/t/0000/t-63/ticket.md')).toBe(true);
    expect(documents.owns('co', 'tickets\\t\\0000\\t-63\\comments\\a.md')).toBe(true);
    expect(documents.owns('co', 'dricket.toml')).toBe(false);
    expect(documents.owns('co', 'tickets-notes/a.md')).toBe(false);
    expect(documents.owns('meta', 'tickets/t/0000/t-63/ticket.md')).toBe(false);
  });

  it('owns nothing while the dricket backend is off', async () => {
    const { documents } = make({ checkout: async () => null });
    await documents.refresh();
    expect(documents.owns('co', 'tickets/t/0000/t-63/ticket.md')).toBe(false);
  });

  it('finds the checkout inside a bigger vault and prefixes the paths', async () => {
    const { documents } = make({ vaults: async () => [{ id: 'big', path: '/data', exists: true }] });
    await documents.refresh();
    expect(documents.owns('big', 'tickets-store/tickets/t/0000/t-63/ticket.md')).toBe(true);
    expect(documents.owns('big', 'meta/a.md')).toBe(false);
    expect(await documents.open('T-0063')).toEqual({ ok: true, document: { vaultId: 'big', path: 'tickets-store/tickets/t/0000/t-63/ticket.md' } });
  });

  it('opens a ticket from the checkout vault, and says null for a ticket that is not in the store', async () => {
    const { documents } = make();
    expect(await documents.open('T-0063')).toEqual({ ok: true, document: { vaultId: 'co', path: LOCATION.path } });
    const files = make({ locate: async () => null });
    expect(await files.documents.open('T-0063')).toEqual({ ok: true, document: null });
  });

  it('asks before registering a checkout that is no vault, and stops when declined', async () => {
    const registered: string[] = [];
    let known = false;
    const { documents } = make({
      vaults: async () => (known ? [{ id: 'new', path: CHECKOUT, exists: true }] : []),
      registerCheckout: async (checkout) => {
        registered.push(checkout);
        known = true;
        return true;
      },
    });
    expect(await documents.open('T-0063')).toEqual({ ok: true, document: { vaultId: 'new', path: LOCATION.path } });
    expect(registered).toEqual([CHECKOUT]);

    const declined = make({ vaults: async () => [] });
    expect(await declined.documents.open('T-0063')).toMatchObject({ ok: false });
  });

  it('saves through the engine with the checkout-relative path, force on a resolved conflict, and adopts the stored text', async () => {
    const saveDocument = vi.fn<TicketDocumentsDeps['saveDocument']>(async (input) => ({ ok: true, text: `${input.text}\r\nrev bumped\r\n`, rev: 4 }));
    const { documents } = make({ saveDocument });
    await documents.refresh();
    const outcome = await documents.route.save({ vaultId: 'co', path: LOCATION.path, body: 'edited\n', force: true });
    expect(saveDocument).toHaveBeenCalledWith({ path: LOCATION.path, text: 'edited\n', force: true });
    expect(outcome).toEqual({ content: 'edited\n\nrev bumped\n', modifiedMs: 42 });
  });

  it('turns exit 12 into the save-conflict answer and a refusal into an error', async () => {
    const conflicted = make({ saveDocument: async () => ({ ok: false, conflict: { text: 'stored\r\n', rev: 9 } }) });
    await conflicted.documents.refresh();
    expect(await conflicted.documents.route.save({ vaultId: 'co', path: LOCATION.path, body: 'x', force: false })).toEqual({
      conflict: { content: 'stored\n', modifiedMs: 42 },
    });

    const refused = make({ saveDocument: async () => ({ ok: false, error: 'dk put: not allowed' }) });
    await refused.documents.refresh();
    await expect(refused.documents.route.save({ vaultId: 'co', path: LOCATION.path, body: 'x', force: false })).rejects.toThrow('dk put: not allowed');
    await expect(refused.documents.route.save({ vaultId: 'meta', path: 'a.md', body: 'x', force: false })).rejects.toThrow('not part of the ticket checkout');
  });
});
