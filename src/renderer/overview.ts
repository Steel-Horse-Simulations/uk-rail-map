/**
 * The overview window.
 *
 * A second screen that watches: it never edits anything. The editor sends its
 * project across whenever the drawing changes and this redraws, fitted to where
 * the network actually is rather than to the whole coastline.
 *
 * The right-hand aside is deliberately empty and hidden — it is where panels
 * will go later without having to rearrange the window.
 */
import type { Project } from '../core/model';
import { renderSvg } from '../core/render';
import { outlineSvg } from '../core/outline';

declare global {
  interface Window {
    overview: {
      onData(cb: (payload: OverviewPayload) => void): void;
    };
  }
}

export interface OverviewPayload {
  project: Project;
  /** what the editor is looking at, in map units */
  view: { x: number; y: number; w: number; h: number };
}

type Show = 'coast' | 'routes' | 'services' | 'labels';

const state = {
  payload: undefined as OverviewPayload | undefined,
  scope: 'all' as 'all' | 'view',
  show: { coast: true, routes: true, services: true, labels: true } as Record<Show, boolean>,
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

/** The box the network occupies — stations and bends, not the coastline. */
function networkBounds(p: Project) {
  const doc = p.maps[p.activeMapId];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const st of Object.values(doc.stations)) for (const c of st.cells) add(c.x, c.y);
  for (const rt of Object.values(doc.routes)) {
    for (const n of rt.path) if (n.kind === 'bend') add(n.at.x, n.at.y);
  }
  if (!Number.isFinite(minX)) return null;
  const cs = doc.cellSize;
  const pad = 12 * cs;
  return {
    x: minX * cs - pad,
    y: minY * cs - pad,
    w: (maxX - minX) * cs + pad * 2,
    h: (maxY - minY) * cs + pad * 2,
  };
}

function draw() {
  const payload = state.payload;
  if (!payload) return;
  const { project } = payload;
  const doc = project.maps[project.activeMapId];

  // A stripped-back copy rather than flags threaded through the renderer: the
  // overview is a view of the same data, so hiding a layer means not giving it
  // to the renderer in the first place.
  const shown = {
    ...doc,
    routes: state.show.routes || state.show.services ? doc.routes : {},
    services: state.show.services ? doc.services : {},
    stations: state.show.labels
      ? doc.stations
      : Object.fromEntries(
          Object.entries(doc.stations).map(([id, st]) => [id, { ...st, name: '' }]),
        ),
  };

  const svg = renderSvg({
    doc: shown,
    operators: project.operators,
    outline: state.show.coast ? project.outline : undefined,
  });
  $('#canvas').innerHTML = svg;

  const el = document.querySelector('#canvas svg');
  if (el) {
    const box =
      state.scope === 'view' ? payload.view : (networkBounds(project) ?? payload.view);
    el.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
    el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }

  $('#counts').textContent =
    `${Object.keys(doc.stations).length} stations · ${Object.keys(doc.routes).length} routes · ` +
    `${Object.keys(doc.services).length} services`;
  $('#what').textContent = state.scope === 'view' ? "where you're working" : 'whole network';
  void outlineSvg;
}

$('#scope-all').onclick = () => {
  state.scope = 'all';
  $('#scope-all').classList.add('on');
  $('#scope-view').classList.remove('on');
  draw();
};
$('#scope-view').onclick = () => {
  state.scope = 'view';
  $('#scope-view').classList.add('on');
  $('#scope-all').classList.remove('on');
  draw();
};

document.querySelectorAll<HTMLButtonElement>('[data-show]').forEach((b) => {
  b.onclick = () => {
    const key = b.dataset.show as Show;
    state.show[key] = !state.show[key];
    b.classList.toggle('on', state.show[key]);
    draw();
  };
});

window.overview.onData((payload) => {
  state.payload = payload;
  draw();
});

window.addEventListener('resize', draw);
