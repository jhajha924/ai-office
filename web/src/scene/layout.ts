/**
 * The office floor plan: a 24 × 16 grid (x to the right, z towards the
 * viewer), four zones, 12 desk pods and every piece of furniture. Pure data,
 * shared by the 3D scene and the tests.
 *
 *   x 0‥12  desk area: 12 pods in 4 columns × 3 rows, aisles between them
 *   x 14‥23 meeting room (z 0‥5), pantry (z 6‥10), lounge (z 11‥15)
 *   door at the bottom edge, x 13
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

export const ZONES: Zone[] = [
  { name: '工位區', x: 0, z: 0, w: 13, d: 16, color: 0xe9e4da },
  { name: '會議室', x: 14, z: 0, w: 10, d: 6, color: 0xdde6ee },
  { name: '茶水間', x: 14, z: 6, w: 10, d: 5, color: 0xf1e6d2 },
  { name: '休息區', x: 14, z: 11, w: 10, d: 5, color: 0xe3eedf },
];

const POD_COLUMNS = [1, 4, 7, 10];
const POD_ROWS = [1, 6, 11];

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

const HALF_PI = Math.PI / 2;

export const FURNITURE: Furniture[] = [
  // Meeting room: one big table with chairs, a TV at the wall.
  { model: 'rugRectangle', x: 15, z: 1, w: 7, d: 4, walkable: true },
  { model: 'table', x: 16, z: 2, w: 4, d: 2, h: 0.75 },
  { model: 'chairCushion', x: 16, z: 1, w: 1, d: 1, h: 0.8 },
  { model: 'chairCushion', x: 17, z: 1, w: 1, d: 1, h: 0.8 },
  { model: 'chairCushion', x: 18, z: 1, w: 1, d: 1, h: 0.8 },
  { model: 'chairCushion', x: 19, z: 1, w: 1, d: 1, h: 0.8 },
  { model: 'chairCushion', x: 16, z: 4, w: 1, d: 1, rot: Math.PI, h: 0.8 },
  { model: 'chairCushion', x: 17, z: 4, w: 1, d: 1, rot: Math.PI, h: 0.8 },
  { model: 'chairCushion', x: 18, z: 4, w: 1, d: 1, rot: Math.PI, h: 0.8 },
  { model: 'chairCushion', x: 19, z: 4, w: 1, d: 1, rot: Math.PI, h: 0.8 },
  { model: 'cabinetTelevision', x: 23, z: 2, w: 1, d: 2, rot: -HALF_PI, h: 0.9 },
  { model: 'pottedPlant', x: 14, z: 0, w: 1, d: 1, h: 1.0 },

  // Pantry: counter along the back wall, a bar with stools.
  { model: 'kitchenFridgeLarge', x: 23, z: 6, w: 1, d: 1, h: 1.6 },
  { model: 'kitchenCabinet', x: 22, z: 6, w: 1, d: 1, h: 0.86 },
  { model: 'kitchenSink', x: 21, z: 6, w: 1, d: 1, h: 0.86 },
  { model: 'kitchenCabinet', x: 20, z: 6, w: 1, d: 1, h: 0.86 },
  { model: 'kitchenCoffeeMachine', x: 20, z: 6, w: 0.6, d: 0.6, y0: 0.86, walkable: true },
  { model: 'kitchenMicrowave', x: 22, z: 6, w: 0.7, d: 0.6, y0: 0.86, walkable: true },
  { model: 'kitchenBar', x: 17, z: 8, w: 3, d: 1, h: 0.95 },
  { model: 'stoolBar', x: 17, z: 9, w: 1, d: 1, h: 0.65 },
  { model: 'stoolBar', x: 18, z: 9, w: 1, d: 1, h: 0.65 },
  { model: 'stoolBar', x: 19, z: 9, w: 1, d: 1, h: 0.65 },

  // Lounge: sofa round a coffee table, books, a lamp, plants.
  { model: 'rugRound', x: 17, z: 11, w: 5, d: 4, walkable: true },
  { model: 'loungeSofa', x: 18, z: 14, w: 3, d: 1, rot: Math.PI, h: 0.7 },
  { model: 'tableCoffee', x: 18, z: 12, w: 3, d: 1, h: 0.35 },
  { model: 'loungeChairRelax', x: 16, z: 12, w: 1, d: 1, rot: HALF_PI, h: 0.75 },
  { model: 'bookcaseOpen', x: 23, z: 11, w: 1, d: 2, rot: -HALF_PI, h: 1.7 },
  { model: 'lampRoundFloor', x: 22, z: 14, w: 1, d: 1, h: 1.5 },
  { model: 'pottedPlant', x: 23, z: 15, w: 1, d: 1, h: 1.0 },
  { model: 'plantSmall2', x: 14, z: 15, w: 1, d: 1, h: 0.5 },

  // Desk area corners and the door mat.
  { model: 'pottedPlant', x: 0, z: 0, w: 1, d: 1, h: 1.0 },
  { model: 'plantSmall1', x: 12, z: 0, w: 1, d: 1, h: 0.5 },
  { model: 'coatRackStanding', x: 12, z: 15, w: 1, d: 1, h: 1.5 },
];

/** The pantry's ping-pong table: no Kenney model, so the scene builds it from boxes. */
export const PING_PONG = { x: 21, z: 9, w: 2, d: 1 };

/** Where an idle employee can go and how it spends its time there. */
export interface Poi extends Cell {
  name: string;
  facing: Facing;
  pose: 'sit' | 'stand';
}

export const POIS: Poi[] = [
  { name: '咖啡機', x: 20, z: 7, facing: 'north', pose: 'stand' },
  { name: '微波爐', x: 22, z: 7, facing: 'north', pose: 'stand' },
  { name: '吧檯', x: 16, z: 8, facing: 'east', pose: 'stand' },
  { name: '桌球桌西', x: 20, z: 9, facing: 'east', pose: 'stand' },
  { name: '桌球桌東', x: 23, z: 9, facing: 'west', pose: 'stand' },
  { name: '沙發左', x: 18, z: 13, facing: 'north', pose: 'sit' },
  { name: '沙發右', x: 20, z: 13, facing: 'north', pose: 'sit' },
  { name: '書櫃', x: 22, z: 12, facing: 'east', pose: 'stand' },
];

/** Cells nobody can walk through: desks, non-walkable furniture and the ping-pong table. */
export function blockedCells(): Set<string> {
  const blocked = new Set<string>();
  for (const pod of PODS) for (const desk of pod.desks) blocked.add(cellKey(desk));
  for (let x = PING_PONG.x; x < PING_PONG.x + PING_PONG.w; x++) {
    for (let z = PING_PONG.z; z < PING_PONG.z + PING_PONG.d; z++) blocked.add(cellKey({ x, z }));
  }
  for (const f of FURNITURE) {
    if (f.walkable || f.y0) continue;
    for (let x = f.x; x < f.x + Math.ceil(f.w); x++) {
      for (let z = f.z; z < f.z + Math.ceil(f.d); z++) blocked.add(cellKey({ x, z }));
    }
  }
  return blocked;
}

export const cellKey = (c: Cell): string => `${c.x},${c.z}`;
