/**
 * Summarize (milestone 37): the LLM digest of the current hits, streamed
 * into a scratch tab the user can keep with "Save as…".
 */
import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import {
  buildSearchSummaryMaterial,
  buildSearchSummarySources,
  formatSearchSummaryHeader,
} from '../shared/search.js';
import type { SearchSession } from './search-session.js';

/** The scratch tab the digest streams into (Save-as keeps it). */
const SUMMARY_TAB = 'search-summary.md';

interface SummaryTask {
  taskId: string;
  /** Document head (title, query, timestamp) — written before any digest text. */
  header: string;
  /** Accumulated digest text from the streamed deltas. */
  text: string;
  /** Appended on the final flush (cancelled / failed marker, truncation note). */
  tail: string;
  flushTimer: number | null;
}

/** Mirrors the main-side 'summarise' reply. */
type SummariseReply =
  | { kind: 'ok'; text: string; included: number; total: number }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

export interface SearchSummary {
  isRunning(): boolean;
  start(): void;
  /** Stops the running generation; the invoke settles as cancelled and the tab is finished. */
  cancel(): void;
}

/** `2026-09-20 18:42` — the summary header's generation stamp (local time). */
function timestampNow(): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function createSearchSummary(api: DreyPluginApi, session: SearchSession): SearchSummary {
  const { state } = session;
  let summaryTask: SummaryTask | null = null;

  const writeSummaryBuffer = (task: SummaryTask, tail: string): void => {
    api.documents.setBuffer(SUMMARY_TAB, task.header + task.text + tail);
  };

  /**
   * The `## Sources` link section for the sections the digest covered.
   * Vault names from the registry decorate the labels (links themselves
   * resolve wherever the note lives); on failure the labels fall back
   * to the raw vault ids.
   */
  const sourcesSection = async (included: number): Promise<string> => {
    const vaultNames: Record<string, string> = {};
    try {
      for (const vault of await api.vault.listVaults()) {
        vaultNames[vault.id] = vault.name;
      }
    } catch {
      // Labels only — keep going with raw ids.
    }
    return buildSearchSummarySources(state.hits, included, vaultNames);
  };

  const start = (): void => {
    if (summaryTask !== null || state.hits.length === 0) {
      return;
    }
    if (!api.llm.enabled()) {
      state.summaryError = 'Connect an LLM in Settings → LLM to summarize search results.';
      session.notify();
      return;
    }
    const count = state.hits.length;
    const task: SummaryTask = {
      taskId: crypto.randomUUID(),
      header: formatSearchSummaryHeader(session.currentQuery(), count, timestampNow()),
      text: '',
      tail: '',
      flushTimer: null,
    };
    summaryTask = task;
    state.summaryError = null;
    api.documents.openScratch(SUMMARY_TAB, `${task.header}_Generating…_`);
    session.notify();

    const flush = (): void => {
      if (task.flushTimer !== null) {
        window.clearTimeout(task.flushTimer);
        task.flushTimer = null;
      }
      writeSummaryBuffer(task, task.tail);
    };
    void (async () => {
      try {
        const reply = (await api.backend.invoke('summarise', {
          query: session.currentQuery(),
          hits: state.hits,
          taskId: task.taskId,
        })) as SummariseReply;
        if (reply.kind === 'ok') {
          // The return value is authoritative — a lost delta cannot truncate the digest.
          task.text = reply.text + (await sourcesSection(reply.included));
          if (reply.included < reply.total) {
            task.tail = `\n\n> Generated from ${reply.included} of ${reply.total} matching sections — the rest exceeded the content budget.`;
          }
        } else if (reply.kind === 'cancelled') {
          // The covered hits are known regardless of the abort — their links stay useful.
          task.text += await sourcesSection(
            buildSearchSummaryMaterial(session.currentQuery(), state.hits).included,
          );
          task.tail = '\n\n_(cancelled)_';
        } else {
          task.tail = `\n\n_(failed: ${reply.message})_`;
          state.summaryError = reply.message;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        task.tail = `\n\n_(failed: ${message})_`;
        state.summaryError = message;
      }
      flush();
      if (summaryTask === task) {
        summaryTask = null;
      }
      session.notify();
    })();
  };

  // Deltas arrive out-of-band (ADR-0014/0047): accumulate, flush the tab
  // throttled so the streaming stays visible without spamming undo steps.
  api.backend.on('summary:delta', (payload) => {
    const task = summaryTask;
    if (task === null) {
      return;
    }
    const data = (payload ?? {}) as { taskId?: unknown; text?: unknown };
    if (data.taskId !== task.taskId || typeof data.text !== 'string') {
      return;
    }
    task.text += data.text;
    if (task.flushTimer === null) {
      task.flushTimer = window.setTimeout(() => {
        task.flushTimer = null;
        if (summaryTask === task) {
          writeSummaryBuffer(task, '\n\n_Generating…_');
        }
      }, 150);
    }
  });

  return {
    isRunning: () => summaryTask !== null,
    start,
    cancel: () => {
      const task = summaryTask;
      if (task !== null) {
        void api.llm.cancelTask(task.taskId);
      }
    },
  };
}
