/**
 * The vault's markdown file paths, cached for the composer's file chips
 * (the @-completion source and the "+" picker). Flattened from
 * `api.vault.listFiles()`'s tree and invalidated on any vault change.
 *
 * A stale entry's worst case is one skipped read at send time (the state
 * layer drops files that are no longer in the vault), never a wrong
 * write — so the invalidation can be lazy ("drop on change, reload on
 * next use") instead of eager.
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';

export interface VaultFileCache {
  /** The sorted `.md` paths, loading the cache on first use. */
  ensureLoaded(): Promise<readonly string[]>;
}

export function createVaultFileCache(api: DreyPluginApi): VaultFileCache {
  let paths: readonly string[] | null = null;
  let loading: Promise<readonly string[]> | null = null;

  const load = async (): Promise<readonly string[]> => {
    const collect = (entries: readonly { name: string; relativePath: string; type: 'file' | 'directory'; children?: unknown }[]): string[] => {
      const out: string[] = [];
      for (const entry of entries) {
        if (entry.type === 'directory') {
          out.push(...collect((entry.children as typeof entries) ?? []));
        } else if (entry.name.toLowerCase().endsWith('.md')) {
          out.push(entry.relativePath);
        }
      }
      return out;
    };
    const files = collect(await api.vault.listFiles());
    files.sort((a, b) => a.localeCompare(b));
    paths = files;
    return files;
  };

  api.vault.onChanged(() => {
    paths = null;
  });

  return {
    ensureLoaded: () => {
      if (paths !== null) {
        return Promise.resolve(paths);
      }
      loading ??= load().finally(() => {
        loading = null;
      });
      return loading;
    },
  };
}
