import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The shared frame every Settings category pane sits in: a title, an
 * optional one-line description, and the standard column layout for the
 * fields below. Panes wrap their content in
 * `<app-settings-pane [title]="…">` and only style what is genuinely
 * their own.
 *
 * The frame (`.pane-head`, `.pane`) and every form primitive
 * (`.switch-row`, `.field`, inputs, `section` / `h3`, `.field-hint`,
 * buttons, `.list`, `.card`, …) are styled by the one global Settings
 * stylesheet, `src/app/settings/settings-ui.css` — plugin pages get the
 * same frame from `PluginSettingsHost`, so both read alike.
 */
@Component({
  selector: 'app-settings-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: block' },
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
})
export class SettingsPane {
  readonly title = input.required<string>();
  readonly description = input<string>('');
}
