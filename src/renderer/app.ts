import {
  emptyProject,
  newId,
  type Cell,
  type MapDoc,
  type Project,
  type Route,
  REGIONS,
  operatorRegions,
  type Operator,
  type Region,
  type Service,
  type Station,
} from '../core/model';
import { renderSvg, serviceStations } from '../core/render';
import { elbow, isOctilinear, snapOctilinear, unitSteps } from '../core/geometry';
import { BASEMAP_H, BASEMAP_W, OUTLINE, PLACES } from '../generated/assets';
import {
  deletePoint,
  insertPoint,
  movePoint,
  type Outline,
} from '../core/outline';

/** A town or city from the overlay: name, position, population, tier. */
export interface Place {
  n: string;
  x: number;
  y: number;
  p: number;
  t: number;
}

declare global {
  interface Window {
    api: {
      saveProject(json: string, current?: string): Promise<string | null>;
      openProject(): Promise<{ path: string; json: string } | null>;
      readBasemap(): Promise<string>;
      readPlaces(): Promise<{ places: Place[] }>;
      exportSvg(svg: string): Promise<string | null>;
      exportPdf(svg: string, w: number, h: number): Promise<string | null>;
      version(): Promise<string>;
      checkForUpdate(): Promise<string | null>;
      installUpdate(): Promise<void>;
      onUpdateReady(cb: (v: string) => void): void;
      onMenu(cb: (what: 'open' | 'save') => void): void;
    };
  }
}

type Tool = 'select' | 'station' | 'route' | 'redit' | 'pan' | 'coast';

const state = {
  project: emptyProject('UK network'),
  filePath: undefined as string | undefined,
  places: [] as Place[],
  /** which coastline point is being dragged, if any */
  coastDrag: undefined as { shapeId: string; index: number } | undefined,
  coastPick: undefined as { shapeId: string; index: number } | undefined,
  /** which node of the route being edited is picked or dragged */
  nodePick: undefined as number | undefined,
  nodeDrag: undefined as number | undefined,
  tool: 'station' as Tool,
  zoom: 0.025,
  pan: { x: 0, y: 0 },
  showGrid: true,
  showTowns: false,
  /** minimum population a town needs before it is drawn */
  townFloor: 30000,
  selectedStation: undefined as string | undefined,
  selectedRoute: undefined as string | undefined,
  selectedService: undefined as string | undefined,
  /** what the right-hand panel is showing */
  focus: 'station' as 'station' | 'route' | 'service',
  drawing: [] as string[],
  /** per leg of the route being drawn: take the diagonal first, or the straight */
  bendFlips: [] as boolean[],
  dragging: undefined as string | undefined,
  panning: undefined as { x: number; y: number } | undefined,
  spaceHeld: false,
};

const doc = (): MapDoc => state.project.maps[state.project.activeMapId];
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const canvas = $('#canvas');
const wrap = $('#canvas-wrap');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- viewport
/**
 * Screen and map coordinates. The SVG viewBox does the work, so lines and text
 * stay crisp at any magnification rather than being scaled up as pixels.
 */
function view() {
  const r = wrap.getBoundingClientRect();
  return {
    w: r.width,
    h: r.height,
    ox: -state.pan.x / state.zoom,
    oy: -state.pan.y / state.zoom,
    vw: r.width / state.zoom,
    vh: r.height / state.zoom,
    rect: r,
  };
}

function screenToMap(ev: MouseEvent) {
  const v = view();
  return {
    x: v.ox + (ev.clientX - v.rect.left) / state.zoom,
    y: v.oy + (ev.clientY - v.rect.top) / state.zoom,
  };
}

function screenToCell(ev: MouseEvent): Cell {
  const m = screenToMap(ev);
  const cs = doc().cellSize;
  return { x: Math.round(m.x / cs), y: Math.round(m.y / cs) };
}

function cellTaken(c: Cell): string | undefined {
  for (const st of Object.values(doc().stations)) {
    if (st.cells.some((k) => k.x === c.x && k.y === c.y)) return st.id;
  }
  return undefined;
}

// ---------------------------------------------------------------- layers
function gridLayer(): string {
  if (!state.showGrid) return '';
  const cs = doc().cellSize;
  const step = cs * state.zoom < 7 ? cs * 5 : cs;
  if (step * state.zoom < 5) return '';
  const v = view();
  const x0 = Math.floor(v.ox / step) * step;
  const y0 = Math.floor(v.oy / step) * step;
  const out: string[] = [];
  for (let x = x0; x < v.ox + v.vw; x += step) {
    out.push(`M ${x.toFixed(1)} ${v.oy.toFixed(1)} V ${(v.oy + v.vh).toFixed(1)}`);
  }
  for (let y = y0; y < v.oy + v.vh; y += step) {
    out.push(`M ${v.ox.toFixed(1)} ${y.toFixed(1)} H ${(v.ox + v.vw).toFixed(1)}`);
  }
  return `<path d="${out.join(' ')}" stroke="#B9D5E4" stroke-width="${(0.7 / state.zoom).toFixed(2)}" fill="none" opacity="0.65"/>`;
}

function visibleTowns(): Place[] {
  if (!state.showTowns) return [];
  return state.places.filter((p) => p.p >= state.townFloor);
}

function townsLayer(): string {
  const list = visibleTowns();
  if (!list.length) return '';
  const k = 1 / state.zoom;
  const out: string[] = [];
  for (const pl of list) {
    const big = pl.p >= 200000;
    out.push(
      `<circle cx="${pl.x}" cy="${pl.y}" r="${((big ? 4.4 : 3) * k).toFixed(2)}" fill="#7C8A98" opacity="0.8"/>`,
    );
    // labels only where they will not turn into a smear
    if (list.length <= 400 || big) {
      const fs = (big ? 15 : 12) * k;
      out.push(
        `<text x="${(pl.x + 6 * k).toFixed(1)}" y="${(pl.y + 4 * k).toFixed(1)}" font-size="${fs.toFixed(1)}" font-weight="${big ? 700 : 400}" fill="#546474" stroke="#ffffff" stroke-width="${(3 * k).toFixed(2)}" paint-order="stroke">${esc(pl.n)}</text>`,
      );
    }
  }
  return `<g class="towns">${out.join('')}</g>`;
}

/**
 * Turn the picked stations into a legal path, inserting a bend wherever two
 * stations are not already in line. Each leg remembers which way round its
 * elbow goes, so Flip bend can swap it without disturbing the rest.
 */
function buildPath(ids: string[], flips: boolean[]) {
  const d = doc();
  const path: (
    | { kind: 'station'; id: string }
    | { kind: 'bend'; at: Cell }
  )[] = [];
  ids.forEach((id, i) => {
    if (i > 0) {
      const a = d.stations[ids[i - 1]].cells[0];
      const b = d.stations[id].cells[0];
      const bend = elbow(a, b, flips[i - 1] ?? false);
      if (bend) path.push({ kind: 'bend', at: bend });
    }
    path.push({ kind: 'station', id });
  });
  return path;
}

/** Handles on every coastline point, shown only while the Coast tool is active. */
function coastLayer(): string {
  if (state.tool !== 'coast' || !state.project.outline) return '';
  const o = state.project.outline;
  const k = 1 / state.zoom;
  const out: string[] = [];
  for (const shape of o.shapes) {
    const pts = shape.ring.map((p) => ({ x: p.x * o.unit, y: p.y * o.unit }));
    // the ring as drawn, so you can see what you are moving
    out.push(
      `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ')} Z" ` +
        `fill="none" stroke="#E8930C" stroke-width="${2 * k}" stroke-dasharray="${9 * k} ${7 * k}"/>`,
    );
    pts.forEach((p, i) => {
      const picked =
        state.coastPick && state.coastPick.shapeId === shape.id && state.coastPick.index === i;
      const pinned = Boolean(shape.shared?.[i]);
      const r = (picked ? 9 : 6) * k;
      out.push(
        `<rect x="${p.x - r}" y="${p.y - r}" width="${2 * r}" height="${2 * r}" ` +
          `fill="${picked ? '#E8930C' : '#ffffff'}" stroke="${pinned ? '#8A6BC4' : '#141C24'}" ` +
          `stroke-width="${2 * k}"/>`,
      );
    });
  }
  return out.join('');
}

/** The coastline point under the pointer, if any. */
function coastPointAt(ev: MouseEvent): { shapeId: string; index: number } | undefined {
  const o = state.project.outline;
  if (!o) return undefined;
  const m = screenToMap(ev);
  const reach = 12 / state.zoom;
  let best: { shapeId: string; index: number } | undefined;
  let bestD = reach;
  for (const shape of o.shapes) {
    shape.ring.forEach((p, i) => {
      const d = Math.hypot(p.x * o.unit - m.x, p.y * o.unit - m.y);
      if (d < bestD) {
        bestD = d;
        best = { shapeId: shape.id, index: i };
      }
    });
  }
  return best;
}

