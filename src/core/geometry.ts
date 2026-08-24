/**
 * The geometry engine.
 *
 * Everything here works in grid cells until the last moment. Three rules drive it:
 *   - track runs at 90 or 45 degrees only;
 *   - parallel services hold their lane along a whole corridor, so a line does not
 *     shuffle sideways when a neighbour terminates;
 *   - corners are concentric, so bundled lines keep an even gap round a bend.
 */

import type { Cell } from './model';

export type Pt = { x: number; y: number };
export type Step = { a: Cell; b: Cell };

export const cellKey = (c: Cell) => `${c.x},${c.y}`;
const stepKey = (s: Step) => {
  const [p, q] = [s.a, s.b].sort((m, n) => (m.x - n.x) || (m.y - n.y));
  return `${p.x},${p.y}|${q.x},${q.y}`;
};

/** Is this move legal — horizontal, vertical or exactly diagonal? */
export function isOctilinear(a: Cell, b: Cell): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return false;
  return dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy);
}

/** Break a leg into single-cell steps. Throws if the leg is not octilinear. */
export function unitSteps(a: Cell, b: Cell): Step[] {
  if (!isOctilinear(a, b)) {
    throw new Error(`leg ${a.x},${a.y} -> ${b.x},${b.y} is not on 90 or 45 degrees`);
  }
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const n = Math.max(Math.abs(dx), Math.abs(dy));
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const out: Step[] = [];
  let cur = a;
  for (let i = 0; i < n; i++) {
    const next = { x: cur.x + sx, y: cur.y + sy };
    out.push({ a: cur, b: next });
    cur = next;
  }
  return out;
}

/**
 * Work out the bend needed to join two cells that are not already in line.
 *
 * Any two cells can be joined by one straight run and one diagonal, and there
 * are two ways round: straight first, or diagonal first. Returns the corner
 * cell, or null if the cells are already on 90 or 45 degrees.
 */
export function elbow(a: Cell, b: Cell, diagonalFirst = false): Cell | null {
  if (isOctilinear(a, b)) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const m = Math.min(adx, ady);
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  if (diagonalFirst) {
    return { x: a.x + sx * m, y: a.y + sy * m };
  }
  return adx > ady
    ? { x: b.x - sx * m, y: a.y }
    : { x: a.x, y: b.y - sy * m };
}

/**
 * Snap an arbitrary target onto the nearest legal cell reachable from `from`,
 * which is what the editor uses while a station is being dragged.
 */
export function snapOctilinear(from: Cell, target: Cell): Cell {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  if (dx === 0 && dy === 0) return { ...from };
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  // whichever of the eight directions is closest in angle
  if (adx > ady * 2.414) return { x: target.x, y: from.y };
  if (ady > adx * 2.414) return { x: from.x, y: target.y };
  const d = Math.round((adx + ady) / 2);
  return { x: from.x + Math.sign(dx) * d, y: from.y + Math.sign(dy) * d };
}

// ---------------------------------------------------------------- lanes

export interface LaneInput {
  id: string;
  steps: Step[];
  /** Lower ranks sit on one side, higher on the other; keeps lines from crossing. */
  rank: number;
}

export interface LaneTable {
  /** offset in lane units (multiply by pitch) for a given service on a given step */
  offset(stepK: string, id: string): number;
  members(stepK: string): string[];
  key: typeof stepKey;
}

/**
 * Work out which lane each service occupies.
 *
 * Steps are grouped into chains: adjacent steps of one service whose member sets
 * nest inside one another belong to the same corridor. Every service keeps one
 * lane index for a whole chain, so nothing shifts when a neighbour joins or ends.
 */
export function buildLanes(lines: LaneInput[]): LaneTable {
  const members = new Map<string, string[]>();
  for (const l of lines) {
    for (const s of l.steps) {
      const k = stepKey(s);
      const list = members.get(k) ?? [];
      if (!list.includes(l.id)) list.push(l.id);
      members.set(k, list);
    }
  }

  // union-find over step keys
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = parent.get(x) ?? x;
    while (r !== (parent.get(r) ?? r)) r = parent.get(r) ?? r;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const k of members.keys()) parent.set(k, k);

  const nests = (a: string[], b: string[]) =>
    a.every((x) => b.includes(x)) || b.every((x) => a.includes(x));

  for (const l of lines) {
    const keys = l.steps.map(stepKey);
    for (let i = 0; i + 1 < keys.length; i++) {
      const m1 = members.get(keys[i]) ?? [];
      const m2 = members.get(keys[i + 1]) ?? [];
      if (nests(m1, m2)) union(keys[i], keys[i + 1]);
    }
  }

  const rankOf = new Map(lines.map((l) => [l.id, l.rank]));
  const chainOrder = new Map<string, string[]>();
  for (const [k, ids] of members) {
    const root = find(k);
    const set = chainOrder.get(root) ?? [];
    for (const id of ids) if (!set.includes(id)) set.push(id);
    chainOrder.set(root, set);
  }
  for (const [root, ids] of chainOrder) {
    ids.sort((a, b) => (rankOf.get(a) ?? 0) - (rankOf.get(b) ?? 0));
    chainOrder.set(root, ids);
  }

  return {
    key: stepKey,
    members: (k) => members.get(k) ?? [],
    offset(k, id) {
      const order = chainOrder.get(find(k)) ?? [];
      const i = order.indexOf(id);
      if (i < 0) return 0;
      return i - (order.length - 1) / 2;
    },
  };
}

