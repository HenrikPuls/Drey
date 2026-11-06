/**
 * The ticket document's plain-DOM halves (E13-6): the proof block, the cost
 * table, the action bar and the header strip's two rows. Pure functions of
 * the view models in `model.ts`; every effect (open a picture, accept, send
 * back) arrives as a callback so the module knows no IPC and no editor.
 */
import type { ActionBar, ChainItem, CostTable, ProofView, TicketStatus } from './model';
import { assetUrl } from './model';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls !== undefined) {
    node.className = cls;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
};

export interface ProofDeps {
  readonly vaultId: string | null;
  /** Opens a vault file (a screenshot) in the editor. */
  readonly openFile: (path: string) => void;
}

/** `## Verification` as the owner reads it: the verdict line, the checks, the pictures, the walkthrough. */
export function proofNode(deps: ProofDeps, proof: ProofView): HTMLElement {
  const root = el('section', 'tickets-doc-block tickets-doc-proof');
  root.contentEditable = 'false';
  const head = el('div', 'tickets-doc-head');
  head.append(el('span', 'tickets-doc-kicker', 'Proof'));
  head.append(el('span', `tickets-doc-verdict ${proof.allPassed ? 'is-green' : 'is-red'}`, proof.summary));
  root.append(head);
  if (proof.stamp !== '') {
    root.append(el('p', 'tickets-doc-stamp', proof.stamp));
  }

  if (proof.checks.length > 0) {
    const list = el('ul', 'tickets-doc-checks');
    for (const check of proof.checks) {
      const row = el('li', `tickets-doc-check ${check.passed ? 'is-pass' : 'is-fail'}`);
      row.append(el('span', 'tickets-doc-mark', check.passed ? '✓' : '✗'));
      const label = el('span', 'tickets-doc-check-label', check.label);
      row.append(label);
      const meta = [check.note, check.at].filter((part): part is string => part !== null && part !== '').join(' · ');
      if (meta !== '') {
        row.append(el('span', 'tickets-doc-check-meta', meta));
      }
      list.append(row);
    }
    root.append(list);
  }

  if (proof.shots.length > 0) {
    const gallery = el('div', 'tickets-doc-shots');
    for (const shot of proof.shots) {
      const path = `tickets/attachments/${shot.file}`;
      const figure = el('figure', 'tickets-doc-shot');
      const button = el('button', 'tickets-doc-shot-open');
      button.type = 'button';
      button.title = 'Open the picture';
      button.setAttribute('aria-label', `Open ${shot.caption}`);
      const image = el('img');
      image.src = assetUrl(deps.vaultId, path);
      image.alt = shot.caption;
      image.loading = 'lazy';
      button.append(image);
      button.addEventListener('click', () => deps.openFile(path));
      figure.append(button, el('figcaption', undefined, shot.caption));
      gallery.append(figure);
    }
    root.append(gallery);
  }

  if (proof.video !== null) {
    const block = el('div', 'tickets-doc-video');
    if (proof.video.file === null) {
      block.append(el('p', 'tickets-doc-note', proof.video.notKept ?? ''));
    } else {
      const player = el('video', 'tickets-doc-player');
      player.controls = true;
      player.preload = 'metadata';
      player.src = assetUrl(deps.vaultId, `tickets/videos/${proof.video.file}`);
      player.setAttribute('aria-label', 'Walkthrough video');
      block.append(player);
      if (proof.video.chapters.length > 0) {
        const chapters = el('div', 'tickets-doc-chapters');
        for (const chapter of proof.video.chapters) {
          const button = el('button', 'tickets-doc-chapter');
          button.type = 'button';
          button.title = `Jump to ${chapter.at}`;
          button.append(el('span', 'tickets-doc-chapter-at', chapter.at), document.createTextNode(` ${chapter.label}`));
          button.addEventListener('click', () => {
            player.currentTime = chapter.atMs / 1000;
            void player.play().catch(() => undefined);
          });
          chapters.append(button);
        }
        block.append(chapters);
      }
    }
    root.append(block);
  }

  if (proof.findings.length > 0) {
    const findings = el('div', 'tickets-doc-findings');
    findings.append(el('span', 'tickets-doc-kicker', 'Findings'));
    const list = el('ul');
    for (const finding of proof.findings) {
      list.append(el('li', undefined, finding));
    }
    findings.append(list);
    root.append(findings);
  }
  return root;
}