/** The edge under the pointer, for inserting a new point into. */
function coastEdgeAt(ev: MouseEvent): { shapeId: string; index: number } | undefined {
  const o = state.project.outline;
  if (!o) return undefined;
  const m = screenToMap(ev);
  const reach = 10 / state.zoom;
  let best: { shapeId: string; index: number } | undefined;
  let bestD = reach;
  for (const shape of o.shapes) {
    const n = shape.ring.length;
    for (let i = 0; i < n; i++) {
      const a = shape.ring[i];
      const b = shape.ring[(i + 1) % n];
      const ax = a.x * o.unit;
      const ay = a.y * o.unit;
      const bx = b.x * o.unit;
      const by = b.y * o.unit;
      const vx = bx - ax;
      const vy = by - ay;
      const len2 = vx * vx + vy * vy || 1;
      let t = ((m.x - ax) * vx + (m.y - ay) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(m.x - (ax + vx * t), m.y - (ay + vy * t));
      if (d < bestD) {
        bestD = d;
        best = { shapeId: shape.id, index: i };
      }
    }
  }
  return best;
}

/**
 * Handles on the selected route: circles for stations, squares for the plain
 * bends between them. Bends are what give a route its shape, so they need to be
 * as editable as the stations are.
 */
function routeEditLayer(): string {
  if (state.tool !== 'redit' || !state.selectedRoute) return '';
  const d = doc();
  const rt = d.routes[state.selectedRoute];
  if (!rt) return '';
  const cs = d.cellSize;
  const k = 1 / state.zoom;
  const out: string[] = [];
  const pts = rt.path.map((n) => (n.kind === 'bend' ? n.at : d.stations[n.id]?.cells[0]));
  out.push(
    `<path d="${pts.filter(Boolean).map((c, i) => `${i ? 'L' : 'M'} ${c!.x * cs} ${c!.y * cs}`).join(' ')}" ` +
      `fill="none" stroke="#E8930C" stroke-width="${2.4 * k}" stroke-dasharray="${9 * k} ${7 * k}"/>`,
  );
  pts.forEach((c, i) => {
    if (!c) return;
    const picked = state.nodePick === i;
    const bend = rt.path[i].kind === 'bend';
    const r = (picked ? 8 : 6) * k;
    const x = c.x * cs;
    const y = c.y * cs;
    out.push(
      bend
        ? `<rect x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" fill="${picked ? '#E8930C' : '#ffffff'}" stroke="#141C24" stroke-width="${2 * k}"/>`
        : `<circle cx="${x}" cy="${y}" r="${r}" fill="${picked ? '#E8930C' : '#ffffff'}" stroke="#0A55C4" stroke-width="${2.2 * k}"/>`,
    );
  });
  return out.join('');
}

/** Which node of the selected route is under the pointer. */
function routeNodeAt(ev: MouseEvent): number | undefined {
  if (!state.selectedRoute) return undefined;
  const d = doc();
  const rt = d.routes[state.selectedRoute];
  if (!rt) return undefined;
  const m = screenToMap(ev);
  const reach = 12 / state.zoom;
  let best: number | undefined;
  let bestD = reach;
  rt.path.forEach((n, i) => {
    const c = n.kind === 'bend' ? n.at : d.stations[n.id]?.cells[0];
    if (!c) return;
    const dist = Math.hypot(c.x * d.cellSize - m.x, c.y * d.cellSize - m.y);
    if (dist < bestD) {
      bestD = dist;
      best = i;
    }
  });
  return best;
}

/** Which leg of the selected route is under the pointer, for adding a bend. */
function routeEdgeAt(ev: MouseEvent): number | undefined {
  if (!state.selectedRoute) return undefined;
  const d = doc();
  const rt = d.routes[state.selectedRoute];
  if (!rt) return undefined;
  const m = screenToMap(ev);
  const cs = d.cellSize;
  let best: number | undefined;
  let bestD = 10 / state.zoom;
  for (let i = 0; i + 1 < rt.path.length; i++) {
    const a = rt.path[i].kind === 'bend' ? (rt.path[i] as { at: Cell }).at : d.stations[(rt.path[i] as { id: string }).id]?.cells[0];
    const b = rt.path[i + 1].kind === 'bend' ? (rt.path[i + 1] as { at: Cell }).at : d.stations[(rt.path[i + 1] as { id: string }).id]?.cells[0];
    if (!a || !b) continue;
    const ax = a.x * cs;
    const ay = a.y * cs;
    const vx = b.x * cs - ax;
    const vy = b.y * cs - ay;
    const len2 = vx * vx + vy * vy || 1;
    let t = ((m.x - ax) * vx + (m.y - ay) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const dist = Math.hypot(m.x - (ax + vx * t), m.y - (ay + vy * t));
    if (dist < bestD) {
      bestD = dist;
      best = i;
    }
  }
  return best;
}

function previewLayer(): string {
  if (state.tool !== 'route' || state.drawing.length === 0) return '';
  const cs = doc().cellSize;
  const pts = buildPath(state.drawing, state.bendFlips).map((n) =>
    n.kind === 'bend' ? n.at : doc().stations[n.id].cells[0],
  );
  const d = pts.map((c, i) => `${i ? 'L' : 'M'} ${c.x * cs} ${c.y * cs}`).join(' ');
  const dots = state.drawing
    .map((id) => doc().stations[id].cells[0])
    .map((c) => `<circle cx="${c.x * cs}" cy="${c.y * cs}" r="${7 / state.zoom}" fill="none" stroke="#E8930C" stroke-width="${3 / state.zoom}"/>`)
    .join('');
  return `<path d="${d}" fill="none" stroke="#E8930C" stroke-width="${5 / state.zoom}" stroke-dasharray="${8 / state.zoom} ${6 / state.zoom}" stroke-linejoin="round"/>${dots}`;
}

function selectionLayer(): string {
  const id = state.selectedStation;
  if (!id) return '';
  const st = doc().stations[id];
  if (!st) return '';
  const cs = doc().cellSize;
  const k = 1 / state.zoom;
  return st.cells
    .map((c) => `<rect x="${c.x * cs - 11 * k}" y="${c.y * cs - 11 * k}" width="${22 * k}" height="${22 * k}" rx="${5 * k}" fill="none" stroke="${st.locked ? '#8A6BC4' : '#E8930C'}" stroke-width="${2.4 * k}"/>`)
    .join('');
}

// ---------------------------------------------------------------- drawing
function draw() {
  const d = doc();
  let svg: string;
  try {
    svg = renderSvg({
      doc: d,
      operators: state.project.operators,
      outline: state.project.outline,
      underlays: gridLayer() + townsLayer(),
      overlays: previewLayer() + selectionLayer() + coastLayer() + routeEditLayer(),
    });
  } catch (err) {
    setMessage(`Could not draw: ${String(err)}`);
    return;
  }
  canvas.innerHTML = svg;

  const el = canvas.querySelector('svg');
  if (el) {
    const v = view();
    el.setAttribute('viewBox', `${v.ox} ${v.oy} ${v.vw} ${v.vh}`);
    el.setAttribute('preserveAspectRatio', 'xMinYMin slice');
  }

  $('#counts').textContent =
    `${Object.keys(d.stations).length} stations · ${Object.keys(d.routes).length} routes · ${Object.keys(d.services).length} services`;
  $('#zoom').textContent = `${Math.round(state.zoom * 100)}%`;
  const shown = visibleTowns().length;
  $('#town-count').textContent = state.showTowns ? `${shown} towns` : '';
}

/** Panels are rebuilt separately, so typing in a field never rips it out mid-keystroke. */
function renderPanels() {
  const d = doc();
  const routes = $('#routes');
  routes.innerHTML = '';
  for (const rt of Object.values(d.routes)) {
    const svcCount = Object.values(d.services).filter((s) => s.routeIds.includes(rt.id)).length;
    const li = document.createElement('li');
    if (rt.id === state.selectedRoute) li.className = 'sel';
    li.innerHTML =
      `<span class="bar" style="background:#9AA8B6"></span>${esc(rt.name)}` +
      `<span class="tag">${svcCount ? `${svcCount} svc` : 'no services'}</span>`;
    li.onclick = () => {
      state.selectedRoute = rt.id;
      state.focus = 'route';
      renderPanels();
    };
    routes.appendChild(li);
  }
  $('#routes-empty').style.display = Object.keys(d.routes).length ? 'none' : '';

  const services = $('#services');
  services.innerHTML = '';
  const palette = ['#0A55C4', '#0E8A3E', '#E2620E', '#7A2E8E', '#C4161C', '#0E8C8C'];
  Object.values(d.services)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .forEach((sv, i) => {
      const li = document.createElement('li');
      if (sv.id === state.selectedService && state.focus === 'service') li.className = 'sel';
      li.innerHTML =
        `<span class="bar" style="background:${sv.colour ?? palette[i % palette.length]}"></span>${esc(sv.name)}` +
        `<span class="tag">${sv.routeIds.length} route${sv.routeIds.length === 1 ? '' : 's'}</span>`;
      li.onclick = () => {
        state.selectedService = sv.id;
        state.focus = 'service';
        renderPanels();
      };
      services.appendChild(li);
    });
  $('#services-empty').style.display = Object.keys(d.services).length ? 'none' : '';

  renderInspector();
}

function renderInspector() {
  if (state.tool === 'coast') return renderCoastInspector();
  if (state.focus === 'route') return renderRouteInspector();
  if (state.focus === 'service') return renderServiceInspector();
  const insp = $('#inspector');
  const st = state.selectedStation ? doc().stations[state.selectedStation] : undefined;
  if (!st) {
    insp.innerHTML =
      '<h2>Nothing selected</h2><p class="hint">Click the canvas with the Station tool to place one. ' +
      'With Towns on, clicking a town places a station already named after it.<br><br>' +
      'Hold space or use the Pan tool to move around. Scroll to zoom.</p>';
    return;
  }
  insp.innerHTML = `
    <h2>Station</h2>
    <label class="f" for="nm">Name</label>
    <input id="nm" type="text" value="${esc(st.name)}">
    <label class="f">Type</label>
    <div class="seg" id="kind">
      <button data-k="stop" class="${st.kind === 'stop' ? 'on' : ''}">Stop</button>
      <button data-k="terminus" class="${st.kind === 'terminus' ? 'on' : ''}">Terminus</button>
      <button data-k="grey" class="${st.kind === 'grey' ? 'on' : ''}">No rail</button>
    </div>
    <label class="f">Occupies ${st.cells.length} cell${st.cells.length > 1 ? 's' : ''}</label>
    <p class="hint">${st.cells.map((c) => `${c.x},${c.y}`).join(' &nbsp; ')}</p>
    <label class="f">Orientation ${st.rotationLocked ? '· locked' : typeof st.rotation === 'number' ? '· set by hand' : '· automatic'}</label>
    <div class="rowbtns">
      <button class="mini" id="rotl" title="Rotate 45 degrees anticlockwise">&#8630; 45&deg;</button>
      <button class="mini" id="rotr" title="Rotate 45 degrees clockwise">45&deg; &#8631;</button>
      <button class="mini" id="rotauto" title="Back to working it out from the lines">Auto</button>
    </div>
    <div class="check">Lock rotation<input id="rlock" type="checkbox" ${st.rotationLocked ? 'checked' : ''}></div>
    <label class="f">Tick and name side</label>
    <div class="seg" id="tside">
      <button data-s="right" class="${st.tickSide === 'left' ? '' : 'on'}">One side</button>
      <button data-s="left" class="${st.tickSide === 'left' ? 'on' : ''}">The other</button>
    </div>
    <label class="f">Name angle</label>
    <div class="seg" id="lang">
      <button data-a="0" class="${st.labelAngle ? '' : 'on'}">Flat</button>
      <button data-a="-45" class="${st.labelAngle === -45 ? 'on' : ''}">Up 45&deg;</button>
      <button data-a="45" class="${st.labelAngle === 45 ? 'on' : ''}">Down 45&deg;</button>
    </div>
    <label class="f">Arm of the T points</label>
    <select id="arm">
      <option value="">automatic</option>
      ${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
        .map((k) => `<option value="${k}" ${st.armSide === k ? 'selected' : ''}>${k}</option>`)
        .join('')}
    </select>
    <div class="check">Interchange<input id="ic" type="checkbox" ${st.interchange ? 'checked' : ''}></div>
    <div class="check">Airport<input id="ap" type="checkbox" ${st.airport ? 'checked' : ''}></div>
    <div class="check">Proposed or closed<input id="pr" type="checkbox" ${st.proposed ? 'checked' : ''}></div>
    <div class="check">Lock position<input id="lk" type="checkbox" ${st.locked ? 'checked' : ''}></div>
    <button class="mini" id="wider">Make wider</button>
    <button class="mini" id="taller">Make taller</button>
    ${st.cells.length > 1 ? '<button class="mini" id="shrink">Back to one cell</button>' : ''}
    <button class="mini" id="del">Delete station</button>
  `;

  const nm = $('#nm') as HTMLInputElement;
  nm.oninput = () => {
    st.name = nm.value;
    draw(); // canvas only — the panel stays put, so focus is not lost
  };

  $('#kind').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      st.kind = (b as HTMLButtonElement).dataset.k as Station['kind'];
      draw();
      renderPanels();
    };
  });

  const rotate = (by: number) => () => {
    if (st.rotationLocked) {
      setMessage('Rotation is locked for this station.');
      return;
    }
    st.rotation = (((st.rotation ?? 0) + by) % 8 + 8) % 8;
    draw();
    renderPanels();
  };
  ($('#rotl') as HTMLButtonElement).onclick = rotate(-1);
  ($('#rotr') as HTMLButtonElement).onclick = rotate(1);
  ($('#rotauto') as HTMLButtonElement).onclick = () => {
    st.rotation = undefined;
    st.rotationLocked = false;
    draw();
    renderPanels();
  };
  ($('#rlock') as HTMLInputElement).onchange = (e) => {
    st.rotationLocked = (e.target as HTMLInputElement).checked;
    // locking keeps whatever it is showing now, rather than leaving it to drift
    if (st.rotationLocked && typeof st.rotation !== 'number') st.rotation = 0;
    renderPanels();
  };
  $('#tside').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      st.tickSide = (b as HTMLButtonElement).dataset.s as Station['tickSide'];
      draw();
      renderPanels();
    };
  });
  $('#lang').querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const v = Number((b as HTMLButtonElement).dataset.a);
      st.labelAngle = v === -45 ? -45 : v === 45 ? 45 : 0;
      draw();
      renderPanels();
    };
  });
  ($('#arm') as HTMLSelectElement).onchange = (e) => {
    const v = (e.target as HTMLSelectElement).value;
    st.armSide = (v || undefined) as Station['armSide'];
    draw();
  };

  const bind = (sel: string, key: 'interchange' | 'airport' | 'proposed' | 'locked') => {
    ($(sel) as HTMLInputElement).onchange = (e) => {
      (st as unknown as Record<string, boolean>)[key] = (e.target as HTMLInputElement).checked;
      draw();
    };
  };
  bind('#ic', 'interchange');
  bind('#ap', 'airport');
  bind('#pr', 'proposed');
  bind('#lk', 'locked');

  const grow = (dx: number, dy: number) => {
    const last = st.cells[st.cells.length - 1];
    const next = { x: last.x + dx, y: last.y + dy };
    if (cellTaken(next)) {
      setMessage('That cell already belongs to another station.');
      return;
    }
    st.cells.push(next);
    st.interchange = true; // a station spanning cells is drawn as a bar
    draw();
    renderPanels();
  };
  ($('#wider') as HTMLButtonElement).onclick = () => grow(1, 0);
  ($('#taller') as HTMLButtonElement).onclick = () => grow(0, 1);
  const shrink = document.querySelector('#shrink') as HTMLButtonElement | null;
  if (shrink) {
    shrink.onclick = () => {
      st.cells = [st.cells[0]];
      draw();
      renderPanels();
    };
  }
  ($('#del') as HTMLButtonElement).onclick = () => {
    const d = doc();
    delete d.stations[st.id];
    for (const rt of Object.values(d.routes)) {
      rt.path = rt.path.filter((n) => !(n.kind === 'station' && n.id === st.id));
    }
    for (const sv of Object.values(d.services)) {
      sv.calls = sv.calls.filter((c) => c !== st.id);
    }
    state.selectedStation = undefined;
    draw();
    renderPanels();
  };
}



