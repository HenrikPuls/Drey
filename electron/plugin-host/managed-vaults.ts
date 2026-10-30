/**
 * The base-owned registry of plugin-managed vaults (SDK 1.32, ADR-0082):
 * a plugin flags the vault it structurally manages through
 * `ctx.vault.markManaged` (the tickets vault — one transition is one
 * structured commit), and consumers (the git plugin's read-only guard)
 * ask `managedBy`. The vault stays fully visible everywhere — only the
 * free-form mutations on it are refused. Plugins never talk to each
 * other; the host is the only broker (ADR-0044).
 */
export class ManagedVaults {
  /** pluginId -> { vaultId, label } ; one mark per plugin (it follows detection). */
  private readonly marks = new Map<string, { vaultId: string; label: string }>();

  /** THIS plugin claims `vaultId`; replaces the plugin's previous mark. */
  mark(pluginId: string, vaultId: string, label: string): void {
    this.marks.set(pluginId, { vaultId, label });
  }

  /** Drops one plugin's mark (a null re-detect, deactivation, quarantine). */
  clearPlugin(pluginId: string): void {
    this.marks.delete(pluginId);
  }

  /** The managing plugin's display name for a vault, or null. First claim wins a collision. */
  managedBy(vaultId: string): string | null {
    for (const mark of this.marks.values()) {
      if (mark.vaultId === vaultId) {
        return mark.label;
      }
    }
    return null;
  }
}
