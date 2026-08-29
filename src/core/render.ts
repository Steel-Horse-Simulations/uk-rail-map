/**
 * Renders a map document to SVG. The same code drives the on-screen canvas, the
 * SVG and PDF exports, and eventually the web version — so nothing in here may
 * depend on the DOM.
 */

import type { Cell, MapDoc, Operator, Service, Station } from './model';
import { nodeCell } from './model';
import { outlineSvg } from './outline';
import {
  buildLanes,
  elbow,
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

export const defaultTheme: Theme = themeForCell(34, 2);

/**
 * How heavily the map is drawn.
 *
 * The grid pitch decides how finely stations can be placed; the weight decides
 * how thick the drawing is. They have to be separate, because the two pull in
 * opposite directions: a city needs a fine pitch to fit its stations in, while a
 * view of half the country needs heavy lines to be legible at all. Tying them
 * together makes one scale unusable whichever way you set it.
 */
export function themeForCell(cellSize: number, weight = 2): Theme {
  const w = cellSize * 0.3 * weight;
  return {
    lineWidth: w,
    laneGap: 2,
    cornerRadius: w * 5,   // room for a few lanes either side and still curve
    tickWidth: w * 0.5,
    ink: '#111111',
    grey: '#9A9A9A',
  };
}

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

/**
 * The cells a service runs over, as one run per route.
 *
 * Routes are NOT strung end to end. A branch leaves from the middle of its
 * parent, so joining the parent's last cell to the branch's first describes a
 * leap across the map that is not track at all — which is what threw "not on 90
 * or 45 degrees" and stopped the whole map drawing. Each route is drawn as its
 * own run; where they meet at a junction they simply meet.
 */
function serviceRuns(doc: MapDoc, svc: Service): Cell[][] {
  const reach = serviceStations(doc, svc);
  const runs: Cell[][] = [];

  for (const rid of svc.routeIds) {
    const route = doc.routes[rid];
    if (!route) continue;

    const nodes: { cell: Cell; station?: string }[] = [];
    for (const node of route.path) {
      const cell = nodeCell(doc, node);
      const last = nodes[nodes.length - 1];
      if (last && last.cell.x === cell.x && last.cell.y === cell.y) continue;
      nodes.push({ cell, station: node.kind === 'station' ? node.id : undefined });
    }
    if (nodes.length < 2) continue;

    // trim this route to the part the service actually reaches
    let start = 0;
    let end = nodes.length - 1;
    if (svc.fromStation || svc.toStation) {
      const first = nodes.findIndex((n) => n.station && reach.includes(n.station));
      const lastIdx = nodes.map((n) => (n.station && reach.includes(n.station) ? 1 : 0)).lastIndexOf(1);
      if (first >= 0 && lastIdx >= first) {
        start = first;
        end = lastIdx;
      }
    }
    const run = nodes.slice(start, end + 1).map((n) => n.cell);
    if (run.length >= 2) runs.push(run);
  }
  return runs;
}

/** The stations a service actually reaches, in order, after trimming. */
export function serviceStations(doc: MapDoc, svc: Service): string[] {
  const ids: string[] = [];
  for (const rid of svc.routeIds) {
    const route = doc.routes[rid];
    if (!route) continue;
    for (const node of route.path) {
      if (node.kind === 'station' && !ids.includes(node.id)) ids.push(node.id);
    }
  }
  let start = 0;
  let end = ids.length - 1;
  if (svc.fromStation) {
    const i = ids.indexOf(svc.fromStation);
    if (i >= 0) start = i;
  }
  if (svc.toStation) {
    const i = ids.indexOf(svc.toStation);
    if (i >= 0) end = i;
  }
  if (start > end) [start, end] = [end, start];
  return ids.slice(start, end + 1);
}

/**
 * Break a path into steps, mending it as we go.
 *
 * Dragging a station can leave a leg that is neither square nor diagonal. That
 * used to throw, which stopped the entire map drawing over one bad corner. A
 * corner is inserted instead — the same one the route tool would have added —
 * so the map always draws and the worst case is a bend you did not choose.
 */
/**
 * Break a run of cells into single steps, inserting the corner where two are not
 * already in line. A leg that still cannot be walked is skipped rather than
 * thrown: one bad leg should cost you that leg, not the entire map.
 */
function stepsForRun(cells: Cell[]): Step[] {
  const out: Step[] = [];
  for (let i = 0; i + 1 < cells.length; i++) {
    const a = cells[i];
    const b = cells[i + 1];
    try {
      const bend = elbow(a, b);
      if (bend) out.push(...unitSteps(a, bend), ...unitSteps(bend, b));
      else out.push(...unitSteps(a, b));
    } catch {
      /* skip the leg */
    }
  }
  return out;
}

function stepsFor(runs: Cell[][]): Step[] {
  return runs.flatMap(stepsForRun);
}

export interface RenderOptions {
  doc: MapDoc;
  operators: Record<string, Operator>;
  theme?: Theme;
  /** base map SVG markup dropped in behind the network */
  basemap?: string;
  /** the editable coastline, drawn behind everything */
  outline?: import('./outline').Outline;
  /**
   * While building, a route with no services yet is drawn in its own colour so a
   * dozen of them in one city stay apart. Everywhere else they are grey.
   */
  buildColours?: boolean;
  /** extra layers behind the network (grid, towns) */
  underlays?: string;
  /** extra layers in front (drawing preview, selection) */
  overlays?: string;
  palette?: string[];
}

const FALLBACK_PALETTE = [
  '#0A55C4', '#0E8A3E', '#E2620E', '#7A2E8E', '#C4161C',
  '#0E8C8C', '#B58B00', '#7B4A22', '#C6216B', '#2F5E33',
];

export function renderSvg(opts: RenderOptions): string {
  const { doc, operators } = opts;
  const theme = opts.theme ?? themeForCell(doc.cellSize, doc.weight ?? 2);
  const palette = opts.palette ?? FALLBACK_PALETTE;
  const cs = doc.cellSize;
  const pitch = theme.lineWidth * theme.laneGap;

  const toPx = (c: Cell): Pt => ({ x: c.x * cs, y: c.y * cs });

  // ---- assemble what has to be drawn -------------------------------------
  const services = Object.values(doc.services);
  const lanes = buildLanes(
    services.map<LaneInput>((s, i) => ({
      id: s.id,
      steps: stepsFor(serviceRuns(doc, s)),
      rank: s.order ?? i,
    })),
  );

  const drawn: Drawn[] = services.map((svc, i) => {
    const runs = serviceRuns(doc, svc);
    const steps = stepsFor(runs);
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

  // ---- routes with nothing running over them yet --------------------------
  // A route is real track whether or not a service uses it, so it has to be
  // drawn: grey, with grey names, until the first service arrives.
  const baseLines: string[] = [];
  for (const rt of Object.values(doc.routes)) {
    if (routeHasServices(doc, rt.id)) continue;
    const cells: Cell[] = rt.path.map((n) => nodeCell(doc, n));
    if (cells.length < 2) continue;
    // routes were drawn as plain straight segments, so their corners came out
    // sharp while services curved; they go through the same rounding now
    const pts = stepsForRun(cells).reduce<{ x: number; y: number; lane: number }[]>(
      (acc, step, i) => {
        if (i === 0) acc.push({ x: step.a.x * cs, y: step.a.y * cs, lane: 0 });
        acc.push({ x: step.b.x * cs, y: step.b.y * cs, lane: 0 });
        return acc;
      },
      [],
    );
    const d = roundedPath(pts, theme.cornerRadius);
    const col = (opts.buildColours && rt.buildColour) || theme.grey;
    baseLines.push(
      `<path d="${d}" fill="none" stroke="${col}" stroke-width="${theme.lineWidth}" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
  }

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
  const border = theme.lineWidth * 0.16;

  for (const st of Object.values(doc.stations)) {
    const calling = drawn.filter((d) => d.service.calls.includes(st.id) && d.hits.has(st.id));
    const passing = drawn.filter((d) => !d.service.calls.includes(st.id) && d.hits.has(st.id));
    // a station with no service yet still needs to be on the map
    if (calling.length === 0 && passing.length === 0) {
      const own = opts.buildColours ? buildColourFor(doc, st) : undefined;
      const greyish = own ?? theme.grey;
      const bar = stationExtent(st, cs);
      if (bar) {
        over.push(
          `<line x1="${bar[0].x}" y1="${bar[0].y}" x2="${bar[1].x}" y2="${bar[1].y}" stroke="${greyish}" stroke-width="${2 * R + 2 * border}" stroke-linecap="round"/>`,
          `<line x1="${bar[0].x}" y1="${bar[0].y}" x2="${bar[1].x}" y2="${bar[1].y}" stroke="#ffffff" stroke-width="${2 * R}" stroke-linecap="round"/>`,
        );
      } else {
        const p = toPx(st.cells[0]);
        over.push(
          `<circle cx="${p.x}" cy="${p.y}" r="${R}" fill="#ffffff" stroke="${greyish}" stroke-width="${border}"/>`,
        );
      }
      continue;
    }

    if (st.kind === 'grey') {
      const p = toPx(st.cells[0]);
      over.push(
        `<circle cx="${p.x}" cy="${p.y}" r="${R}" fill="${theme.grey}" stroke="${theme.ink}" stroke-width="${border * 0.8}"/>`,
      );
      continue;
    }
    if (calling.length === 0) continue;

    // A dot is a deliberate choice: only where the station is set to Terminus,
    // or ticked as an interchange. The end of a line is otherwise just a tick.
    if (!st.interchange && st.kind === 'terminus') {
      const pts = calling.map((d) => d.hits.get(st.id)!.pt);
      const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
      const ring = calling.length === 1 ? calling[0].colour : theme.ink;
      const extent = stationExtent(st, cs);
      if (extent) {
        over.push(
          `<line x1="${extent[0].x}" y1="${extent[0].y}" x2="${extent[1].x}" y2="${extent[1].y}" stroke="${ring}" stroke-width="${2 * R + 2 * border}" stroke-linecap="round"/>`,
          `<line x1="${extent[0].x}" y1="${extent[0].y}" x2="${extent[1].x}" y2="${extent[1].y}" stroke="#ffffff" stroke-width="${2 * R}" stroke-linecap="round"/>`,
        );
      } else {
        // drawn as the interchange blob is, so the two match in size
        over.push(
          `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(theme.lineWidth * 0.76).toFixed(1)}" fill="${ring}"/>`,
          `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(theme.lineWidth * 0.5).toFixed(1)}" fill="#ffffff"/>`,
        );
      }
      continue;
    }

    if (!st.interchange && calling.length >= 1) {
      // An ordinary stop is a circle on each line that calls there — one per
      // service, sitting in that service's own lane. Ticks read poorly once a
      // corridor carries more than a line or two.
      for (const d of calling) {
        const { pt } = d.hits.get(st.id)!;
        const col = d.service.routeIds.every((r) => !routeHasServices(doc, r)) ? theme.grey : d.colour;
        // sized against the line itself: the ring stands a little proud of it,
        // and the white middle is about as wide as the line
        const outer = theme.lineWidth * 0.76;
        const inner = theme.lineWidth * 0.5;
        over.push(
          `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${outer.toFixed(1)}" fill="${col}"/>`,
          `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${inner.toFixed(1)}" fill="#ffffff"/>`,
        );
      }
      continue;
    }

    // Interchange marker.
    //
    // The body runs along the station's own axis — worked out from the lines
    // through it, or fixed by hand. Services that terminate here get an arm
    // that grows outward from the body rather than stretching it from the
    // middle, so the station itself never shifts as more trains are added.
    const centre = stationCentre(st, cs);
    const axis = stationAxis(st, calling, cs);
    const perp = { x: -axis.y, y: axis.x };

    const through = calling.filter((d) => !terminatesHere(doc, d.service, st.id));
    const ending = calling.filter((d) => terminatesHere(doc, d.service, st.id));

    const along = (p: Pt) => (p.x - centre.x) * axis.x + (p.y - centre.y) * axis.y;

    // half length of the body: enough for its cells and for every through line
    let half = 0;
    for (const c of st.cells) {
      const p = toPx(c);
      half = Math.max(half, Math.abs(along(p)));
    }
    for (const d of through) half = Math.max(half, Math.abs(along(d.hits.get(st.id)!.pt)));

    const bars: [Pt, Pt][] = [
      [
        { x: centre.x - axis.x * half, y: centre.y - axis.y * half },
        { x: centre.x + axis.x * half, y: centre.y + axis.y * half },
      ],
    ];

    if (ending.length) {
      const side = st.armSide ? compass(st.armSide) : dominantSide(ending, centre, perp);
      // how far out the terminating platforms sit, measured along the arm
      let reach = 0;
      for (const d of ending) {
        const p = d.hits.get(st.id)!.pt;
        reach = Math.max(reach, (p.x - centre.x) * side.x + (p.y - centre.y) * side.y);
      }
      // a chosen side is honoured even when nothing sticks out that way yet
      if (st.armSide) reach = Math.max(reach, R * 2.4);
      const root = { x: centre.x, y: centre.y };
      const tip = { x: centre.x + side.x * reach, y: centre.y + side.y * reach };
      if (reach > 1) bars.push([root, tip]);
      // and the arm spans the terminating platforms across its own width
      let spread = 0;
      for (const d of ending) spread = Math.max(spread, Math.abs(along(d.hits.get(st.id)!.pt)));
      if (spread > 1) {
        bars.push([
          { x: tip.x - axis.x * spread, y: tip.y - axis.y * spread },
          { x: tip.x + axis.x * spread, y: tip.y + axis.y * spread },
        ]);
      }
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
  // A name belongs at the far end of the station's tick, clear of the line, not
  // sitting across it.
  const labels: string[] = [];
  for (const st of Object.values(doc.stations)) {
    if (!st.name) continue;
    const calling = drawn.filter((d) => d.service.calls.includes(st.id) && d.hits.has(st.id));
    const colour = labelColour(doc, st, operators, theme);

    let anchorPt = toPx(st.cells[0]);
    let away = { x: 1, y: 0 };
    if (calling.length) {
      const h = calling[0].hits.get(st.id)!;
      anchorPt = h.pt;
      // the tick sticks out on one side; the name follows it
      const sign = st.tickSide === 'left' ? -1 : 1;
      away = { x: -h.dir.y * sign, y: h.dir.x * sign };
      if (st.interchange || calling.length > 1) {
        const c = stationCentre(st, cs);
        const axis = stationAxis(st, calling, cs);
        const sign = st.tickSide === 'left' ? -1 : 1;
        anchorPt = c;
        away = { x: -axis.y * sign, y: axis.x * sign };
      }
    }
    // a chosen side wins over whichever way the tick happens to point
    if (st.labelSide) {
      away = compass(st.labelSide);
      anchorPt = st.interchange || calling.length > 1 ? stationCentre(st, cs) : anchorPt;
    }
    const clear = (st.interchange || calling.length > 1 ? R + border : theme.lineWidth * 0.76) + theme.lineWidth * 0.7;
    const x = anchorPt.x + away.x * clear;
    const y = anchorPt.y + away.y * clear;

    // Where the tick points up or down there is room to centre a flat name on it.
    // Where it points left or right there is not — the name has to run away from
    // the line instead, or half of it lands back across the track. A tilted name
    // always starts at the tick and runs outward.
    const upright = Math.abs(away.y) > Math.abs(away.x);
    const anchor = st.labelAngle
      ? away.x >= 0
        ? 'start'
        : 'end'
      : upright
        ? 'middle'
        : away.x > 0
          ? 'start'
          : 'end';
    const dy = (st.labelAngle ? 0.36 : away.y > 0.3 ? 0.9 : away.y < -0.3 ? -0.37 : 0.36) * theme.lineWidth * 1.9;
    const rot = st.labelAngle ? ` transform="rotate(${st.labelAngle} ${x.toFixed(1)} ${(y + dy).toFixed(1)})"` : '';
    const t = esc(st.name);
    const fs = theme.lineWidth * 1.9;
    labels.push(
      `<text x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}" font-size="${fs.toFixed(1)}" font-weight="600" text-anchor="${anchor}" fill="none" stroke="#ffffff" stroke-width="${(fs * 0.27).toFixed(1)}" stroke-linejoin="round"${rot}>${t}</text>`,
      `<text x="${x.toFixed(1)}" y="${(y + dy).toFixed(1)}" font-size="${fs.toFixed(1)}" font-weight="600" text-anchor="${anchor}" fill="${colour}"${rot}>${t}</text>`,
    );
  }

  const bounds = contentBounds(doc, cs);
  const defs = `<defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#ffffff"/><line x1="0" y1="0" x2="0" y2="7" stroke="#5A6B7A" stroke-width="3"/></pattern></defs>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.join(' ')}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif">`,
    defs,
    opts.outline ? outlineSvg(opts.outline) : (opts.basemap ?? ''),
    opts.underlays ?? '',
    ...baseLines,
    ...under,
    ...lines,
    ...over,
    ...labels,
    opts.overlays ?? '',
    '</svg>',
  ].join('\n');
}

/** The bar covering every cell a large station occupies, or null if it is one cell. */
function stationExtent(st: Station, cs: number): [Pt, Pt] | null {
  if (st.cells.length < 2) return null;
  let a = st.cells[0];
  let b = st.cells[0];
  let best = -1;
  for (const p of st.cells) {
    for (const q of st.cells) {
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d > best) {
        best = d;
        a = p;
        b = q;
      }
    }
  }
  const [p, q] = snap45({ x: a.x * cs, y: a.y * cs }, { x: b.x * cs, y: b.y * cs });
  return [p, q];
}

