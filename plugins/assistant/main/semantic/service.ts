/**
 * The semantic service (ADR-0055): owns the per-vault vector indexes, the
 * embedding worker, and the plugin-config slice (`semantic.*`). Freshness
 * rides the same registries as the tags index (save hooks + vault-change
 * events); indexes persist as one JSON file per vault under the plugin's
 * userData area and load lazily. Retrieval hydrates section text from the
 * vault AT ANSWER TIME, so even a slightly stale index never serves stale
 * text — only stale rankings.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { MainPluginContext, VaultChangeEvent } from '../../../../shared/plugin-api';
import {
  DEFAULT_SEMANTIC_MIN_SCORE,
  DEFAULT_SEMANTIC_MODEL,
  DEFAULT_SEMANTIC_TOP_K,
  EMBED_BATCH,
  MAX_SEMANTIC_TOP_K,
  contextCitations,
  isSemanticIndexPath,
  passageText,
  queryText,
  semanticSectionsFor,
  type ContextCite,
  type RetrievedSection,
  type RetrievalOutcome,
  type VaultScope,
} from '../../shared/semantic.js';
import { SemanticEmbedder } from './embedder';
import { VectorIndex } from './vector-index';

/** The service's view of the host; narrow so the spec suite can fake it. */
export interface SemanticDeps {
  listVaults(): Promise<readonly { id: string; name: string; active: boolean }[]>;
  readVaultText(vaultId: string, path: string): Promise<string | null>;
  listMarkdownFiles(vaultId: string): Promise<readonly string[]>;
  getConfig<T>(key: string): Promise<T | undefined>;
  emit(event: string, data?: unknown): void;
  log(message: string, level?: 'info' | 'warn' | 'error'): void;
  /** Absolute path of the plugin's userData dir (config.json's home). */
  dataDir: string;
  /** Absolute path to the compiled embed worker. */
  workerPath: string;
  /** Where the embedding models cache (usually `<userData>/models`). */
  modelCacheDir: string;
}

interface BuildProgress {
  done: number;
  total: number;
}

export interface SemanticVaultStatus {
  id: string;
  name: string;
  active: boolean;
  sections: number;
  stale: boolean;
  building: BuildProgress | null;
}

export interface SemanticStatus {
  enabled: boolean;
  model: string;
  topK: number;
  minScore: number;
  ready: boolean;
  vaults: SemanticVaultStatus[];
}

const SAVE_DEBOUNCE_MS = 1500;

export class SemanticService {
  private readonly deps: SemanticDeps;
  private readonly index = new VectorIndex();
  private embedder: SemanticEmbedder;
  private enabled = false;
  private model = DEFAULT_SEMANTIC_MODEL;
  private topK = DEFAULT_SEMANTIC_TOP_K;
  private minScore = DEFAULT_SEMANTIC_MIN_SCORE;
  private readonly building = new Map<string, BuildProgress>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(deps: SemanticDeps) {
    this.deps = deps;
    this.embedder = new SemanticEmbedder({
      workerPath: deps.workerPath,
      model: this.model,
      cacheDir: deps.modelCacheDir,
      maxBatch: EMBED_BATCH,
    });
  }

