/**
 * Refining a ticket on the phone (req-66 R5): one section at a time —
 * Description, Plan, Acceptance criteria — or the header (title,
 * priority, repository). What is typed is kept as a draft on the device
 * until it is saved, so a conflict, a reload or a closed app never loses
 * it; the save carries the revision the text was read at, and the desk
 * refuses when the ticket changed meanwhile.
 */
import type { RefineReply } from '../shared/remote-protocol';
import { TICKET_PRIORITIES, type TicketPriority } from '../shared/tickets';
import type { Ctx, View } from './context';
import { button, empty, h, present, toast } from './dom';
import { placeOf, REFINE_TITLES, sectionTextOf, type RefineKey } from './model';

export type RefineTab = RefineKey | 'header';

const TABS: readonly RefineTab[] = ['description', 'plan', 'acceptance', 'header'];
const TAB_LABEL: Readonly<Record<RefineTab, string>> = {
  description: 'Description',
  plan: 'Plan',
  acceptance: 'Acceptance',
  header: 'Header',
};

interface Draft {
  readonly base: string;
  readonly text: string;
}

const draftKey = (id: string, tab: RefineTab): string => `drey.remote.draft.${id}.${tab}`;

function readDraft(id: string, tab: RefineTab): Draft | null {
  try {
    const raw = localStorage.getItem(draftKey(id, tab));
    const parsed = raw === null ? null : (JSON.parse(raw) as Partial<Draft>);
    return parsed !== null && typeof parsed.base === 'string' && typeof parsed.text === 'string' ? (parsed as Draft) : null;
  } catch {
    return null;
  }
}

function writeDraft(id: string, tab: RefineTab, draft: Draft | null): void {
  try {
    if (draft === null) {
      localStorage.removeItem(draftKey(id, tab));
    } else {
      localStorage.setItem(draftKey(id, tab), JSON.stringify(draft));
    }
  } catch {
    // a draft is a convenience; the save itself does not depend on it
  }
}

export function refineTabOf(raw: string | null): RefineTab {
  return TABS.includes(raw as RefineTab) ? (raw as RefineTab) : 'plan';
}

