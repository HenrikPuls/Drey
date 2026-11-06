/**
 * The ticket document's editor extension (E13-6): `## Verification` drawn
 * as the proof widget, and the Cost table plus the action bar closing the
 * document. Built from the host's CodeMirror modules (`api.editor.cm`,
 * ADR-0044 rule 1) and registered through the generic
 * `editor.registerExtension` — the SDK knows nothing about tickets.
 *
 * The proof section is a block *replace* decoration over the section body
 * (the heading stays a real line): the widget shows while the caret is
 * outside, the raw Markdown shows the moment the selection touches it —
 * the Live Preview rule of tables and images. The tail is a block widget
 * after the last line, so the file text is never touched by either.
 */
import type { DreyPluginApi, EditorSurfaceContext } from '../../../../shared/plugin-api/renderer';
import type { BoardSnapshot, TicketCard } from '../../shared/tickets';
import type { WorkRow } from '../work-groups';
import { actionBarNode, costNode, proofNode, shapeMarksNode } from './dom';
import { actionBarOf, chainOf, costTableOfText, proofOfText, sectionBodyRange } from './model';
import { planHeadingEnd, type ShapeMarks } from './shape';
import { ticketIdOfPath } from '../ticket-header';

export interface TicketDocumentActions {
  accept(card: TicketCard): void;
  sendBack(card: TicketCard): void;
  openThread(card: TicketCard): void;
  /** Opens the ticket's Review tab (E13-7): the proof and the branch's diff. */
  openReview(card: TicketCard): void;
}

export interface TicketDocumentDeps {
  readonly api: DreyPluginApi;
  readonly snapshot: () => BoardSnapshot | null;
  /** The ticket's row in the work groups; null for a ticket outside them (archive, unknown phase). */
  readonly rowOf: (card: TicketCard) => WorkRow | null;
  /** The surface shows a ticket of the board's vault. */
  readonly matches: (context: EditorSurfaceContext) => boolean;
  readonly actions: TicketDocumentActions;
  /**
   * Shape (E13-9): the marks under the Plan heading. `want` tells the source
   * what the buffer says now (it decides whether to ask the engine); `marks`
   * answers from what it knows. Absent = no marks.
   */
  readonly shape?: {
    want(ticketId: string, text: string): void;
    marks(ticketId: string): ShapeMarks | null;
  };
}

export interface TicketDocumentExtension {
  readonly factory: (context: EditorSurfaceContext) => unknown;
  /** Draws every open ticket document again (the board or a run changed). */
  repaint(): void;
}