// ---------------------------------------------------------------- infill
/**
 * Spread stations evenly along one leg of a route.
 *
 * The positions come from walking the actual drawn path between the two anchor
 * stations, so a leg with bends in it spaces correctly rather than by straight
 * line. Each position is nudged to the nearest cell, and off any bend, since a
 * station must sit on a straight run.
 */
function legCells(routeId: string, aId: string, bId: string): Cell[] | null {
  const d = doc();
  const rt = d.routes[routeId];
  if (!rt) return null;
  const idxA = rt.path.findIndex((n) => n.kind === 'station' && n.id === aId);
  const idxB = rt.path.findIndex((n) => n.kind === 'station' && n.id === bId);
  if (idxA < 0 || idxB < 0) return null;
  const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
  const anchors = rt.path.slice(lo, hi + 1).map((n) => (n.kind === 'bend' ? n.at : d.stations[n.id].cells[0]));
  const cells: Cell[] = [anchors[0]];
  for (let i = 0; i + 1 < anchors.length; i++) {
    for (const st of unitSteps(anchors[i], anchors[i + 1])) cells.push(st.b);
  }
  return cells;
}

/** Cells where the path changes direction — no station may sit on one. */
function bendCells(cells: Cell[]): Set<string> {
  const out = new Set<string>();
  for (let i = 1; i + 1 < cells.length; i++) {
    const a = cells[i - 1];
    const b = cells[i];
    const c = cells[i + 1];
    if (b.x - a.x !== c.x - b.x || b.y - a.y !== c.y - b.y) out.add(`${b.x},${b.y}`);
  }
  return out;
}

