import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { migrateLegacyActions } from './actions-migration';
import { PluginConfigStore, type ConfigIo } from './plugin-config-store';

/**
 * The one-time A6 migration: the actions slice moves from app-config.json
 * into the assistant plugin's own config. The store runs against a memory
 * io; the base file is a spy around real temp files.
 */

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

const io: ConfigIo = {
  readFile: async (file) => {
    if (file.replace(/\\/g, '/').endsWith('assistant/config.json')) {
      return JSON.stringify(store.peek());
    }
    throw new Error('no such file');
  },
  writeFile: async (file, text) => {
    // The store writes tmp + rename; the test store commits at once.
    if (file.replace(/\\/g, '/').includes('assistant/config')) {
      store.write(JSON.parse(text) as Record<string, unknown>);
    }
  },
  mkdir: async () => undefined,
  rename: async () => undefined,
};

/** A tiny handle on what the store has persisted. */
const persisted: Record<string, unknown> = {};
const store = {
  peek: (): Record<string, unknown> => persisted,
  write: (config: Record<string, unknown>): void => {
    for (const key of Object.keys(persisted)) {
      delete persisted[key];
    }
    Object.assign(persisted, config);
  },
};

const realStore = new PluginConfigStore('W:/ud/plugins', io);

function baseFileWith(content: unknown): void {
  vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify(content));
}

describe('migrateLegacyActions', () => {
  it('moves a stored actions slice into the assistant plugin config, normalized', async () => {
    baseFileWith({
      llm: { enabled: true },
      actions: {
        templates: [
          { id: 'u1', name: 'Reformat', prompt: 'tidy up', resultKind: 'document' },
          // A half-written entry normalizes away.
          { id: 'u2', name: '', prompt: 'x' },
        ],
        triggers: [{ id: 't1', templateId: 'u1', event: 'manual', confirm: true, enabled: true }],
      },
    });

    await migrateLegacyActions('W:/ud/app-config.json', realStore);

    const actions = persisted['actions'] as { templates: unknown[]; triggers: unknown[] };
    expect(actions.triggers).toHaveLength(1);
    // The three built-ins re-inject around the surviving user template.
    expect((actions.templates as Array<{ builtin: string | null }>).map((t) => t.builtin)).toEqual([
      'search-summary',
      'autotag',
      'lossless-format',
      null,
    ]);
  });

  it('is a no-op when the assistant config already holds the key (it wins)', async () => {
    store.write({ actions: { templates: [{ id: 'user-newer' }], triggers: [] } });
    baseFileWith({ actions: { templates: [{ id: 'older' }], triggers: [] } });

    await migrateLegacyActions('W:/ud/app-config.json', realStore);

    const actions = persisted['actions'] as { templates: Array<{ id: string }> };
    expect(actions.templates.map((t) => t.id)).toEqual(['user-newer']);
  });

  it('is a no-op when the base file has no actions key or cannot be read', async () => {
    store.write({});
    baseFileWith({ llm: { enabled: false } });
    await migrateLegacyActions('W:/ud/app-config.json', realStore);
    expect(persisted['actions']).toBeUndefined();

    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('boom');
    });
    await migrateLegacyActions('W:/ud/app-config.json', realStore);
    expect(persisted['actions']).toBeUndefined();
  });
});
