/**
 * The embedding worker (ADR-0055): one worker_threads entry that owns the
 * transformers.js WASM pipeline so the main process never blocks. This is
 * the ONLY module in the app that loads `@huggingface/transformers` —
 * unit tests and the host never touch it.
 *
 * Load order is load-bearing (the package statically requires
 * `onnxruntime-node`, whose stub is inert — ADR-0023 keeps "no native
 * modules"): the WASM runtime is injected via
 * `globalThis[Symbol.for('onnxruntime')]` BEFORE transformers resolves,
 * and the ORT glue (.mjs/.wasm) must load from real files — an asar path
 * is rewritten to its unpacked twin. Plain `require` calls keep the
 * ordering explicit under CommonJS.
 */
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

type Extractor = (
  texts: readonly string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

interface TransformersModule {
  pipeline(
    task: 'feature-extraction',
    model: string,
    options: { dtype: 'q8'; device: 'auto' },
  ): Promise<unknown>;
  env: {
    allowLocalModels: boolean;
    cacheDir?: string;
    backends: { onnx: { wasm?: { numThreads: number; wasmPaths?: string } } };
  };
}

interface WorkerData {
  model: string;
  cacheDir: string;
}

type EmbedRequest = { id: number; texts: string[] };
type EmbedSuccess = { id: number; vectors: number[][] };
type EmbedFailure = { id?: number; error: string };

const post = (message: EmbedSuccess | EmbedFailure): void => {
  parentPort?.postMessage(message);
};

void (async (): Promise<void> => {
  const ortWeb = require('onnxruntime-web') as { default?: unknown } | null;
  (globalThis as Record<symbol, unknown>)[Symbol.for('onnxruntime')] =
    (ortWeb as { default?: unknown } | null)?.default ?? ortWeb;

  const transformers = require('@huggingface/transformers') as TransformersModule;

  const data = workerData as Partial<WorkerData> | undefined;
  const model =
    typeof data?.model === 'string' && data.model !== ''
      ? data.model
      : 'Xenova/multilingual-e5-small';
  const cacheDir = typeof data?.cacheDir === 'string' ? data.cacheDir : undefined;

  // `…/app.asar/…` → `…/app.asar.unpacked/…` (the glue must be a real file).
  const unpacked = (value: string): string =>
    value.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

  const wasm = transformers.env.backends.onnx.wasm;
  if (wasm === undefined) {
    throw new Error('The ONNX WASM backend is unavailable.');
  }
  transformers.env.allowLocalModels = false;
  if (cacheDir !== undefined) {
    transformers.env.cacheDir = cacheDir;
  }
  wasm.numThreads = 1;
  const ortDir = unpacked(require.resolve('onnxruntime-web')).replace(/[\\/][^\\/]+$/, '');
  wasm.wasmPaths = pathToFileURL(`${ortDir}/`).href;

  const extractor = (await transformers.pipeline('feature-extraction', model, {
    dtype: 'q8',
    device: 'auto',
  })) as unknown as Extractor;

  parentPort?.on('message', (raw: unknown) => {
    const request = raw as Partial<EmbedRequest> | null;
    if (!request || typeof request.id !== 'number' || !Array.isArray(request.texts)) {
      return;
    }
    void extractor(request.texts, { pooling: 'mean', normalize: true }).then(
      (result) => {
        post({ id: request.id as number, vectors: result.tolist() });
      },
      (err: unknown) => {
        post({ id: request.id, error: err instanceof Error ? err.message : String(err) });
      },
    );
  });
})().catch((err: unknown) => {
  post({ error: err instanceof Error ? err.message : String(err) });
});
