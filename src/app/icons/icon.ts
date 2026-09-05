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
  | 'settings'
  | 'window'
  | 'x'
  | 'check'
  | 'plus'
  | 'arrow-up';

const ICONS: Record<IconName, readonly IconShape[]> = {
  'chevron-right': [{ kind: 'path', d: 'm9 18 6-6-6-6' }],
  'chevron-left': [{ kind: 'path', d: 'm15 18-6-6 6-6' }],
  'chevron-down': [{ kind: 'path', d: 'm6 9 6 6 6-6' }],
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
