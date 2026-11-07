/**
 * The ticket document's editor extension (E13-6; boards 9a, 7b, 7c, 7j): the
 * page's type and width per state, `## Verification` as the proof, `## Verlauf`
 * as the cost by phase, `### Parts` as the Parts block, the per-line plan marks
 * and the Log's head. Built from the host's CodeMirror modules (`api.editor.cm`,
 * ADR-0044 rule 1) and registered through the generic `editor.registerExtension`
 * — the SDK knows nothing about tickets.
 *
 * A widget standing in for a section is a block *replace* decoration over the
 * whole section: it shows while the caret is outside, the raw Markdown shows the
 * moment the selection touches it — the Live Preview rule of tables and images.
 * The file text is never touched. Source mode shows it all raw, nothing is decorated.
 */
import type { DreyPluginApi, EditorSurfaceContext } from '../../../../shared/plugin-api/renderer';
import type { BoardSnapshot, TicketCard } from '../../shared/tickets';
import { maskFenceLines } from '../../../../shared/markdown/fences';
import { ideaPhaseIds, type WorkRow } from '../work-groups';
import { costNode, proofNode, shapeMarksNode } from './dom';
import { actionBarOf, chainOf, costTableOfText, pageShapeOf, proofOfText, sectionRange, type PageShape, type TextRange } from './model';
import { partsNode, createPartsStore } from './parts';
import { partsRange } from './parts-model';
import { markGroupsOf, type ShapeMarks } from './shape';
import { planHeadingEnd } from './shape';
import { cardOfDocument, logSectionRange, ticketIdOfPath, ticketIdOfText } from '../ticket-header';

export interface TicketDocumentActions {
  openThread(card: TicketCard): void;
}

