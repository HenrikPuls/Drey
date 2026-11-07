// i18n: catalog
/**
 * The Persona page (board 7k, milestone 201): a tab of its own, opened by
 * `Edit persona` on the Crew tab. What the record serves is editable and
 * saved as one commit (`personaPatch`). The instructions are read from the
 * persona's `prompt.md` in the vault (owner ruling on the 7k measure
 * sheet); while that read fails the editor and Save stay disabled, so an
 * unread prompt can never be overwritten. What the engine does not serve
 * is absent, as the changelog's Fidelity block lists it. Plain DOM over
 * `persona-model.ts`.
 */
import type { ImprovementProposal } from '../../../../packages/tickets-engine/src/core/improvements';
import type { PersonaImprovementsReply, PersonaView } from '../../shared/remote-protocol';
import { h, type DeskDeps } from '../desk-deps';
import {
  draftOf,
  isDirty,
  isMissingFileError,
  patchOf,
  personaPathsOf,
  poolRowsOf,
  skillTitleOf,
  stepsOf,
  wordsOf,
  type PersonaDraft,
} from './persona-model';
import { initialsOf, roleLabel, usd } from './team-model';
import type { TeamStore } from './team-store';

/** How soon a failed load tries again: the engine may be restarting, and the board may stay quiet meanwhile. */
const LOAD_RETRY_MS = 2_000;

/** How often a clean page looks at the prompt file again after a board change. */
const PROMPT_REREAD_MS = 4_000;

/** The unsaved edits per persona: switching tabs remounts the page, a typed draft must survive that. */
const drafts = new Map<string, PersonaDraft>();

/** The words of the instructions per open persona page, for the status bar; null while not loaded. */
const wordCounts = new Map<string, number>();

export function personaWordCountOf(id: string): number | null {
  return wordCounts.get(id) ?? null;
}

export interface PersonaPageHost {
  /** Back to Crew. */
  back(): void;
  /** The persona's name changed: the tab follows. */
  retitle(title: string): void;
}

type PromptRead = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };

