import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { McI18nPipe } from '../i18n/i18n.pipe';

/** The three areas of the iPad header's switch (canvas decision 12). */
export type ShellArea = 'notes' | 'work' | 'crew';

/**
 * The iPad header (req-96, boards 10e / 10s / 10b): one 52 px row with the
 * left-sidebar toggle at the far left, the segmented Notes · Work · Crew
 * switch centred, and at the right the Autopilot chip slot (req-95b fills
 * it through `[autopilot]`), the Settings control and the right-sidebar
 * toggle. The toggles carry `aria-pressed`; every control is 44 px. The
 * Notes segment is rendered only while `notesEnabled` says so — hidden
 * behind the feature flag until req-101 ships the Notes client.
 */
@Component({
  selector: 'mc-shell-header',
  imports: [McI18nPipe],
  templateUrl: './header.html',
  styleUrl: './header.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShellHeader {
  readonly area = input.required<ShellArea>();
  readonly notesEnabled = input(false);
  readonly left = input.required<boolean>();
  readonly right = input.required<boolean>();
  /** Settings owns the centre. */
  readonly settingsOn = input(false);
  /** Work's "Needs you" count; 0 hides the badge. */
  readonly needsCount = input(0);

  readonly toggleLeft = output<void>();
  readonly toggleRight = output<void>();
  readonly areaChange = output<ShellArea>();
  readonly settings = output<void>();
}
