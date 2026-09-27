/**
 * Worker supervision for the embedding pipeline (ADR-0055): spawns the
 * embed worker lazily, queues one request at a time (the WASM session is
 * single-threaded anyway), and survives a model change (restart) or a
 * worker crash (respawn on the next request). All transformers/ONNX
 * specifics stay inside the worker file.
 */
import { Worker } from 'node:worker_threads';

export interface EmbedderOptions {
  /** Absolute path to the compiled `embed-worker.js`. */
  workerPath: string;
  model: string;
  cacheDir: string;
  /** Max texts per worker round (kept small — the worker is synchronous). */
  maxBatch?: number;
}

interface Pending {
  resolve: (vectors: Float32Array[]) => void;
  reject: (error: Error) => void;
}

export class SemanticEmbedder {
  private readonly workerPath: string;
  private readonly cacheDir: string;
  private readonly maxBatch: number;
  private _model: string;
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();

  constructor(options: EmbedderOptions) {
    this.workerPath = options.workerPath;
    this.cacheDir = options.cacheDir;
    this.maxBatch = options.maxBatch ?? 16;
    this._model = options.model;
  }

  get model(): string {
    return this._model;
  }

  /** Swaps the model; the next embed restarts the worker with it. */
  changeModel(model: string): void {
    if (model === this._model) {
      return;
    }
    this._model = model;
    this.kill();
  }

  /**
   * Embeds the texts (already prefixed). Longer lists are split into
   * sequential worker rounds. Rejects when the model cannot load — the
   * caller decides whether that fails the ask or degrades quietly.
   */
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.maxBatch) {
      const batch = texts.slice(i, i + this.maxBatch);
      out.push(...(await this.embedBatch(batch)));
    }
    return out;
  }

  dispose(): void {
    this.kill();
  }

  private kill(): void {
    this.failAll(new Error('The embedding worker was stopped.'));
    this.worker?.terminate();
    this.worker = null;
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    const worker = this.ensureWorker();
    const id = ++this.seq;
    return new Promise<Float32Array[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, texts: [...texts] });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker !== null) {
      return this.worker;
    }
    const model = this._model;
    const worker = new Worker(this.workerPath, {
      workerData: { model, cacheDir: this.cacheDir },
    });
    worker.on('message', (raw: unknown) => {
      const message = raw as { id?: number; vectors?: number[][]; error?: string } | null;
      if (message === null || typeof message !== 'object') {
        return;
      }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!pending) {
          return;
        }
        if (typeof message.error === 'string') {
          pending.reject(new Error(message.error));
        } else if (Array.isArray(message.vectors)) {
          pending.resolve(message.vectors.map((v) => Float32Array.from(v)));
        } else {
          pending.reject(new Error('Malformed embed result.'));
        }
        return;
      }
      // An id-less message is the worker's init failure (model load etc.).
      this.failAll(new Error(typeof message.error === 'string' ? message.error : 'The embedding worker failed to start.'));
      void worker.terminate();
      if (this.worker === worker) {
        this.worker = null;
      }
    });
    worker.on('error', (err) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)));
      if (this.worker === worker) {
        this.worker = null;
      }
    });
    worker.on('exit', (code) => {
      this.failAll(new Error(`The embedding worker exited (code ${code}).`));
      if (this.worker === worker) {
        this.worker = null;
      }
    });
    this.worker = worker;
    return worker;
  }
}
