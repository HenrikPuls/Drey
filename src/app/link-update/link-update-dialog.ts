import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { OverlayGuardDirective } from '../services/overlay-guard.directive';
import { LinkUpdateChoice, LinkUpdateService } from './link-update.service';

/** One changed line of a note: what it read before and what it reads after. */
interface ChangedLine {
  line: number;
  before: string;
  after: string;
}

interface FileView {
  path: string;
  links: number;
  lines: ChangedLine[];
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The rename dialog (milestone 59, ADR-0059): which notes' links a rename
 * or move would rewrite -- one block per note, its changed lines before /
 * after -- and which attachments travel along. Three answers: update the
 * links, rename only, cancel; "Don't ask again" turns the first two into
 * the standing Settings -> Vault mode.
 *
 * A link rewrite never adds or removes a line, so the preview pairs lines
 * by number instead of running a diff. View-only; state and wiring live in
 * `LinkUpdateService`.
 */
@Component({
  selector: 'app-link-update-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OverlayGuardDirective],
  templateUrl: './link-update-dialog.html',
  styleUrl: './link-update-dialog.css',
  host: { '(document:keydown.escape)': 'choose("cancel")' },
})
export class LinkUpdateDialog {
  private readonly service = inject(LinkUpdateService);
  protected readonly pending = this.service.pending;

  protected readonly dontAskAgain = signal(false);

  protected readonly files = computed<FileView[]>(() =>
    (this.pending()?.preview.files ?? []).map((file) => {
      const before = file.before.split('\n');
      const after = file.after.split('\n');
      const lines: ChangedLine[] = [];
      for (let i = 0; i < Math.max(before.length, after.length); i++) {
        if (before[i] !== after[i]) {
          lines.push({ line: i + 1, before: before[i] ?? '', after: after[i] ?? '' });
        }
      }
      return { path: file.newPath, links: file.links, lines };
    }),
  );

  protected readonly summary = computed<string>(() => {
    const req = this.pending();
    if (!req) {
      return '';
    }
    const from = baseName(req.fromRel);
    const to = baseName(req.toRel);
    const what = from === to ? `Moving "${from}"` : `Renaming "${from}" to "${to}"`;
    const links = req.preview.files.reduce((sum, file) => sum + file.links, 0);
    const parts: string[] = [];
    if (links > 0) {
      parts.push(`changes ${plural(links, 'link')} in ${plural(req.preview.files.length, 'note')}`);
    }
    if (req.preview.assets.length > 0) {
      parts.push(`takes ${plural(req.preview.assets.length, 'attachment')} along`);
    }
    return `${what} ${parts.join(' and ')}.`;
  });

  protected linkCount(n: number): string {
    return plural(n, 'link');
  }

  protected choose(choice: LinkUpdateChoice): void {
    if (!this.pending()) {
      return;
    }
    this.service.answer(choice, choice !== 'cancel' && this.dontAskAgain());
    this.dontAskAgain.set(false);
  }
}