/** The Cost card at the end of the ticket: one row per settled run, the totals under it. */
export function costNode(table: CostTable): HTMLElement {
  const root = el('section', 'tickets-doc-block tickets-doc-cost');
  root.contentEditable = 'false';
  const head = el('div', 'tickets-doc-head');
  head.append(el('span', 'tickets-doc-kicker', 'Cost'));
  if (table.total !== null) {
    head.append(el('span', 'tickets-doc-total', table.total));
  }
  root.append(head);

  const grid = el('table', 'tickets-doc-table');
  const header = el('tr');
  for (const [label, numeric] of [
    ['Phase', false],
    ['Model', false],
    ['Tokens', true],
    ['Time', true],
    ['Cost', true],
  ] as const) {
    const cell = el('th', numeric ? 'is-num' : undefined, label);
    cell.scope = 'col';
    header.append(cell);
  }
  const thead = el('thead');
  thead.append(header);
  const body = el('tbody');
  for (const row of table.rows) {
    const tr = el('tr');
    tr.append(
      el('td', undefined, row.step),
      el('td', 'is-muted', row.who),
      el('td', 'is-num', row.tokens),
      el('td', 'is-num', row.time),
      el('td', 'is-num', row.cost),
    );
    if (row.outcome === 'failed' || row.outcome === 'stopped') {
      tr.classList.add('is-bad');
      tr.title = row.outcome;
    }
    body.append(tr);
  }
  const foot = el('tfoot');
  const total = el('tr');
  total.append(
    el('td', undefined, 'Total'),
    el('td'),
    el('td', 'is-num', table.totalTokens ?? ''),
    el('td', 'is-num', table.totalTime ?? ''),
    el('td', 'is-num', table.total ?? '—'),
  );
  foot.append(total);
  grid.append(thead, body, foot);
  root.append(grid);
  return root;
}

export interface ActionBarDeps {
  readonly icon: (name: string, size?: number) => SVGElement;
  readonly onThread: () => void;
  readonly onReview: () => void;
}

/** The DOM event of "Decision waiting · go to the card": `detail.id` names the ticket (req-97). */
export const GO_TO_DECISION_CARD = 'drey:tickets-go-to-decision-card';

export interface GoToDecisionCardDetail {
  readonly id: string;
  /** A card that is on screen sets it; still false after dispatch = no card is showing. */
  handled: boolean;
}

/**
 * Asks the decision card of the ticket to take the focus. Returns whether a
 * card answered (the Ready card of the thread does, `ready-view.ts`).
 */
export function goToDecisionCard(id: string): boolean {
  const detail: GoToDecisionCardDetail = { id, handled: false };
  document.dispatchEvent(new CustomEvent<GoToDecisionCardDetail>(GO_TO_DECISION_CARD, { detail }));
  return detail.handled;
}

/**
 * The bar under the ticket: Thread and Open Review. While a decision waits
 * it leads with the quiet link "Decision waiting · go to the card" instead of
 * Accept / Send back — the decision is made on the Mission Control card only
 * (req-97, canvas decision 16). With no card on screen the link opens the
 * thread, where the Ready card sits.
 */
export function actionBarNode(deps: ActionBarDeps, bar: ActionBar): HTMLElement {
  const root = el('div', 'tickets-doc-actions');
  root.contentEditable = 'false';
  const button = (label: string, cls: string, icon: string, run: () => void, title?: string): HTMLButtonElement => {
    const node = el('button', `tickets-doc-btn ${cls}`);
    node.type = 'button';
    node.append(deps.icon(icon, 14), document.createTextNode(label));
    if (title !== undefined) {
      node.title = title;
    }
    node.addEventListener('click', run);
    return node;
  };
  if (bar.decide && bar.ticketId !== null) {
    const id = bar.ticketId;
    const link = el('a', 'tickets-doc-decision-link', 'Decision waiting · go to the card'); // TODO(i18n)
    link.href = '#';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      if (!goToDecisionCard(id)) {
        deps.onThread();
        setTimeout(() => goToDecisionCard(id), 300);
      }
    });
    root.append(link);
  }
  root.append(el('span', 'tickets-doc-spacer'));
  root.append(
    button('Thread', '', 'messages-square', deps.onThread, "The agent's thread for this ticket"),
    button('Open Review', '', 'external-link', deps.onReview, 'The changes and the result card of this ticket'),
  );
  return root;
}

