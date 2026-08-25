/**
 * The coastline, as editable data rather than a fixed picture.
 *
 * A shape is a ring of points on a coarse grid — one unit is roughly 20 km. The
 * outline between points always runs straight or at 45 degrees; where a pair of
 * points is at some other angle, a corner is inserted when it is drawn, so you
 * can drag a point anywhere and the coast stays in the house style.
 *
 * Neighbouring countries share the points along their border by index, so moving
 * a border point moves it for both and no gap can open between them.
 */

export interface OutlinePoint {
  x: number;
  y: number;
}

export interface OutlineShape {
  id: string;
  name: string;
  fill: string;
  ring: OutlinePoint[];
  /** Points this shape shares with another, as "otherShapeId:index" per own index. */
  shared?: Record<number, string>;
}

export interface Outline {
  /** Map units per outline grid unit. */
  unit: number;
  /** Corner radius in outline units. */
  radius: number;
  shapes: OutlineShape[];
}

/** Insert the corner that keeps every edge horizontal, vertical or diagonal. */
export function legalise(ring: OutlinePoint[]): OutlinePoint[] {
  const out: OutlinePoint[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    out.push(a);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)) continue;
    const m = Math.min(Math.abs(dx), Math.abs(dy));
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    out.push(
      Math.abs(dx) > Math.abs(dy)
        ? { x: b.x - sx * m, y: a.y }
        : { x: a.x, y: b.y - sy * m },
    );
  }
  return out;
}

export function shapePath(shape: OutlineShape, unit: number, radius: number): string {
  const pts = legalise(shape.ring).map((p) => ({ x: p.x * unit, y: p.y * unit }));
  const n = pts.length;
  if (n < 3) return '';
  const r = radius * unit;
  const d: string[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1e-9;
    const l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1e-9;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const u1 = { x: (p1.x - p0.x) / l1, y: (p1.y - p0.y) / l1 };
    const u2 = { x: (p2.x - p1.x) / l2, y: (p2.y - p1.y) / l2 };
    const a = { x: p1.x - u1.x * rr, y: p1.y - u1.y * rr };
    const b = { x: p1.x + u2.x * rr, y: p1.y + u2.y * rr };
    d.push(
      (d.length === 0 ? `M ${a.x.toFixed(1)} ${a.y.toFixed(1)}` : `L ${a.x.toFixed(1)} ${a.y.toFixed(1)}`) +
        ` Q ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`,
    );
  }
  return d.join(' ') + ' Z';
}

export function outlineSvg(outline: Outline): string {
  return outline.shapes
    .map((s) => `<path d="${shapePath(s, outline.unit, outline.radius)}" fill="${s.fill}"/>`)
    .join('\n');
}

/** Move a point, and any point on another shape that is pinned to it. */
export function movePoint(
  outline: Outline,
  shapeId: string,
  index: number,
  to: OutlinePoint,
): void {
  const shape = outline.shapes.find((s) => s.id === shapeId);
  if (!shape || !shape.ring[index]) return;
  shape.ring[index] = { ...to };
  const link = shape.shared?.[index];
  if (!link) return;
  for (const entry of link.split(',')) {
    const [otherId, idxText] = entry.split(':');
    const other = outline.shapes.find((s) => s.id === otherId);
    const idx = Number(idxText);
    if (other && other.ring[idx]) other.ring[idx] = { ...to };
  }
}

export function insertPoint(outline: Outline, shapeId: string, afterIndex: number): number | null {
  const shape = outline.shapes.find((s) => s.id === shapeId);
  if (!shape) return null;
  const a = shape.ring[afterIndex];
  const b = shape.ring[(afterIndex + 1) % shape.ring.length];
  if (!a || !b) return null;
  const mid = { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) };
  shape.ring.splice(afterIndex + 1, 0, mid);
  // indices after the insertion shift by one, so the pin table has to follow
  if (shape.shared) {
    const next: Record<number, string> = {};
    for (const [k, v] of Object.entries(shape.shared)) {
      const i = Number(k);
      next[i > afterIndex ? i + 1 : i] = v;
    }
    shape.shared = next;
  }
  return afterIndex + 1;
}

export function deletePoint(outline: Outline, shapeId: string, index: number): boolean {
  const shape = outline.shapes.find((s) => s.id === shapeId);
  if (!shape || shape.ring.length <= 4) return false;
  if (shape.shared?.[index]) return false; // a border point belongs to two shapes
  shape.ring.splice(index, 1);
  if (shape.shared) {
    const next: Record<number, string> = {};
    for (const [k, v] of Object.entries(shape.shared)) {
      const i = Number(k);
      next[i > index ? i - 1 : i] = v;
    }
    shape.shared = next;
  }
  return true;
}
