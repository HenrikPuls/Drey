import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The shared frame every Settings category pane sits in: a title, an
 * optional one-line description, and the standard column layout for the
 * fields below. Panes used to each repeat this header markup and re-declare
 * the `.pane` container in their own stylesheet; now they wrap their
 * content in `<app-settings-pane [title]="…">` and only style what is
 * genuinely their own.
 *
 * The common form primitives (`.switch-row`, `.field`, `select`,
 * `fieldset`, `.field-hint`, `.ghost`, …) live in
 * `src/app/settings/settings-forms.css`, which each pane pulls in via
 * `styleUrls`.
 */
@Component({
  selector: 'app-settings-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="pane-head">
      <h2>{{ title() }}</h2>
      @if (description()) {
        <p class="pane-description">{{ description() }}</p>
      }
    </header>
    <div class="pane">
      <ng-content />
    </div>
  `,
  styleUrl: './settings-pane.css',
})
export class SettingsPane {
  readonly title = input.required<string>();
  readonly description = input<string>('');
}
