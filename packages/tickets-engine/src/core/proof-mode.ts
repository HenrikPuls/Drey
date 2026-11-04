/**
 * Proof mode (E11-1, concept v2 §5.3, owner decision D12): a ticket's
 * proof is a UI walkthrough (`ui`) or test results alone (`tests`).
 *
 * Who decides, strongest first: the frontmatter pin `proof:`, then the
 * builder's declaration in the Handover (`proof: ui|tests — <reason>`,
 * which the review step confirms or corrects by rewriting the same
 * line), then the safe default `ui`. A missing or unreadable
 * declaration is never a guess towards the cheap side. Specification:
 * specs/ticket-schema.md, "Proof mode".
 */
import { maskFences } from '../../../../shared/markdown/fences';

export type ProofMode = 'ui' | 'tests';

export type ProofSource = 'pin' | 'handover' | 'default';

export interface ProofResolution {
  readonly mode: ProofMode;
  readonly source: ProofSource;
  /** The declaration's one-sentence reason; null when none was given. */
  readonly reason: string | null;
}

/** The two words a pin or declaration may carry; anything else reads as absent. */
export function parseProofMode(value: unknown): ProofMode | null {
  if (typeof value !== 'string') {
    return null;
  }
  const word = value.trim().toLowerCase();
  return word === 'ui' || word === 'tests' ? word : null;
}

const HANDOVER_HEADING = /^## Handover[ \t]*\r?$/m;
const DECLARATION = /^[ \t]*(?:[-*][ \t]+)?proof:[ \t]*(\S+)(?:[ \t]*[—–-]+[ \t]*(.*?))?[ \t]*$/im;

/**
 * The declaration inside the `## Handover` section; null when the
 * section or the line is absent or names neither word. When a reviewer
 * appended a correction the LAST declaration wins.
 */
export function parseProofDeclaration(ticketText: string): { mode: ProofMode; reason: string | null } | null {
  const scan = maskFences(ticketText);
  const heading = HANDOVER_HEADING.exec(scan);
  if (heading === null) {
    return null;
  }
  const rest = scan.slice(heading.index + heading[0].length);
  const next = /^## /m.exec(rest);
  const section = next === null ? rest : rest.slice(0, next.index);
  let found: { mode: ProofMode; reason: string | null } | null = null;
  for (const line of section.split(/\r?\n/)) {
    const match = DECLARATION.exec(line);
    const mode = match === null ? null : parseProofMode(match[1]);
    if (match !== null && mode !== null) {
      const reason = match[2]?.trim() ?? '';
      found = { mode, reason: reason === '' ? null : reason };
    }
  }
  return found;
}

/** The pin (frontmatter) wins over the declaration; the default is `ui`. */
export function resolveProofMode(pin: ProofMode | null, ticketText: string): ProofResolution {
  const declared = parseProofDeclaration(ticketText);
  if (pin !== null) {
    return { mode: pin, source: 'pin', reason: declared?.reason ?? null };
  }
  if (declared !== null) {
    return { mode: declared.mode, source: 'handover', reason: declared.reason };
  }
  return { mode: 'ui', source: 'default', reason: null };
}