function spreadAlong(routeId: string, aId: string, bId: string, names: string[]): string[] {
  const d = doc();
  const cells = legCells(routeId, aId, bId);
  if (!cells || cells.length < 3 || names.length === 0) return [];
  const bends = bendCells(cells);
  const taken = new Set<string>();
  for (const st of Object.values(d.stations)) {
    for (const c of st.cells) taken.add(`${c.x},${c.y}`);
  }

  const made: string[] = [];
  names.forEach((name, i) => {
    const ideal = ((i + 1) / (names.length + 1)) * (cells.length - 1);
    // nearest free cell that is not a bend and not an anchor
    let best: Cell | undefined;
    let bestD = Infinity;
    for (let j = 1; j < cells.length - 1; j++) {
      const c = cells[j];
      const key = `${c.x},${c.y}`;
      if (bends.has(key) || taken.has(key)) continue;
      const dist = Math.abs(j - ideal);
      if (dist < bestD) {
        bestD = dist;
        best = c;
      }
    }
    if (!best) return;
    taken.add(`${best.x},${best.y}`);
    const st: Station = {
      id: newId('st'),
      name: name.trim() || 'New station',
      cells: [best],
      kind: 'stop',
      interchange: false,
      spacing: { routeId, anchorA: aId, anchorB: bId },
    };
    d.stations[st.id] = st;
    made.push(st.id);
  });

  // slot them into the route in path order
  const rt = d.routes[routeId];
  const order = new Map(cells.map((c, i) => [`${c.x},${c.y}`, i]));
  const idxA = rt.path.findIndex((n) => n.kind === 'station' && n.id === aId);
  const idxB = rt.path.findIndex((n) => n.kind === 'station' && n.id === bId);
  const at = Math.min(idxA, idxB) + 1;
  const sorted = made
    .slice()
    .sort((p, q) => (order.get(`${d.stations[p].cells[0].x},${d.stations[p].cells[0].y}`) ?? 0)
      - (order.get(`${d.stations[q].cells[0].x},${d.stations[q].cells[0].y}`) ?? 0));
  rt.path.splice(at, 0, ...sorted.map((id) => ({ kind: 'station' as const, id })));
  return made;
}

/** After an anchor moves, lay its evenly-spaced neighbours out again. */
function respreadAround(stationId: string) {
  const d = doc();
  const groups = new Map<string, { routeId: string; a: string; b: string; ids: string[] }>();
  for (const st of Object.values(d.stations)) {
    const sp = st.spacing;
    if (!sp) continue;
    if (sp.anchorA !== stationId && sp.anchorB !== stationId) continue;
    const key = `${sp.routeId}|${sp.anchorA}|${sp.anchorB}`;
    const g = groups.get(key) ?? { routeId: sp.routeId, a: sp.anchorA, b: sp.anchorB, ids: [] };
    g.ids.push(st.id);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const cells = legCells(g.routeId, g.a, g.b);
    if (!cells || cells.length < 3) continue;
    const bends = bendCells(cells);
    const rt = d.routes[g.routeId];
    const inOrder = rt.path
      .filter((n) => n.kind === 'station' && g.ids.includes(n.id))
      .map((n) => (n as { id: string }).id);
    const taken = new Set<string>();
    for (const st of Object.values(d.stations)) {
      if (g.ids.includes(st.id)) continue;
      for (const c of st.cells) taken.add(`${c.x},${c.y}`);
    }
    inOrder.forEach((id, i) => {
      const ideal = ((i + 1) / (inOrder.length + 1)) * (cells.length - 1);
      let best: Cell | undefined;
      let bestD = Infinity;
      for (let j = 1; j < cells.length - 1; j++) {
        const c = cells[j];
        const key = `${c.x},${c.y}`;
        if (bends.has(key) || taken.has(key)) continue;
        const dist = Math.abs(j - ideal);
        if (dist < bestD) {
          bestD = dist;
          best = c;
        }
      }
      if (!best) return;
      taken.add(`${best.x},${best.y}`);
      d.stations[id].cells = [best];
    });
  }
}

let infillNames: string[] = [''];

function openInfill() {
  const d = doc();
  const rt = state.selectedRoute ? d.routes[state.selectedRoute] : undefined;
  if (!rt) {
    setMessage('Select a route first.');
    return;
  }
  const stations = routeStations(rt.id);
  if (stations.length < 2) {
    setMessage('The route needs two stations before anything can go between them.');
    return;
  }
  const legs: [string, string][] = [];
  for (let i = 0; i + 1 < stations.length; i++) legs.push([stations[i], stations[i + 1]]);

  const body = $('#dialog-body');
  const render = () => {
    body.innerHTML = `
      <h3>Add stations along ${esc(rt.name)}</h3>
      <p class="lede">They will be spread evenly between the two you pick, nudged onto the grid and
      kept off any bend. Move one afterwards and it stays where you put it — until you move an end
      station, which spreads them again.</p>
      <label class="f">Between</label>
      <select id="ifleg">
        ${legs
          .map(([a, b], i) => `<option value="${i}">${esc(d.stations[a]?.name ?? a)} &rarr; ${esc(d.stations[b]?.name ?? b)}</option>`)
          .join('')}
      </select>
      <label class="f">Stations, in order</label>
      <div id="ifrows">
        ${infillNames
          .map(
            (n, i) => `<div class="oprow" draggable="true" data-row="${i}" style="padding:6px 8px">
              <span class="grip" title="Drag to reorder">&#8942;&#8942;</span>
              <input type="text" data-i="${i}" value="${esc(n)}" placeholder="Station name" style="flex:1">
              <button class="btn" data-up="${i}">&uarr;</button>
              <button class="btn" data-down="${i}">&darr;</button>
              <button class="btn" data-rm="${i}">&times;</button>
            </div>`,
          )
          .join('')}
      </div>
      <button class="mini" id="ifadd">Add another station</button>
      <div class="actions">
        <button class="btn" id="ifcancel">Cancel</button>
        <button class="btn p" id="ifok">Place ${infillNames.filter((n) => n.trim()).length} stations</button>
      </div>
    `;
    body.querySelectorAll('input[data-i]').forEach((el) => {
      (el as HTMLInputElement).oninput = () => {
        infillNames[Number((el as HTMLInputElement).dataset.i)] = (el as HTMLInputElement).value;
      };
    });
    function move(a: number, b: number) {
      if (b < 0 || b >= infillNames.length) return;
      const [x] = infillNames.splice(a, 1);
      infillNames.splice(b, 0, x);
      render();
    }
    // drag a row to reorder, with the arrows still there for fine work
    let from = -1;
    body.querySelectorAll('[data-row]').forEach((el) => {
      const row = el as HTMLElement;
      row.ondragstart = () => {
        from = Number(row.dataset.row);
        row.style.opacity = '0.4';
      };
      row.ondragend = () => {
        row.style.opacity = '';
      };
      row.ondragover = (ev) => {
        ev.preventDefault();
        row.style.borderTop = '2px solid #E8930C';
      };
      row.ondragleave = () => {
        row.style.borderTop = '';
      };
      row.ondrop = (ev) => {
        ev.preventDefault();
        row.style.borderTop = '';
        const to = Number(row.dataset.row);
        if (from >= 0 && from !== to) move(from, to);
      };
    });
    body.querySelectorAll('[data-up]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => move(Number((b as HTMLButtonElement).dataset.up), Number((b as HTMLButtonElement).dataset.up) - 1);
    });
    body.querySelectorAll('[data-down]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => move(Number((b as HTMLButtonElement).dataset.down), Number((b as HTMLButtonElement).dataset.down) + 1);
    });
    body.querySelectorAll('[data-rm]').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        infillNames.splice(Number((b as HTMLButtonElement).dataset.rm), 1);
        if (infillNames.length === 0) infillNames = [''];
        render();
      };
    });
    ($('#ifadd') as HTMLButtonElement).onclick = () => {
      infillNames.push('');
      render();
    };
    ($('#ifcancel') as HTMLButtonElement).onclick = () => {
      $('#dialog').classList.add('hidden');
    };
    ($('#ifok') as HTMLButtonElement).onclick = () => {
      const i = Number(($('#ifleg') as HTMLSelectElement).value);
      const names = infillNames.map((n) => n.trim()).filter(Boolean);
      if (!names.length) {
        setMessage('Type at least one station name.');
        return;
      }
      const made = spreadAlong(rt.id, legs[i][0], legs[i][1], names);
      setMessage(`${made.length} stations placed along ${rt.name}.`);
      infillNames = [''];
      $('#dialog').classList.add('hidden');
      draw();
      renderPanels();
    };
  };
  render();
  $('#dialog').classList.remove('hidden');
}

