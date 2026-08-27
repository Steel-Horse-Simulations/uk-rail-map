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
  /**
   * The three-letter station code (ABD, STN). Kept with the station but never
   * drawn — it is there for matching against timetables and station lists.
   */
  code?: string;
  /** A station may occupy several cells; big termini need the room. */
  cells: Cell[];
  kind: StationKind;
  /** Interchange marker is a per-station choice, not inferred from service count. */
  interchange: boolean;
  airport?: boolean;
  proposed?: boolean;
  locked?: boolean;
  /**
   * Orientation of the station's body, in 45-degree steps clockwise from east.
   * Left undefined the app works it out from the lines meeting the station; set
   * it, or lock it, and it stays where you put it.
   */
  rotation?: number;
  rotationLocked?: boolean;
  /** Name drawn flat, tilted up, or tilted down. */
  labelAngle?: 0 | -45 | 45;
  /**
   * Which side of the line the tick sticks out, and with it the name. Applies to
   * every service calling here, so a station reads as one thing.
   */
  tickSide?: 'left' | 'right';
  /** Which way the arm of a T-shaped interchange sticks out. */
  armSide?: 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';
  /**
   * Set on stations that were spread evenly between two others, so they can be
   * spread again if one of those two moves.
   */
  spacing?: { routeId: string; anchorA: string; anchorB: string };
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
  /** Where the service begins and ends. Blank means the far ends of its routes. */
  fromStation?: string;
  toStation?: string;
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
  /** Every country this operator runs in. One entry unless it crosses a border. */
  regions: Region[];
  /** Filed under Cross-border rather than under a single country. */
  crossBorder?: boolean;
  /** Older files stored a single country here. */
  region?: Region;
  metro?: boolean;
}

/** Reads either shape, so maps saved before cross-border support still load. */
export function operatorRegions(o: Operator): Region[] {
  if (o.regions?.length) return o.regions;
  return o.region ? [o.region] : [];
}

export interface MapDoc {
  id: string;
  name: string;
  /** Grid pitch in map units: how finely stations can be placed. */
  cellSize: number;
  /** How heavily the map is drawn, independent of the pitch. 1 is thin, 4 is bold. */
  weight?: number;
  stations: Record<string, Station>;
  routes: Record<string, Route>;
  services: Record<string, Service>;
}

export interface Project {
  version: 1;
  name: string;
  /** The coastline, editable inside the app and saved with the map. */
  outline?: import('./outline').Outline;
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
        cellSize: 10,
        weight: 2,
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
