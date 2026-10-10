import { Injectable, inject } from '@angular/core';
import type { FileOpenerContrib, Unsubscribe } from '../../../shared/plugin-api/renderer';
import { LogService } from './log.service';

/**
 * The file-opener seam (SDK 1.16, ADR-0064): a plugin can take over the
 * opening of vault files by name suffix (`.drawio.svg`), ahead of the base
 * text / image / PDF routing in `EditorService.openFile`. The longest
 * matching suffix wins, so `.drawio.svg` beats a plain `.svg`; between
 * equal suffixes the first registration wins.
 *
 * Lives beside `EditorService` rather than in `plugin-host/`: the editor
 * service consults it, and the plugin host already depends on the editor
 * service.
 */
@Injectable({ providedIn: 'root' })
export class FileOpenerRegistry {
  private readonly log = inject(LogService);
  private readonly openers: FileOpenerContrib[] = [];

  register(opener: FileOpenerContrib): Unsubscribe {
    this.openers.push(opener);
    return () => {
      const index = this.openers.indexOf(opener);
      if (index !== -1) {
        this.openers.splice(index, 1);
      }
    };
  }

  /** The opener for this path, or null when the base routing applies. */
  find(relativePath: string): FileOpenerContrib | null {
    const name = relativePath.toLowerCase();
    let best: FileOpenerContrib | null = null;
    let bestLength = 0;
    for (const opener of this.openers) {
      for (const extension of opener.extensions) {
        const suffix = extension.toLowerCase();
        if (suffix.length > bestLength && suffix.startsWith('.') && name.endsWith(suffix)) {
          best = opener;
          bestLength = suffix.length;
        }
      }
    }
    return best;
  }

  /**
   * Hands the file to its opener. False when none claims it or the opener
   * threw (logged) -- the caller then falls back to the base routing.
   */
  open(relativePath: string, vaultId: string | null): boolean {
    const opener = this.find(relativePath);
    if (opener === null) {
      return false;
    }
    try {
      opener.open(relativePath, vaultId);
      return true;
    } catch (error) {
      this.log.record('error', `plugin file opener failed for ${relativePath}: ${String(error)}`);
      return false;
    }
  }
}
