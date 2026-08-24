import {
  emptyProject,
  newId,
  type Cell,
  type MapDoc,
  type Project,
  type Route,
  type Service,
  type Station,
} from '../core/model';
import { renderSvg } from '../core/render';
import { isOctilinear, snapOctilinear } from '../core/geometry';

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

type Tool = 'select' | 'station' | 'route';

/** A town or city from the overlay: name, position, population, tier. */
export interface Place {
  n: string;
  x: number;
  y: number;
  p: number;
  t: number;
}

const state = {
  project: emptyProject('UK network'),
  filePath: undefined as string | undefined,
  basemap: '',
  tool: 'station' as Tool,
  zoom: 1,
  pan: { x: 60, y: 60 },
  selectedStation: undefined as string | undefined,
  selectedRoute: undefined as string | undefined,
  /** stations picked so far while drawing a route */
  drawing: [] as string[],
  dragging: undefined as string | undefined,
  places: [] as Place[],
  showTowns: false,
};

const doc = (): MapDoc => state.project.maps[state.project.activeMapId];

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const canvas = $('#canvas');
const wrap = $('#canvas-wrap');

// ---------------------------------------------------------------- helpers
function screenToCell(ev: MouseEvent): Cell {
  const r = wrap.getBoundingClientRect();
  const cs = doc().cellSize * state.zoom;
  return {
    x: Math.round((ev.clientX - r.left - state.pan.x) / cs),
    y: Math.round((ev.clientY - r.top - state.pan.y) / cs),
  };
}

function cellTaken(c: Cell): string | undefined {
  for (const st of Object.values(doc().stations)) {
    if (st.cells.some((k) => k.x === c.x && k.y === c.y)) return st.id;
  }
  return undefined;
}

function addStation(c: Cell): Station {
  const st: Station = {
    id: newId('st'),
    name: 'New station',
    cells: [c],
    kind: 'stop',
    interchange: false,
  };
  doc().stations[st.id] = st;
  return st;
}

// ---------------------------------------------------------------- drawing
function draw() {
  const d = doc();
  const svg = renderSvg({
    doc: d,
    operators: state.project.operators,
    basemap: state.basemap,
  });
  canvas.innerHTML = svg;

  const el = canvas.querySelector('svg');
  if (el) {
    // pan and zoom by moving the viewBox origin rather than scaling the DOM,
    // so line widths and text stay crisp at any magnification
    const cs = d.cellSize;
    const r = wrap.getBoundingClientRect();
    const w = r.width / state.zoom;
    const h = r.height / state.zoom;
    const ox = -state.pan.x / state.zoom;
    const oy = -state.pan.y / state.zoom;
    el.setAttribute('viewBox', `${ox} ${oy} ${w} ${h}`);
    el.setAttribute('preserveAspectRatio', 'xMinYMin slice');

    const ns = 'http://www.w3.org/2000/svg';

    // towns and cities, thinned by zoom: at a distance only the big places,
    // and the whole gazetteer once you are close enough to place a station
    if (state.showTowns && state.places.length) {
      const maxTier = state.zoom < 0.5 ? 0 : state.zoom < 1 ? 1 : state.zoom < 2 ? 2 : 3;
      const dotR = state.zoom > 1.5 ? 2.4 : 3.2;
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', 'towns');
      for (const pl of state.places) {
        if (pl.t > maxTier) continue;
        const dot = document.createElementNS(ns, 'circle');
        dot.setAttribute('cx', String(pl.x));
        dot.setAttribute('cy', String(pl.y));
        dot.setAttribute('r', String(pl.t === 0 ? dotR * 1.5 : dotR));
        dot.setAttribute('fill', '#7C8A98');
        dot.setAttribute('opacity', '0.75');
        g.appendChild(dot);
        if (pl.t <= Math.min(maxTier, 2)) {
          const t = document.createElementNS(ns, 'text');
          t.setAttribute('x', String(pl.x + 6));
          t.setAttribute('y', String(pl.y + 4));
          t.setAttribute('font-size', String(pl.t === 0 ? 15 : 12));
          t.setAttribute('font-weight', pl.t === 0 ? '700' : '400');
          t.setAttribute('fill', '#5A6B7C');
          t.setAttribute('paint-order', 'stroke');
          t.setAttribute('stroke', '#ffffff');
          t.setAttribute('stroke-width', '3');
          t.textContent = pl.n;
          g.appendChild(t);
        }
      }
      el.appendChild(g);
    }

    // stations that exist but have no service yet still need to be visible
    for (const st of Object.values(d.stations)) {
      const used = Object.values(d.routes).some((rt) =>
        rt.path.some((n) => n.kind === 'station' && n.id === st.id),
      );
      if (used) continue;
      const c = st.cells[0];
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', String(c.x * cs));
      dot.setAttribute('cy', String(c.y * cs));
      dot.setAttribute('r', '5');
      dot.setAttribute('fill', '#fff');
      dot.setAttribute('stroke', st.id === state.selectedStation ? '#E8930C' : '#9A9A9A');
      dot.setAttribute('stroke-width', '2.5');
      el.appendChild(dot);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', String(c.x * cs + 10));
      label.setAttribute('y', String(c.y * cs + 4));
      label.setAttribute('font-size', '12');
      label.setAttribute('fill', '#6C7C8C');
      label.textContent = st.name;
      el.appendChild(label);
    }
  }

  renderPanels();
  $('#counts').textContent =
    `${Object.keys(d.stations).length} stations · ${Object.keys(d.routes).length} routes · ${Object.keys(d.services).length} services`;
  $('#zoom').textContent = `${Math.round(state.zoom * 100)}%`;
}

