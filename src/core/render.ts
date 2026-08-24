/**
 * Renders a map document to SVG. The same code drives the on-screen canvas, the
 * SVG and PDF exports, and eventually the web version — so nothing in here may
 * depend on the DOM.
 */

import type { Cell, MapDoc, Operator, Service, Station } from './model';
import { nodeCell } from './model';
import {
  buildLanes,
  lanePolyline,
  roundedPath,
  snap45,
  unitSteps,
  type LaneInput,
  type Pt,
  type Step,
} from './geometry';

export interface Theme {
  lineWidth: number;
  /** gap between parallel lines, as a multiple of line width */
  laneGap: number;
  cornerRadius: number;
  tickWidth: number;
  ink: string;
  grey: string;
}

export const defaultTheme: Theme = {
  lineWidth: 7.2,
  laneGap: 2,
  cornerRadius: 13,
  tickWidth: 3.6,
  ink: '#111111',
  grey: '#9A9A9A',
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Drawn {
  service: Service;
  steps: Step[];
  colour: string;
  /** where this service meets each station it touches */
  hits: Map<string, { pt: Pt; dir: Pt; lane: number }>;
}

export function serviceColour(
  svc: Service,
  operators: Record<string, Operator>,
  fallback: string,
): string {
  if (svc.colour) return svc.colour;
  const op = svc.operatorId ? operators[svc.operatorId] : undefined;
  return op?.colour ?? fallback;
}

/** A route with no services on it is drawn grey, and so are its station names. */
function routeHasServices(doc: MapDoc, routeId: string): boolean {
  return Object.values(doc.services).some((s) => s.routeIds.includes(routeId));
}

function servicePath(doc: MapDoc, svc: Service): Cell[] {
  const cells: Cell[] = [];
  for (const rid of svc.routeIds) {
    const route = doc.routes[rid];
    if (!route) continue;
    for (const node of route.path) {
      const c = nodeCell(doc, node);
      const last = cells[cells.length - 1];
      if (!last || last.x !== c.x || last.y !== c.y) cells.push(c);
    }
  }
  return cells;
}

function stepsFor(cells: Cell[]): Step[] {
  const out: Step[] = [];
  for (let i = 0; i + 1 < cells.length; i++) out.push(...unitSteps(cells[i], cells[i + 1]));
  return out;
}

export interface RenderOptions {
  doc: MapDoc;
  operators: Record<string, Operator>;
  theme?: Theme;
  /** base map SVG markup dropped in behind the network */
  basemap?: string;
  palette?: string[];
}

const FALLBACK_PALETTE = [
  '#0A55C4', '#0E8A3E', '#E2620E', '#7A2E8E', '#C4161C',
  '#0E8C8C', '#B58B00', '#7B4A22', '#C6216B', '#2F5E33',
];

export function renderSvg(opts: RenderOptions): string {
  const { doc, operators } = opts;
  const theme = opts.theme ?? defaultTheme;
  const palette = opts.palette ?? FALLBACK_PALETTE;
  const cs = doc.cellSize;
  const pitch = theme.lineWidth * theme.laneGap;

  const toPx = (c: Cell): Pt => ({ x: c.x * cs, y: c.y * cs });

  // ---- assemble what has to be drawn -------------------------------------
  const services = Object.values(doc.services);
  const lanes = buildLanes(
    services.map<LaneInput>((s, i) => ({
      id: s.id,
      steps: stepsFor(servicePath(doc, s)),
      rank: i,
    })),
  );

  const drawn: Drawn[] = services.map((svc, i) => {
    const cells = servicePath(doc, svc);
    const steps = stepsFor(cells);
    const colour = serviceColour(svc, operators, palette[i % palette.length]);
    const pts = lanePolyline(steps, svc.id, lanes, toPx, pitch);

    // where does this service meet each station on its path?
    const hits = new Map<string, { pt: Pt; dir: Pt; lane: number }>();
    const cellToStation = new Map<string, string>();
    for (const rid of svc.routeIds) {
      const route = doc.routes[rid];
      if (!route) continue;
      for (const node of route.path) {
        if (node.kind !== 'station') continue;
        for (const c of doc.stations[node.id]?.cells ?? []) {
          cellToStation.set(`${c.x},${c.y}`, node.id);
        }
      }
    }
    steps.forEach((s, si) => {
      const k = lanes.key(s);
      const off = lanes.offset(k, svc.id) * pitch;
      const [ca, cb] = [s.a, s.b].sort((m, n) => (m.x - n.x) || (m.y - n.y));
      const pa = toPx(ca);
      const pb = toPx(cb);
      const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
      const nx = -(pb.y - pa.y) / len;
      const ny = (pb.x - pa.x) / len;
      const A = toPx(s.a);
      const B = toPx(s.b);
      const dl = Math.hypot(B.x - A.x, B.y - A.y) || 1;
      const dir = { x: (B.x - A.x) / dl, y: (B.y - A.y) / dl };
      for (const node of [s.a, s.b]) {
        const sid = cellToStation.get(`${node.x},${node.y}`);
        if (!sid) continue;
        const P = toPx(node);
        hits.set(sid, { pt: { x: P.x + nx * off, y: P.y + ny * off }, dir, lane: off });
      }
      void si;
    });

    return { service: svc, steps, colour, hits, ...({ pts } as object) } as Drawn & { pts: typeof pts };
  });

  // ---- lines --------------------------------------------------------------
  const under: string[] = [];
  const lines: string[] = [];
  const over: string[] = [];

  for (const d of drawn) {
    const pts = lanePolyline(d.steps, d.service.id, lanes, toPx, pitch);
    const path = roundedPath(pts, theme.cornerRadius);
    const grey = d.service.routeIds.every((r) => !routeHasServices(doc, r));
    const col = grey ? theme.grey : d.colour;
    const w = theme.lineWidth;
    const common = 'fill="none" stroke-linejoin="round" stroke-linecap="butt"';
    switch (d.service.style) {
      case 'metro':
        lines.push(`<path d="${path}" ${common} stroke="${col}" stroke-width="${w}"/>`);
        lines.push(`<path d="${path}" ${common} stroke="#ffffff" stroke-width="${w - 3.2}"/>`);
        break;
      case 'heritage':
        lines.push(`<path d="${path}" ${common} stroke="${col}" stroke-width="${w * 0.55}"/>`);
        break;
      case 'construction':
        lines.push(`<path d="${path}" ${common} stroke="${col}" stroke-width="${w}"/>`);
        lines.push(`<path d="${path}" ${common} stroke="url(#hatch)" stroke-width="${w - 3}"/>`);
        break;
      case 'ferry':
        lines.push(
          `<path d="${path}" ${common} stroke="${col}" stroke-width="${w * 0.55}" stroke-dasharray="13 7"/>`,
        );
        break;
      case 'bus':
        lines.push(
          `<path d="${path}" fill="none" stroke="${col}" stroke-width="${w * 0.55}" stroke-dasharray="0.1 6" stroke-linecap="round"/>`,
        );
        break;
      default:
        lines.push(`<path d="${path}" ${common} stroke="${col}" stroke-width="${w}"/>`);
    }
    if (d.service.oneWayWhole) over.push(...chevrons(pts, w));
  }

  // ---- station markers ----------------------------------------------------
  const R = theme.lineWidth * 0.66;
  const border = 2.6;

  for (const st of Object.values(doc.stations)) {
    const calling = drawn.filter((d) => d.service.calls.includes(st.id) && d.hits.has(st.id));
    const passing = drawn.filter((d) => !d.service.calls.includes(st.id) && d.hits.has(st.id));
    if (calling.length === 0 && passing.length === 0) continue;

    if (st.kind === 'grey') {
      const p = toPx(st.cells[0]);
      over.push(
        `<circle cx="${p.x}" cy="${p.y}" r="${R}" fill="${theme.grey}" stroke="${theme.ink}" stroke-width="${border * 0.8}"/>`,
      );
      continue;
    }
    if (calling.length === 0) continue;

    if (!st.interchange && calling.length >= 1) {
      // ordinary stop: one tick per calling service, in that service's colour,
      // sticking out of one side and long enough to graze the next line along
      for (const d of calling) {
        const h = d.hits.get(st.id)!;
        const nx = -h.dir.y;
        const ny = h.dir.x;
        const L = theme.lineWidth * 1.72;
        over.push(
          `<line x1="${h.pt.x.toFixed(1)}" y1="${h.pt.y.toFixed(1)}" x2="${(h.pt.x + nx * L).toFixed(1)}" y2="${(h.pt.y + ny * L).toFixed(1)}" stroke="${d.colour}" stroke-width="${theme.tickWidth}"/>`,
        );
      }
      continue;
    }

    // interchange: one bar per arm, snapped to 45 degrees, meeting at right angles
    const arms = new Map<string, { pt: Pt; lane: number }[]>();
    for (const d of calling) {
      const h = d.hits.get(st.id)!;
      const axis = Math.abs(h.dir.x) > Math.abs(h.dir.y) ? 'h' : 'v';
      const list = arms.get(axis) ?? [];
      list.push({ pt: h.pt, lane: h.lane });
      arms.set(axis, list);
    }
    const bars: [Pt, Pt][] = [];
    for (const [, list] of arms) {
      list.sort((a, b) => a.lane - b.lane);
      const [p, q] = snap45(list[0].pt, list[list.length - 1].pt);
      bars.push([p, q]);
    }
    // a non-stopping line through the middle: the blobs join beneath it
    if (passing.length && bars.length === 1) {
      const [p, q] = bars[0];
      under.push(
        `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="${theme.ink}" stroke-width="${2 * (R / 3) + 2 * border}"/>`,
        `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="#ffffff" stroke-width="${2 * (R / 3)}"/>`,
      );
    }
    for (const [p, q] of bars) {
      over.push(
        `<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke="${theme.ink}" stroke-width="${2 * R + 2 * border}" stroke-linecap="round"/>`,
      );
    }
    for (const [p, q] of bars) {
      over.push(
        `<line x1="${p.x.toFixed(1)}" y1="${p.y.toFixed(1)}" x2="${q.x.toFixed(1)}" y2="${q.y.toFixed(1)}" stroke="#ffffff" stroke-width="${2 * R}" stroke-linecap="round"/>`,
      );
    }
  }

  // ---- labels -------------------------------------------------------------
  const labels: string[] = [];
  for (const st of Object.values(doc.stations)) {
    if (!st.name) continue;
    const p = toPx(st.cells[0]);
    const colour = labelColour(doc, st, operators, theme);
    const x = (p.x + R + 8).toFixed(1);
    const y = (p.y + 4.8).toFixed(1);
    const t = esc(st.name);
    labels.push(
      `<text x="${x}" y="${y}" font-size="13.5" font-weight="600" fill="none" stroke="#ffffff" stroke-width="3.6" stroke-linejoin="round">${t}</text>`,
      `<text x="${x}" y="${y}" font-size="13.5" font-weight="600" fill="${colour}">${t}</text>`,
    );
  }

  const bounds = contentBounds(doc, cs);
  const defs = `<defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#ffffff"/><line x1="0" y1="0" x2="0" y2="7" stroke="#5A6B7A" stroke-width="3"/></pattern></defs>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.join(' ')}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">`,
    defs,
    opts.basemap ?? '',
    ...under,
    ...lines,
    ...over,
    ...labels,
    '</svg>',
  ].join('\n');
}

