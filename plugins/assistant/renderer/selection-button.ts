/**
 * The assistant button at a selection (milestone 74): a small icon button
 * that appears next to a non-empty selection in a document editor and
 * opens the selection popover (`selection-popover.ts`).
 *
 * Built from the host's CodeMirror modules (ADR-0044 rule 1). The button is
 * a CodeMirror tooltip, so the editor positions it and keeps it in view;
 * a small state field tracks the two things the selection alone does not
 * say — whether the mouse button is still down (no button mid-drag) and
 * whether the editor has focus.
 */
import type { EditorView } from '@codemirror/view';
import type { CodeMirrorModules } from '../../../shared/plugin-api/renderer';

export interface SelectionButtonDeps {
  /** False hides the button (setting off, LLM features disabled). */
  enabled(): boolean;
  /** A fresh glyph for the button. */
  icon(): Element;
  /** The button was clicked on `view`'s selection. */
  open(view: EditorView): void;
}

export interface SelectionButton {
  /** The extension for one editor surface. */
  extension(): unknown;
  /** The document editor that last had focus (still mounted), or null. */
  lastView(): EditorView | null;
}

interface Gate {
  readonly dragging: boolean;
  readonly focused: boolean;
}

export function createSelectionButton(
  cm: CodeMirrorModules,
  deps: SelectionButtonDeps,
): SelectionButton {
  const { StateEffect, StateField } = cm.state;
  const { EditorView: View, ViewPlugin, showTooltip } = cm.view;

  let last: EditorView | null = null;

  const setDragging = StateEffect.define<boolean>();
  const setFocused = StateEffect.define<boolean>();

  const gate = StateField.define<Gate>({
    create: () => ({ dragging: false, focused: false }),
    update(value, tr) {
      let next = value;
      for (const effect of tr.effects) {
        if (effect.is(setDragging)) {
          next = { ...next, dragging: effect.value };
        } else if (effect.is(setFocused)) {
          next = { ...next, focused: effect.value };
        }
      }
      return next;
    },
  });

  const buttonDom = (view: EditorView): HTMLElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-btn assistant-selection-btn';
    button.title = 'Ask the assistant about the selection';
    button.setAttribute('aria-label', 'Ask the assistant about the selection');
    button.appendChild(deps.icon());
    // Keep the editor's focus and selection: the press must not blur it.
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      deps.open(view);
    });
    const wrap = document.createElement('div');
    wrap.className = 'assistant-selection-tip';
    wrap.appendChild(button);
    return wrap;
  };

  const tooltip = showTooltip.compute([gate, 'selection'], (state) => {
    const { dragging, focused } = state.field(gate);
    const range = state.selection.main;
    if (dragging || !focused || range.empty || !deps.enabled()) {
      return null;
    }
    // Next to the moving end, on the side away from the selected text.
    return {
      pos: range.head,
      above: range.head < range.anchor,
      strictSide: false,
      arrow: false,
      create: (view: EditorView) => ({ dom: buttonDom(view) }),
    };
  });

  const tracker = ViewPlugin.define((view) => {
    const onUp = (): void => {
      document.removeEventListener('mouseup', onUp, true);
      if (view.state.field(gate, false)?.dragging === true) {
        view.dispatch({ effects: setDragging.of(false) });
      }
    };
    const onDown = (event: MouseEvent): void => {
      if (event.button !== 0 || (event.target as Element | null)?.closest('.cm-tooltip')) {
        return;
      }
      view.dispatch({ effects: setDragging.of(true) });
      document.addEventListener('mouseup', onUp, true);
    };
    view.dom.addEventListener('mousedown', onDown);
    if (view.hasFocus) {
      last = view;
    }
    return {
      update(update) {
        if (update.focusChanged && update.view.hasFocus) {
          last = update.view;
        }
      },
      destroy() {
        view.dom.removeEventListener('mousedown', onDown);
        document.removeEventListener('mouseup', onUp, true);
        if (last === view) {
          last = null;
        }
      },
    };
  });

  return {
    extension: () => [
      gate,
      tooltip,
      tracker,
      View.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
    ],
    lastView: () => last,
  };
}
