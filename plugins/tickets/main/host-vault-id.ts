import * as path from 'node:path';

/**
 * The standalone engine (ADR-0088 E2b) hosts the tickets vault under its own
 * id — `standalone` — while the renderer's `api.documents.open`, the editor
 * surface's `vaultId()` and the Files panel all speak Drey's vault ids. A
 * snapshot that reaches the renderer with the engine's id matches nothing:
 * the ticket header never shows, "Ticket file" opens nothing.
 *
 * `hostVaultIdMapper` translates the id once per vault name: the Drey vault
 * whose folder carries the engine's vault name and holds the board's
 * `tickets/_meta/pipeline.md` (the detector's own probe).
 */
export interface HostVaultLike {
  readonly id: string;
  readonly path: string;
  readonly exists: boolean;
}

export interface SnapshotVault {
  readonly vaultId: string | null;
  readonly vaultName: string | null;
}

export function hostVaultIdMapper(deps: {
  readonly listVaults: () => Promise<readonly HostVaultLike[]>;
  readonly hasBoard: (vaultId: string) => Promise<boolean>;
}): <T extends SnapshotVault>(snapshot: T) => Promise<T> {
  const byName = new Map<string, string>();
  return async <T extends SnapshotVault>(snapshot: T): Promise<T> => {
    if (snapshot.vaultId === null || snapshot.vaultName === null) {
      return snapshot;
    }
    const vaults = await deps.listVaults();
    // Already one of Drey's ids (an engine hosted by the Drey host).
    if (vaults.some((vault) => vault.id === snapshot.vaultId)) {
      return snapshot;
    }
    let id = byName.get(snapshot.vaultName);
    if (id === undefined || !vaults.some((vault) => vault.id === id && vault.exists)) {
      id = undefined;
      for (const vault of vaults) {
        if (vault.exists && path.basename(vault.path) === snapshot.vaultName && (await deps.hasBoard(vault.id))) {
          id = vault.id;
          byName.set(snapshot.vaultName, id);
          break;
        }
      }
    }
    return id === undefined ? snapshot : { ...snapshot, vaultId: id };
  };
}