export interface TicketDocumentDeps {
  readonly api: DreyPluginApi;
  readonly snapshot: () => BoardSnapshot | null;
  /** The ticket's row in the work groups; null for a ticket outside them (archive, unknown phase). */
  readonly rowOf: (card: TicketCard) => WorkRow | null;
  /** The surface shows a ticket of the board's vault. */
  readonly matches: (context: EditorSurfaceContext) => boolean;
  readonly actions: TicketDocumentActions;
  readonly invoke: (method: string, payload?: unknown) => Promise<unknown>;
  /** Opens the Flow tab, of the ticket or of one part (E13-11). */
  readonly openFlow: (card: TicketCard, part: number | null) => void;
  /**
   * Shape (E13-9): the marks in the plan. `want` tells the source what the
   * buffer says now (it decides whether to ask the engine); `marks` answers
   * from what it knows. Absent = no marks.
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

/** The surface's class per page shape: the CSS keeps the type and the width of the two boards. */
const shapeClass = (shape: PageShape): string => `tickets-doc-editor is-${shape}`;

const inside = (ranges: readonly TextRange[], from: number, to: number): boolean => ranges.some((range) => from >= range.from && to <= range.to);

export function createTicketDocumentExtension(deps: TicketDocumentDeps): TicketDocumentExtension {
  const { StateField, StateEffect } = deps.api.editor.cm.state;
  const { Decoration, EditorView, ViewPlugin, WidgetType } = deps.api.editor.cm.view;
  const { foldEffect, unfoldEffect, foldedRanges } = deps.api.editor.cm.language;
  const refresh = StateEffect.define<null>();
  const setRaw = StateEffect.define<boolean>();
  const views = new Set<import('@codemirror/view').EditorView>();
  const repaint = (): void => {
    for (const view of [...views]) {
      if (view.dom.isConnected) {
        view.dispatch({ effects: refresh.of(null) });
      } else {
        views.delete(view);
      }
    }
  };
  const parts = createPartsStore({ i18n: deps.api.i18n, invoke: deps.invoke, changed: () => repaint() });

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

  /** The Log heading's chevron: folds and unfolds the section. */
  class LogChevron extends WidgetType {
    constructor(
      private readonly folded: boolean,
      private readonly range: TextRange,
    ) {
      super();
    }
    override eq(other: import('@codemirror/view').WidgetType): boolean {
      return other instanceof LogChevron && other.folded === this.folded && other.range.from === this.range.from && other.range.to === this.range.to;
    }
    override toDOM(view: import('@codemirror/view').EditorView): HTMLElement {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tickets-doc-log-chevron';
      button.title = deps.api.i18n.t('ticket.log.toggle');
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-expanded', String(!this.folded));
      button.append(deps.api.ui.icon(this.folded ? 'chevron-right' : 'chevron-down', 16));
      button.addEventListener('click', () => {
        const effect = this.folded ? unfoldEffect.of(this.range) : foldEffect.of(this.range);
        view.dispatch({ effects: effect });
      });
      return button;
    }
    override ignoreEvent(): boolean {
      return true;
    }
  }

  class LogCount extends WidgetType {
    constructor(private readonly words: string) {
      super();
    }
    override eq(other: import('@codemirror/view').WidgetType): boolean {
      return other instanceof LogCount && other.words === this.words;
    }
    override toDOM(): HTMLElement {
      const node = document.createElement('span');
      node.className = 'tickets-doc-log-count';
      node.textContent = this.words;
      return node;
    }
  }

  const factory = (context: EditorSurfaceContext): unknown => {
    const rawField = StateField.define<boolean>({
      create: () => false,
      update: (value, transaction) => transaction.effects.find((effect) => effect.is(setRaw))?.value ?? value,
    });

    /** The ticket this surface shows now and its page shape; null off a ticket. */
    const ticketOf = (text: string): { id: string; snapshot: BoardSnapshot; path: string; card: TicketCard | null; shape: PageShape } | null => {
      const snapshot = deps.snapshot();
      const path = context.path();
      if (snapshot === null || path === null || !deps.matches(context)) {
        return null;
      }
      const id = ticketIdOfText(text);
      // On a tab switch the text and the path arrive one after the other; the
      // path names the id in both store shapes (`T-nnnn.md`, `t-N/ticket.md` — D-23).
      if (id === undefined || ticketIdOfPath(path) !== id) {
        return null;
      }
      const card = cardOfDocument(snapshot, path);
      return { id, snapshot, path, card, shape: pageShapeOf(card?.phase ?? null, snapshot.pipeline) };
    };

    const build = (state: import('@codemirror/state').EditorState): import('@codemirror/view').DecorationSet => {
      if (state.field(rawField)) {
        return Decoration.none;
      }
      const text = state.doc.toString();
      const ticket = ticketOf(text);
      if (ticket === null) {
        return Decoration.none;
      }
      const { id, snapshot, card, shape } = ticket;
      const phaseTitle = (phase: string): string => snapshot.pipeline.find((p) => p.id === phase)?.title ?? phase;
      const vaultId = snapshot.vaultId;
      const ranges: import('@codemirror/state').Range<import('@codemirror/view').Decoration>[] = [];
      const replaced: TextRange[] = [];
      const touched = (range: TextRange): boolean => state.selection.ranges.some((sel) => sel.to >= range.from && sel.from <= range.to);
      const stand = (range: TextRange | null, key: string, render: () => HTMLElement): void => {
        if (range === null) {
          return;
        }
        replaced.push(range);
        if (!touched(range)) {
          ranges.push(Decoration.replace({ block: true, widget: new BlockWidget(key, render) }).range(range.from, range.to));
        }
      };

      const proof = proofOfText(deps.api.i18n, text);
      if (proof !== null) {
        stand(sectionRange(text, 'Verification'), JSON.stringify(['proof', vaultId, proof]), () =>
          proofNode(
            {
              i18n: deps.api.i18n,
              vaultId,
              openFile: (file) => void deps.api.documents.open(file, undefined, vaultId === null ? undefined : { vaultId }),
            },
            proof,
          ),
        );
      }

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
      // The cost by phase starts with the work (7j); before it (9a, 7b, 7c) the card says the cost.
      const cost = costTableOfText(deps.api.i18n, text, phaseTitle, chain);
      if (cost !== null) {
        const planning = card === null || ideaPhaseIds(snapshot.pipeline).includes(card.phase);
        stand(sectionRange(text, 'Verlauf'), JSON.stringify(['cost', planning, cost]), () => (planning ? document.createElement('div') : costNode(deps.api.i18n, cost)));
      }

      const partsAt = partsRange(text);
      if (partsAt !== null && card !== null) {
        const chapter = text.slice(partsAt.from, partsAt.to);
        parts.want(id, chapter);
        const view = parts.view(id);
        if (view !== null && view.parts.length > 0) {
          const row = deps.rowOf(card);
          const decide = actionBarOf(row, snapshot).decide || card.phase === 'shaping';
          stand(partsAt, JSON.stringify(['parts', view, decide, chain]), () =>
            partsNode(
              {
                i18n: deps.api.i18n,
                icon: (name, size) => deps.api.ui.icon(name, size),
                decide,
                flowSteps: chain.filter((step) => !step.checkpoint && !step.skipped).map((step) => step.title),
                edit: (edit) => {
                  void parts.edit(id, edit).then((refused) => {
                    if (refused !== null) {
                      void deps.api.ui.showMessage(refused, 'Tickets');
                    }
                  });
                },
                onFlow: (part) => deps.openFlow(card, part),
                onAsk: () => deps.actions.openThread(card),
              },
              view,
            ),
          );
        }
      }

      // --- the lines: headings, blank lines, plan marks ------------------------

      const lines = text.split('\n');
      const scan = maskFenceLines(lines);
      const frontmatterEnd = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(text)?.[0].length ?? 0;
      const planEnd = planHeadingEnd(text);
      const planHasChapters = planEnd !== null && /^###\s/m.test((/^[\s\S]*?(?=^#{1,2}\s)/m.exec(text.slice(planEnd + 1))?.[0]) ?? text.slice(planEnd + 1));
      const caretLines = new Set(state.selection.ranges.flatMap((sel) => {
        const out: number[] = [];
        for (let n = state.doc.lineAt(sel.from).number; n <= state.doc.lineAt(sel.to).number; n++) {
          out.push(n);
        }
        return out;
      }));
      const logRange = logSectionRange(text);
      let offset = 0;
      let inPlan = false;
      const lineClass = (from: number, cls: string): void => {
        ranges.push(Decoration.line({ class: cls }).range(from));
      };
      for (const [index, raw] of lines.entries()) {
        const from = offset;
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        const probe = scan[index]!.endsWith('\r') ? scan[index]!.slice(0, -1) : scan[index]!;
        offset += raw.length + 1;
        if (from < frontmatterEnd || inside(replaced, from, from + line.length) && !touched({ from, to: from + line.length })) {
          continue;
        }
        const level = /^(#{1,6})\s/.exec(probe)?.[1]?.length ?? 0;
        if (level >= 1 && level <= 2) {
          inPlan = from + line.length === planEnd;
        }
        if (level === 1) {
          lineClass(from, 'tickets-doc-h1');
        } else if (level === 2) {
          if (from + line.length === planEnd && planHasChapters && shape === 'flow') {
            // "The plan is the ticket" (7b, 7c): its chapters stand for themselves.
            if (!caretLines.has(index + 1)) {
              lineClass(from, 'tickets-doc-collapsed');
            }
          } else {
            lineClass(from, 'tickets-doc-h2');
          }
        } else if (level === 3 && inPlan && shape === 'flow') {
          lineClass(from, 'tickets-doc-h2');
        } else if (line.trim() === '' && !caretLines.has(index + 1)) {
          const before = (scan[index - 1] ?? '').trim();
          const after = (scan[index + 1] ?? '').trim();
          const between = before !== '' && after !== '' && !before.startsWith('#') && !after.startsWith('#') && from > frontmatterEnd;
          lineClass(from, between ? 'tickets-doc-gap' : 'tickets-doc-collapsed');
        }
      }

      // The plan's marks (E13-9, board 7b): a bar down the lines, the note under them.
      if (deps.shape !== undefined) {
        deps.shape.want(id, text);
        const marks = deps.shape.marks(id);
        if (marks !== null) {
          const groups = markGroupsOf(text, marks);
          for (const group of groups) {
            for (const from of group.lines) {
              lineClass(from, `tickets-doc-marked is-${group.by}`);
            }
            const stands = replaced.find((range) => group.end >= range.from && group.end <= range.to && !touched(range));
            const noteAt = stands?.to ?? group.end;
            const note = group.by === 'you' ? { paul: null, you: marks.you, youDetail: marks.youDetail } : { paul: marks.paul, you: null, youDetail: null };
            ranges.push(
              Decoration.widget({
                block: true,
                side: 1,
                widget: new BlockWidget(JSON.stringify(['shape', note]), () => shapeMarksNode(note)),
              }).range(noteAt),
            );
          }
          const headingEnd = planEnd;
          if (groups.length === 0 && headingEnd !== null) {
            ranges.push(
              Decoration.widget({
                block: true,
                side: 1,
                widget: new BlockWidget(JSON.stringify(['shape', marks.paul, marks.you, marks.youDetail]), () => shapeMarksNode(marks)),
              }).range(headingEnd),
            );
          }
        }
      }

      // The Log's head (board 9a): chevron, the word, how many entries lie folded.
      if (logRange !== null) {
        const headEnd = logRange.from;
        const headStart = state.doc.lineAt(headEnd).from;
        let folded = false;
        foldedRanges(state).between(logRange.from, logRange.to, () => {
          folded = true;
        });
        const entries = text.slice(logRange.from, logRange.to).split('\n').filter((entry) => /^\s*-\s/.test(entry)).length;
        lineClass(headStart, 'tickets-doc-log');
        ranges.push(Decoration.widget({ side: -1, widget: new LogChevron(folded, logRange) }).range(headStart));
        ranges.push(Decoration.widget({ side: 1, widget: new LogCount(deps.api.i18n.t('ticket.log.entries', { n: entries })) }).range(headEnd));
      }

      return Decoration.set(ranges, true);
    };

    const field = StateField.define<import('@codemirror/view').DecorationSet>({
      create: (state) => build(state),
      update: (value, transaction) =>
        transaction.docChanged ||
        transaction.selection !== undefined ||
        transaction.effects.some((effect) => effect.is(refresh) || effect.is(setRaw) || effect.is(foldEffect) || effect.is(unfoldEffect))
          ? build(transaction.state)
          : value,
      provide: (self) => EditorView.decorations.from(self),
    });

    const attributes = EditorView.editorAttributes.of((view) => {
      if (view.state.field(rawField)) {
        return null;
      }
      const ticket = ticketOf(view.state.doc.toString());
      return ticket === null ? null : { class: shapeClass(ticket.shape) };
    });

    const watcher = ViewPlugin.define((view) => {
      views.add(view);
      let seen = `${context.vaultId() ?? ''}:${context.path() ?? ''}`;
      /**
       * Source mode: the SDK does not tell a surface its view mode (named in the report
       * of wave 4.3, roadmap), so the pane's own toggle is read.
       */
      const checkRaw = (): void => {
        view.requestMeasure({
          read: () => view.dom.closest('app-editor')?.querySelector('button.source')?.getAttribute('aria-pressed') === 'true',
          write: (raw) => {
            if (raw !== view.state.field(rawField)) {
              queueMicrotask(() => view.dispatch({ effects: setRaw.of(raw) }));
            }
          },
        });
      };
      checkRaw();
      return {
        // The path can change without a document change (a tab switch).
        update: () => {
          const now = `${context.vaultId() ?? ''}:${context.path() ?? ''}`;
          if (now !== seen) {
            seen = now;
            queueMicrotask(() => view.dispatch({ effects: refresh.of(null) }));
          }
          checkRaw();
        },
        destroy: () => {
          views.delete(view);
        },
      };
    });
    return [rawField, field, attributes, watcher];
  };

  return { factory, repaint };
}
