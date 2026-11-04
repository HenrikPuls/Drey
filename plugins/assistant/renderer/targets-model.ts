/**
 * The pure halves of the conversation targets (E13-5): how the registered
 * targets fold into switcher segments, and how a view's default target id
 * resolves. No DOM, no API -- `targets.ts` wires them.
 */
import type { ConversationTarget } from '../../../shared/plugin-api/renderer';

/** The Assistant's own model: plain chat, always present, the Notes default. */
export const MODEL_TARGET = 'model';

/** One switcher segment: the model, one target, or a group of targets behind a menu. */
export interface TargetSegment {
  /** `model`, a target id, or `group:<name>`. */
  readonly key: string;
  readonly label: string;
  readonly description: string;
  /** Empty for the model; one for a plain target; several for a group. */
  readonly targets: readonly ConversationTarget[];
}

/** Model first, then the targets in registration order; a `group` folds its members into one segment at the first member's place. */
export function segmentsOf(targets: readonly ConversationTarget[]): readonly TargetSegment[] {
  const segments: TargetSegment[] = [
    { key: MODEL_TARGET, label: 'Model', description: 'Plain chat with the model from Settings → Assistant', targets: [] },
  ];
  const groups = new Map<string, ConversationTarget[]>();
  for (const target of targets) {
    if (target.group === undefined || target.group === '') {
      segments.push({ key: target.id, label: target.label, description: target.description ?? target.label, targets: [target] });
      continue;
    }
    const known = groups.get(target.group);
    if (known !== undefined) {
      known.push(target);
      continue;
    }
    const members = [target];
    groups.set(target.group, members);
    segments.push({
      key: `group:${target.group}`,
      label: target.group,
      description: `Talk to one of ${target.group}`,
      targets: members,
    });
  }
  return segments;
}

/** The segment that holds the target `id` (`model` holds itself); null when unknown. */
export function segmentOf(segments: readonly TargetSegment[], id: string): TargetSegment | null {
  if (id === MODEL_TARGET) {
    return segments[0] ?? null;
  }
  return segments.find((segment) => segment.targets.some((target) => target.id === id)) ?? null;
}

/**
 * What the active view's default means right now: no default = the model;
 * a default that is registered = select it; a default that is not (yet)
 * registered = wait (its plugin may load after the Assistant).
 */
export function resolveViewDefault(
  viewTarget: string | null,
  registered: readonly string[],
): { readonly kind: 'select'; readonly id: string } | { readonly kind: 'wait' } {
  if (viewTarget === null || viewTarget === MODEL_TARGET) {
    return { kind: 'select', id: MODEL_TARGET };
  }
  return registered.includes(viewTarget) ? { kind: 'select', id: viewTarget } : { kind: 'wait' };
}
