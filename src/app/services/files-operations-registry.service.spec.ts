import { TestBed } from '@angular/core/testing';
import type {
  VaultFileOperation,
  VaultFileOperationOutcome,
  VaultFileOperationsHandler,
} from '../../../shared/plugin-api/renderer';
import {
  FilesOperationsRegistryService,
  FilesOperationDecision,
} from './files-operations-registry.service';

const deleteOp: VaultFileOperation = {
  kind: 'delete',
  vaultId: 'tickets',
  paths: ['tickets/10-plan/T-0001.md'],
};

const handler = (
  check: VaultFileOperationsHandler['check'],
  perform?: VaultFileOperationsHandler['perform'],
): VaultFileOperationsHandler => ({
  check,
  perform:
    perform ??
    (() =>
      Promise.resolve<VaultFileOperationOutcome>({ ok: true, path: 'done.md' })),
});

describe('FilesOperationsRegistryService (SDK 1.32 files seam)', () => {
  let registry: FilesOperationsRegistryService;

  beforeEach(() => {
    registry = TestBed.inject(FilesOperationsRegistryService);
  });

  it('allows when no plugin registered', async () => {
    await expectDecision({ action: 'allow' });
  });

  it('allows when every handler allows', async () => {
    registry.register('a', handler(() => Promise.resolve({ action: 'allow' })));
    registry.register('b', handler(() => Promise.resolve({ action: 'allow' })));
    await expectDecision({ action: 'allow' });
  });

  it('refuses with the first refusal, beating an earlier handle', async () => {
    registry.register('taker', handler(() => Promise.resolve({ action: 'handle' })));
    registry.register(
      'veto',
      handler(() => Promise.resolve({ action: 'refuse', reason: 'not yours' })),
    );
    await expectDecision({ action: 'refuse', reason: 'not yours' });
  });

  it('refuses with the FIRST refusal when several veto', async () => {
    registry.register(
      'a',
      handler(() => Promise.resolve({ action: 'refuse', reason: 'first' })),
    );
    registry.register(
      'b',
      handler(() => Promise.resolve({ action: 'refuse', reason: 'second' })),
    );
    await expectDecision({ action: 'refuse', reason: 'first' });
  });

  it('handles through the FIRST handler that claims, later claimants idle', async () => {
    const performed: string[] = [];
    registry.register('first', handler(() => Promise.resolve({ action: 'handle' }), () => {
      performed.push('first');
      return Promise.resolve<VaultFileOperationOutcome>({ ok: true });
    }));
    registry.register('second', handler(() => Promise.resolve({ action: 'handle' }), () => {
      performed.push('second');
      return Promise.resolve<VaultFileOperationOutcome>({ ok: true });
    }));
    const outcome = await registry.perform(deleteOp);
    expect(performed).toEqual(['first']);
    expect(outcome.ok).toBe(true);
  });

  it('a handle decision performs with the claiming handler', async () => {
    const performed: VaultFileOperation[] = [];
    registry.register(
      'tickets',
      handler(() => Promise.resolve({ action: 'handle' }), (operation) => {
        performed.push(operation);
        return Promise.resolve<VaultFileOperationOutcome>({
          ok: true,
          path: 'tickets/40-done/T-0001.md',
        });
      }),
    );
    const decision = await registry.check(deleteOp);
    expect(decision.action).toBe('handle');
    if (decision.action !== 'handle') {
      return;
    }
    const outcome = await decision.perform();
    expect(performed).toEqual([deleteOp]);
    expect(outcome).toEqual({ ok: true, path: 'tickets/40-done/T-0001.md' });
  });

  it('a throwing check counts as a refusal with its message', async () => {
    registry.register('broken', handler(() => Promise.reject(new Error('boom'))));
    await expectDecision({ action: 'refuse', reason: 'boom' });
  });

  it('a throwing perform resolves to a failed outcome', async () => {
    registry.register(
      'tickets',
      handler(
        () => Promise.resolve({ action: 'handle' }),
        () => Promise.reject(new Error('transition failed')),
      ),
    );
    const outcome = await registry.perform(deleteOp);
    expect(outcome).toEqual({ ok: false, error: 'transition failed' });
  });

  it('perform fails when no handler claims the operation', async () => {
    registry.register('a', handler(() => Promise.resolve({ action: 'allow' })));
    const outcome = await registry.perform(deleteOp);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeTruthy();
  });

  it('clear drops the plugin handler; unsubscribe keeps a newer registration', async () => {
    const off = registry.register(
      'tickets',
      handler(() => Promise.resolve({ action: 'refuse', reason: 'old' })),
    );
    registry.register(
      'tickets',
      handler(() => Promise.resolve({ action: 'refuse', reason: 'new' })),
    );
    off();
    await expectDecision({ action: 'refuse', reason: 'new' });
    registry.clear('tickets');
    await expectDecision({ action: 'allow' });
  });

  function expectDecision(expected: FilesOperationDecision): Promise<void> {
    return registry.check(deleteOp).then((decision) => {
      expect(decision).toEqual(expected);
    });
  }
});
