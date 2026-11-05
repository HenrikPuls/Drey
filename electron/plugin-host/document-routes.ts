import type { DocumentRoute } from '../../shared/plugin-api';

/**
 * The base-owned registry of document routes (SDK 1.44, E14-4c): a plugin
 * claims documents it writes through its own engine (the tickets plugin's
 * dricket checkout). `NoteManager` hands the editor's save of such a document
 * to the route; `VaultManager` refuses every other mutation of it. Plugins
 * never talk to each other; the host is the only broker (ADR-0044).
 */
export class DocumentRoutes {
  /** pluginId -> route and the plugin's display name; one route per plugin. */
  private readonly routes = new Map<string, { route: DocumentRoute; label: string }>();

  set(pluginId: string, label: string, route: DocumentRoute): void {
    this.routes.set(pluginId, { route, label });
  }

  clearPlugin(pluginId: string): void {
    this.routes.delete(pluginId);
  }

  /** Drops the plugin's route only while it is still `route` (a replaced route stays). */
  clearRoute(pluginId: string, route: DocumentRoute): void {
    if (this.routes.get(pluginId)?.route === route) {
      this.routes.delete(pluginId);
    }
  }

  /** The route that owns the document, or null. First claim wins a collision. */
  routeFor(vaultId: string, path: string): { route: DocumentRoute; label: string } | null {
    for (const entry of this.routes.values()) {
      if (entry.route.owns(vaultId, path)) {
        return entry;
      }
    }
    return null;
  }

  /** Why a document may not be changed by a plain vault write, or null when it may. */
  refusal(vaultId: string, path: string): string | null {
    const owner = this.routeFor(vaultId, path);
    return owner === null ? null : `${path} is managed by ${owner.label} and cannot be changed here.`;
  }
}