// ---------------------------------------------------------------- polylines

export interface PolyPoint extends Pt {
  /** signed offset from the corridor centre, positive to the left of travel */
  lane: number;
}

/** Turn a service's steps into screen points, offset into its lane. */
export function lanePolyline(
  steps: Step[],
  id: string,
  lanes: LaneTable,
  toPx: (c: Cell) => Pt,
  pitch: number,
): PolyPoint[] {
  const pts: PolyPoint[] = [];
  steps.forEach((s, i) => {
    const k = lanes.key(s);
    const off = lanes.offset(k, id) * pitch;

    // normal taken from the step's canonical direction, so both directions of
    // travel land in the same lane and never swap sides
    const [ca, cb] = [s.a, s.b].sort((m, n) => (m.x - n.x) || (m.y - n.y));
    const pa = toPx(ca);
    const pb = toPx(cb);
    const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
    const nx = -(pb.y - pa.y) / len;
    const ny = (pb.x - pa.x) / len;

    const A = toPx(s.a);
    const B = toPx(s.b);
    const travel = { x: B.x - A.x, y: B.y - A.y };
    const left = { x: -travel.y, y: travel.x };
    const sign = nx * left.x + ny * left.y > 0 ? 1 : -1;

    const push = (t: number) => {
      const p = {
        x: A.x + travel.x * t + nx * off,
        y: A.y + travel.y * t + ny * off,
        lane: off * sign,
      };
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.01) pts.push(p);
    };
    if (i === 0) push(0);
    push(1);
  });
  return pts;
}

/**
 * Rounded corners.
 *
 * The radius is adjusted by the lane's own offset so that bundled lines stay
 * concentric round a bend, and neighbouring corners negotiate: if two are close
 * enough to eat the same straight twice, both shrink until they fit. That is what
 * stops the little S-kinks where a line steps sideways over one cell.
 */
export function roundedPath(pts: PolyPoint[], baseRadius: number): string {
  const n = pts.length;
  if (n < 2) return '';
  const seg: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    seg.push(Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y));
  }
  const rad = new Array(n).fill(0);
  for (let i = 1; i + 1 < n; i++) {
    const l1 = seg[i - 1];
    const l2 = seg[i];
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const u1 = { x: (pts[i].x - pts[i - 1].x) / l1, y: (pts[i].y - pts[i - 1].y) / l1 };
    const u2 = { x: (pts[i + 1].x - pts[i].x) / l2, y: (pts[i + 1].y - pts[i].y) / l2 };
    const cross = u1.x * u2.y - u1.y * u2.x;
    const dot = u1.x * u2.x + u1.y * u2.y;
    if (Math.abs(cross) < 1e-6 && dot > 0) continue; // straight through
    const turnLeft = cross > 0 ? -1 : 1; // screen y points down
    rad[i] = Math.max(3, baseRadius + turnLeft * pts[i].lane);
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i + 1 < n; i++) {
      const total = rad[i] + rad[i + 1];
      if (total > seg[i] && total > 0) {
        const k = seg[i] / total;
        rad[i] *= k;
        rad[i + 1] *= k;
      }
    }
  }

  const d: string[] = [`M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`];
  for (let i = 1; i + 1 < n; i++) {
    if (rad[i] <= 0.01) continue;
    const l1 = seg[i - 1];
    const l2 = seg[i];
    const u1 = { x: (pts[i].x - pts[i - 1].x) / l1, y: (pts[i].y - pts[i - 1].y) / l1 };
    const u2 = { x: (pts[i + 1].x - pts[i].x) / l2, y: (pts[i + 1].y - pts[i].y) / l2 };
    const r = rad[i];
    const a = { x: pts[i].x - u1.x * r, y: pts[i].y - u1.y * r };
    const b = { x: pts[i].x + u2.x * r, y: pts[i].y + u2.y * r };
    d.push(`L ${a.x.toFixed(2)} ${a.y.toFixed(2)}`);
    d.push(`Q ${pts[i].x.toFixed(2)} ${pts[i].y.toFixed(2)} ${b.x.toFixed(2)} ${b.y.toFixed(2)}`);
  }
  d.push(`L ${pts[n - 1].x.toFixed(2)} ${pts[n - 1].y.toFixed(2)}`);
  return d.join(' ');
}

/** Snap a marker's axis to the nearest 45 degrees so blobs never sit askew. */
export function snap45(a: Pt, b: Pt): [Pt, Pt] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [a, b];
  const ang = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const hx = (Math.cos(ang) * len) / 2;
  const hy = (Math.sin(ang) * len) / 2;
  return [
    { x: mx - hx, y: my - hy },
    { x: mx + hx, y: my + hy },
  ];
}