  /** Reads the config slice; a model change restarts the worker lazily. */
  async refreshConfig(): Promise<void> {
    const [enabled, model, topK, minScore] = await Promise.all([
      this.deps.getConfig<boolean>('semantic.enabled'),
      this.deps.getConfig<string>('semantic.model'),
      this.deps.getConfig<number>('semantic.topK'),
      this.deps.getConfig<number>('semantic.minScore'),
    ]);
    this.enabled = enabled === true;
    const nextModel = typeof model === 'string' && model.trim() !== '' ? model.trim() : DEFAULT_SEMANTIC_MODEL;
    if (nextModel !== this.model) {
      this.model = nextModel;
      this.embedder.changeModel(this.model);
    }
    this.topK = clampInt(topK, 1, MAX_SEMANTIC_TOP_K, DEFAULT_SEMANTIC_TOP_K);
    this.minScore = clampNum(minScore, 0, 1, DEFAULT_SEMANTIC_MIN_SCORE);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Called after the renderer wrote the config slice (Settings page). */
  async onConfigChanged(): Promise<void> {
    const wasModel = this.model;
    await this.refreshConfig();
    if (this.enabled && this.model !== wasModel) {
      // Vectors of the old model are meaningless now — rebuild everything.
      void this.rebuildAll();
      return;
    }
    if (this.enabled) {
      void this.catchUpAll();
    }
  }

  async status(): Promise<SemanticStatus> {
    const vaults = await this.deps.listVaults();
    await this.ensureLoaded(vaults.map((v) => v.id));
    return {
      enabled: this.enabled,
      model: this.model,
      topK: this.topK,
      minScore: this.minScore,
      ready: true,
      vaults: vaults.map((vault) => ({
        id: vault.id,
        name: vault.name,
        active: vault.active,
        sections: this.index.sectionCount(vault.id),
        stale: this.index.isStale(vault.id, this.model),
        building: this.building.get(vault.id) ?? null,
      })),
    };
  }

  /** The save-hook entry (content already carries the saved text). */
  onSaved(vaultId: string, filePath: string, content: string): void {
    if (!this.enabled || this.disposed || !isSemanticIndexPath(filePath)) {
      return;
    }
    void this.enqueue(vaultId, () => this.embedFile(vaultId, filePath, content));
  }

  /** The vault-change entry (delete/write/refresh), mirroring the tags index. */
  onVaultChanged(event: VaultChangeEvent): void {
    if (!this.enabled || this.disposed) {
      return;
    }
    if (
      event.kind === 'delete' &&
      event.path !== undefined &&
      event.vaultId !== undefined
    ) {
      this.index.removeFile(event.vaultId, event.path);
      this.scheduleSave(event.vaultId);
      this.announce();
      return;
    }
    if (event.kind === 'write' && event.path !== undefined && event.vaultId !== undefined) {
      const { vaultId, path: filePath } = event as { vaultId: string; path: string };
      if (!isSemanticIndexPath(filePath)) {
        return;
      }
      void this.enqueue(vaultId, async () => {
        const content = await this.deps.readVaultText(vaultId, filePath);
        if (content === null) {
          this.index.removeFile(vaultId, filePath);
          this.scheduleSave(vaultId);
          this.announce();
          return;
        }
        await this.embedFile(vaultId, filePath, content);
      });
      return;
    }
    void this.rebuildAll();
  }

  /** Full rebuild of one vault (Settings button) — or every registered vault. */
  async rebuild(targetVaultId?: string): Promise<void> {
    if (targetVaultId !== undefined) {
      await this.rebuildVault(targetVaultId);
      return;
    }
    await this.rebuildAll();
  }

  async rebuildAll(): Promise<void> {
    if (!this.enabled || this.disposed) {
      return;
    }
    const vaults = await this.deps.listVaults();
    for (const vault of vaults) {
      await this.rebuildVault(vault.id);
    }
    const registered = new Set(vaults.map((v) => v.id));
    for (const id of this.index.knownVaults()) {
      if (!registered.has(id)) {
        this.index.dropVault(id);
      }
    }
    this.announce();
  }

  /** (Re)builds one vault: clear, then embed every Markdown file in order. */
  async rebuildVault(vaultId: string): Promise<void> {
    if (!this.enabled || this.disposed) {
      return;
    }
    await this.enqueue(vaultId, async () => {
      const files = (await this.deps.listMarkdownFiles(vaultId)).filter(isSemanticIndexPath);
      this.index.removeAll(vaultId);
      const progress: BuildProgress = { done: 0, total: files.length };
      this.building.set(vaultId, progress);
      this.emitProgress(vaultId, progress);
      for (const filePath of files) {
        const content = await this.deps.readVaultText(vaultId, filePath);
        if (content !== null) {
          await this.embedFile(vaultId, filePath, content);
        }
        progress.done += 1;
        this.emitProgress(vaultId, progress);
      }
      this.building.delete(vaultId);
      this.scheduleSave(vaultId);
      this.announce();
    });
  }

  /**
   * Boot/enable catch-up: load the persisted index, then embed the files
   * it does not cover yet (cheap when current, the automatic first build
   * after enabling).
   */
  async catchUpAll(): Promise<void> {
    if (!this.enabled || this.disposed) {
      return;
    }
    const vaults = await this.deps.listVaults();
    await this.ensureLoaded(vaults.map((v) => v.id));
    for (const vault of vaults) {
      const files = (await this.deps.listMarkdownFiles(vault.id)).filter(isSemanticIndexPath);
      const missing = files.filter((file) => !this.indexHasFile(vault.id, file));
      if (missing.length === 0) {
        continue;
      }
      await this.enqueue(vault.id, async () => {
        const progress: BuildProgress = { done: 0, total: missing.length };
        this.building.set(vault.id, progress);
        this.emitProgress(vault.id, progress);
        for (const filePath of missing) {
          const content = await this.deps.readVaultText(vault.id, filePath);
          if (content !== null) {
            await this.embedFile(vault.id, filePath, content);
          }
          progress.done += 1;
          this.emitProgress(vault.id, progress);
        }
        this.building.delete(vault.id);
        this.scheduleSave(vault.id);
        this.announce();
      });
    }
  }

  /**
   * Retrieval for one ask turn: embed the question, top-k over the scoped
   * vaults, then hydrate each hit's text FRESH from the vault. A disabled
   * service returns `enabled: false` (nothing was searched — the caller
   * can say so); hard failures throw, the caller catches and degrades to
   * no context.
   */
  async retrieve(
    question: string,
    scope: Extract<VaultScope, 'vault' | 'all'>,
  ): Promise<RetrievalOutcome> {
    if (!this.enabled || this.disposed) {
      return { enabled: false, minScore: this.minScore, hits: [] };
    }
    const empty: RetrievalOutcome = { enabled: true, minScore: this.minScore, hits: [] };
    const vaults = await this.deps.listVaults();
    const targetIds: string[] = [];
    if (scope === 'all') {
      targetIds.push(...vaults.map((v) => v.id));
    } else {
      const active = vaults.find((v) => v.active);
      if (active !== undefined) {
        targetIds.push(active.id);
      }
    }
    if (targetIds.length === 0) {
      return empty;
    }
    await this.ensureLoaded(targetIds);
    const [queryVec] = await this.embedder.embed([queryText(this.model, question)]);
    if (queryVec === undefined) {
      return empty;
    }
    // Query-time exclusion too: an index built before the chats/ rule may
    // still carry chat sections — they never surface, even unrebuilt.
    const hits = this.index
      .search(targetIds, this.model, queryVec, this.topK, this.minScore)
      .filter((hit) => isSemanticIndexPath(hit.path));
    const out: RetrievedSection[] = [];
    for (const hit of hits) {
      const content = await this.deps.readVaultText(hit.vaultId, hit.path);
      if (content === null) {
        continue;
      }
      const sections = semanticSectionsFor(hit.path, content);
      const exact = sections.find((entry) => entry.line === hit.line);
      const section =
        exact ??
        sections.filter((entry) => entry.line <= hit.line).at(-1);
      if (section === undefined) {
        continue;
      }
      out.push({
        vaultId: hit.vaultId,
        path: hit.path,
        heading: section.heading,
        line: section.line,
        score: hit.score,
        text: section.text,
      });
    }
    return { enabled: true, minScore: this.minScore, hits: out };
  }

  citationsFor(
    question: string,
    scope: Extract<VaultScope, 'vault' | 'all'>,
  ): Promise<ContextCite[]> {
    return this.retrieve(question, scope).then((outcome) => contextCitations(outcome.hits));
  }

  /** Sync flush for app quit. */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.saveTimers.values()) {
      clearTimeout(timer);
    }
    this.saveTimers.clear();
    for (const vaultId of [...this.dirty]) {
      this.flushSync(vaultId);
    }
    this.embedder.dispose();
  }

  // -- internals -------------------------------------------------------------

  private indexHasFile(vaultId: string, filePath: string): boolean {
    // Cheap probe via search is wrong; expose file presence through the index.
    return this.index.fileExists(vaultId, filePath);
  }

  /** One file: split → embed (batched by the embedder) → index → persist. */
  private async embedFile(vaultId: string, filePath: string, content: string): Promise<void> {
    const sections = semanticSectionsFor(filePath, content);
    if (sections.length === 0) {
      this.index.setFile(vaultId, this.model, filePath, []);
      this.scheduleSave(vaultId);
      return;
    }
    let vectors: Float32Array[];
    try {
      vectors = await this.embedder.embed(sections.map((s) => passageText(this.model, s.text)));
    } catch (err) {
      this.deps.log(
        `embedding failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        'warn',
      );
      return; // keep whatever the file had before; next save retries
    }
    this.index.setFile(
      vaultId,
      this.model,
      filePath,
      sections.map((section, i) => ({
        heading: section.heading,
        line: section.line,
        vec: vectors[i] ?? new Float32Array(),
      })),
    );
    this.scheduleSave(vaultId);
    this.announce();
  }

  /** Serializes embed/index work per vault so hooks never interleave. */
  private enqueue(vaultId: string, task: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(vaultId) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.chains.set(vaultId, next);
    void next.catch(() => undefined);
    return next;
  }

  private async ensureLoaded(vaultIds: readonly string[]): Promise<void> {
    for (const vaultId of vaultIds) {
      if (this.index.modelOf(vaultId) !== null || this.index.isStale(vaultId, this.model)) {
        continue;
      }
      const json = await this.readIndexFile(vaultId);
      this.index.load(vaultId, this.model, json);
    }
  }

  private indexFile(vaultId: string): string {
    return path.join(this.deps.dataDir, 'semantic-index', `${vaultId}.json`);
  }

  private async readIndexFile(vaultId: string): Promise<string | null> {
    try {
      return await readFile(this.indexFile(vaultId), 'utf8');
    } catch {
      return null;
    }
  }

  private scheduleSave(vaultId: string): void {
    this.dirty.add(vaultId);
    const existing = this.saveTimers.get(vaultId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.saveTimers.set(
      vaultId,
      setTimeout(() => {
        this.saveTimers.delete(vaultId);
        void this.flush(vaultId);
      }, SAVE_DEBOUNCE_MS),
    );
  }

  private async flush(vaultId: string): Promise<void> {
    if (!this.dirty.has(vaultId)) {
      return;
    }
    const json = this.index.serialize(vaultId);
    if (json === null) {
      this.dirty.delete(vaultId);
      return;
    }
    const target = this.indexFile(vaultId);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      await writeFile(tmp, json, 'utf8');
      await rename(tmp, target);
      this.dirty.delete(vaultId);
    } catch (err) {
      this.deps.log(
        `semantic index persist failed: ${err instanceof Error ? err.message : String(err)}`,
        'warn',
      );
    }
  }

  private flushSync(vaultId: string): void {
    const json = this.index.serialize(vaultId);
    if (json === null) {
      this.dirty.delete(vaultId);
      return;
    }
    const target = this.indexFile(vaultId);
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, json, 'utf8');
      renameSync(tmp, target);
      this.dirty.delete(vaultId);
    } catch {
      // Quit-time best effort; the next catch-up rebuilds anything missed.
    }
  }

  private emitProgress(vaultId: string, progress: BuildProgress): void {
    this.deps.emit('semantic:progress', { vaultId, done: progress.done, total: progress.total });
  }

  private announce(): void {
    this.deps.emit('semantic:updated', {});
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, num));
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, num));
}

/** The wiring helper main/index.ts uses to build the service from a live ctx. */
export function createSemanticService(
  ctx: Pick<
    MainPluginContext,
    'vault' | 'config' | 'ipc' | 'log' | 'appConfig'
  >,
  options: { dataDir: string; workerPath: string; modelCacheDir: string },
): SemanticService {
  const vaults = async (): Promise<readonly { id: string; name: string; active: boolean }[]> => {
    const list = await ctx.vault.listVaults();
    return list.map((v) => ({ id: v.id, name: v.name, active: v.active === true }));
  };
  return new SemanticService({
    listVaults: vaults,
    readVaultText: (vaultId, filePath) =>
      ctx.vault
        .read(filePath, { vaultId })
        .then((content) => content)
        .catch(() => null),
    listMarkdownFiles: (vaultId) => ctx.vault.listMarkdownFiles({ vaultId }),
    getConfig: <T,>(key: string) => ctx.config.get<T>(key),
    emit: (event, data) => ctx.ipc.emit(event, data),
    log: (message, level) => ctx.log(message, level),
    dataDir: options.dataDir,
    workerPath: options.workerPath,
    modelCacheDir: options.modelCacheDir,
  });
}
