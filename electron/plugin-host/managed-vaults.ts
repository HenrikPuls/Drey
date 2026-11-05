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
  /** pluginId -> { vaultIds, label } ; one mark per plugin (it follows detection), SDK 1.45: of several vaults. */
  private readonly marks = new Map<string, { vaultIds: ReadonlySet<string>; label: string }>();

  /** THIS plugin claims `vaultId` (or the listed vaults); replaces the plugin's previous mark. */
  mark(pluginId: string, vaultId: string | readonly string[], label: string): void {
    const vaultIds = new Set(typeof vaultId === 'string' ? [vaultId] : vaultId);
    if (vaultIds.size === 0) {
      this.marks.delete(pluginId);
      return;
    }
    this.marks.set(pluginId, { vaultIds, label });
  }

  /** Drops one plugin's mark (a null re-detect, deactivation, quarantine). */
  clearPlugin(pluginId: string): void {
    this.marks.delete(pluginId);
  }

  /** The managing plugin's display name for a vault, or null. First claim wins a collision. */
  managedBy(vaultId: string): string | null {
    for (const mark of this.marks.values()) {
      if (mark.vaultIds.has(vaultId)) {
        return mark.label;
      }
    }
    return null;
  }
}