// --- the header strip -------------------------------------------------------

export interface StripData {
  readonly status: TicketStatus;
  /** The persona doing (or next doing) the ticket's current step; '' when none. */
  readonly who: string;
  /** `$1.84 in total`; null while nothing readable was spent. */
  readonly cost: string | null;
  /** `About $0.30 · 9 min` plus its basis as the tooltip; null without an estimate. */
  readonly estimate: { readonly short: string; readonly basis: string } | null;
  readonly chain: readonly ChainItem[];
  /** The gate: why the ticket waits on the owner (`Waits for you: …`); '' when it does not. */
  readonly gate: string;
  /** "Change flow" under the chain (E13-11); absent = no link. */
  readonly onFlow?: () => void;
}

const GLYPH: Record<ChainItem['state'], string> = { past: '✓', current: '●', future: '○' };

/** The status row, the chain and the gate — drawn under the chip row of the ticket header. */
export function stripNode(data: StripData): HTMLElement {
  const root = el('div', 'tickets-doc-strip');

  const facts = el('div', 'tickets-doc-facts');
  facts.append(el('span', `tickets-doc-status is-${data.status.tone}`, data.status.label));
  if (data.who !== '') {
    facts.append(el('span', 'tickets-doc-who', data.who));
  }
  if (data.status.line !== '') {
    facts.append(el('span', 'tickets-doc-line', data.status.line));
  }
  if (data.cost !== null) {
    facts.append(el('span', 'tickets-doc-sep', '·'), el('span', 'tickets-doc-cost-fact', data.cost));
  }
  if (data.estimate !== null) {
    const estimate = el('span', 'tickets-doc-estimate', `est. ${data.estimate.short}`);
    estimate.title = data.estimate.basis;
    facts.append(el('span', 'tickets-doc-sep', '·'), estimate);
  }
  root.append(facts);

  if (data.chain.length > 0) {
    const chain = el('ol', 'tickets-doc-chain');
    chain.setAttribute('aria-label', 'Chain');
    for (const step of data.chain) {
      const item = el('li', `tickets-doc-step is-${step.state}${step.checkpoint ? ' is-checkpoint' : ''}${step.skipped ? ' is-skipped' : ''}`);
      item.append(el('span', 'tickets-doc-step-mark', step.checkpoint && step.state !== 'past' ? '◆' : GLYPH[step.state]));
      item.append(el('span', 'tickets-doc-step-title', step.title));
      if (step.who !== '') {
        item.append(el('span', 'tickets-doc-step-who', step.who));
      }
      if (step.inserted) {
        item.title = 'Added for this ticket';
      }
      chain.append(item);
    }
    root.append(chain);
    if (data.onFlow !== undefined) {
      const change = el('button', 'tickets-doc-flow', 'Change flow');
      change.type = 'button';
      change.title = 'Open the flow editor for this ticket';
      change.addEventListener('click', data.onFlow);
      root.append(change);
    }
  }

  if (data.gate !== '') {
    root.append(el('p', 'tickets-doc-gate', data.gate));
  }
  return root;
}

/**
 * The two marks under the `## Plan` heading (E13-9): who changed the plan
 * last. Paul's line is quiet; the owner's carries the accent, because it
 * is the one that asks something (it goes with the next message).
 */
export function shapeMarksNode(marks: { readonly paul: string | null; readonly you: string | null; readonly youDetail: string | null }): HTMLElement {
  const root = el('div', 'tickets-doc-shape-marks');
  root.contentEditable = 'false';
  if (marks.paul !== null) {
    root.append(el('span', 'tickets-doc-shape-mark is-paul', marks.paul));
  }
  if (marks.you !== null) {
    const you = el('span', 'tickets-doc-shape-mark is-you', marks.you);
    if (marks.youDetail !== null) {
      you.title = marks.youDetail;
    }
    root.append(you);
  }
  return root;
}