// ---------------------------------------------------------------- coast panel
function renderCoastInspector() {
  const insp = $('#inspector');
  const o = state.project.outline;
  if (!o) {
    insp.innerHTML = '<h2>Coastline</h2><p class="hint">No outline loaded.</p>';
    return;
  }
  const pick = state.coastPick;
  const shape = pick ? o.shapes.find((s) => s.id === pick.shapeId) : undefined;
  const pt = shape && pick ? shape.ring[pick.index] : undefined;
  const pinned = Boolean(pick && shape?.shared?.[pick.index]);

  insp.innerHTML = `
    <h2>Coastline</h2>
    <p class="hint">Drag any handle to move that stretch of coast. Click an edge to add a point.
    Delete removes one. Hold shift while dragging for a quarter-unit nudge.<br><br>
    One grid unit is about 20 km. Violet handles are shared with the country next door — move one
    and both follow.</p>
    ${
      pt && shape
        ? `<label class="f">Selected</label>
           <p class="hint"><b>${esc(shape.name)}</b> · point ${pick!.index + 1} of ${shape.ring.length}
           <br>at ${pt.x}, ${pt.y}${pinned ? ' · shared border point' : ''}</p>
           <div class="rowbtns">
             <button class="mini" id="cnudge-l">←</button>
             <button class="mini" id="cnudge-r">→</button>
             <button class="mini" id="cnudge-u">↑</button>
             <button class="mini" id="cnudge-d">↓</button>
           </div>`
        : '<p class="hint">Nothing selected.</p>'
    }
    <label class="f">Corner rounding</label>
    <input id="crad" type="range" min="0" max="60" value="${Math.round(o.radius * 100)}" style="width:100%">
    <button class="mini" id="creset">Reset the whole coastline</button>
  `;

  if (pt && pick) {
    const nudge = (dx: number, dy: number) => () => {
      movePoint(state.project.outline!, pick.shapeId, pick.index, { x: pt.x + dx, y: pt.y + dy });
      draw();
      renderPanels();
    };
    ($('#cnudge-l') as HTMLButtonElement).onclick = nudge(-1, 0);
    ($('#cnudge-r') as HTMLButtonElement).onclick = nudge(1, 0);
    ($('#cnudge-u') as HTMLButtonElement).onclick = nudge(0, -1);
    ($('#cnudge-d') as HTMLButtonElement).onclick = nudge(0, 1);
  }
  ($('#crad') as HTMLInputElement).oninput = (e) => {
    o.radius = Number((e.target as HTMLInputElement).value) / 100;
    draw();
  };
  ($('#creset') as HTMLButtonElement).onclick = () => {
    state.project.outline = JSON.parse(JSON.stringify(OUTLINE)) as Outline;
    state.coastPick = undefined;
    setMessage('Coastline reset.');
    draw();
    renderPanels();
  };
}

// ---------------------------------------------------------------- route panel
function renderRouteInspector() {
  const insp = $('#inspector');
  const d = doc();
  const rt = state.selectedRoute ? d.routes[state.selectedRoute] : undefined;
  if (!rt) {
    insp.innerHTML = '<h2>Route</h2><p class="hint">Select a route on the left.</p>';
    return;
  }
  const stations = routeStations(rt.id);
  insp.innerHTML = `
    <h2>Route</h2>
    <label class="f" for="rn">Name</label>
    <input id="rn" type="text" value="${esc(rt.name)}">
    <label class="f" for="rs">Line style</label>
    <select id="rs">
      ${['main', 'metro', 'heritage', 'construction', 'ferry', 'bus']
        .map((k) => `<option value="${k}" ${rt.style === k ? 'selected' : ''}>${k}</option>`)
        .join('')}
    </select>
    <label class="f">Path — ${rt.path.length} points, ${stations.length} stations</label>
    <div class="picklist" id="rpath">
      ${rt.path
        .map((n, i) => {
          const label =
            n.kind === 'bend'
              ? `<i>bend at ${n.at.x}, ${n.at.y}</i>`
              : esc(d.stations[n.id]?.name ?? n.id);
          const sel = state.nodePick === i ? ' style="background:#E7EDF4;font-weight:600"' : '';
          return `<label data-node="${i}"${sel}>${label}</label>`;
        })
        .join('')}
    </div>
    <p class="hint">Pick the <b>Edit route</b> tool to drag these on the map. Click a leg to add a
    bend, Delete to remove one. Shift-click a station to add it to the end, alt-click for the start.</p>
    <div class="rowbtns">
      <button class="mini" id="rrev">Reverse</button>
      <button class="mini" id="rfill">Add stations</button>
    </div>
    <button class="mini" id="rsvc">Add service</button>
    <button class="mini" id="rdel">Delete route</button>
  `;
  const nm = $('#rn') as HTMLInputElement;
  nm.oninput = () => {
    rt.name = nm.value;
    refreshLists();
  };
  ($('#rs') as HTMLSelectElement).onchange = (e) => {
    rt.style = (e.target as HTMLSelectElement).value as Route['style'];
    draw();
  };
  $('#rpath').querySelectorAll('label').forEach((el) => {
    (el as HTMLElement).onclick = () => {
      state.nodePick = Number((el as HTMLElement).dataset.node);
      draw();
      renderPanels();
    };
  });
  ($('#rfill') as HTMLButtonElement).onclick = openInfill;
  ($('#rrev') as HTMLButtonElement).onclick = () => {
    rt.path.reverse();
    state.nodePick = undefined;
    setMessage(`${rt.name} reversed.`);
    draw();
    renderPanels();
  };
  ($('#rsvc') as HTMLButtonElement).onclick = addServiceToSelectedRoute;
  ($('#rdel') as HTMLButtonElement).onclick = () => {
    delete d.routes[rt.id];
    for (const sv of Object.values(d.services)) {
      sv.routeIds = sv.routeIds.filter((r) => r !== rt.id);
    }
    for (const sv of Object.values(d.services)) {
      if (sv.routeIds.length === 0) delete d.services[sv.id];
    }
    state.selectedRoute = undefined;
    state.focus = 'station';
    draw();
    renderPanels();
  };
}

/** Every station along a route, in path order. */
function routeStations(routeId: string): string[] {
  const rt = doc().routes[routeId];
  if (!rt) return [];
  return rt.path.filter((n) => n.kind === 'station').map((n) => (n as { id: string }).id);
}

