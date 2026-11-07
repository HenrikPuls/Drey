import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** A persona's picture on the boards: the silhouette on the persona's colour. */
@Component({
  selector: 'mc-ph-avatar',
  template: `<svg class="ava" role="img" [attr.aria-label]="name()" [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24">
    <rect width="24" height="24" [attr.fill]="color()" />
    <circle cx="12" cy="9.5" r="4.2" fill="var(--on-pastel)" fill-opacity="0.78" />
    <path d="M3.5 24c0-5 3.8-8 8.5-8s8.5 3 8.5 8z" fill="var(--on-pastel)" fill-opacity="0.78" />
  </svg>`,
  styleUrl: './avatar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhoneAvatar {
  readonly name = input('');
  readonly color = input('var(--text-2)');
  readonly size = input(24);
}