function labelColour(
  doc: MapDoc,
  st: Station,
  operators: Record<string, Operator>,
  theme: Theme,
): string {
  const calling = Object.values(doc.services).filter((s) => s.calls.includes(st.id));
  if (calling.length === 0) return theme.grey;
  const ops = new Set<string>();
  let metroOnly = true;
  for (const s of calling) {
    if (s.style !== 'metro') metroOnly = false;
    if (s.operatorId) ops.add(s.operatorId);
  }
  if (metroOnly) return '#7A7A7A';
  if (ops.size === 1) {
    const op = operators[[...ops][0]];
    return op?.colour ?? theme.ink;
  }
  return theme.ink;
}

function contentBounds(doc: MapDoc, cs: number): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const st of Object.values(doc.stations)) {
    for (const c of st.cells) {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x);
      maxY = Math.max(maxY, c.y);
    }
  }
  if (!Number.isFinite(minX)) return [0, 0, 800, 600];
  const pad = 3;
  return [
    (minX - pad) * cs,
    (minY - pad) * cs,
    (maxX - minX + pad * 2) * cs,
    (maxY - minY + pad * 2) * cs,
  ];
}

/** Solid chevrons, full line width, evenly spaced along the run. */
function chevrons(pts: { x: number; y: number }[], w: number): string[] {
  const segs: [Pt, Pt][] = [];
  for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);
  const lens = segs.map(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y));
  const total = lens.reduce((a, b) => a + b, 0);
  const n = Math.max(1, Math.round(total / 58));
  const gap = total / n;
  const targets = Array.from({ length: n }, (_, i) => gap * (i + 0.5));
  const out: string[] = [];
  let acc = 0;
  let ti = 0;
  segs.forEach(([a, b], i) => {
    const L = lens[i];
    if (L < 1e-6) return;
    const u = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    const nrm = { x: -u.y, y: u.x };
    while (ti < targets.length && targets[ti] <= acc + L) {
      const t = targets[ti] - acc;
      const cx = a.x + u.x * t;
      const cy = a.y + u.y * t;
      const h = w / 2;
      const th = w * 0.44;
      const f = h * 0.55;
      const p = [
        [cx + u.x * f, cy + u.y * f],
        [cx + u.x * (f - h) + nrm.x * h, cy + u.y * (f - h) + nrm.y * h],
        [cx + u.x * (f - h - th) + nrm.x * h, cy + u.y * (f - h - th) + nrm.y * h],
        [cx + u.x * (f - th), cy + u.y * (f - th)],
        [cx + u.x * (f - h - th) - nrm.x * h, cy + u.y * (f - h - th) - nrm.y * h],
        [cx + u.x * (f - h) - nrm.x * h, cy + u.y * (f - h) - nrm.y * h],
      ];
      out.push(
        `<path d="M ${p.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L ')} Z" fill="#fff"/>`,
      );
      ti++;
    }
    acc += L;
  });
  return out;
}
