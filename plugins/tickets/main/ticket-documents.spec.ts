import { describe, expect, it, vi } from 'vitest';
import { TicketDocuments, askToAddCheckout, fileTicketTitle, type TicketDocumentsDeps } from './ticket-documents';

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

describe('the checkout prompt (D-14)', () => {
  const notAVault = { vaults: async () => [{ id: 'meta', path: '/data/meta', exists: true }] };

  it('asks once while the prompt is open: every further click waits for the same answer', async () => {
    let answer: (yes: boolean) => void = () => undefined;
    const vaults = [{ id: 'meta', path: '/data/meta', exists: true }];
    const registerCheckout = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = (yes) => {
            vaults.push({ id: 'co', path: CHECKOUT, exists: true });
            resolve(yes);
          };
        }),
    );
    const { documents } = make({ vaults: async () => vaults, registerCheckout });
    const clicks = [documents.open('T-0063'), documents.open('T-0064'), documents.open('T-0063')];
    await vi.waitFor(() => expect(registerCheckout).toHaveBeenCalled());
    answer(true);
    const replies = await Promise.all(clicks);
    expect(registerCheckout).toHaveBeenCalledTimes(1);
    expect(replies.every((reply) => reply.ok)).toBe(true);
  });

  it('asks again after a decline, because that was an answer', async () => {
    const registerCheckout = vi.fn(async () => false);
    const { documents } = make({ ...notAVault, registerCheckout });
    expect(await documents.open('T-0063')).toMatchObject({ ok: false });
    expect(await documents.open('T-0063')).toMatchObject({ ok: false });
    expect(registerCheckout).toHaveBeenCalledTimes(2);
  });

  it('brings the app window to the front and attaches the prompt to it', async () => {
    const calls: string[] = [];
    const window = { isMinimized: () => true, restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus') };
    const showMessageBox = vi.fn(async (_parent: unknown, _options: { message: string }) => ({ response: 0 }));
    const register = vi.fn(async () => undefined);
    expect(await askToAddCheckout({ window: () => window, showMessageBox, register }, CHECKOUT)).toBe(true);
    expect(calls).toEqual(['restore', 'show', 'focus']);
    expect(showMessageBox.mock.calls[0]?.[0]).toBe(window);
    expect(showMessageBox.mock.calls[0]?.[1]).toMatchObject({ message: 'Add the ticket checkout as a vault?' });
    expect(register).toHaveBeenCalledWith(CHECKOUT);
  });

  it('registers nothing when the prompt is cancelled', async () => {
    const register = vi.fn(async () => undefined);
    expect(await askToAddCheckout({ window: () => null, showMessageBox: async () => ({ response: 1 }), register }, CHECKOUT)).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });
});

describe('the files store ticket as a tab name (fidelity ruling O6)', () => {
  const text = '---\nid: T-0017\ntitle: A8 large modules\n---\n\n# Body\n';

  it('is id and title, wherever the file sits', () => {
    expect(fileTicketTitle('tickets/20-prioritized/T-0017.md', text)).toBe('T-0017 · A8 large modules');
    expect(fileTicketTitle('tickets/archive/T-0017.md', text)).toBe('T-0017 · A8 large modules');
  });

  it('falls back to the id without a title', () => {
    expect(fileTicketTitle('tickets/20-prioritized/T-0017.md', '---\nid: T-0017\n---\n')).toBe('T-0017');
  });

  it('leaves anything else its name: another path, or a header that is not this ticket', () => {
    expect(fileTicketTitle('notes/T-0017.md', text)).toBeNull();
    expect(fileTicketTitle('tickets/_meta/pipeline.md', text)).toBeNull();
    expect(fileTicketTitle('tickets/20-prioritized/T-0018.md', text)).toBeNull();
    expect(fileTicketTitle('tickets/20-prioritized/T-0017.md', 'no header')).toBeNull();
  });

  it('reaches the route for a vault the route does not own', async () => {
    const { documents } = make();
    await documents.refresh();
    expect(documents.owns('notes', 'tickets/20-prioritized/T-0017.md')).toBe(false);
    expect(documents.route.title?.('notes', 'tickets/20-prioritized/T-0017.md', text)).toBe('T-0017 · A8 large modules');
  });
});

describe('the ticket document title (D-15)', () => {
  it('names a document of the checkout by id and title, also inside a bigger vault', async () => {
    const { documents } = make({ vaults: async () => [{ id: 'big', path: '/data', exists: true }, { id: 'co', path: CHECKOUT, exists: true }] });
    await documents.refresh();
    const text = '---\nid: t-63\ntitle: Pin tabs to the left\n---\n';
    expect(documents.route.title?.('co', 'tickets/t/0000/t-63/ticket.md', text)).toBe('T-0063 · Pin tabs to the left');
    expect(documents.route.title?.('big', 'tickets-store/tickets/t/0000/t-63/ticket.md', text)).toBe('T-0063 · Pin tabs to the left');
    expect(documents.route.title?.('co', 'tickets/t/0000/t-63/comments/a.md', text)).toBeNull();
  });
});

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

  it('flags every vault that holds the checkout as plugin-managed, and clears the flag when the backend is off', async () => {
    const markManaged = vi.fn();
    const { documents } = make({ markManaged, vaults: async () => [{ id: 'big', path: '/data', exists: true }, { id: 'co', path: CHECKOUT, exists: true }, { id: 'meta', path: '/data/meta', exists: true }] });
    await documents.refresh();
    expect(markManaged).toHaveBeenLastCalledWith(['big', 'co']);
    const off = vi.fn();
    await make({ markManaged: off, checkout: async () => null }).documents.refresh();
    expect(off).toHaveBeenLastCalledWith([]);
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

describe('a checkout inside a larger vault (D-25)', () => {
  const vaults = async () => [{ id: 'big', path: '/data', exists: true }];

  it('hands out the document with its prefix and titles it by its id', async () => {
    const { documents } = make({ checkout: async () => '/data/work/store', vaults });
    await documents.refresh();
    const prefixed = 'work/store/tickets/t/0000/t-63/ticket.md';
    expect(documents.owns('big', prefixed)).toBe(true);
    expect(documents.owns('big', 'tickets/t/0000/t-63/ticket.md')).toBe(false);
    expect(documents.route.title?.('big', prefixed, '---\ntitle: Pin tabs\n---\n')).toBe('T-0063 · Pin tabs');
  });
});
