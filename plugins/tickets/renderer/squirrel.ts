/**
 * The worker's pulse as a squirrel (req-75 W4d): a pure pose rule over the
 * fields every run already carries, plus the little inline SVG that draws
 * it. The pose is one `data-pose` attribute — all movement is CSS
 * (`board.css`), so a panel full of squirrels costs no timers.
 */
import type { RunInfo } from '../main/fleet/protocol';
import { LIVE_RUN_STATES } from './message-queue';

export type SquirrelPose = 'run' | 'sprint' | 'sit';

/** A busy worker counts as sprinting while its last activity is this recent. */
export const SPRINT_MS = 4_000;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Lucide's `squirrel` (ISC — the icon set the app already vendors) as four
 * strokes of one 24×24 view box. The animal faces right, the direction it
 * runs, so no mirror is needed.
 */
const STROKES: readonly string[] = [
  'M15.236 22a3 3 0 0 0-2.2-5',
  'M16 20a3 3 0 0 1 3-3h1a2 2 0 0 0 2-2v-2a4 4 0 0 0-4-4V4',
  'M18 13h.01',
  'M18 6a4 4 0 0 0-4 4 7 7 0 0 0-7 7c0-5 4-5 4-10.5a4.5 4.5 0 1 0-9 0 2.5 2.5 0 0 0 5 0C7 10 3 11 3 17c0 2.8 2.2 5 5 5h10',
];

/** The last stroke carries the tail — the CSS wags it by that class. */
const TAIL_STROKE = STROKES.length - 1;

const POSE_LABEL: Readonly<Record<SquirrelPose, string>> = {
  run: 'Worker running',
  sprint: 'Worker sprinting',
  sit: 'Worker idle',
};

/**
 * The pose a run earns: sitting with no run, off a live state, standing
 * idle, or waiting on the owner; sprinting while a busy turn's last
 * activity is within `SPRINT_MS`; running otherwise.
 */
export function squirrelPose(run: RunInfo | null, nowMs: number): SquirrelPose {
  if (run === null || !LIVE_RUN_STATES.includes(run.state) || run.turn === 'idle' || (run.waiting ?? null) !== null) {
    return 'sit';
  }
  const last = Date.parse(run.lastActivity);
  return Number.isFinite(last) && nowMs - last < SPRINT_MS ? 'sprint' : 'run';
}

/**
 * An inline squirrel SVG (24×24 view box, `stroke = currentColor`), sized
 * in pixels, wrapped in a `.tickets-squirrel` span that starts sitting.
 * Built with the SVG DOM — no `innerHTML` (the renderer's CSP).
 */
export function squirrelNode(sizePx: number): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'tickets-squirrel';
  wrap.setAttribute('role', 'img');
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(sizePx));
  svg.setAttribute('height', String(sizePx));
  // The span is the image (pose + label); the drawing itself stays hidden.
  svg.setAttribute('aria-hidden', 'true');
  STROKES.forEach((d, stroke) => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    if (stroke === TAIL_STROKE) {
      path.setAttribute('class', 'tickets-squirrel-tail');
    }
    svg.append(path);
  });
  wrap.append(svg);
  setSquirrelPose(wrap, 'sit');
  return wrap;
}

/** One attribute, one label — the CSS reads `data-pose` and draws the pose. */
export function setSquirrelPose(node: HTMLElement, pose: SquirrelPose): void {
  node.dataset['pose'] = pose;
  node.setAttribute('aria-label', POSE_LABEL[pose]);
}
