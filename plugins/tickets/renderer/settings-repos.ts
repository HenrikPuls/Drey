import type { DreyPluginApi } from '../../../shared/plugin-api/renderer';
import type { RepoCandidate, RepoRef, ReposListing } from '../shared/tickets';
import { el, iconButton, mutate, textButton } from './settings-dom';

/**
 * Settings → Tickets, the repositories (req-72): `_meta/repos.md`'s
 * entries as editable rows — the registry a ticket's `repos:` field names
 * and the fleet works on. Every save rewrites the file's frontmatter (the
 * owner's prose under it is kept) as one commit; the page follows the
 * board's change events like the rest. "Add from folder…" probes a picked
 * folder for git repositories and offers the found ones as seeds.
 */

export interface ReposSection {
  readonly root: HTMLElement;
  update(listing: ReposListing): void;
}

/** One row's editable shape — strings straight from the inputs. */
interface RepoDraft {
  name: string;
  url: string;
  branch: string;
  path: string;
  policy: string;
  worker: string;
  worktrees: string;
  launch: string;
  link: string; // comma-separated folder names
}

function draftOf(repo: RepoRef): RepoDraft {
  return {
    name: repo.name,
    url: repo.url,
    branch: repo.branch ?? '',
    path: repo.path ?? '',
    policy: repo.policy ?? '',
    worker: repo.worker ?? '',
    worktrees: repo.worktrees ?? '',
    launch: repo.launch ?? '',
    link: (repo.link ?? []).join(', '),
  };
}

function refOf(draft: RepoDraft): RepoRef {
  const one = (value: string): string | null => {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };
  const links = draft.link
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return {
    name: draft.name.trim(),
    url: draft.url.trim(),
    branch: one(draft.branch),
    policy: one(draft.policy),
    path: one(draft.path),
    worker: one(draft.worker),
    worktrees: one(draft.worktrees),
    launch: one(draft.launch),
    ...(links.length > 0 ? { link: links } : {}),
  };
}

