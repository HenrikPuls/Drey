/**
 * The in-memory vector index (ADR-0055): per vault, one entry per embedded
 * note section (path + heading + line + float32 vector), plus the model
 * the vectors were computed with — vectors from a different model are
 * meaningless, so a mismatch marks the vault stale and search skips it.
 * Persistence is the service's job: `serialize`/`load` map one vault to
 * its JSON file.
 */
import { cosineSimilarity, decodeVector, encodeVector } from '../../shared/semantic.js';

export interface IndexedSection {
  path: string;
  heading: string;
  line: number;
  vec: Float32Array;
}

export interface IndexHit {
  vaultId: string;
  path: string;
  heading: string;
  line: number;
  score: number;
}

export interface NewSectionRecord {
  heading: string;
  line: number;
  vec: Float32Array;
}

interface VaultIndex {
  model: string;
  files: Map<string, IndexedSection[]>;
}

export interface SerializedVaultIndex {
  model: string;
  sections: { path: string; heading: string; line: number; v: string }[];
}

export class VectorIndex {
  private readonly byVault = new Map<string, VaultIndex>();

  /** The model a vault's vectors were computed with, or null when empty. */
  modelOf(vaultId: string): string | null {
    return this.byVault.get(vaultId)?.model ?? null;
  }

  /** True when a vault HAS vectors but under another model (search must skip it). */
  isStale(vaultId: string, model: string): boolean {
    const index = this.byVault.get(vaultId);
    return index !== undefined && index.model !== model && index.files.size > 0;
  }

  /** Replaces everything one file contributed (empty records remove the file). */
  setFile(vaultId: string, model: string, path: string, records: readonly NewSectionRecord[]): void {
    const index = this.byVault.get(vaultId) ?? { model, files: new Map<string, IndexedSection[]>() };
    index.model = model;
    if (records.length === 0) {
      index.files.delete(path);
    } else {
      index.files.set(
        path,
        records.map((record) => ({ path, heading: record.heading, line: record.line, vec: record.vec })),
      );
    }
    this.byVault.set(vaultId, index);
  }

  removeFile(vaultId: string, path: string): void {
    this.byVault.get(vaultId)?.files.delete(path);
  }

  /** Whether any section of this file is indexed (catch-up probe). */
  fileExists(vaultId: string, path: string): boolean {
    return this.byVault.get(vaultId)?.files.has(path) ?? false;
  }

  removeAll(vaultId: string): void {
    this.byVault.delete(vaultId);
  }

  dropVault(vaultId: string): void {
    this.removeAll(vaultId);
  }

  knownVaults(): readonly string[] {
    return [...this.byVault.keys()];
  }

  sectionCount(vaultId: string): number {
    const index = this.byVault.get(vaultId);
    if (index === undefined) {
      return 0;
    }
    let count = 0;
    for (const sections of index.files.values()) {
      count += sections.length;
    }
    return count;
  }

  /**
   * Top-k over the given vaults (vectors of a stale vault are skipped by
   * the model check), best first, nothing below `minScore`.
   */
  search(
    vaultIds: readonly string[],
    model: string,
    queryVec: Float32Array,
    k: number,
    minScore: number,
  ): IndexHit[] {
    const hits: IndexHit[] = [];
    for (const vaultId of vaultIds) {
      const index = this.byVault.get(vaultId);
      if (index === undefined || index.model !== model) {
        continue;
      }
      for (const sections of index.files.values()) {
        for (const section of sections) {
          const score = cosineSimilarity(queryVec, section.vec);
          if (score >= minScore) {
            hits.push({ vaultId, path: section.path, heading: section.heading, line: section.line, score });
          }
        }
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(0, k));
  }

  serialize(vaultId: string): string | null {
    const index = this.byVault.get(vaultId);
    if (index === undefined) {
      return null;
    }
    const sections: SerializedVaultIndex['sections'] = [];
    for (const fileSections of index.files.values()) {
      for (const section of fileSections) {
        sections.push({ path: section.path, heading: section.heading, line: section.line, v: encodeVector(section.vec) });
      }
    }
    return JSON.stringify({ version: 1, model: index.model, sections } satisfies SerializedVaultIndex & { version: number });
  }

  /** Loads a persisted index; a corrupt file or model mismatch yields nothing. */
  load(vaultId: string, model: string, json: string | null): void {
    if (json === null) {
      return;
    }
    let data: SerializedVaultIndex & { version?: number };
    try {
      data = JSON.parse(json) as SerializedVaultIndex & { version?: number };
    } catch {
      return;
    }
    if (!data || data.model !== model || !Array.isArray(data.sections)) {
      return;
    }
    const files = new Map<string, IndexedSection[]>();
    try {
      for (const entry of data.sections) {
        if (
          typeof entry?.path !== 'string' ||
          typeof entry?.heading !== 'string' ||
          typeof entry?.line !== 'number' ||
          typeof entry?.v !== 'string'
        ) {
          continue;
        }
        const section: IndexedSection = {
          path: entry.path,
          heading: entry.heading,
          line: entry.line,
          vec: decodeVector(entry.v),
        };
        const existing = files.get(entry.path);
        if (existing === undefined) {
          files.set(entry.path, [section]);
        } else {
          existing.push(section);
        }
      }
    } catch {
      return; // a corrupted vector payload invalidates the whole file
    }
    this.byVault.set(vaultId, { model, files });
  }
}
