import { describe, expect, it } from 'vitest';
import { ManagedVaults } from './managed-vaults';

describe('ManagedVaults (SDK 1.32 plugin-managed vaults)', () => {
  it('a marked vault reports the managing plugin\'s label', () => {
    const registry = new ManagedVaults();
    expect(registry.managedBy('tickets')).toBeNull();
    registry.mark('tickets', 'tickets', 'Tickets');
    expect(registry.managedBy('tickets')).toBe('Tickets');
  });

  it('one mark per plugin: re-marking moves the claim with detection', () => {
    const registry = new ManagedVaults();
    registry.mark('tickets', 'tickets-a', 'Tickets');
    registry.mark('tickets', 'tickets-b', 'Tickets');
    expect(registry.managedBy('tickets-a')).toBeNull();
    expect(registry.managedBy('tickets-b')).toBe('Tickets');
  });

  it('re-marking the same vault refreshes the label', () => {
    const registry = new ManagedVaults();
    registry.mark('tickets', 'tickets', 'Tickets');
    registry.mark('tickets', 'tickets', 'Tickets (renamed)');
    expect(registry.managedBy('tickets')).toBe('Tickets (renamed)');
  });

  it('clearPlugin drops only that plugin\'s mark', () => {
    const registry = new ManagedVaults();
    registry.mark('tickets', 'tickets', 'Tickets');
    registry.mark('other', 'notes', 'Notes owner');
    registry.clearPlugin('tickets');
    expect(registry.managedBy('tickets')).toBeNull();
    expect(registry.managedBy('notes')).toBe('Notes owner');
  });

  it('two plugins claiming one vault: the first registration wins', () => {
    const registry = new ManagedVaults();
    registry.mark('first', 'shared', 'First');
    registry.mark('second', 'shared', 'Second');
    expect(registry.managedBy('shared')).toBe('First');
    registry.clearPlugin('first');
    expect(registry.managedBy('shared')).toBe('Second');
  });
});