const COMPASS: Record<string, Pt> = {
  E: { x: 1, y: 0 },
  SE: { x: Math.SQRT1_2, y: Math.SQRT1_2 },
  S: { x: 0, y: 1 },
  SW: { x: -Math.SQRT1_2, y: Math.SQRT1_2 },
  W: { x: -1, y: 0 },
  NW: { x: -Math.SQRT1_2, y: -Math.SQRT1_2 },
  N: { x: 0, y: -1 },
  NE: { x: Math.SQRT1_2, y: -Math.SQRT1_2 },
};

function compass(dir: string): Pt {
  return COMPASS[dir] ?? COMPASS.E;
}

function stationCentre(st: Station, cs: number): Pt {
  const n = st.cells.length || 1;
  return {
    x: (st.cells.reduce((a, c) => a + c.x, 0) / n) * cs,
    y: (st.cells.reduce((a, c) => a + c.y, 0) / n) * cs,
  };
}

/** The station's own axis: fixed by hand if set, otherwise from its longest line. */
function stationAxis(st: Station, calling: Drawn[], cs: number): Pt {
  if (typeof st.rotation === 'number') {
    const a = (st.rotation * Math.PI) / 4;
    return { x: Math.cos(a), y: Math.sin(a) };
  }
  if (st.cells.length > 1) {
    const a = st.cells[0];
    const b = st.cells[st.cells.length - 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  }
  void cs;
  const d = calling[0]?.hits.values().next().value;
  const dir = d?.dir ?? { x: 1, y: 0 };
  // the bar sits across the line, not along it
  return { x: -dir.y, y: dir.x };
}

/** Which side the terminating platforms mostly sit on, if no side was chosen. */
function dominantSide(ending: Drawn[], centre: Pt, perp: Pt): Pt {
  let sum = 0;
  for (const d of ending) {
    const p = [...d.hits.values()][0]?.pt ?? centre;
    sum += (p.x - centre.x) * perp.x + (p.y - centre.y) * perp.y;
  }
  return sum >= 0 ? perp : { x: -perp.x, y: -perp.y };
}

/** Does this service finish at this station rather than run through it? */
function terminatesHere(doc: MapDoc, svc: Service, stationId: string): boolean {
  const ids = serviceStations(doc, svc);
  return ids.length > 0 && (ids[0] === stationId || ids[ids.length - 1] === stationId);
}

/** The build colour of the first serviceless route this station sits on. */
function buildColourFor(doc: MapDoc, st: Station): string | undefined {
  for (const rt of Object.values(doc.routes)) {
    if (!rt.buildColour) continue;
    if (!rt.path.some((n) => n.kind === 'station' && n.id === st.id)) continue;
    if (Object.values(doc.services).some((s) => s.routeIds.includes(rt.id))) continue;
    return rt.buildColour;
  }
  return undefined;
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
