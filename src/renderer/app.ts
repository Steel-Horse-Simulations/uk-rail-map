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
import { renderSvg } from '../core/render';
import { elbow, isOctilinear, snapOctilinear } from '../core/geometry';
import { BASEMAP_SVG, PLACES } from '../generated/assets';

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

type Tool = 'select' | 'station' | 'route' | 'pan';

const state = {
  project: emptyProject('UK network'),
  filePath: undefined as string | undefined,
  basemap: '',
  places: [] as Place[],
  tool: 'station' as Tool,
  zoom: 0.5,
  pan: { x: 40, y: 20 },
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
      basemap: state.basemap,
      underlays: gridLayer() + townsLayer(),
      overlays: previewLayer() + selectionLayer(),
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
    <label class="f">${stations.length} stations, in order</label>
    <div class="picklist">
      ${stations.map((id) => `<label>${esc(d.stations[id]?.name ?? id)}</label>`).join('')}
    </div>
    <div class="rowbtns">
      <button class="mini" id="rsvc">Add service</button>
      <button class="mini" id="rdel">Delete route</button>
    </div>
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
  // every station the service passes, taken from the routes it runs over
  const along: string[] = [];
  for (const rid of sv.routeIds) {
    for (const id of routeStations(rid)) if (!along.includes(id)) along.push(id);
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

    <label class="f">Calls at (${sv.calls.length} of ${along.length})</label>
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
  if (state.dragging) renderPanels();
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
  if (ev.key === 'Escape') cancelRoute();
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
    state.zoom = Math.min(8, Math.max(0.08, state.zoom * (ev.deltaY < 0 ? 1.12 : 0.893)));
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
  const svg = renderSvg({ doc: doc(), operators: state.project.operators, basemap: state.basemap });
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
  state.basemap = BASEMAP_SVG;
  state.places = PLACES;
  $('#ver').textContent = `v${await window.api.version()}`;
  draw();
  renderPanels();
})();
