/**
 * The Source control panel's state without any DOM: what main reported
 * per vault, which repository the panel shows, the command in flight and
 * the commit message drafts. Everything that draws subscribes here.
 */
import type { DreyPluginApi, OpenDocumentInfo } from '../../../shared/plugin-api/renderer';
import { decorationsFor, type GitLogEntry, type VaultGitState } from '../shared/status.js';
import { messageOf } from './dom.js';
import { okVaults, pickCurrentVault, unsavedSubject, type OkVault } from './repo-model.js';

export interface RepoState {
  vaults: VaultGitState[];
  names: Map<string, string>;
  /** The vault whose repository the panel shows. */
  current: string | null;
  /** The command in flight (`Pulling…`), or null. */
  busy: string | null;
  /** True while the running command can be cancelled (network). */
  cancellable: boolean;
  /** Commit message drafts, per vault. */
  drafts: Map<string, string>;
  historyOpen: boolean;
  /** Amend mode: the next commit rewrites the last one. */
  amend: boolean;
  log: GitLogEntry[];
}

export interface RepoSession {
  readonly state: RepoState;
  /** Calls `listener` after every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  notify(): void;
  okVaults(): OkVault[];
  currentState(): VaultGitState | null;
  /** The shown vault when it is a repository git can read. */
  currentOk(): OkVault | null;
  /** Shows another repository (the panel's select). */
  select(vaultId: string): void;
  applyStates(vaults: readonly VaultGitState[]): void;
  /**
   * Pulls the state: `cached` = what main already knows, `refresh` = run
   * git status again, `relocate` = also look again which vaults are
   * repositories (somebody may have run `git init` or moved a folder).
   */
  pull(mode: 'cached' | 'refresh' | 'relocate'): Promise<void>;
  loadLog(): Promise<void>;
  /** The vault's text tabs with unsaved changes. */
  dirtyDocs(vaultId: string): OpenDocumentInfo[];
  /** Runs one backend command with the busy line, the error dialog and the new state. */
  run(label: string, method: string, payload: Record<string, unknown>, cancellable?: boolean): Promise<boolean>;
  /** Refuses a command that rewrites files while the vault has unsaved tabs. */
  cleanTabsOrExplain(vaultId: string, what: string): Promise<boolean>;
  /** Follows main's pushes, the focused document, saves and the window focus; returns the undo. */
  watch(): () => void;
}

export function createRepoSession(api: DreyPluginApi): RepoSession {
  const state: RepoState = {
    vaults: [],
    names: new Map<string, string>(),
    current: null,
    busy: null,
    cancellable: false,
    drafts: new Map<string, string>(),
    historyOpen: false,
    amend: false,
    log: [],
  };
  /** Vault ids that had decorations last time, to clear the ones that lost them. */
  let decorated = new Set<string>();

  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const currentState = (): VaultGitState | null => state.vaults.find((v) => v.vaultId === state.current) ?? null;
  const currentOk = (): OkVault | null => {
    const found = currentState();
    return found !== null && found.state === 'ok' ? found : null;
  };

  /** Follows the focused document's vault when it is a repository. */
  const pickCurrent = (): void => {
    state.current = pickCurrentVault(state.vaults, state.current, api.documents.active()?.vaultId ?? null);
  };

  const applyStates = (vaults: readonly VaultGitState[]): void => {
    state.vaults = [...vaults];
    const now = new Set<string>();
    for (const vault of state.vaults) {
      if (vault.state === 'ok') {
        const decorations = decorationsFor(vault.status);
        api.ui.setFileDecorations(vault.vaultId, decorations);
        if (decorations.length > 0) {
          now.add(vault.vaultId);
        }
      }
    }
    for (const id of decorated) {
      if (!now.has(id)) {
        api.ui.setFileDecorations(id, null);
      }
    }
    decorated = now;
    pickCurrent();
    notify();
  };

  const loadNames = async (): Promise<void> => {
    const vaults = await api.vault.listVaults();
    state.names = new Map(vaults.map((v) => [v.id, v.name]));
  };

  const pull = async (mode: 'cached' | 'refresh' | 'relocate'): Promise<void> => {
    try {
      await loadNames();
      applyStates(
        (await api.backend.invoke('status', {
          refresh: mode !== 'cached',
          relocate: mode === 'relocate',
        })) as VaultGitState[],
      );
    } catch (error) {
      api.ui.showMessage(messageOf(error), 'Git').catch(() => undefined);
    }
  };

  const loadLog = async (): Promise<void> => {
    const vaultId = state.current;
    if (!state.historyOpen || vaultId === null || currentOk() === null) {
      state.log = [];
      notify();
      return;
    }
    try {
      const log = (await api.backend.invoke('log', { vaultId })) as GitLogEntry[];
      if (state.current === vaultId) {
        state.log = log;
        notify();
      }
    } catch {
      state.log = [];
      notify();
    }
  };

  const dirtyDocs = (vaultId: string): OpenDocumentInfo[] =>
    api.documents.list().filter((d) => d.vaultId === vaultId && d.kind === 'text' && d.dirty);

  const run = async (
    label: string,
    method: string,
    payload: Record<string, unknown>,
    cancellable = false,
  ): Promise<boolean> => {
    if (state.busy !== null) {
      return false;
    }
    state.busy = label;
    state.cancellable = cancellable;
    notify();
    try {
      const result = await api.backend.invoke(method, payload);
      if (Array.isArray(result)) {
        applyStates(result as VaultGitState[]);
      }
      return true;
    } catch (error) {
      const message = messageOf(error);
      if (message !== 'Cancelled.') {
        await api.ui.showMessage(message, 'Git');
      }
      return false;
    } finally {
      state.busy = null;
      state.cancellable = false;
      notify();
      void loadLog();
    }
  };

  const cleanTabsOrExplain = async (vaultId: string, what: string): Promise<boolean> => {
    const dirty = dirtyDocs(vaultId);
    if (dirty.length === 0) {
      return true;
    }
    await api.ui.showMessage(
      `${what} can rewrite files of this vault, and ${unsavedSubject(dirty)} unsaved changes. Save or close them first.`,
      'Unsaved changes',
    );
    return false;
  };

  const watch = (): (() => void) => {
    api.backend.on('status-updated', (data) => {
      if (Array.isArray(data)) {
        void loadNames().then(() => applyStates(data as VaultGitState[]));
      }
    });

    api.documents.onChange((event) => {
      if (event.type === 'active-changed') {
        const before = state.current;
        pickCurrent();
        if (state.current !== before) {
          notify();
          void loadLog();
        }
      } else if (event.type === 'dirty-changed' && !event.dirty) {
        // A save of any file kind (the note pipeline only reports notes).
        void pull('refresh');
      }
    });

    // Somebody may have committed, pulled or edited outside the app.
    const onFocus = (): void => void pull('relocate');
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  };

  return {
    state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify,
    okVaults: () => okVaults(state.vaults),
    currentState,
    currentOk,
    select: (vaultId) => {
      state.current = vaultId;
      notify();
      void loadLog();
    },
    applyStates,
    pull,
    loadLog,
    dirtyDocs,
    run,
    cleanTabsOrExplain,
    watch,
  };
}