function renderPanels() {
  const d = doc();
  const routes = $('#routes');
  routes.innerHTML = '';
  for (const rt of Object.values(d.routes)) {
    const li = document.createElement('li');
    if (rt.id === state.selectedRoute) li.className = 'sel';
    li.innerHTML = `<span class="bar" style="background:#9AA8B6"></span>${rt.name}`;
    li.onclick = () => {
      state.selectedRoute = rt.id;
      draw();
    };
    routes.appendChild(li);
  }
  const services = $('#services');
  services.innerHTML = '';
  for (const sv of Object.values(d.services)) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="bar" style="background:${sv.colour ?? '#0A55C4'}"></span>${sv.name}`;
    services.appendChild(li);
  }
  renderInspector();
}

function renderInspector() {
  const insp = $('#inspector');
  const st = state.selectedStation ? doc().stations[state.selectedStation] : undefined;
  if (!st) {
    insp.innerHTML = '<p class="hint">Click the canvas to place a station. Pick the Route tool and click stations in order to draw track.</p>';
    return;
  }
  insp.innerHTML = `
    <h2>Station</h2>
    <label for="nm">Name</label>
    <input id="nm" type="text" value="${st.name.replace(/"/g, '&quot;')}">
    <label>Cells</label>
    <p class="hint">${st.cells.map((c) => `${c.x},${c.y}`).join('  ')}</p>
    <div class="check">Interchange<input id="ic" type="checkbox" ${st.interchange ? 'checked' : ''}></div>
    <div class="check">Airport<input id="ap" type="checkbox" ${st.airport ? 'checked' : ''}></div>
    <div class="check">Proposed or closed<input id="pr" type="checkbox" ${st.proposed ? 'checked' : ''}></div>
    <div class="check">Lock position<input id="lk" type="checkbox" ${st.locked ? 'checked' : ''}></div>
    <button class="mini" id="widen">Add a cell to the right</button>
  `;
  ($('#nm') as HTMLInputElement).oninput = (e) => {
    st.name = (e.target as HTMLInputElement).value;
    draw();
  };
  const bind = (id: string, key: 'interchange' | 'airport' | 'proposed' | 'locked') => {
    ($(id) as HTMLInputElement).onchange = (e) => {
      (st as unknown as Record<string, boolean>)[key] = (e.target as HTMLInputElement).checked;
      draw();
    };
  };
  bind('#ic', 'interchange');
  bind('#ap', 'airport');
  bind('#pr', 'proposed');
  bind('#lk', 'locked');
  ($('#widen') as HTMLButtonElement).onclick = () => {
    const last = st.cells[st.cells.length - 1];
    st.cells.push({ x: last.x + 1, y: last.y });
    draw();
  };
}

// ---------------------------------------------------------------- input
wrap.addEventListener('mousedown', (ev) => {
  if (ev.button === 1 || ev.shiftKey) return; // middle or shift starts a pan
  const c = screenToCell(ev);
  const hit = cellTaken(c);

  if (state.tool === 'station') {
    if (hit) {
      state.selectedStation = hit;
      const st = doc().stations[hit];
      if (!st.locked) state.dragging = hit;
    } else {
      const st = addStation(c);
      state.selectedStation = st.id;
    }
    draw();
    return;
  }

  if (state.tool === 'route') {
    if (!hit) {
      setMessage('Route tool: click an existing station.');
      return;
    }
    const prev = state.drawing[state.drawing.length - 1];
    if (prev) {
      const a = doc().stations[prev].cells[0];
      const b = doc().stations[hit].cells[0];
      if (!isOctilinear(a, b)) {
        setMessage('That leg is not on 90 or 45 degrees — add a bend first.');
        return;
      }
    }
    state.drawing.push(hit);
    setMessage(`${state.drawing.length} stations picked. Press Finish route when done.`);
    draw();
    return;
  }

  if (hit) {
    state.selectedStation = hit;
    draw();
  }
});

wrap.addEventListener('mousemove', (ev) => {
  const c = screenToCell(ev);
  $('#cell').textContent = `${c.x}, ${c.y}`;
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
  state.dragging = undefined;
});

wrap.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  if (ev.ctrlKey || ev.metaKey) {
    const before = state.zoom;
    state.zoom = Math.min(6, Math.max(0.15, state.zoom * (ev.deltaY < 0 ? 1.12 : 0.89)));
    const r = wrap.getBoundingClientRect();
    const mx = ev.clientX - r.left;
    const my = ev.clientY - r.top;
    state.pan.x = mx - ((mx - state.pan.x) * state.zoom) / before;
    state.pan.y = my - ((my - state.pan.y) * state.zoom) / before;
  } else {
    state.pan.x -= ev.deltaX;
    state.pan.y -= ev.deltaY;
  }
  draw();
}, { passive: false });

// ---------------------------------------------------------------- chrome
document.querySelectorAll<HTMLButtonElement>('.tool[data-tool]').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tool[data-tool]').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    state.tool = b.dataset.tool as Tool;
    state.drawing = [];
  };
});

$('#finish-route').onclick = () => {
  if (state.drawing.length < 2) {
    setMessage('Pick at least two stations first.');
    return;
  }
  const rt: Route = {
    id: newId('rt'),
    name: `Route ${Object.keys(doc().routes).length + 1}`,
    style: 'main',
    path: state.drawing.map((id) => ({ kind: 'station', id })),
  };
  doc().routes[rt.id] = rt;
  state.selectedRoute = rt.id;
  state.drawing = [];
  setMessage(`Created ${rt.name}. Add a service to give it colour.`);
  draw();
};

$('#add-service').onclick = () => {
  const rid = state.selectedRoute;
  if (!rid) {
    setMessage('Select a route first.');
    return;
  }
  const route = doc().routes[rid];
  const stations = route.path.filter((n) => n.kind === 'station').map((n) => (n as { id: string }).id);
  const sv: Service = {
    id: newId('sv'),
    name: `Service ${Object.keys(doc().services).length + 1}`,
    style: 'main',
    routeIds: [rid],
    calls: stations,
  };
  doc().services[sv.id] = sv;
  draw();
};

$('#lock').onclick = () => {
  const id = state.selectedStation;
  if (!id) return;
  const st = doc().stations[id];
  st.locked = !st.locked;
  setMessage(st.locked ? 'Station locked.' : 'Station unlocked.');
  draw();
};

$('#towns').onclick = () => {
  state.showTowns = !state.showTowns;
  $('#towns').classList.toggle('on', state.showTowns);
  setMessage(state.showTowns ? 'Towns shown — zoom in for the smaller ones.' : 'Towns hidden.');
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
    setMessage(`Saved to ${p}`);
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
  draw();
});

window.api.onUpdateReady(() => {
  $('#update-bar').classList.remove('hidden');
});
$('#restart').onclick = () => window.api.installUpdate();

// ---------------------------------------------------------------- boot
(async () => {
  state.basemap = await window.api.readBasemap();
  // the basemap is a whole SVG document; lift its contents into our own
  const inner = state.basemap.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  state.basemap = `<g class="basemap" transform="translate(0,0)">${inner}</g>`;
  state.places = (await window.api.readPlaces()).places;
  $('#ver').textContent = `v${await window.api.version()}`;
  draw();
})();