// ---------------------------------------------------------------- service panel
function renderServiceInspector() {
  const insp = $('#inspector');
  const d = doc();
  const sv = state.selectedService ? d.services[state.selectedService] : undefined;
  if (!sv) {
    insp.innerHTML = '<h2>Service</h2><p class="hint">Select a service on the left.</p>';
    return;
  }
  // only the stations the service actually reaches, once its extent is applied
  const along = serviceStations(d, sv);
  const everywhere: string[] = [];
  for (const rid of sv.routeIds) {
    for (const id of routeStations(rid)) if (!everywhere.includes(id)) everywhere.push(id);
  }

  const operators = Object.values(state.project.operators);

  insp.innerHTML = `
    <h2>Service</h2>
    <label class="f" for="sn">Name</label>
    <input id="sn" type="text" value="${esc(sv.name)}">

    <label class="f" for="so">Operator</label>
    <select id="so">
      <option value="">— none —</option>
      ${GROUPS.map((r) => {
        const mine = operators.filter((o) => operatorGroups(o).includes(r.id));
        if (!mine.length) return '';
        return (
          `<optgroup label="${r.name}">` +
          mine
            .map((o) => `<option value="${o.id}" ${sv.operatorId === o.id ? 'selected' : ''}>${esc(o.name)}</option>`)
            .join('') +
          '</optgroup>'
        );
      }).join('')}
    </select>

    <label class="f" for="sc">Colour</label>
    <input id="sc" type="color" value="${sv.colour ?? '#0A55C4'}">

    <label class="f" for="ss">Line style</label>
    <select id="ss">
      ${['main', 'metro', 'heritage', 'construction', 'ferry', 'bus']
        .map((k) => `<option value="${k}" ${sv.style === k ? 'selected' : ''}>${k}</option>`)
        .join('')}
    </select>

    <label class="f">Runs over these routes</label>
    <div class="picklist" id="sroutes">
      ${Object.values(d.routes)
        .map(
          (rt) =>
            `<label><input type="checkbox" data-r="${rt.id}" ${sv.routeIds.includes(rt.id) ? 'checked' : ''}>${esc(rt.name)}</label>`,
        )
        .join('')}
    </div>

    <label class="f">Runs from</label>
    <select id="sfrom">
      <option value="">start of the route</option>
      ${everywhere
        .map((id) => `<option value="${id}" ${sv.fromStation === id ? 'selected' : ''}>${esc(d.stations[id]?.name ?? id)}</option>`)
        .join('')}
    </select>
    <label class="f">Runs to</label>
    <select id="sto">
      <option value="">end of the route</option>
      ${everywhere
        .map((id) => `<option value="${id}" ${sv.toStation === id ? 'selected' : ''}>${esc(d.stations[id]?.name ?? id)}</option>`)
        .join('')}
    </select>
    <button class="mini" id="strim">Trim to its calling stations</button>

    <label class="f">Calls at (${sv.calls.filter((c) => along.includes(c)).length} of ${along.length})</label>
    <div class="picklist" id="scalls">
      ${along
        .map((id) => {
          const on = sv.calls.includes(id);
          return `<label class="${on ? '' : 'pass'}"><input type="checkbox" data-s="${id}" ${on ? 'checked' : ''}>${esc(d.stations[id]?.name ?? id)}${on ? '' : ' — passes'}</label>`;
        })
        .join('')}
    </div>
    <div class="rowbtns">
      <button class="mini" id="sall">All</button>
      <button class="mini" id="snone">None</button>
    </div>

    <div class="check">One-way throughout<input id="s1w" type="checkbox" ${sv.oneWayWhole ? 'checked' : ''}></div>

    <label class="f">Order across shared track</label>
    <div class="rowbtns">
      <button class="mini" id="sup">Move up</button>
      <button class="mini" id="sdown">Move down</button>
    </div>
    <p class="hint">Where this service shares track with others, this decides which side of the bundle it sits on.</p>
    <button class="mini" id="sdel">Delete service</button>
  `;

  const nm = $('#sn') as HTMLInputElement;
  nm.oninput = () => {
    sv.name = nm.value;
    refreshLists();
  };
  ($('#so') as HTMLSelectElement).onchange = (e) => {
    const v = (e.target as HTMLSelectElement).value;
    sv.operatorId = v || undefined;
    const op = v ? state.project.operators[v] : undefined;
    if (op?.colour) sv.colour = op.colour;
    draw();
    renderPanels();
  };
  ($('#sc') as HTMLInputElement).oninput = (e) => {
    sv.colour = (e.target as HTMLInputElement).value;
    draw();
  };
  ($('#ss') as HTMLSelectElement).onchange = (e) => {
    sv.style = (e.target as HTMLSelectElement).value as Service['style'];
    draw();
  };
  $('#sroutes').querySelectorAll('input').forEach((box) => {
    (box as HTMLInputElement).onchange = () => {
      const rid = (box as HTMLInputElement).dataset.r!;
      if ((box as HTMLInputElement).checked) {
        if (!sv.routeIds.includes(rid)) sv.routeIds.push(rid);
        for (const id of routeStations(rid)) if (!sv.calls.includes(id)) sv.calls.push(id);
      } else {
        sv.routeIds = sv.routeIds.filter((r) => r !== rid);
      }
      draw();
      renderPanels();
    };
  });
  $('#scalls').querySelectorAll('input').forEach((box) => {
    (box as HTMLInputElement).onchange = () => {
      const id = (box as HTMLInputElement).dataset.s!;
      sv.calls = (box as HTMLInputElement).checked
        ? [...sv.calls, id]
        : sv.calls.filter((c) => c !== id);
      draw();
      renderPanels();
    };
  });
  const setEnd = (which: 'fromStation' | 'toStation') => (e: Event) => {
    const v = (e.target as HTMLSelectElement).value;
    sv[which] = v || undefined;
    sv.calls = sv.calls.filter((c) => serviceStations(d, sv).includes(c));
    draw();
    renderPanels();
  };
  ($('#sfrom') as HTMLSelectElement).onchange = setEnd('fromStation');
  ($('#sto') as HTMLSelectElement).onchange = setEnd('toStation');
  ($('#strim') as HTMLButtonElement).onclick = () => {
    const called = everywhere.filter((id) => sv.calls.includes(id));
    if (called.length < 2) {
      setMessage('Tick at least two calling stations first.');
      return;
    }
    sv.fromStation = called[0];
    sv.toStation = called[called.length - 1];
    setMessage(`Now runs ${esc(d.stations[called[0]]?.name ?? '')} to ${esc(d.stations[called[called.length - 1]]?.name ?? '')}.`);
    draw();
    renderPanels();
  };
  ($('#sall') as HTMLButtonElement).onclick = () => {
    sv.calls = [...along];
    draw();
    renderPanels();
  };
  ($('#snone') as HTMLButtonElement).onclick = () => {
    sv.calls = [];
    draw();
    renderPanels();
  };
  ($('#s1w') as HTMLInputElement).onchange = (e) => {
    sv.oneWayWhole = (e.target as HTMLInputElement).checked;
    draw();
  };
  const nudge = (dir: number) => {
    const list = Object.values(d.services).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    list.forEach((x, i) => (x.order = i));
    const i = list.findIndex((x) => x.id === sv.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const tmp = list[i].order!;
    list[i].order = list[j].order!;
    list[j].order = tmp;
    draw();
    renderPanels();
  };
  ($('#sup') as HTMLButtonElement).onclick = () => nudge(-1);
  ($('#sdown') as HTMLButtonElement).onclick = () => nudge(1);
  ($('#sdel') as HTMLButtonElement).onclick = () => {
    delete d.services[sv.id];
    state.selectedService = undefined;
    state.focus = 'station';
    draw();
    renderPanels();
  };
}

/** Rebuild the side lists without touching the inspector, so fields keep focus. */
function refreshLists() {
  const d = doc();
  const routes = $('#routes');
  routes.innerHTML = '';
  for (const rt of Object.values(d.routes)) {
    const svcCount = Object.values(d.services).filter((s) => s.routeIds.includes(rt.id)).length;
    const li = document.createElement('li');
    if (rt.id === state.selectedRoute && state.focus === 'route') li.className = 'sel';
    li.innerHTML =
      `<span class="bar" style="background:#9AA8B6"></span>${esc(rt.name)}` +
      `<span class="tag">${svcCount ? `${svcCount} svc` : 'no services'}</span>`;
    li.onclick = () => {
      state.selectedRoute = rt.id;
      state.focus = 'route';
      renderPanels();
    };
    routes.appendChild(li);
  }
  const services = $('#services');
  services.innerHTML = '';
  Object.values(d.services)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .forEach((sv) => {
      const li = document.createElement('li');
      if (sv.id === state.selectedService && state.focus === 'service') li.className = 'sel';
      li.innerHTML =
        `<span class="bar" style="background:${sv.colour ?? '#0A55C4'}"></span>${esc(sv.name)}` +
        `<span class="tag">${sv.routeIds.length} route${sv.routeIds.length === 1 ? '' : 's'}</span>`;
      li.onclick = () => {
        state.selectedService = sv.id;
        state.focus = 'service';
        renderPanels();
      };
      services.appendChild(li);
    });
  draw();
}

// ---------------------------------------------------------------- operators
/** Which heading an operator is filed under in the lists. */
function operatorGroups(o: Operator): (Region | 'cross')[] {
  return o.crossBorder ? ['cross'] : operatorRegions(o);
}

const GROUPS: { id: Region | 'cross'; name: string }[] = [
  ...REGIONS,
  { id: 'cross', name: 'Cross-border' },
];

let editingOperator: string | undefined;

function openOperators() {
  const body = $('#dialog-body');
  const ops = Object.values(state.project.operators);
  const editing = editingOperator ? state.project.operators[editingOperator] : undefined;
  const chosen = editing ? operatorRegions(editing) : (['eng'] as Region[]);
  const cross = editing?.crossBorder ?? false;

  body.innerHTML = `
    <h3>Operators</h3>
    <p class="lede">Filed by country. An operator that crosses a border sits under Cross-border, with every country it runs in recorded against it. A station's name takes the operator's colour when only one operator calls there.</p>
    <div id="oplist">
      ${ops.length ? '' : '<p class="hint">None yet.</p>'}
      ${GROUPS.map((g) => {
        const mine = ops.filter((o) => operatorGroups(o).includes(g.id));
        if (!mine.length) return '';
        return (
          `<h2 style="margin-top:14px">${g.name}</h2>` +
          mine
            .map((o) => {
              const where = operatorRegions(o)
                .map((r) => REGIONS.find((x) => x.id === r)?.name ?? r)
                .join(', ');
              return `<div class="oprow">
                <span class="sw" style="background:${o.colour ?? '#C7CCD2'}"></span>
                <span><span class="nm">${esc(o.name)}</span><br><span class="mt">${o.colour ?? 'no colour set — names stay black'}${o.crossBorder && where ? ' · ' + esc(where) : ''}${o.website ? ' · ' + esc(o.website) : ''}</span></span>
                <button class="btn del" data-edit="${o.id}">Edit</button>
                <button class="btn" data-del="${o.id}">Remove</button>
              </div>`;
            })
            .join('')
        );
      }).join('')}
    </div>

    <h3 style="font-size:14px;margin-top:18px">${editing ? 'Edit operator' : 'Add one'}</h3>
    <div class="grid2">
      <input id="opname" type="text" placeholder="Name, e.g. ScotRail" value="${editing ? esc(editing.name) : ''}">
      <input id="opcol" type="color" value="${editing?.colour ?? '#1E5CB3'}">
    </div>
    <div class="grid2" style="margin-top:8px">
      <input id="opsite" type="text" placeholder="Website (optional)" value="${editing?.website ? esc(editing.website) : ''}">
      <select id="opregion" ${cross ? 'disabled' : ''}>
        ${REGIONS.map((r) => `<option value="${r.id}" ${chosen[0] === r.id ? 'selected' : ''}>${r.name}</option>`).join('')}
      </select>
    </div>
    <div class="check" style="margin-top:8px">Runs in more than one country<input id="opcross" type="checkbox" ${cross ? 'checked' : ''}></div>
    <div id="opcountries" class="picklist ${cross ? '' : 'hidden'}" style="margin-top:8px">
      ${REGIONS.map(
        (r) =>
          `<label><input type="checkbox" data-reg="${r.id}" ${chosen.includes(r.id) ? 'checked' : ''}>${r.name}</label>`,
      ).join('')}
    </div>

    <div class="actions">
      <button class="btn" id="opclose">Close</button>
      ${editing ? '<button class="btn" id="opcancel">Cancel edit</button>' : ''}
      <button class="btn p" id="opadd">${editing ? 'Save changes' : 'Add operator'}</button>
    </div>
  `;
  $('#dialog').classList.remove('hidden');

  const crossBox = $('#opcross') as HTMLInputElement;
  crossBox.onchange = () => {
    $('#opcountries').classList.toggle('hidden', !crossBox.checked);
    ($('#opregion') as HTMLSelectElement).disabled = crossBox.checked;
  };

  body.querySelectorAll('[data-edit]').forEach((b) => {
    (b as HTMLButtonElement).onclick = () => {
      editingOperator = (b as HTMLButtonElement).dataset.edit;
      openOperators();
    };
  });
  body.querySelectorAll('[data-del]').forEach((b) => {
    (b as HTMLButtonElement).onclick = () => {
      const id = (b as HTMLButtonElement).dataset.del!;
      delete state.project.operators[id];
      for (const sv of Object.values(doc().services)) {
        if (sv.operatorId === id) sv.operatorId = undefined;
      }
      if (editingOperator === id) editingOperator = undefined;
      openOperators();
      draw();
    };
  });

  const cancel = document.querySelector('#opcancel') as HTMLButtonElement | null;
  if (cancel) {
    cancel.onclick = () => {
      editingOperator = undefined;
      openOperators();
    };
  }
  ($('#opclose') as HTMLButtonElement).onclick = () => {
    editingOperator = undefined;
    $('#dialog').classList.add('hidden');
    renderPanels();
  };
  ($('#opadd') as HTMLButtonElement).onclick = () => {
    const name = ($('#opname') as HTMLInputElement).value.trim();
    if (!name) {
      setMessage('Give the operator a name first.');
      return;
    }
    const isCross = crossBox.checked;
    const regions: Region[] = isCross
      ? Array.from($('#opcountries').querySelectorAll('input'))
          .filter((b) => (b as HTMLInputElement).checked)
          .map((b) => (b as HTMLInputElement).dataset.reg as Region)
      : [($('#opregion') as HTMLSelectElement).value as Region];
    if (regions.length === 0) {
      setMessage('Tick at least one country.');
      return;
    }
    const id = editingOperator ?? newId('op');
    state.project.operators[id] = {
      id,
      name,
      colour: ($('#opcol') as HTMLInputElement).value,
      website: ($('#opsite') as HTMLInputElement).value.trim() || undefined,
      regions,
      crossBorder: isCross && regions.length > 1,
      region: undefined,
    };
    // services already using it follow the new colour
    for (const sv of Object.values(doc().services)) {
      if (sv.operatorId === id) sv.colour = state.project.operators[id].colour;
    }
    editingOperator = undefined;
    openOperators();
    draw();
  };
}
$('#operators').onclick = () => {
  editingOperator = undefined;
  openOperators();
};
$('#dialog').onclick = (ev) => {
  if (ev.target === $('#dialog')) {
    editingOperator = undefined;
    $('#dialog').classList.add('hidden');
    renderPanels();
  }
};

function addServiceToSelectedRoute() {
  const rid = state.selectedRoute;
  if (!rid) {
    setMessage('Select a route in the left panel first.');
    return;
  }
  const d = doc();
  const route = d.routes[rid];
  const stations = routeStations(rid);
  const palette = ['#0A55C4', '#0E8A3E', '#E2620E', '#7A2E8E', '#C4161C', '#0E8C8C'];
  const n = Object.keys(d.services).length;
  const sv: Service = {
    id: newId('sv'),
    name: `Service ${n + 1}`,
    style: 'main',
    routeIds: [rid],
    calls: stations,
    colour: palette[n % palette.length],
    order: n,
  };
  d.services[sv.id] = sv;
  state.selectedService = sv.id;
  state.focus = 'service';
  setMessage(`${sv.name} added to ${route.name}, calling everywhere. Untick the ones it passes.`);
  draw();
  renderPanels();
}

// ---------------------------------------------------------------- input
function wantsPan(ev: MouseEvent): boolean {
  return state.tool === 'pan' || state.spaceHeld || ev.button === 1 || ev.shiftKey;
}

/** Nearest town to a click, if the towns layer is on and one is close enough. */
function townAt(ev: MouseEvent): Place | undefined {
  if (!state.showTowns) return undefined;
  const m = screenToMap(ev);
  const reach = 14 / state.zoom;
  let best: Place | undefined;
  let bestD = reach;
  for (const p of visibleTowns()) {
    const d = Math.hypot(p.x - m.x, p.y - m.y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

wrap.addEventListener('mousedown', (ev) => {
  ev.preventDefault(); // stops the browser starting a text selection drag
  if (wantsPan(ev)) {
    state.panning = { x: ev.clientX - state.pan.x, y: ev.clientY - state.pan.y };
    wrap.classList.add('panning');
    return;
  }

  if (state.tool === 'coast') {
    const pt = coastPointAt(ev);
    if (pt) {
      state.coastPick = pt;
      state.coastDrag = pt;
      draw();
      renderPanels();
      return;
    }
    const edge = coastEdgeAt(ev);
    if (edge && state.project.outline) {
      const idx = insertPoint(state.project.outline, edge.shapeId, edge.index);
      if (idx !== null) {
        state.coastPick = { shapeId: edge.shapeId, index: idx };
        state.coastDrag = state.coastPick;
        setMessage('Point added — drag it into place.');
      }
      draw();
      renderPanels();
    }
    return;
  }

  if (state.tool === 'redit') {
    const d = doc();
    const rt = state.selectedRoute ? d.routes[state.selectedRoute] : undefined;
    if (!rt) {
      setMessage('Select a route on the left first.');
      return;
    }
    const cell = screenToCell(ev);
    const station = cellTaken(cell);

    // shift or alt adds a station to one end of the route
    if (station && (ev.shiftKey || ev.altKey)) {
      const node = { kind: 'station' as const, id: station };
      if (ev.altKey) rt.path.unshift(node);
      else rt.path.push(node);
      setMessage(`${d.stations[station].name} added to the ${ev.altKey ? 'start' : 'end'} of ${rt.name}.`);
      draw();
      renderPanels();
      return;
    }

    const node = routeNodeAt(ev);
    if (node !== undefined) {
      state.nodePick = node;
      state.nodeDrag = node;
      draw();
      renderPanels();
      return;
    }
    const edge = routeEdgeAt(ev);
    if (edge !== undefined) {
      const a = rt.path[edge];
      const b = rt.path[edge + 1];
      const ca = a.kind === 'bend' ? a.at : d.stations[a.id].cells[0];
      const cb = b.kind === 'bend' ? b.at : d.stations[b.id].cells[0];
      rt.path.splice(edge + 1, 0, {
        kind: 'bend',
        at: { x: Math.round((ca.x + cb.x) / 2), y: Math.round((ca.y + cb.y) / 2) },
      });
      state.nodePick = edge + 1;
      state.nodeDrag = state.nodePick;
      setMessage('Bend added — drag it into place.');
      draw();
      renderPanels();
    }
    return;
  }

  const c = screenToCell(ev);
  const hit = cellTaken(c);

  if (state.tool === 'station') {
    if (hit) {
      state.selectedStation = hit;
      state.focus = 'station';
      if (!doc().stations[hit].locked) state.dragging = hit;
    } else {
      const town = townAt(ev);
      const st: Station = {
        id: newId('st'),
        name: town ? town.n : 'New station',
        cells: [c],
        kind: 'stop',
        interchange: false,
      };
      doc().stations[st.id] = st;
      state.selectedStation = st.id;
      state.focus = 'station';
      if (town) setMessage(`Placed ${town.n}.`);
    }
    draw();
    renderPanels();
    return;
  }

  if (state.tool === 'route') {
    if (!hit) {
      setMessage('Route tool: click a station you have already placed.');
      return;
    }
    const prev = state.drawing[state.drawing.length - 1];
    if (prev === hit) return;
    let bent = false;
    if (prev) {
      const a = doc().stations[prev].cells[0];
      const b = doc().stations[hit].cells[0];
      bent = !isOctilinear(a, b);
      state.bendFlips.push(false);
    }
    state.drawing.push(hit);
    $('#finish-route').classList.toggle('hidden', state.drawing.length < 2);
    $('#cancel-route').classList.remove('hidden');
    $('#flip-bend').classList.toggle('hidden', !bent);
    setMessage(
      bent
        ? `${state.drawing.length} picked — a bend was added. Press F or Flip bend to send it the other way round.`
        : `${state.drawing.length} picked. Press Finish route when you are done.`,
    );
    draw();
    return;
  }

  if (hit) {
    state.selectedStation = hit;
    state.focus = 'station';
    if (!doc().stations[hit].locked) state.dragging = hit;
    draw();
    renderPanels();
  }
});

wrap.addEventListener('mousemove', (ev) => {
  const c = screenToCell(ev);
  $('#cell').textContent = `${c.x}, ${c.y}`;

  if (state.panning) {
    state.pan.x = ev.clientX - state.panning.x;
    state.pan.y = ev.clientY - state.panning.y;
    draw();
    return;
  }

  if (state.nodeDrag !== undefined && state.selectedRoute) {
    const d = doc();
    const rt = d.routes[state.selectedRoute];
    const node = rt?.path[state.nodeDrag];
    const cell = screenToCell(ev);
    if (node?.kind === 'bend') {
      node.at = cell;
    } else if (node?.kind === 'station') {
      const st = d.stations[node.id];
      if (st && !st.locked) {
        const anchor = st.cells[0];
        const dx = cell.x - anchor.x;
        const dy = cell.y - anchor.y;
        if (dx || dy) st.cells = st.cells.map((k) => ({ x: k.x + dx, y: k.y + dy }));
      }
    }
    draw();
    return;
  }

  if (state.coastDrag && state.project.outline) {
    const o = state.project.outline;
    const m = screenToMap(ev);
    const step = ev.shiftKey ? 0.25 : 1;      // shift for a finer nudge
    const to = {
      x: Math.round(m.x / o.unit / step) * step,
      y: Math.round(m.y / o.unit / step) * step,
    };
    movePoint(o, state.coastDrag.shapeId, state.coastDrag.index, to);
    draw();
    return;
  }

  if (!state.dragging) return;

  const st = doc().stations[state.dragging];
  const anchor = st.cells[0];
  const target = ev.altKey ? c : snapOctilinear(anchor, c);
  const dx = target.x - anchor.x;
  const dy = target.y - anchor.y;
  if (dx === 0 && dy === 0) return;
  st.cells = st.cells.map((k) => ({ x: k.x + dx, y: k.y + dy }));
  draw();
});

window.addEventListener('mouseup', () => {
  if (state.dragging) {
    respreadAround(state.dragging);
    draw();
    renderPanels();
  }
  if (state.coastDrag || state.nodeDrag !== undefined) renderPanels();
  state.nodeDrag = undefined;
  state.coastDrag = undefined;
  state.dragging = undefined;
  state.panning = undefined;
  wrap.classList.remove('panning');
});

window.addEventListener('keydown', (ev) => {
  if (ev.code === 'Space' && !state.spaceHeld) {
    const t = ev.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    ev.preventDefault();
    state.spaceHeld = true;
    wrap.classList.add('pan-ready');
  }
  if (ev.key === 'Escape') {
    cancelRoute();
    state.coastPick = undefined;
    draw();
  }
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && state.tool === 'redit' && state.nodePick !== undefined) {
    const t = ev.target as HTMLElement;
    if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) {
      ev.preventDefault();
      const rt = state.selectedRoute ? doc().routes[state.selectedRoute] : undefined;
      if (rt && rt.path.length > 2) {
        const was = rt.path[state.nodePick];
        rt.path.splice(state.nodePick, 1);
        state.nodePick = undefined;
        setMessage(was.kind === 'bend' ? 'Bend removed.' : 'Station taken off the route.');
      } else {
        setMessage('A route needs at least two points.');
      }
      draw();
      renderPanels();
    }
  }
  if ((ev.key === 'Delete' || ev.key === 'Backspace') && state.tool === 'coast' && state.coastPick) {
    const t = ev.target as HTMLElement;
    if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) {
      ev.preventDefault();
      const o = state.project.outline;
      if (o && deletePoint(o, state.coastPick.shapeId, state.coastPick.index)) {
        state.coastPick = undefined;
        setMessage('Point removed.');
      } else {
        setMessage('That point is shared with the country next door, so it stays.');
      }
      draw();
      renderPanels();
    }
  }
  if ((ev.key === 'f' || ev.key === 'F') && state.tool === 'route') {
    const t = ev.target as HTMLElement;
    if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA')) flipLastBend();
  }
});
window.addEventListener('keyup', (ev) => {
  if (ev.code === 'Space') {
    state.spaceHeld = false;
    wrap.classList.remove('pan-ready');
  }
});

wrap.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    if (ev.shiftKey) {
      state.pan.x -= ev.deltaY;
      draw();
      return;
    }
    const before = state.zoom;
    state.zoom = Math.min(8, Math.max(0.008, state.zoom * (ev.deltaY < 0 ? 1.12 : 0.893)));
    const r = wrap.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    const my = ev.clientY - r.top;
    state.pan.x = mx - ((mx - state.pan.x) * state.zoom) / before;
    state.pan.y = my - ((my - state.pan.y) * state.zoom) / before;
    draw();
  },
  { passive: false },
);

