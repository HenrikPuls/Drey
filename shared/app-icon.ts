import { CYBERPUNK_THEME } from './app-config';

/**
 * Which app mark goes with a theme (req-42). Most themes share the one
 * mark; a theme with its own art names it here. Main reads this for the
 * window / taskbar icon, the renderer for the titlebar and About mark --
 * one table, so the two can never show different marks.
 *
 * The exe, the installer and the shortcuts keep the default mark: those are
 * fixed when the app is packed.
 */
export type AppIconVariant = 'default' | 'cyberpunk';

export function appIconVariant(themeId: string): AppIconVariant {
  return themeId === CYBERPUNK_THEME ? 'cyberpunk' : 'default';
}

/** File stem of a variant's icon files (`icon.ico`, `icon-cyberpunk.png`, …). */
export function appIconStem(variant: AppIconVariant): string {
  return variant === 'default' ? 'icon' : `icon-${variant}`;
}
