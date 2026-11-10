/**
 * What every floor plan shares: a 24 × 16 grid (x to the right, z towards
 * the viewer), the door and the elevator at the bottom edge, the 12 desk pods
 * of a department floor and the shapes the plans are made of. The plans
 * themselves (one per floor theme) are in floorPlans.ts. Pure data, shared by
 * the 3D scene and the tests.
 *
 *   x 0‥12  work area (on department floors: 12 pods, 4 columns × 3 rows)
 *   x 13    the aisle, with the door (13,15) and the elevator (12,15) beside it
 *   x 14‥23 three rooms: A (z 0‥5), B (z 6‥10), C (z 11‥15)
 */

export const GRID_W = 24;
export const GRID_H = 16;

export interface Cell {
  x: number;
  z: number;
}

export type Facing = 'north' | 'south' | 'east' | 'west';

export interface Seat extends Cell {
  /** Which way a seated character looks (towards its desk). */
  facing: Facing;
}

export interface Pod {
  index: number;
  /** Top-left desk cell; the pod's desks fill (x‥x+1, z‥z+1). */
  x: number;
  z: number;
  desks: Cell[];
  /** Seat 0 is the main character's, seats 1‥3 the members'. */
  seats: Seat[];
  /** Aisle cells beside the pod where members beyond the third stand. */
  standing: Cell[];
  center: { x: number; z: number };
}

export interface Zone {
  name: string;
  /** The room whose name depends on the floor (president's, managers' meeting, team lead's). */
  room?: boolean;
  x: number;
  z: number;
  w: number;
  d: number;
  color: number;
}

export interface Furniture {
  model: string;
  x: number;
  z: number;
  w: number;
  d: number;
  /** Radians around the vertical axis; 0 = the model's front faces +z (towards the viewer). */
  rot?: number;
  /** Height to scale the model to; omitted = fit the footprint. */
  h?: number;
  /** Stands on another model (e.g. a coffee machine on a cabinet). */
  y0?: number;
  /** Rugs and similar: drawn but walkable. */
  walkable?: boolean;
}

export const DOOR: Cell = { x: 13, z: 15 };
/** Where people come and go on every floor but the lobby: next to the door, off the aisle. */
export const ELEVATOR: Cell = { x: 12, z: 15 };

const POD_COLUMNS = [1, 4, 7, 10];
const POD_ROWS = [1, 6, 11];

/** The 12 pods of a department floor, in 4 columns × 3 rows. */
export const PODS: Pod[] = POD_ROWS.flatMap((pz, row) =>
  POD_COLUMNS.map((px, col) => {
    const index = row * POD_COLUMNS.length + col;
    return {
      index,
      x: px,
      z: pz + 1,
      desks: [
        { x: px, z: pz + 1 },
        { x: px + 1, z: pz + 1 },
        { x: px, z: pz + 2 },
        { x: px + 1, z: pz + 2 },
      ],
      seats: [
        { x: px, z: pz, facing: 'south' },
        { x: px + 1, z: pz, facing: 'south' },
        { x: px, z: pz + 3, facing: 'north' },
        { x: px + 1, z: pz + 3, facing: 'north' },
      ],
      standing: [
        { x: px + 2, z: pz + 1 },
        { x: px + 2, z: pz + 2 },
        { x: px - 1, z: pz + 1 },
        { x: px - 1, z: pz + 2 },
      ],
      center: { x: px + 1, z: pz + 2 },
    } satisfies Pod;
  }),
);

/** Allocation order: pods nearest the door (and the viewer) fill first. */
export const POD_ORDER: number[] = PODS.map((p) => p.index).sort(
  (a, b) => podDistance(PODS[a]) - podDistance(PODS[b]) || a - b,
);

function podDistance(pod: Pod): number {
  return Math.abs(pod.center.x - DOOR.x) + Math.abs(pod.center.z - DOOR.z);
}

export const POD_SEATS = 4;

/** Where an idle employee can go and how it spends its time there. */
export interface Poi extends Cell {
  name: string;
  facing: Facing;
  pose: 'sit' | 'stand';
}

export const cellKey = (c: Cell): string => `${c.x},${c.z}`;
