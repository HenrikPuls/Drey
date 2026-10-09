import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import { TAG_NAME_SOURCE } from '../shared/tags.js';
import { normalizeTagName } from '../shared/rename.js';

/**
 * Settings → Tags: the tag prefix colors (milestone 33) and the tag list
 * with rename / merge (milestone 53). The list merges every vault's
 * vocabulary (from the plugin backend — the renderer cannot import shared
 * values over plugin://); "Rename…" opens a modal over the same
 * preview/apply backend the Search panel's vault replace uses (TOCTOU
 * re-read before every write, one bundled per-file-diff confirmation,
 * nested `#tag/…` descendants along by default, duplicates a merge would
 * create are dropped). Saves immediately (ADR-0044 rule 3).
 */

interface PrefixRow {
  prefix: string;
  color: string;
}

/** `tag-list` reply (defensively re-shaped). */
interface TagListReply {
  vaults: Array<{ id: string; name: string; active?: boolean }>;
  tags: Record<string, Array<{ tag: string; count: number }>>;
}

/** One merged vocabulary row: total count plus the per-vault counts. */
interface TagRow {
  tag: string;
  count: number;
  perVault: Map<string, number>;
}

interface RenameOp {
  vaultId: string;
  path: string;
  occurrences: number;
  diff: Array<{ type: 'add' | 'del' | 'context'; text: string }>;
}

const PREFIX_SOURCE = new RegExp(`^${TAG_NAME_SOURCE}(?:/${TAG_NAME_SOURCE})*$`, 'u');

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

/** Mirrors the base-side `resolveTagStyle` auto branch (local twin). */
function autoColor(tag: string, palette: readonly string[]): string {
  let h = 5381;
  for (const ch of tag.split('/', 1)[0] || tag) {
    h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  }
  return palette[h % palette.length] ?? '#c96442';
}

function resolveColor(tag: string, prefixes: readonly PrefixRow[], palette: readonly string[]): string {
  let best: PrefixRow | null = null;
  for (const p of prefixes) {
    if ((tag === p.prefix || tag.startsWith(`${p.prefix}/`)) && (best === null || p.prefix.length > best.prefix.length)) {
      best = p;
    }
  }
  return best !== null ? best.color : autoColor(tag, palette);
}

