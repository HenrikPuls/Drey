import { Injectable, computed, signal } from '@angular/core';

/**
 * Scope of the bottom chat/search bar: just the active document, or the
 * whole vault. Per `specs/roadmap.md` the "this document" case feeds the
 * editor buffer straight into the prompt (no RAG); "all notes" is keyword
 * search now, semantic search in Phase 2.
 */
export type ChatScope = 'doc' | 'all';

/**
 * State for the sticky input bar. Milestone "visual shell" wires the field
 * and the scope toggle only -- `submit()` is intentionally inert until the
 * keyword-search / chat milestone gives it a backend. Kept as a service so
 * the query survives the component and the wiring later has one place to
 * land (CLAUDE.md, "no business logic inside components").
 */
@Injectable({ providedIn: 'root' })
export class ChatService {
  readonly query = signal('');
  readonly scope = signal<ChatScope>('doc');

  readonly canSubmit = computed(() => this.query().trim().length > 0);

  setQuery(value: string): void {
    this.query.set(value);
  }

  setScope(scope: ChatScope): void {
    this.scope.set(scope);
  }

  /** No-op until keyword search / chat is implemented (later Phase 1). */
  submit(): void {
    // Intentionally empty -- see class comment.
  }
}