window.addEventListener('resize', draw);

// ---------------------------------------------------------------- chrome
document.querySelectorAll<HTMLButtonElement>('.tool[data-tool]').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tool[data-tool]').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    state.tool = b.dataset.tool as Tool;
    if (state.tool !== 'route') cancelRoute();
    wrap.classList.toggle('pan-ready', state.tool === 'pan');
  };
});

function flipLastBend() {
  if (state.bendFlips.length === 0) return;
  const i = state.bendFlips.length - 1;
  state.bendFlips[i] = !state.bendFlips[i];
  draw();
}
$('#flip-bend').onclick = flipLastBend;

function cancelRoute() {
  state.drawing = [];
  state.bendFlips = [];
  $('#flip-bend').classList.add('hidden');
  $('#finish-route').classList.add('hidden');
  $('#cancel-route').classList.add('hidden');
  draw();
}
$('#cancel-route').onclick = cancelRoute;

$('#finish-route').onclick = () => {
  if (state.drawing.length < 2) {
    setMessage('Pick at least two stations first.');
    return;
  }
  const rt: Route = {
    id: newId('rt'),
    name: `Route ${Object.keys(doc().routes).length + 1}`,
    style: 'main',
    path: buildPath(state.drawing, state.bendFlips),
  };
  doc().routes[rt.id] = rt;
  state.selectedRoute = rt.id;
  cancelRoute();
  setMessage(`${rt.name} created — grey until a service runs over it.`);
  draw();
  renderPanels();
};