function outlineButton(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const button = h('button', className, text);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function avatarNode(className: string, title: string, color: string): HTMLElement {
  const node = h('span', className, initialsOf(title));
  node.setAttribute('aria-hidden', 'true');
  node.style.setProperty('--persona-color', color);
  return node;
}

function fieldNode(label: string): { readonly wrap: HTMLLabelElement; readonly input: HTMLInputElement } {
  const wrap = h('label', 'persona-field');
  const input = h('input', 'persona-input');
  input.type = 'text';
  wrap.append(h('span', 'persona-muted', label), input);
  return { wrap, input };
}

export function mountPersonaPage(deps: DeskDeps, store: TeamStore, mountHost: HTMLElement, id: string, host: PersonaPageHost): () => void {
  const { api } = deps;
  const t: DeskDeps['api']['i18n']['t'] = (key, params) => api.i18n.t(key, params);
  const paths = personaPathsOf(id);
  const root = h('div', 'persona-page');
  mountHost.append(root);

  let view: PersonaView | null = null;
  let base: PersonaDraft | null = null;
  let draft: PersonaDraft | null = null;
  let promptRead: PromptRead | null = null;
  let proposal: ImprovementProposal | null = null;
  let loading = false;
  let loadError = '';
  let busy = false;
  let adding = false;
  let message = '';
  let messageIsError = false;
  let lastPromptRead = 0;
  let viewKey = '';
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  let saveStateNode: HTMLElement | null = null;
  let saveButton: HTMLButtonElement | null = null;
  let discardButton: HTMLButtonElement | null = null;

  const vaultOptions = (): { readonly vaultId: string } | null => {
    const vaultId = deps.snapshot()?.vaultId;
    return vaultId === null || vaultId === undefined ? null : { vaultId };
  };

  const readPrompt = async (): Promise<PromptRead> => {
    const options = vaultOptions();
    if (options === null) {
      return { ok: false, error: t('persona.page.no_vault') };
    }
    lastPromptRead = Date.now();
    try {
      return { ok: true, text: (await api.vault.readFile(paths.prompt, options)).content };
    } catch (error) {
      return isMissingFileError(error) ? { ok: true, text: '' } : { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const syncState = (): void => {
    const dirty = base !== null && draft !== null && isDirty(base, draft);
    if (draft !== null) {
      wordCounts.set(id, wordsOf(draft.prompt));
    }
    if (saveStateNode !== null) {
      const failed = promptRead !== null && !promptRead.ok;
      const text = message !== '' ? message : failed ? t('persona.page.prompt_unreadable') : dirty ? t('persona.page.changed') : t('persona.page.saved');
      saveStateNode.textContent = text;
      saveStateNode.classList.toggle('persona-state-error', messageIsError || failed);
    }
    // A clean page's Save and Discard look as the board draws them and do nothing; only a failed read or a running save disables.
    if (saveButton !== null) {
      saveButton.disabled = promptRead?.ok !== true || busy;
    }
    if (discardButton !== null) {
      discardButton.disabled = busy;
    }
  };

  const edit = (next: Partial<PersonaDraft>): void => {
    if (draft === null) {
      return;
    }
    draft = { ...draft, ...next };
    message = '';
    messageIsError = false;
    if (base !== null && isDirty(base, draft)) {
      drafts.set(id, draft);
    } else {
      drafts.delete(id);
    }
    syncState();
  };

  const fail = (text: string): void => {
    message = text;
    messageIsError = true;
    syncState();
  };

  const headNode = (persona: PersonaView, current: PersonaDraft): HTMLElement => {
    const head = h('header', 'persona-head');
    const names = h('div', 'persona-head-names');
    const sub = h('span', 'persona-muted');
    sub.append(`${roleLabel(persona.role)} · `, h('span', 'persona-mono', paths.personaShort));
    names.append(h('b', 'persona-head-name', current.title), sub);
    saveStateNode = h('span', 'persona-muted');
    const open = outlineButton(t('persona.page.open_markdown'), 'persona-btn persona-btn-32', () => {
      const options = vaultOptions();
      if (options !== null) {
        void api.documents.open(paths.persona, undefined, { ...options, stayInView: true }).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
      }
    });
    const back = outlineButton(t('persona.page.back'), 'persona-back', () => host.back());
    head.append(avatarNode('persona-avatar persona-avatar-head', current.title, persona.color), names, h('span', 'persona-grow'), saveStateNode, open, back);
    return head;
  };

  const profileNode = (persona: PersonaView, current: PersonaDraft): HTMLElement => {
    const block = h('div', 'persona-block');
    const name = fieldNode(t('persona.page.name'));
    name.wrap.classList.add('persona-field-first');
    name.input.value = current.title;
    name.input.dataset['field'] = 'title';
    name.input.addEventListener('input', () => edit({ title: name.input.value }));
    const role = fieldNode(t('persona.page.role'));
    role.input.value = current.role;
    role.input.dataset['field'] = 'role';
    role.input.addEventListener('input', () => edit({ role: role.input.value }));
    const picture = h('div', 'persona-profile-row');
    picture.append(avatarNode('persona-avatar persona-avatar-profile', current.title, persona.color));
    block.append(h('b', 'persona-title', t('persona.page.profile')), picture, name.wrap, role.wrap);
    return block;
  };

  const poolNode = (persona: PersonaView, current: PersonaDraft): HTMLElement => {
    const pool = h('div', 'persona-pool');
    const size = deps.chain()?.poolSize?.[persona.worker];
    for (const row of poolRowsOf(persona.worker, current.pool)) {
      const node = h('div', 'persona-pool-row');
      const body = h('span', 'persona-grow', `${row.label} · ${row.model}`);
      if (row.overflow) {
        body.append(h('span', 'persona-muted persona-line', t('persona.page.when_full', { name: row.label })));
      }
      node.append(h('span', 'persona-muted', String(row.index)), body);
      if (typeof size === 'number') {
        node.append(h('span', 'persona-muted', t('persona.page.slots', { count: size })));
      }
      pool.append(node);
    }
    if (adding) {
      const input = h('input', 'persona-input');
      input.type = 'text';
      input.setAttribute('aria-label', t('persona.page.add_model'));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          adding = false;
          render();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          const model = input.value.trim();
          adding = false;
          if (model !== '' && !current.pool.includes(model)) {
            edit({ pool: [...current.pool, model] });
          }
          render();
        }
      });
      input.addEventListener('blur', () => {
        if (adding && input.value.trim() === '') {
          adding = false;
          render();
        }
      });
      pool.append(input);
      queueMicrotask(() => input.focus());
    } else {
      pool.append(
        outlineButton(t('persona.page.add_model'), 'persona-btn persona-btn-30', () => {
          adding = true;
          render();
        }),
      );
    }
    return pool;
  };

  const workNode = (persona: PersonaView, current: PersonaDraft): HTMLElement => {
    const block = h('div', 'persona-block');
    const lead = h('span', 'persona-muted', t('persona.page.steps', { name: current.title }));
    lead.append(h('span', 'persona-line', t('persona.page.steps_hint')));
    const steps = h('div', 'persona-steps');
    steps.setAttribute('role', 'group');
    steps.setAttribute('aria-label', t('persona.page.steps', { name: current.title }));
    for (const step of stepsOf(deps.snapshot()?.pipeline ?? [], persona.phases ?? [])) {
      const chip = h('span', `persona-step${step.on ? ' persona-step-on' : ''}`, step.on ? `✓ ${step.title}` : step.title);
      chip.dataset['step'] = step.id;
      steps.append(chip);
    }
    const poolLabel = h('span', 'persona-muted persona-gap-4', t('persona.page.pool'));
    const budget = fieldNode(t('persona.page.budget'));
    budget.wrap.classList.add('persona-gap-4', 'persona-half');
    budget.input.value = persona.budget === null ? '' : usd(persona.budget);
    budget.input.readOnly = true;
    block.append(h('b', 'persona-title', t('persona.page.work')), lead, steps, poolLabel, poolNode(persona, current), budget.wrap);
    return block;
  };

  const skillsNode = (current: PersonaDraft): HTMLElement => {
    const block = h('div', 'persona-skills');
    block.append(h('b', 'persona-title', t('persona.page.skills')));
    for (const skill of current.skills) {
      const row = h('div', 'persona-skill');
      row.dataset['skill'] = skill;
      const name = h('span', 'persona-grow', skillTitleOf(skill));
      name.append(h('span', 'persona-muted persona-mono persona-skill-path', `skills/${skill}.md`));
      const remove = h('button', 'persona-icon-btn');
      remove.type = 'button';
      remove.title = t('persona.page.skill_remove_title', { name: current.title });
      remove.setAttribute('aria-label', t('persona.page.skill_remove', { name: skillTitleOf(skill) }));
      remove.append(api.ui.icon('x', 14));
      remove.addEventListener('click', () => {
        edit({ skills: current.skills.filter((entry) => entry !== skill) });
        render();
      });
      row.append(name, remove);
      block.append(row);
    }
    return block;
  };

  const frictionNode = (open: ImprovementProposal, current: PersonaDraft): HTMLElement => {
    const card = h('div', 'persona-friction');
    const text = h('span', 'persona-grow');
    text.append(h('b', undefined, t('persona.page.friction', { count: open.evidence.length })), h('span', 'persona-muted persona-line', open.title));
    card.append(text);
    if (open.target === 'prompt.md') {
      card.append(
        outlineButton(t('persona.page.show_diff'), 'persona-btn persona-btn-28', () => {
          void api.ui.showDiff({ title: open.title, path: paths.promptShort, before: current.prompt, after: open.content, beforeLabel: t('persona.page.diff_now'), afterLabel: t('persona.page.diff_suggested') });
        }),
      );
    }
    card.append(
      outlineButton(t('persona.page.dismiss'), 'persona-btn persona-btn-28', () => {
        void dismiss(open);
      }),
    );
    return card;
  };

  const promptNode = (current: PersonaDraft): HTMLElement => {
    const section = h('section', 'persona-prompt');
    section.setAttribute('aria-label', t('persona.page.prompt_label'));
    const head = h('div', 'persona-prompt-head');
    head.append(h('b', 'persona-title', t('persona.page.instructions')), h('span', 'persona-muted', t('persona.page.instructions_sub', { name: current.title, path: paths.promptShort })));
    const scroller = h('div', 'persona-prompt-scroll');
    const text = h('textarea', 'persona-text');
    text.setAttribute('aria-label', t('persona.page.instructions_for', { name: current.title }));
    text.spellcheck = false;
    text.value = current.prompt;
    text.disabled = promptRead?.ok !== true;
    text.addEventListener('input', () => edit({ prompt: text.value }));
    scroller.append(text, skillsNode(current), h('span', 'persona-muted', t('persona.page.also_loaded')));
    if (proposal !== null) {
      scroller.append(frictionNode(proposal, current));
    }
    const foot = h('div', 'persona-foot');
    discardButton = outlineButton(t('persona.page.discard'), 'persona-btn persona-btn-32', () => {
      if (base !== null) {
        draft = base;
        drafts.delete(id);
        message = '';
        messageIsError = false;
        render();
      }
    });
    saveButton = outlineButton(t('persona.page.save'), 'persona-save', () => void save());
    saveButton.title = t('persona.page.save_title', { path: paths.dirShort });
    foot.append(h('span', 'persona-muted persona-grow', t('persona.page.commit_note', { path: paths.dirShort })), discardButton, saveButton);
    section.append(head, scroller, foot);
    return section;
  };

  const render = (): void => {
    if (disposed) {
      return;
    }
    const left = root.querySelector('.persona-general')?.scrollTop ?? 0;
    const right = root.querySelector('.persona-prompt-scroll')?.scrollTop ?? 0;
    saveStateNode = null;
    saveButton = null;
    discardButton = null;
    if (view === null || draft === null) {
      const note = loadError !== '' ? loadError : store.loaded() && store.personas().every((entry) => entry.id !== id) ? t('persona.page.missing', { id }) : t('persona.page.loading');
      root.replaceChildren(h('div', `persona-note${loadError !== '' ? ' persona-state-error' : ''}`, note));
      return;
    }
    const body = h('div', 'persona-body');
    const general = h('section', 'persona-general');
    general.setAttribute('aria-label', t('persona.page.general_label'));
    general.append(profileNode(view, draft), h('div', 'persona-rule'), workNode(view, draft));
    body.append(general, promptNode(draft));
    root.replaceChildren(headNode(view, draft), body);
    general.scrollTop = left;
    const scroller = root.querySelector('.persona-prompt-scroll');
    if (scroller !== null) {
      scroller.scrollTop = right;
    }
    syncState();
  };

  const improvementsOf = async (): Promise<PersonaImprovementsReply> => (await deps.invoke('personaImprovements', { persona: id })) as PersonaImprovementsReply;

  const failLoad = (text: string): void => {
    if (disposed) {
      return;
    }
    loadError = text;
    render();
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
    }
    retryTimer = setTimeout(() => {
      retryTimer = null;
      onChange();
    }, LOAD_RETRY_MS);
  };

  const load = async (persona: PersonaView): Promise<void> => {
    loading = true;
    try {
      const [prompt, improvements] = await Promise.all([readPrompt(), improvementsOf()]);
      if (disposed) {
        return;
      }
      if (!improvements.ok) {
        failLoad(improvements.error);
        return;
      }
      view = persona;
      viewKey = keyOf(persona);
      promptRead = prompt;
      proposal = improvements.proposals.find((entry) => entry.state === 'open') ?? null;
      base = draftOf(persona, prompt.ok ? prompt.text : '', improvements.persona.skills);
      draft = drafts.get(id) ?? base;
      loadError = '';
      host.retitle(persona.title);
      render();
    } catch (error) {
      failLoad(error instanceof Error ? error.message : String(error));
    } finally {
      loading = false;
    }
  };

  const save = async (): Promise<void> => {
    if (base === null || draft === null || busy || promptRead?.ok !== true) {
      return;
    }
    const patch = patchOf(base, draft);
    if (Object.keys(patch).length === 0) {
      return;
    }
    busy = true;
    syncState();
    try {
      if (patch.prompt !== undefined) {
        // The file may have moved on since the page read it (Mission Control writes it too).
        const fresh = await readPrompt();
        if (!fresh.ok || fresh.text !== base.prompt) {
          fail(t('persona.page.prompt_moved'));
          return;
        }
      }
      const reply = (await deps.invoke('personaPatch', { persona: id, ...patch })) as { ok: boolean; error?: string; warning?: string };
      if (!reply.ok) {
        fail(reply.error ?? t('persona.page.save_failed'));
        return;
      }
      drafts.delete(id);
      base = { ...draft, title: draft.title.trim(), role: roleLabel(draft.role.trim().toLowerCase()) };
      draft = base;
      promptRead = { ok: true, text: base.prompt };
      message = reply.warning ?? '';
      messageIsError = false;
      host.retitle(base.title);
      await store.refresh();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
      render();
    }
  };

  const dismiss = async (open: ImprovementProposal): Promise<void> => {
    try {
      const reply = (await deps.invoke('personaImprovementDecide', { persona: id, proposal: open.id, decision: 'dismissed' })) as { ok: boolean; error?: string };
      if (!reply.ok) {
        fail(reply.error ?? t('persona.page.save_failed'));
        return;
      }
      const improvements = await improvementsOf();
      proposal = improvements.ok ? (improvements.proposals.find((entry) => entry.state === 'open') ?? null) : null;
      render();
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  };

  /** What a repaint of a loaded page depends on; the day's cost and the pause do not count. */
  const keyOf = (persona: PersonaView): string =>
    JSON.stringify([persona.title, persona.role, persona.worker, persona.pool, persona.color, persona.budget, persona.phases, deps.chain()?.poolSize?.[persona.worker], deps.snapshot()?.pipeline.map((phase) => phase.id)]);

  const onChange = (): void => {
    const persona = store.personas().find((entry) => entry.id === id);
    if (persona === undefined) {
      render();
      return;
    }
    if (view === null) {
      // The tab may be restored before the snapshot or the directory arrive; a failed load tries again on the next change.
      if (!loading && vaultOptions() !== null) {
        void load(persona);
      }
      return;
    }
    const clean = base !== null && draft !== null && !isDirty(base, draft);
    if (keyOf(persona) !== viewKey && !busy && !adding) {
      viewKey = keyOf(persona);
      view = persona;
      if (clean && base !== null) {
        base = draftOf(persona, base.prompt, base.skills);
        draft = base;
        host.retitle(persona.title);
      }
      if (root.contains(document.activeElement)) {
        syncState();
      } else {
        render();
      }
    }
    if (clean && !busy && Date.now() - lastPromptRead >= PROMPT_REREAD_MS) {
      void readPrompt().then((fresh) => {
        const unchanged = base !== null && draft === base;
        if (!disposed && unchanged && base !== null && (fresh.ok !== promptRead?.ok || (fresh.ok && fresh.text !== base.prompt))) {
          promptRead = fresh;
          base = { ...base, prompt: fresh.ok ? fresh.text : '' };
          draft = base;
          render();
        }
      });
    }
  };

  const offStore = store.subscribe(onChange);
  const offDeps = deps.subscribe(onChange);
  render();
  onChange();
  return () => {
    disposed = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
    }
    offStore();
    offDeps();
    root.remove();
  };
}
