import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * The prototype draws every glyph as a hand-rolled inline SVG. Rather than
 * pull in `lucide-angular` (its 1.x line pins `@angular/core` to 13-21,
 * this project is on 22) or an icon font, the handful of icons the UI
 * actually needs are vendored here as [Lucide](https://lucide.dev) path
 * data on a 24x24 grid. `lucide-static` can later replace this map without
 * touching a single call site -- everything goes through `<app-icon>`.
 *
 * Shapes are described declaratively (no `innerHTML` / sanitizer bypass):
 * each icon is a list of path / circle primitives rendered with a
 * `currentColor` stroke, so colour and size come from CSS / the `size`
 * input.
 */
type IconShape =
  | { readonly kind: 'path'; readonly d: string }
  | { readonly kind: 'circle'; readonly cx: number; readonly cy: number; readonly r: number };

export type IconName =
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-down'
  | 'chevrons-down-up'
  | 'settings'
  | 'window'
  | 'x'
  | 'check'
  | 'plus'
  | 'arrow-up'
  | 'sparkles'
  | 'more-horizontal'
  | 'copy'
  | 'corner-down-left'
  | 'rotate-ccw'
  | 'refresh-cw'
  | 'folder'
  | 'list-ordered'
  | 'grip-vertical'
  | 'minus'
  | 'pencil'
  | 'globe'
  | 'square'
  | 'save'
  | 'pin';

const ICONS: Record<IconName, readonly IconShape[]> = {
  'chevron-right': [{ kind: 'path', d: 'm9 18 6-6-6-6' }],
  'chevron-left': [{ kind: 'path', d: 'm15 18-6-6 6-6' }],
  'chevron-down': [{ kind: 'path', d: 'm6 9 6 6 6-6' }],
  // Lucide "chevrons-down-up" -- the Files panel "collapse all folders" button.
  'chevrons-down-up': [
    { kind: 'path', d: 'm7 20 5-5 5 5' },
    { kind: 'path', d: 'm7 4 5 5 5-5' },
  ],
  settings: [
    {
      kind: 'path',
      d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
    },
    { kind: 'circle', cx: 12, cy: 12, r: 3 },
  ],
  window: [
    { kind: 'path', d: 'M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z' },
    { kind: 'path', d: 'M2 9h20' },
  ],
  x: [
    { kind: 'path', d: 'M18 6 6 18' },
    { kind: 'path', d: 'm6 6 12 12' },
  ],
  check: [{ kind: 'path', d: 'M20 6 9 17l-5-5' }],
  plus: [
    { kind: 'path', d: 'M5 12h14' },
    { kind: 'path', d: 'M12 5v14' },
  ],
  'arrow-up': [
    { kind: 'path', d: 'm5 12 7-7 7 7' },
    { kind: 'path', d: 'M12 19V5' },
  ],
  // Lucide "sparkles" -- the assistant / AI affordance.
  sparkles: [
    {
      kind: 'path',
      d: 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z',
    },
    { kind: 'path', d: 'M20 3v4' },
    { kind: 'path', d: 'M22 5h-4' },
  ],
  'more-horizontal': [
    { kind: 'circle', cx: 12, cy: 12, r: 1 },
    { kind: 'circle', cx: 19, cy: 12, r: 1 },
    { kind: 'circle', cx: 5, cy: 12, r: 1 },
  ],
  // Lucide "copy" -- the card's copy-to-clipboard action. The outer square
  // is Lucide's `<rect>` re-expressed as a rounded-rect path, since this
  // map only renders path / circle primitives.
  copy: [
    {
      kind: 'path',
      d: 'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z',
    },
    { kind: 'path', d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' },
  ],
  // Lucide "corner-down-left" -- "insert this card into the note".
  'corner-down-left': [
    { kind: 'path', d: 'M20 4v7a4 4 0 0 1-4 4H4' },
    { kind: 'path', d: 'm9 10-5 5 5 5' },
  ],
  // Lucide "rotate-ccw" -- "restart chat from here".
  'rotate-ccw': [
    { kind: 'path', d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' },
    { kind: 'path', d: 'M3 3v5h5' },
  ],
  // Lucide "refresh-cw" -- the "re-read the vault" button.
  'refresh-cw': [
    { kind: 'path', d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' },
    { kind: 'path', d: 'M21 3v5h-5' },
    { kind: 'path', d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' },
    { kind: 'path', d: 'M3 21v-5h5' },
  ],
  // Lucide "folder" -- the Files panel's vault switcher row.
  folder: [
    {
      kind: 'path',
      d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
    },
  ],
  // Lucide "list-ordered" -- the meta-bar line-numbers toggle.
  'list-ordered': [
    { kind: 'path', d: 'M10 12h11' },
    { kind: 'path', d: 'M10 18h11' },
    { kind: 'path', d: 'M10 6h11' },
    { kind: 'path', d: 'M4 10h2' },
    { kind: 'path', d: 'M4 6h1v4' },
    { kind: 'path', d: 'M6 18H4c0-1 2-2 2-3s-1-1.5-2-1' },
  ],
  // Lucide "grip-vertical" -- panel-header drag grip.
  'grip-vertical': [
    { kind: 'circle', cx: 9, cy: 12, r: 1 },
    { kind: 'circle', cx: 9, cy: 5, r: 1 },
    { kind: 'circle', cx: 9, cy: 19, r: 1 },
    { kind: 'circle', cx: 15, cy: 12, r: 1 },
    { kind: 'circle', cx: 15, cy: 5, r: 1 },
    { kind: 'circle', cx: 15, cy: 19, r: 1 },
  ],
  // Titlebar minimize.
  minus: [{ kind: 'path', d: 'M5 12h14' }],
  // Rename (matches the Live Preview widgets' edit affordance).
  pencil: [{ kind: 'path', d: 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' }],
  // Lucide "globe" -- the browser-tab fallback icon (no favicon yet).
  globe: [
    { kind: 'circle', cx: 12, cy: 12, r: 10 },
    { kind: 'path', d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' },
    { kind: 'path', d: 'M2 12h20' },
  ],
  // Titlebar maximize (an outline square).
  square: [
    {
      kind: 'path',
      d: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    },
  ],
  // Lucide "save" -- the meta-bar save button (a floppy disk).
  save: [
    {
      kind: 'path',
      d: 'M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
    },
    { kind: 'path', d: 'M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7' },
    { kind: 'path', d: 'M7 3v4a1 1 0 0 0 1 1h7' },
  ],
  // Lucide "pin" -- a pinned tab (never replaced by the next file opened).
  pin: [
    { kind: 'path', d: 'M12 17v5' },
    {
      kind: 'path',
      d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
    },
  ],
};

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      [attr.stroke-width]="strokeWidth()"
      stroke-linecap="round"
      stroke-linejoin="round"
      [attr.width]="size()"
      [attr.height]="size()"
      aria-hidden="true"
      focusable="false"
    >
      @for (shape of shapes(); track $index) {
        @if (shape.kind === 'path') {
          <svg:path [attr.d]="shape.d" />
        } @else {
          <svg:circle [attr.cx]="shape.cx" [attr.cy]="shape.cy" [attr.r]="shape.r" />
        }
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      line-height: 0;
    }
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input(16);
  readonly strokeWidth = input(1.75);

  protected readonly shapes = computed<readonly IconShape[]>(() => ICONS[this.name()]);
}