$('#add-service').onclick = addServiceToSelectedRoute;

$('#lock').onclick = () => {
  const id = state.selectedStation;
  if (!id) {
    setMessage('Select a station first.');
    return;
  }
  const st = doc().stations[id];
  st.locked = !st.locked;
  setMessage(st.locked ? 'Locked — it will not move.' : 'Unlocked.');
  draw();
  renderPanels();
};

$('#fit').onclick = fitToMap;

$('#grid').onclick = () => {
  state.showGrid = !state.showGrid;
  $('#grid').classList.toggle('on', state.showGrid);
  draw();
};

$('#towns').onclick = () => {
  state.showTowns = !state.showTowns;
  $('#towns').classList.toggle('on', state.showTowns);
  $('#town-slider-wrap').classList.toggle('hidden', !state.showTowns);
  draw();
};

/**
 * The slider is a population floor, not a count: sliding right raises the bar so
 * only larger places survive. Curved so the useful range is not all bunched up
 * at one end, since town sizes are wildly uneven.
 */
($('#town-slider') as HTMLInputElement).oninput = (e) => {
  const v = Number((e.target as HTMLInputElement).value) / 100;
  state.townFloor = Math.round(500 * Math.pow(2000, v));
  draw();
};

$('#save').onclick = save;
$('#export-svg').onclick = async () => {
  const svg = renderSvg({
    doc: doc(),
    operators: state.project.operators,
    outline: state.project.outline,
  });
  const p = await window.api.exportSvg(svg);
  if (p) setMessage(`Exported to ${p}`);
};

async function save() {
  const p = await window.api.saveProject(JSON.stringify(state.project, null, 2), state.filePath);
  if (p) {
    state.filePath = p;
    $('#filename').textContent = `— ${p.split(/[\\/]/).pop()}`;
    setMessage('Saved.');
  }
}

/** Frame the whole country, whatever size the window is. */
function fitToMap() {
  const r = wrap.getBoundingClientRect();
  const z = Math.min(r.width / BASEMAP_W, r.height / BASEMAP_H) * 0.94;
  state.zoom = z;
  state.pan.x = (r.width - BASEMAP_W * z) / 2;
  state.pan.y = (r.height - BASEMAP_H * z) / 2;
  draw();
}

function setMessage(m: string) {
  $('#msg').textContent = m;
}

window.api.onMenu(async (what) => {
  if (what === 'save') return save();
  const r = await window.api.openProject();
  if (!r) return;
  state.project = JSON.parse(r.json) as Project;
  state.filePath = r.path;
  $('#filename').textContent = `— ${r.path.split(/[\\/]/).pop()}`;
  draw();
  renderPanels();
});

window.api.onUpdateReady(() => $('#update-bar').classList.remove('hidden'));
$('#restart').onclick = () => window.api.installUpdate();

// ---------------------------------------------------------------- boot
(async () => {
  state.places = PLACES;
  if (!state.project.outline) {
    state.project.outline = JSON.parse(JSON.stringify(OUTLINE)) as Outline;
  }
  $('#ver').textContent = `v${await window.api.version()}`;
  fitToMap();
  renderPanels();
})();