export function refineView(ctx: Ctx, id: string, tab: RefineTab): View {
  const reply = ctx.state.ticket;
  const board = ctx.state.board;
  const placed = board === null ? null : placeOf(board, id);
  const title = `Refine ${id}`;
  if (ctx.state.readOnly) {
    return { title, back: `#ticket/${id}`, body: [empty('This device is paired read only.')] };
  }
  if (reply === null || !reply.ok || reply.card.id !== id || placed === null) {
    return { title, back: `#ticket/${id}`, body: [empty(reply !== null && !reply.ok ? reply.error : 'Loading…')] };
  }
  const { card } = placed;
  const revision = reply.revision;

  const tabs = h(
    'div',
    { class: 'chipbar', attrs: { role: 'tablist', 'aria-label': 'Part to refine' } },
    ...TABS.map((t) =>
      h('button', {
        class: `pchip${t === tab ? ' on' : ''}`,
        text: TAB_LABEL[t],
        attrs: { type: 'button', role: 'tab', 'aria-selected': String(t === tab) },
        on: { click: () => ctx.go(`#refine/${id}/${t}`) },
      }),
    ),
  );
  const banner = h('p', { class: 'banner', attrs: { role: 'status' } });
  banner.hidden = true;
  const showBanner = (text: string, reload: boolean): void => {
    banner.replaceChildren(...present<Node>([h('span', { class: 'grow', text }), reload ? button('Reload', () => ctx.reload(), 'link') : null]));
    banner.hidden = false;
  };

  let body: Node[];
  let collect: () => { sections?: Record<string, string>; header?: Record<string, string> } | null;
  let clearDraft: () => void;

  if (tab === 'header') {
    const titleInput = h('input', { attrs: { id: 'ref-title', type: 'text', 'aria-label': 'Title' } });
    titleInput.value = card.meta.title ?? '';
    let priority: TicketPriority = card.meta.priority;
    const prio = h(
      'div',
      { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': 'Priority' } },
      ...TICKET_PRIORITIES.map((p) => {
        const node = h('button', { class: p === priority ? 'on' : '', text: p, attrs: { type: 'button', role: 'radio', 'aria-checked': String(p === priority) } });
        node.addEventListener('click', () => {
          priority = p;
          prio.querySelectorAll('button').forEach((b) => {
            b.classList.toggle('on', b === node);
            b.setAttribute('aria-checked', String(b === node));
          });
        });
        return node;
      }),
    );
    const repo = h(
      'select',
      { attrs: { id: 'ref-repo', 'aria-label': 'Repository' } },
      h('option', { text: 'No repository', attrs: { value: '' } }),
      ...(board?.repos ?? []).map((r) => h('option', { text: r.name, attrs: { value: r.name } })),
    );
    repo.value = card.meta.repo ?? '';
    body = [
      h(
        'form',
        { class: 'form', on: { submit: (e) => e.preventDefault() } },
        h('label', { text: 'Title', attrs: { for: 'ref-title' } }),
        titleInput,
        h('span', { class: 'label', text: 'Priority' }),
        prio,
        h('label', { text: 'Repository', attrs: { for: 'ref-repo' } }),
        repo,
      ),
    ];
    collect = () => {
      const header: Record<string, string> = {};
      if (titleInput.value.trim() !== (card.meta.title ?? '')) {
        header['title'] = titleInput.value;
      }
      if (priority !== card.meta.priority) {
        header['priority'] = priority;
      }
      if (repo.value !== (card.meta.repo ?? '')) {
        header['repo'] = repo.value;
      }
      return Object.keys(header).length === 0 ? null : { header };
    };
    clearDraft = () => undefined;
  } else {
    const original = sectionTextOf(reply.text, tab);
    const draft = readDraft(id, tab);
    const area = h('textarea', { class: 'refine-area', attrs: { id: 'ref-text', rows: '14', spellcheck: 'true', 'aria-label': REFINE_TITLES[tab] } });
    area.value = draft?.text ?? original;
    if (draft !== null && draft.text !== original) {
      if (draft.base !== revision) {
        showBanner('Your unsaved draft started from an older version of the ticket. Check it before saving.', false);
      } else {
        showBanner('Your unsaved draft is back.', false);
      }
    }
    area.addEventListener('input', () => writeDraft(id, tab, { base: draft?.base ?? revision, text: area.value }));
    body = present<Node>([
      h('label', { class: 'label', text: REFINE_TITLES[tab], attrs: { for: 'ref-text' } }),
      area,
      tab === 'acceptance'
        ? h('p', { class: 'small', text: 'One checkbox line per check; a line that starts with a `command` is what the gate runs.' })
        : null,
    ]);
    collect = () => (area.value.trim() === original.trim() ? null : { sections: { [tab]: area.value } });
    clearDraft = () => writeDraft(id, tab, null);
  }

  const save = button(
    'Save',
    () => {
      const changes = collect();
      if (changes === null) {
        toast('Nothing changed.');
        return;
      }
      save.disabled = true;
      ctx.api
        .post<RefineReply>(`/api/tickets/${encodeURIComponent(id)}/refine`, { baseRevision: revision, ...changes })
        .then((result) => {
          save.disabled = false;
          if (result.ok) {
            clearDraft();
            toast(result.warning ?? `${id} saved`);
            ctx.go(`#ticket/${id}`);
          } else if (result.conflict === true) {
            showBanner('The ticket changed on the desk. Your text is kept — reload, then save again.', true);
          } else {
            toast(result.error ?? 'The desk refused.', 'error');
          }
        })
        .catch((error: unknown) => {
          save.disabled = false;
          toast(error instanceof Error ? error.message : String(error), 'error');
        });
    },
    'btn btn-primary grow',
  );

  return {
    title,
    back: `#ticket/${id}`,
    body: present<Node>([tabs, h('h1', { class: 'ticket-title', text: card.meta.title ?? id }), banner, ...body]),
    actions: h('div', { class: 'actionbar' }, save),
    form: true,
  };
}
