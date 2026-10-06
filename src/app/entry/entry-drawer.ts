import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  AfterViewInit,
  computed,
  effect,
  inject,
  viewChild,
  ElementRef,
} from '@angular/core';
import { MarkdownSurface } from '../editor/markdown-surface/markdown-surface';
import { WikilinkService } from '../editor/wikilinks';
import { TagField } from '../tags/tag-field';
import { TagVocabularyService } from '../tags/tag-vocabulary.service';
import { EntryDraftService } from './entry-draft.service';
import { EditorService } from '../services/editor.service';
import { EditorPrefsService } from '../editor/editor-prefs.service';
import { SpellcheckService } from '../services/spellcheck.service';
import { AutotagButton } from './autotag-button';
import { Icon } from '../icons/icon';

/**
 * The "Add entry" panel body: an optional TOPIC, a row of tag chips, then
 * the Markdown text. It replaced the old bottom chat bar's capture role,
 * and is now a dock panel (default home: the bottom dock) rather than a
 * fixed strip -- the `PanelFrame` chevron handles show/hide, so this
 * component no longer draws its own toggle.
 *
 * The text field is the shared `MarkdownSurface` with the inline
 * spellchecker mixed in -- one editor component everywhere (ADR-0009), one
 * squiggle implementation.
 */
@Component({
  selector: 'app-entry-drawer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MarkdownSurface, AutotagButton, Icon],
  templateUrl: './entry-drawer.html',
  styleUrl: './entry-drawer.css',
})
export class EntryDrawer implements AfterViewInit, OnDestroy {
  protected readonly drawer = inject(EntryDraftService);
  protected readonly editor = inject(EditorService);
  /** The drawer's formatting-toolbar toggle (own persisted value). */
  protected readonly prefs = inject(EditorPrefsService);
  private readonly spellcheck = inject(SpellcheckService);
  private readonly wikiLinks = inject(WikilinkService);
  private readonly tagVocab = inject(TagVocabularyService);
  private readonly surface = viewChild(MarkdownSurface);
  private readonly tagFieldHost = viewChild.required<ElementRef<HTMLDivElement>>('tagFieldHost');

  /** The shared tag chip field; the drawer owns one instance (milestone 33). */
  private tagField: TagField | null = null;

  /**
   * The source handed to the surface. Ungated: checking starts with the
   * first word typed, the same as any editor the user has ever used --
   * an earlier draft only checked "anchored" entries, which meant the
   * squiggles appeared late and looked broken.
   */
  protected readonly spellcheckSource = this.spellcheck.makeSource();

  /**
   * `Ctrl`/`Cmd`-click on a Markdown link in the capture body. The drawer
   * has no "current note" to resolve a relative path against, so only web /
   * mail targets act -- they open in the OS browser (Req-5); anything else
   * is left alone.
   */
  protected readonly activateLink = (href: string): void => {
    const raw = href.trim();
    if (/^(https?:|mailto:)/i.test(raw)) {
      void window.dreyApi.openExternal(raw);
    }
  };

  /**
   * A `Ctrl`/`Cmd`-click on a `[[wikilink]]` in the capture body: follows
   * an existing note (resolved vault-wide -- the drawer has no note of its
   * own) but never creates one; the text here may yet be discarded.
   */
  protected readonly activateWikilink = (target: string, anchor: string | null): void => {
    void this.wikiLinks.openResolvedOnly(target, anchor);
  };

  protected readonly canSubmit = computed<boolean>(
    () => this.drawer.hasContent() && !this.drawer.appending(),
  );

  /** "N words · N chars" for the footer, from the body text. */
  protected readonly bodyCount = computed<string>(() => {
    const text = this.drawer.text();
    const trimmed = text.trim();
    if (!trimmed) {
      return '';
    }
    return `${trimmed.split(/\s+/).length} words · ${text.length} chars`;
  });

  constructor() {
    // The checker only re-runs on a text change, so toggling spelling (or
    // switching dictionary) in Settings would otherwise leave the current
    // text judged by the old setting until the next keystroke.
    effect(() => {
      this.spellcheck.enabled();
      this.spellcheck.language();
      this.surface()?.recheckSpelling();
    });
    // Draft → field: auto-extracted / discarded chips repaint the field.
    // (`setValues` never fires `onChange`, so this cannot loop.)
    effect(() => {
      this.tagField?.setValues(this.drawer.tags());
    });
  }

  ngAfterViewInit(): void {
    const field = new TagField(this.tagVocab, {
      values: this.drawer.tags(),
      onChange: (values) => this.syncTagsFromField(values),
      placeholder: '+ tag',
      ariaLabel: 'Tags',
    });
    this.tagFieldHost().nativeElement.appendChild(field.element);
    this.tagField = field;
  }

  ngOnDestroy(): void {
    this.tagField?.dispose();
    this.tagField = null;
  }

  /**
   * Field → draft, as a delta through the draft service's add/remove so the
   * `manualTags` bookkeeping (chips surviving a text edit) stays intact.
   */
  private syncTagsFromField(next: string[]): void {
    const current = this.drawer.tags();
    const currentLower = new Set(current.map((t) => t.toLowerCase()));
    const nextLower = new Set(next);
    for (const tag of next) {
      if (!currentLower.has(tag)) {
        this.drawer.addChip(tag);
      }
    }
    for (const tag of current) {
      if (!nextLower.has(tag.toLowerCase())) {
        this.drawer.removeChip(tag);
      }
    }
  }

  protected async submit(): Promise<void> {
    if ((await this.drawer.submit()) === 'appended') {
      this.surface()?.setContent('');
    }
  }

  protected discard(): void {
    this.drawer.discard();
    this.surface()?.setContent('');
  }
}
