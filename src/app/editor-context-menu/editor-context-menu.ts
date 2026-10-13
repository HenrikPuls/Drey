import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { EditorView } from '@codemirror/view';
import { MenuService } from '../titlebar';
import { EditorService } from '../services/editor.service';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { EditorContextMenuRegistry } from '../plugin-host';
import { EditorPrefsService } from '../editor/editor-prefs.service';
import { eraseFormatting } from '../editor/erase-formatting';
import { MarkdownSurface } from '../editor/markdown-surface/markdown-surface';
import { MarkdownToolbar } from '../editor/markdown-toolbar';
import { ToolbarAction } from '../editor/toolbar-commands';
import { caretLineText, dispatchToolbarAction } from '../editor/toolbar-dispatch';
import { EmojiPickerService } from '../emoji-picker/emoji-picker.service';
import { EditorContextMenuService } from './editor-context-menu.service';
import { formattingStripView } from './format-strip-target';

/**
 * The editor's right-click menu (ADR-0030), rendered at App level. On an
 * editable Markdown surface its head is the **formatting strip** (req-41)
 * -- the same icon bar the meta bar docks while pinned, acting on the
 * surface that was right-clicked. Below it the menu list: standard
 * clipboard rows -- routed through `MenuService.execEdit` with the view of
 * the clicked surface, so they act right there (like Ctrl+V would) instead
 * of on the last-focused pane editor -- then base rows and
 * plugin-contributed rows (ADR-0044).
 */
@Component({
  selector: 'app-editor-context-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverlayGuardDirective, MarkdownToolbar],
  templateUrl: './editor-context-menu.html',
  styleUrl: './editor-context-menu.css',
})
export class EditorContextMenu {
  protected readonly svc = inject(EditorContextMenuService);
  protected readonly menu = inject(MenuService);
  protected readonly editor = inject(EditorService);
  protected readonly prefs = inject(EditorPrefsService);
  private readonly emoji = inject(EmojiPickerService);
  private readonly contributions = inject(EditorContextMenuRegistry);

  /** Base rows (head group) and plugin rows (tail group), per menu open. */
  protected readonly baseItems = computed(() => this.group('head').filter((item) => item.run !== undefined));

  protected readonly pluginItems = computed(() => this.group('tail').filter((item) => item.run !== undefined));

  /** The view the strip formats; `null` = no strip on this surface. */
  protected readonly stripView = computed<EditorView | null>(() =>
    this.svc.anchor() === null
      ? null
      : formattingStripView(this.svc.menuTarget(), { isMarkdown: (p) => this.editor.isMarkdown(p) }),
  );

  /**
   * With the strip, the list is the strip's first menu (req-41): open
   * when the context menu opens, closed while another strip menu is --
   * one menu at a time, every one under its button. The strip owns the
   * state and reports it.
   */
  private readonly listOpen = signal(true);

  /** Without a strip (an image tab, a read-only view) the list is the whole menu. */
  protected readonly listShown = computed(() => this.stripView() === null || this.listOpen());

  /** A pane document was clicked -- the surfaces plugin buttons and image saves act on. */
  protected readonly onDocument = computed(() => {
    const target = this.svc.menuTarget();
    return target !== null && target.surface === 'editor' && target.docPath !== null;
  });

  /** "Image…" needs a surface that saves pictures into the vault. */
  protected readonly imagesEnabled = computed(() => {
    const view = this.stripView();
    return this.onDocument() && view !== null && MarkdownSurface.forView(view)?.imageCapture() === true;
  });

  /** The clicked view's caret line, for the paragraph menu's current mark. */
  protected readonly currentLine = (): string | null => {
    const view = this.stripView();
    return view === null ? null : caretLineText(view);
  };

  constructor() {
    // Every open starts with the list showing, whatever the last one left.
    effect(() => {
      if (this.svc.anchor() === null) {
        this.listOpen.set(true);
      }
    });
  }

  protected onListToggled(open: boolean): void {
    this.listOpen.set(open);
  }

  private group(kind: 'head' | 'tail'): readonly { label: string; disabled?: boolean; run(): void }[] {
    const target = this.svc.menuTarget();
    if (this.svc.anchor() === null || target === null) {
      return [];
    }
    const grouped = this.contributions.groupedItems(target);
    return kind === 'head' ? grouped.head : grouped.tail;
  }

  // Close the menu (and its full-screen backdrop) FIRST, then run the
  // action -- if the action throws, the backdrop must not be left covering
  // the app with a dead click handler. The clipboard rows and the strip
  // resolve the view of the clicked surface BEFORE closing (close() drops
  // the target), so they land on the right-clicked editor, not the
  // last-focused pane.
  protected cut(): void {
    const view = this.svc.resolveView();
    this.svc.close();
    this.menu.execEdit('cut', view);
  }

  protected copy(): void {
    const view = this.svc.resolveView();
    this.svc.close();
    this.menu.execEdit('copy', view);
  }

  protected paste(): void {
    const view = this.svc.resolveView();
    this.svc.close();
    this.menu.execEdit('paste', view);
  }

  protected selectAll(): void {
    const view = this.svc.resolveView();
    this.svc.close();
    this.menu.execEdit('selectAll', view);
  }

  protected applyAction(action: ToolbarAction): void {
    const view = this.stripView();
    this.svc.close();
    if (view !== null) {
      dispatchToolbarAction(view, action);
    }
  }

  protected clearFormatting(): void {
    const view = this.stripView();
    this.svc.close();
    if (view !== null) {
      eraseFormatting(view);
    }
  }

  protected pickEmoji(): void {
    const view = this.stripView();
    this.svc.close();
    if (view !== null) {
      const { from, to } = view.state.selection.main;
      this.emoji.open({ view, from, to });
    }
  }

  protected insertImages(files: File[]): void {
    const view = this.stripView();
    this.svc.close();
    if (view !== null) {
      void MarkdownSurface.forView(view)?.insertToolbarImages(files);
    }
  }

  protected runBaseItem(index: number): void {
    const item = this.baseItems()[index];
    this.svc.close();
    if (item?.run !== undefined && item.disabled !== true) {
      item.run();
    }
  }

  protected runPluginItem(index: number): void {
    const item = this.pluginItems()[index];
    this.svc.close();
    if (item?.run !== undefined && item.disabled !== true) {
      item.run();
    }
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.svc.close();
  }
}
