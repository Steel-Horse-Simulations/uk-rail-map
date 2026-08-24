/**
 * The data model.
 *
 * A ROUTE is the base layer: physical track, holding every station along it in order.
 * A SERVICE is drawn on top of one or more routes, with its own colour and its own
 * stopping pattern, and may start or finish partway along a route.
 */

export type Cell = { x: number; y: number };

/** A node in a route's path: either a station, or a plain bend point. */
export type Node =
  | { kind: 'station'; id: string }
  | { kind: 'bend'; at: Cell };

export type StationKind =
  | 'stop'
  | 'interchange'
  | 'terminus'
  | 'grey'; // a bus or ferry stop with no rail

export interface Station {
  id: string;
  name: string;
  /** A station may occupy several cells; big termini need the room. */
  cells: Cell[];
  kind: StationKind;
  /** Interchange marker is a per-station choice, not inferred from service count. */
  interchange: boolean;
  airport?: boolean;
  proposed?: boolean;
  locked?: boolean;
  /** Real-world position, used to seed placement and to draw ghost markers. */
  lat?: number;
  lon?: number;
}

export type LineStyle = 'main' | 'metro' | 'heritage' | 'construction' | 'ferry' | 'bus';

export interface Route {
  id: string;
  name: string;
  style: LineStyle;
  path: Node[];
  /** Segment index -> locked. A locked stretch will not be moved by re-layout. */
  lockedSegments?: number[];
}

export interface OneWayRun {
  fromIndex: number;
  toIndex: number;
  reversed?: boolean;
}

export interface Service {
  id: string;
  name: string;
  style: LineStyle;
  operatorId?: string;
  /** Explicit colour overrides the operator's. */
  colour?: string;
  /** Routes this service runs over, in order. */
  routeIds: string[];
  /** The stations it actually calls at. Everything else on the path is passed. */
  calls: string[];
  /** Position across a shared corridor. Lower sits on one side, higher the other. */
  order?: number;
  oneWayWhole?: boolean;
  oneWayRuns?: OneWayRun[];
  /** Which side of the line the bus or ferry glyph sits on. */
  glyphSide?: 'left' | 'right';
}

/** Which country's list an operator is filed under. */
export type Region = 'sco' | 'eng' | 'wal' | 'ni' | 'ire';

export const REGIONS: { id: Region; name: string }[] = [
  { id: 'sco', name: 'Scottish' },
  { id: 'eng', name: 'English' },
  { id: 'wal', name: 'Welsh' },
  { id: 'ni', name: 'Northern Irish' },
  { id: 'ire', name: 'Irish' },
];

export interface Operator {
  id: string;
  name: string;
  colour?: string;
  website?: string;
  logo?: string;
  region: Region;
  metro?: boolean;
}

export interface MapDoc {
  id: string;
  name: string;
  /** Grid pitch in pixels at 100% zoom. */
  cellSize: number;
  stations: Record<string, Station>;
  routes: Record<string, Route>;
  services: Record<string, Service>;
}

export interface Project {
  version: 1;
  name: string;
  operators: Record<string, Operator>;
  /** The rail map, plus any others such as buses and trams. */
  maps: Record<string, MapDoc>;
  activeMapId: string;
}

export function emptyProject(name = 'Untitled map'): Project {
  return {
    version: 1,
    name,
    operators: {},
    maps: {
      rail: {
        id: 'rail',
        name: 'Rail',
        cellSize: 34,
        stations: {},
        routes: {},
        services: {},
      },
    },
    activeMapId: 'rail',
  };
}

export function nodeCell(doc: MapDoc, n: Node): Cell {
  if (n.kind === 'bend') return n.at;
  const s = doc.stations[n.id];
  if (!s) throw new Error(`unknown station ${n.id}`);
  return s.cells[0];
}

let counter = 0;
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}