export function createReposSection(api: DreyPluginApi, reload: () => Promise<void>): ReposSection {
  const root = el('section', 'tset-section');
  root.setAttribute('aria-labelledby', 'tset-repos-head');

  const head = el('div', 'tset-section-head');
  const title = el('h3', undefined, 'Repositories');
  title.id = 'tset-repos-head';
  const count = el('span', 'tset-muted');
  const status = el('span', 'tset-muted tset-error');
  status.setAttribute('role', 'status');
  const scanBtn = iconButton(api, 'download', 'Add from folder…');
  const addBtn = iconButton(api, 'plus', 'New repository');
  const openBtn = iconButton(api, 'folder', 'Open the tickets folder');
  const reloadBtn = iconButton(api, 'refresh-cw', 'Reload from disk');
  const tools = el('span', 'tset-head-tools');
  tools.append(scanBtn, addBtn, openBtn, reloadBtn);
  head.append(title, count, tools);

  const hint = el('p', 'section-hint');
  const list = el('div', 'tset-repolist');
  root.append(head, status, hint, list);

  let listing: ReposListing = { file: null, repos: [], error: null };
  let editing: string | null = null; // the open row's name, or '' for the new-repository form

  const setStatus = (text: string, error = false): void => {
    status.textContent = text;
    status.classList.toggle('tset-error', error);
  };

  /** Applies the whole list (one commit), then reloads from disk. */
  const saveAll = async (next: readonly RepoRef[]): Promise<boolean> => {
    setStatus('Saving…');
    const result = await mutate(api, 'reposSave', { repos: next });
    if (!result.ok) {
      setStatus(`Not saved: ${result.error ?? 'the write failed'}`, true);
      return false;
    }
    setStatus('');
    await reload();
    return true;
  };

  const renderForm = (host: HTMLElement, draft: RepoDraft, onCommit: (draft: RepoDraft) => void): void => {
    host.replaceChildren();
    const form = el('div', 'tset-repo-form');
    const field = (label: string, key: keyof RepoDraft, hint?: string): void => {
      const wrap = el('label', 'tset-repo-field');
      const name = el('span', 'tset-kv-label', label);
      const input = el('input', 'mono-input');
      input.type = 'text';
      input.spellcheck = false;
      input.value = draft[key];
      input.addEventListener('input', () => {
        draft[key] = input.value;
      });
      wrap.append(name, input, ...(hint !== undefined ? [el('span', 'field-hint', hint)] : []));
      form.append(wrap);
    };
    field('Name *', 'name', 'What a ticket\'s repos: field names.');
    field('URL *', 'url', 'The clone URL (origin).');
    field('Branch', 'branch', 'The integration branch. Empty = the checkout\'s default.');
    field('Local path', 'path', 'The local checkout the fleet opens and tests in.');
    field('Policy', 'policy', 'Branch protection a push must respect, as a note for the worker.');
    field('Worker', 'worker', 'This repo\'s default fleet worker. Empty = the board\'s.');
    field('Worktrees base', 'worktrees', 'Where the fleet\'s checkouts live. Empty = the tickets repo\'s _worktrees.');
    field('Launch command', 'launch', 'Runs in the ticket\'s worktree in a new console. Empty: dev.ps1 -Built -Multi when the worktree has one.');
    field('Link folders', 'link', 'Git-ignored folders a worktree borrows, comma-separated (node_modules, .tools).');
    const actions = el('div', 'tset-actions');
    const cancel = textButton('Cancel');
    const save = textButton('Save', 'primary');
    cancel.addEventListener('click', () => {
      editing = null;
      renderRows();
    });
    save.addEventListener('click', () => {
      if (draft.name.trim() === '' || draft.url.trim() === '') {
        setStatus('A repository needs at least a name and a URL.', true);
        return;
      }
      onCommit(draft);
    });    actions.append(cancel, save);
    form.append(actions);
    host.append(form);
  };

  const renderRows = (): void => {
    list.replaceChildren();
    if (editing === '') {
      const host = el('div', 'tset-repo-entry');
      renderForm(host, { name: '', url: '', branch: '', path: '', policy: '', worker: '', worktrees: '', launch: '', link: '' }, (draft) => {
        void saveAll([...listing.repos, refOf(draft)]).then(() => {
          editing = null;
        });
      });
      list.append(host);
    }
    if (listing.repos.length === 0 && editing === null) {
      const empty = el('div', 'tset-pempty');
      empty.append(
        el('span', undefined, 'No repositories registered.'),
        el('span', 'tset-muted', 'Add one by hand, or scan a folder that holds your checkouts.'),
      );
      list.append(empty);
    }
    for (const repo of listing.repos) {
      const entry = el('div', 'tset-repo-entry');
      const row = el('div', 'tset-repo-row');
      const info = el('div', 'tset-repo-info');
      const name = el('span', 'tset-repo-name', repo.name);
      name.title = repo.url;
      const meta = el(
        'span',
        'tset-repo-meta',
        [repo.branch ?? '(default branch)', repo.path ?? '(no local path)', repo.worker !== null ? `worker: ${repo.worker}` : null]
          .filter((part): part is string => part !== null)
          .join(' · '),
      );
      info.append(name, meta);
      const tools = el('div', 'tset-repo-tools');
      const edit = iconButton(api, 'pencil', `Edit ${repo.name}`);
      edit.addEventListener('click', () => {
        editing = repo.name;
        renderRows();
      });
      const remove = iconButton(api, 'trash', `Remove ${repo.name}`);
      remove.addEventListener('click', () => {
        void saveAll(listing.repos.filter((r) => r.name !== repo.name));
      });
      tools.append(edit, remove);
      row.append(info, tools);
      entry.append(row);
      if (editing === repo.name) {
        renderForm(entry, draftOf(repo), (draft) => {
          const next = listing.repos.map((r) => (r.name === repo.name ? refOf(draft) : r));
          void saveAll(next).then(() => {
            editing = null;
          });
        });
      }
      list.append(entry);
    }
  };

  /** The "Add from folder" flow: pick, scan, offer, merge, one save. */
  const addFromFolder = async (): Promise<void> => {
    setStatus('');
    const picked = (await mutate(api, 'pickFolder')) as { ok: boolean; path?: string; error?: string };
    if (!picked.ok) {
      setStatus(picked.error ?? 'The folder picker failed.', true);
      return;
    }
    if (picked.path === undefined) {
      return; // cancelled
    }
    const scan = (await mutate(api, 'scanRepos', { folder: picked.path })) as unknown as {
      ok: boolean;
      error?: string;
      candidates?: readonly RepoCandidate[];
    };
    if (!scan.ok || scan.candidates === undefined) {
      setStatus(scan.error ?? 'The scan failed.', true);
      return;
    }
    if (scan.candidates.length === 0) {
      setStatus(`No git repositories found in ${picked.path}`, true);
      return;
    }
    const close = api.ui.showModal((host) => {
      const box = el('div', 'tset-scan');
      box.append(
        el('h3', undefined, 'Found repositories'),
        el('p', 'tset-muted', `${picked.path} — choose the checkouts to register in _meta/repos.md.`),
      );
      const chosen = new Map<string, RepoCandidate>();
      for (const candidate of scan.candidates!) {
        const known = listing.repos.some((r) => r.path === candidate.path);
        const row = el('label', 'tset-scan-row');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !known;
        const text = el(
          'span',
          undefined,
          `${candidate.name} — ${candidate.url ?? '(no origin remote)'} · ${candidate.branch ?? '(detached)'}${known ? ' · already registered' : ''}`,
        );
        row.append(input, text);
        if (!known) {
          chosen.set(candidate.path, candidate);
        }
        input.addEventListener('change', () => {
          if (input.checked) {
            chosen.set(candidate.path, candidate);
          } else {
            chosen.delete(candidate.path);
          }
          syncAddLabel();
        });
        box.append(row);
      }
      const actions = el('div', 'tset-actions');
      const cancel = textButton('Cancel');
      const add = textButton(`Add ${chosen.size}`, 'primary');
      const syncAddLabel = (): void => {
        add.textContent = `Add ${chosen.size}`;
        add.disabled = chosen.size === 0;
      };
      syncAddLabel();
      cancel.addEventListener('click', close);
      add.addEventListener('click', () => {
        const merged = [...listing.repos];
        for (const candidate of chosen.values()) {
          const at = merged.findIndex((r) => r.name === candidate.name);
          const ref: RepoRef = {
            name: candidate.name,
            url: candidate.url ?? candidate.path.replaceAll('\\', '/'),
            branch: candidate.branch,
            policy: null,
            path: candidate.path,
            worker: null,
            worktrees: null,
            launch: null,
          };
          if (at >= 0) {
            merged[at] = ref;
          } else {
            merged.push(ref);
          }
        }
        close();
        void saveAll(merged);
      });
      actions.append(cancel, add);
      box.append(actions);
      host.append(box);
    });
  };

  scanBtn.addEventListener('click', () => void addFromFolder());
  addBtn.addEventListener('click', () => {
    editing = '';
    renderRows();
  });
  openBtn.addEventListener('click', () => void mutate(api, 'openFolder', { which: 'tickets' }));
  reloadBtn.addEventListener('click', () => void reload());

  return {
    root,
    update: (next: ReposListing) => {
      listing = next;
      const n = next.repos.length;
      count.textContent = n === 1 ? '1 repository' : `${n} repositories`;
      hint.textContent =
        `${next.file ?? 'tickets/_meta/repos.md'} — the work repositories a ticket's repos: field names. ` +
        'Every save is one commit; your notes under the frontmatter are kept.';
      openBtn.disabled = next.file === null;
      if (editing !== null && editing !== '' && !next.repos.some((r) => r.name === editing)) {
        editing = null; // the edited row is gone from disk
      }
      if (next.error !== null) {
        setStatus(`repos.md does not parse: ${next.error} — fix the file; saving here replaces it.`, true);
      } else {
        setStatus('');
      }
      renderRows();
    },
  };
}
