import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type PhoneIconName =
  | 'plus' | 'search' | 'play' | 'pause' | 'stop' | 'doc' | 'ticket' | 'crew' | 'sliders' | 'chev'
  | 'contrast' | 'chat' | 'bell' | 'device' | 'book' | 'terminal' | 'more' | 'check' | 'mic' | 'send'
  | 'folder' | 'pencil' | 'x' | 'ask' | 'bold' | 'italic' | 'heading' | 'list' | 'checkbox' | 'link' | 'hash';

/**
 * The line icons the phone boards draw (10a–10t), one place for the paths.
 * Size and stroke come from the board: 22 at 1.75 unless the screen says
 * otherwise. The glyph takes `currentColor`.
 */
@Component({
  selector: 'mc-ph-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './icon.css',
  templateUrl: './icon.html',
})
export class PhoneIcon {
  readonly name = input.required<PhoneIconName>();
  readonly size = input(22);
  readonly stroke = input(1.75);
}