export function createTicketDocumentExtension(deps: TicketDocumentDeps): TicketDocumentExtension {
  const { StateField, StateEffect } = deps.api.editor.cm.state;
  const { Decoration, EditorView, ViewPlugin, WidgetType } = deps.api.editor.cm.view;
  const refresh = StateEffect.define<null>();
  const views = new Set<import('@codemirror/view').EditorView>();

  class BlockWidget extends WidgetType {
    constructor(
      private readonly key: string,
      private readonly render: () => HTMLElement,
    ) {
      super();
    }
    override eq(other: import('@codemirror/view').WidgetType): boolean {
      return other instanceof BlockWidget && other.key === this.key;
    }
    override toDOM(): HTMLElement {
      const host = document.createElement('div');
      host.className = 'tickets-doc-host';
      host.append(this.render());
      return host;
    }
    override ignoreEvent(): boolean {
      return true;
    }
  }

  const factory = (context: EditorSurfaceContext): unknown => {
    const cardOf = (path: string): TicketCard | null =>
      deps.snapshot()?.columns.flatMap((column) => column.tickets).find((ticket) => ticket.path === path) ?? null;

    const build = (state: import('@codemirror/state').EditorState): import('@codemirror/view').DecorationSet => {
      const snapshot = deps.snapshot();
      const path = context.path();
      if (snapshot === null || path === null || !deps.matches(context)) {
        return Decoration.none;
      }
      const text = state.doc.toString();
      const id = /^id:\s*['"]?(T-\d{4,})/m.exec(text)?.[1];
      // On a tab switch the text and the path arrive one after the other; the
      // path names the id in both store shapes (`T-nnnn.md`, `t-N/ticket.md` — D-23).
      if (id === undefined || ticketIdOfPath(path) !== id) {
        return Decoration.none;
      }
      const phaseTitle = (phase: string): string => snapshot.pipeline.find((p) => p.id === phase)?.title ?? phase;
      const vaultId = snapshot.vaultId;
      const ranges: import('@codemirror/state').Range<import('@codemirror/view').Decoration>[] = [];

      const proof = proofOfText(text);
      const body = proof === null ? null : sectionBodyRange(text, 'Verification');
      if (proof !== null && body !== null) {
        const touched = state.selection.ranges.some((range) => range.to >= body.from && range.from <= body.to);
        if (!touched) {
          ranges.push(
            Decoration.replace({
              block: true,
              widget: new BlockWidget(JSON.stringify([vaultId, proof]), () =>
                proofNode(
                  {
                    vaultId,
                    openFile: (file) => void deps.api.documents.open(file, undefined, vaultId === null ? undefined : { vaultId }),
                  },
                  proof,
                ),
              ),
            }).range(body.from, body.to),
          );
        }
      }

      if (deps.shape !== undefined) {
        deps.shape.want(id, text);
        const marks = deps.shape.marks(id);
        const headingEnd = marks === null ? null : planHeadingEnd(text);
        if (marks !== null && headingEnd !== null) {
          ranges.push(
            Decoration.widget({
              block: true,
              side: 1,
              widget: new BlockWidget(JSON.stringify(['shape', marks]), () => shapeMarksNode(marks)),
            }).range(headingEnd),
          );
        }
      }

      const card = cardOf(path);
      const row = card === null ? null : deps.rowOf(card);
      // The chain's phases still to run get their quiet `no run yet` row (req-98).
      const chain =
        card === null
          ? []
          : chainOf({ pipeline: snapshot.pipeline, currentPhaseId: card.phase, card, personas: [] }).map((step) => ({
              id: step.phase,
              title: step.title,
              checkpoint: step.checkpoint,
              skipped: step.skipped,
            }));
      const cost = costTableOfText(deps.api.i18n, text, phaseTitle, chain);
      const bar = actionBarOf(row, snapshot);
      const tail = new BlockWidget(JSON.stringify([id, cost, bar, card !== null]), () => {
        const root = document.createElement('div');
        root.className = 'tickets-doc-tail';
        if (cost !== null) {
          root.append(costNode(deps.api.i18n, cost));
        }
        if (card !== null) {
          root.append(
            actionBarNode(
              {
                icon: (name, size) => deps.api.ui.icon(name, size),
                decisionLinkText: deps.api.i18n.t('decision.waiting_go_to_card'),
                onThread: () => deps.actions.openThread(card),
                onReview: () => deps.actions.openReview(card),
              },
              bar,
            ),
          );
        }
        return root;
      });
      ranges.push(Decoration.widget({ block: true, side: 1, widget: tail }).range(state.doc.length));
      return Decoration.set(ranges, true);
    };

    const field = StateField.define<import('@codemirror/view').DecorationSet>({
      create: (state) => build(state),
      update: (value, transaction) =>
        transaction.docChanged || transaction.selection !== undefined || transaction.effects.some((effect) => effect.is(refresh))
          ? build(transaction.state)
          : value,
      provide: (self) => EditorView.decorations.from(self),
    });

    const watcher = ViewPlugin.define((view) => {
      views.add(view);
      let seen = `${context.vaultId() ?? ''}:${context.path() ?? ''}`;
      return {
        // The path can change without a document change (a tab switch).
        update: () => {
          const now = `${context.vaultId() ?? ''}:${context.path() ?? ''}`;
          if (now !== seen) {
            seen = now;
            queueMicrotask(() => view.dispatch({ effects: refresh.of(null) }));
          }
        },
        destroy: () => {
          views.delete(view);
        },
      };
    });
    return [field, watcher];
  };

  return {
    factory,
    repaint: () => {
      for (const view of [...views]) {
        if (view.dom.isConnected) {
          view.dispatch({ effects: refresh.of(null) });
        } else {
          views.delete(view);
        }
      }
    },
  };
}