export function registerTagsSettingsPage(api: DreyPluginApi): void {
  void api.ui.registerSettingsPage({
    id: 'tags',
    label: 'Tags',
    hint: 'Tag colors, rename and merge',
    mount(body: HTMLElement): () => void {
      body.classList.add('tags-settings');
      let palette: string[] = [];
      let rows: PrefixRow[] = [];
      const disposers: Array<() => void> = [];

      // ---- Tag list: rename / merge (milestone 53) --------------------------

      let tagRows: TagRow[] = [];
      let vaults: TagListReply['vaults'] = [];
      let filter = '';

      const managerHint = el('p', 'section-hint');
      managerHint.textContent =
        'Rename or merge a tag across one or more vaults. Nested tags (#tag/…) come along by default; a merge drops the duplicates it would create.';
      const filterField = el('input', 'tags-settings-filter') as HTMLInputElement;
      filterField.type = 'text';
      filterField.setAttribute('aria-label', 'Filter tags');
      const tagList = el('div', 'tags-settings-tags');
      const tagStatus = el('p', 'field-hint');

      const chip = (tag: string, color: string): HTMLElement => {
        const node = el('span', 'tags-settings-chip', `#${tag}`);
        const { fg, bg } = chipColors(color);
        node.style.color = fg;
        node.style.backgroundColor = bg;
        return node;
      };

      const renderTags = (): void => {
        tagList.textContent = '';
        const needle = filter.trim().toLowerCase();
        const visible = tagRows.filter((row) => needle === '' || row.tag.includes(needle));
        for (const row of visible) {
          const line = el('div', 'tags-settings-tag-row');
          line.appendChild(chip(row.tag, resolveColor(row.tag, rows, palette)));
          const name = el('span', 'name mono', row.tag.replace(/^#/, ''));
          line.appendChild(name);
          const badge = el('span', 'badge', `${row.count}`);
          badge.title = 'Sections carrying this tag';
          line.appendChild(badge);
          const rename = el('button', 'link', 'Rename…') as HTMLButtonElement;
          rename.type = 'button';
          rename.addEventListener('click', () => {
            openRename(row);
          });
          line.appendChild(rename);
          tagList.appendChild(line);
        }
        if (visible.length === 0) {
          tagList.appendChild(
            el(
              'p',
              'empty',
              tagRows.length === 0
                ? 'No tags yet — tags appear here once notes carry them.'
                : 'No tag matches the filter.',
            ),
          );
        }
      };

      const loadTags = async (): Promise<void> => {
        try {
          const reply = (await api.backend.invoke('tag-list', {})) as TagListReply;
          vaults = Array.isArray(reply?.vaults)
            ? reply.vaults.filter((v) => typeof v?.id === 'string' && typeof v?.name === 'string')
            : [];
          const merged = new Map<string, TagRow>();
          for (const [vaultId, entries] of Object.entries(reply?.tags ?? {})) {
            if (!Array.isArray(entries)) {
              continue;
            }
            for (const entry of entries) {
              if (typeof entry?.tag !== 'string' || typeof entry.count !== 'number') {
                continue;
              }
              let row = merged.get(entry.tag);
              if (row === undefined) {
                row = { tag: entry.tag, count: 0, perVault: new Map() };
                merged.set(entry.tag, row);
              }
              row.count += entry.count;
              row.perVault.set(vaultId, entry.count);
            }
          }
          tagRows = [...merged.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
        } catch {
          tagRows = [];
        }
        renderTags();
      };

      const openRename = (row: TagRow): void => {
        let close = (): void => {};
        close = api.ui.showModal((box) => {
          box.classList.add('tag-search-modal', 'tags-rename-modal');
          const title = el('h3', 'tag-search-modal-title', `Rename #${row.tag}`);
          box.appendChild(title);
          const hint = el(
            'p',
            'tag-search-modal-hint',
            'Every tag token in the selected vaults is rewritten. Each file is re-checked right before it is written.',
          );
          box.appendChild(hint);

          const nameField = el('div', 'tags-rename-field');
          const nameLabel = el('span', 'tags-rename-label', 'New name');
          const nameInput = el('input', 'tags-settings-rename-input') as HTMLInputElement;
          nameInput.type = 'text';
          nameInput.value = row.tag;
          nameInput.setAttribute('aria-label', 'New tag name');
          nameField.append(nameLabel, nameInput);
          box.appendChild(nameField);

          // The descendants switch only exists when there are descendants.
          const hasDescendants = tagRows.some((r) => r.tag.startsWith(`${row.tag}/`));
          let includeDescendants = true;
          if (hasDescendants) {
            const switchRow = el('label', 'tags-rename-switch');
            const nested = el('input') as HTMLInputElement;
            nested.type = 'checkbox';
            nested.checked = true;
            const labels = el('span');
            const label = el('span', 'tags-rename-label', 'Rename nested tags too');
            const sub = el('span', 'tags-rename-sub', `#${row.tag}/… becomes #<new name>/…`);
            labels.append(label, sub);
            nested.addEventListener('change', () => {
              includeDescendants = nested.checked;
            });
            switchRow.append(nested, labels);
            box.appendChild(switchRow);
          }

          // One checkbox per vault that carries the tag (two or more only).
          const carrying = vaults
            .map((v) => ({ vault: v, count: row.perVault.get(v.id) ?? 0 }))
            .filter((entry) => entry.count > 0);
          const checked = new Set(carrying.map((entry) => entry.vault.id));
          if (carrying.length > 1) {
            const vaultBox = el('div', 'tags-rename-vaults');
            for (const entry of carrying) {
              const label = el('label', 'tags-rename-check');
              const box0 = el('input') as HTMLInputElement;
              box0.type = 'checkbox';
              box0.checked = true;
              box0.addEventListener('change', () => {
                if (box0.checked) {
                  checked.add(entry.vault.id);
                } else {
                  checked.delete(entry.vault.id);
                }
              });
              label.append(box0, document.createTextNode(` ${entry.vault.name} · ${entry.count}×`));
              vaultBox.appendChild(label);
            }
            box.appendChild(vaultBox);
          }

          const error = el('p', 'tag-search-modal-hint');
          const results = el('div', 'tags-rename-results');
          const actions = el('div', 'tag-search-modal-actions');
          const cancel = el('button', 'ghost', 'Cancel') as HTMLButtonElement;
          cancel.type = 'button';
          cancel.addEventListener('click', () => {
            close();
          });
          const preview = el('button', 'primary', 'Preview') as HTMLButtonElement;
          preview.type = 'button';
          const apply = el('button', 'primary', 'Rename') as HTMLButtonElement;
          apply.type = 'button';
          apply.style.display = 'none';

          const runPreview = (): void => {
            void (async () => {
              error.textContent = '';
              preview.disabled = true;
              try {
                const reply = (await api.backend.invoke('rename-preview', {
                  from: row.tag,
                  to: nameInput.value,
                  includeDescendants,
                  vaults: [...checked],
                })) as { ok?: boolean; error?: string; merged?: boolean; ops?: RenameOp[] };
                if (reply?.ok !== true) {
                  error.textContent = reply?.error ?? 'Rename preview failed.';
                  preview.disabled = false;
                  return;
                }
                const ops = Array.isArray(reply.ops) ? reply.ops : [];
                if (ops.length === 0) {
                  error.textContent = 'Nothing to rename — no occurrence in the selected vaults.';
                  preview.disabled = false;
                  return;
                }
                const occurrences = ops.reduce((n, op) => n + op.occurrences, 0);
                if (reply.merged === true) {
                  title.textContent = `Merge #${row.tag} into #${normalizeTagName(nameInput.value) ?? nameInput.value}`;
                  hint.textContent =
                    'Both tags end up as one; a duplicate the merge would create on a line is dropped.';
                }
                for (const op of ops) {
                  const details = el('details', 'tag-search-modal-file');
                  const summary = el('summary', 'tag-search-modal-file-head');
                  summary.appendChild(el('span', 'tag-search-modal-path', op.path));
                  const vaultName = vaults.find((v) => v.id === op.vaultId)?.name ?? op.vaultId;
                  if (carrying.length > 1) {
                    summary.appendChild(el('span', 'tag-search-modal-vault', vaultName));
                  }
                  summary.appendChild(el('span', 'tag-search-modal-count', `${op.occurrences} ×`));
                  details.appendChild(summary);
                  const diff = el('div', 'tag-search-modal-diff');
                  for (const line of op.diff) {
                    if (line.type === 'context') {
                      continue;
                    }
                    diff.appendChild(
                      el(
                        'span',
                        line.type === 'add' ? 'tag-search-diff-add' : 'tag-search-diff-del',
                        `${line.type === 'add' ? '+' : '−'} ${line.text}`,
                      ),
                    );
                  }
                  if (diff.childElementCount === 0) {
                    diff.appendChild(el('span', 'tag-search-modal-empty', '(no line changes)'));
                  }
                  details.appendChild(diff);
                  results.appendChild(details);
                }
                apply.textContent = `${
                  reply.merged === true ? 'Merge' : 'Rename'
                } ${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ${ops.length} file${ops.length === 1 ? '' : 's'}`;
                apply.style.display = '';
                apply.addEventListener('click', () => {
                  void (async () => {
                    apply.disabled = true;
                    try {
                      const result = (await api.backend.invoke('rename-apply', {
                        from: row.tag,
                        to: nameInput.value,
                        includeDescendants,
                        vaults: [...checked],
                      })) as { error?: string; applied?: RenameOp[] };
                      if (result?.error !== undefined) {
                        error.textContent = result.error;
                        apply.disabled = false;
                        return;
                      }
                      const applied = Array.isArray(result?.applied) ? result.applied : [];
                      const occurrencesDone = applied.reduce((n, op) => n + op.occurrences, 0);
                      const to = normalizeTagName(nameInput.value) ?? nameInput.value;
                      tagStatus.textContent = `Renamed #${row.tag} → #${to} in ${applied.length} file${
                        applied.length === 1 ? '' : 's'
                      } (${occurrencesDone} occurrence${occurrencesDone === 1 ? '' : 's'}).`;
                      close();
                      void loadTags();
                    } catch (e) {
                      error.textContent = e instanceof Error ? e.message : String(e);
                      apply.disabled = false;
                    }
                  })();
                });
                nameInput.disabled = true;
                preview.style.display = 'none';
              } catch (e) {
                error.textContent = e instanceof Error ? e.message : String(e);
                preview.disabled = false;
              }
            })();
          };
          preview.addEventListener('click', () => {
            const to = normalizeTagName(nameInput.value);
            if (to === null) {
              error.textContent = 'The new name is not a valid tag name (and "task" is reserved).';
              return;
            }
            if (to === row.tag) {
              error.textContent = 'The new name is the same as the old one.';
              return;
            }
            runPreview();
          });
          nameInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              preview.click();
            }
          });
          actions.append(cancel, preview, apply);
          box.append(error, results, actions);
          nameInput.focus();
          nameInput.select();
        });
      };

      const onFilterInput = (): void => {
        filter = filterField.value;
        renderTags();
      };
      filterField.addEventListener('input', onFilterInput);
      disposers.push(() => filterField.removeEventListener('input', onFilterInput));

      // ---- Prefix colors (milestone 33) --------------------------------------

      const list = el('div', 'tags-settings-list');
      const addRow = el('div', 'tags-settings-add');
      const hint = el('p', 'field-hint');
      hint.textContent =
        'A prefix colors every tag under it — "proj" colors #proj/alpha. The longest prefix wins; unconfigured tags keep their automatic color.';

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
            if (!/^#[0-9a-f]{6}$/i.test(colorInput.value)) {
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

      const colorsHead = el('p', 'section-hint', 'Prefix colors');
      body.append(
        managerHint,
        filterField,
        tagList,
        tagStatus,
        colorsHead,
        hint,
        list,
        addRow,
      );

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
        void loadTags();
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
