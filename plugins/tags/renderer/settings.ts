import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { TAG_NAME_SOURCE } from '../shared/tags.js';

/**
 * Settings → Tags (milestone 33): the tag prefix colors. One row per
 * configured prefix — a live chip preview, the prefix input, a swatch
 * strip (auto palette from the plugin backend — the renderer cannot import
 * shared values over plugin://), a free color picker and remove — plus an
 * add row. Saves immediately (ADR-0044 rule 3) into the plugin's own
 * config store, then pokes `colors-changed` so the main side pushes
 * `search:changed` and every pill/chip in the app recolors live.
 *
 * Prefix semantics (shared/tag-style.ts is the base-side resolver): a
 * prefix is a `/`-namespace, the longest configured one wins, lower-cased,
 * no `#`, no trailing `/`.
 */

interface PrefixRow {
  prefix: string;
  color: string;
}

const PREFIX_SOURCE = new RegExp(`^${TAG_NAME_SOURCE}(?:/${TAG_NAME_SOURCE})*$`, 'u');
const COLOR_SOURCE = /^#[0-9a-f]{6}$/i;

/** Mirrors the base-side `normalizeTagPrefix` (local twin — plugin://). */
function normalizePrefix(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase().replace(/^#/, '').replace(/\/+$/, '');
  if (cleaned === '' || !PREFIX_SOURCE.test(cleaned)) {
    return null;
  }
  return cleaned;
}

/** Mirrors the base-side `tagChipColors` (local twin — plugin://). */
function chipColors(color: string): { fg: string; bg: string } {
  return {
    fg: `color-mix(in srgb, ${color} 58%, #f2efe9)`,
    bg: `color-mix(in srgb, ${color} 15%, transparent)`,
  };
}

export function registerTagsSettingsPage(api: DreyPluginApi): void {
  void api.ui.registerSettingsPage({
    id: 'tags',
    label: 'Tags',
    hint: 'Tag prefix colors',
    mount(body: HTMLElement): () => void {
      body.classList.add('tags-settings');
      let palette: string[] = [];
      let rows: PrefixRow[] = [];
      const disposers: Array<() => void> = [];

      const list = el('div', 'tags-settings-list');
      const addRow = el('div', 'tags-settings-add');
      const hint = el('p', 'field-hint');
      hint.textContent =
        'A prefix colors every tag under it — "proj" colors #proj/alpha. The longest prefix wins; unconfigured tags keep their automatic color.';

      const chip = (tag: string, color: string): HTMLElement => {
        const node = el('span', 'tags-settings-chip', `#${tag}`);
        const { fg, bg } = chipColors(color);
        node.style.color = fg;
        node.style.backgroundColor = bg;
        return node;
      };

      const persist = async (): Promise<void> => {
        try {
          await api.settings.set('prefixColors', rows);
          await api.backend.invoke('colors-changed', {});
        } catch {
          // Config store unavailable — the UI keeps its local state.
        }
      };

      const render = (): void => {
        list.textContent = '';
        for (const row of rows) {
          const line = el('div', 'tags-settings-row');
          line.appendChild(chip(row.prefix || 'tag', row.color));

          const prefixInput = el('input', 'tags-settings-prefix') as HTMLInputElement;
          prefixInput.type = 'text';
          prefixInput.value = row.prefix;
          prefixInput.placeholder = 'prefix';
          prefixInput.setAttribute('aria-label', 'Tag prefix');
          const commitPrefix = (): boolean => {
            const normalized = normalizePrefix(prefixInput.value);
            if (normalized === null || rows.some((r) => r !== row && r.prefix === normalized)) {
              prefixInput.classList.add('invalid');
              return false;
            }
            prefixInput.classList.remove('invalid');
            row.prefix = normalized;
            prefixInput.value = normalized;
            return true;
          };
          prefixInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              if (commitPrefix()) {
                void persist();
                render();
              }
            }
          });
          prefixInput.addEventListener('change', () => {
            if (commitPrefix()) {
              void persist();
              render();
            }
          });
          line.appendChild(prefixInput);

          const swatches = el('span', 'tags-settings-swatches');
          for (const color of palette) {
            const swatch = el('button', 'tags-settings-swatch') as HTMLButtonElement;
            swatch.type = 'button';
            swatch.style.backgroundColor = color;
            swatch.title = color;
            swatch.setAttribute('aria-label', `Use ${color}`);
            if (color === row.color) {
              swatch.classList.add('on');
            }
            swatch.addEventListener('click', () => {
              row.color = color;
              colorInput.value = color;
              void persist();
              render();
            });
            swatches.appendChild(swatch);
          }
          line.appendChild(swatches);

          const colorInput = el('input', 'tags-settings-color') as HTMLInputElement;
          colorInput.type = 'color';
          colorInput.value = row.color;
          colorInput.setAttribute('aria-label', 'Custom color');
          colorInput.addEventListener('input', () => {
            if (!COLOR_SOURCE.test(colorInput.value)) {
              return;
            }
            row.color = colorInput.value.toLowerCase();
            void persist();
            render();
          });
          line.appendChild(colorInput);

          line.appendChild(
            el('button', 'link-danger', 'Remove') as HTMLButtonElement,
          );
          (line.lastChild as HTMLButtonElement).type = 'button';
          (line.lastChild as HTMLButtonElement).addEventListener('click', () => {
            rows = rows.filter((r) => r !== row);
            void persist();
            render();
          });

          list.appendChild(line);
        }
        if (rows.length === 0) {
          list.appendChild(
            el('p', 'empty', 'No prefixes configured — every tag uses its automatic color.'),
          );
        }
      };

      const addPrefix = (): void => {
        rows = [...rows, { prefix: '', color: palette[0] ?? '#c96442' }];
        render();
        const first = list.querySelector<HTMLInputElement>('.tags-settings-prefix');
        first?.focus();
      };

      const addButton = el('button', 'ghost', '+ Add prefix') as HTMLButtonElement;
      addButton.type = 'button';
      addButton.addEventListener('click', addPrefix);
      disposers.push(() => addButton.removeEventListener('click', addPrefix));
      addRow.appendChild(addButton);

      body.append(hint, list, addRow);

      void (async () => {
        try {
          const stored = await api.settings.get<PrefixRow[]>('prefixColors');
          if (Array.isArray(stored)) {
            rows = stored.filter(
              (r): r is PrefixRow =>
                typeof r?.prefix === 'string' && typeof r?.color === 'string',
            );
          }
          const p = (await api.backend.invoke('palette', {})) as { auto?: string[] };
          palette = Array.isArray(p?.auto) ? p.auto : [];
        } catch {
          palette = [];
        }
        render();
      })();

      return () => {
        for (const dispose of disposers) {
          dispose();
        }
      };
    },
  });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}
