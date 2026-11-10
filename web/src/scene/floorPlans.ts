import type { FloorTheme } from '../../../server/src/office/types.ts';
import type { Cell, Furniture, Pod, Poi, Zone } from './layout.ts';
import { cellKey, GRID_H, GRID_W, POD_ORDER, PODS } from './layout.ts';

/**
 * One floor plan per floor theme, so no two floors look alike. Every plan
 * keeps the shared skeleton (grid, door, elevator, the aisle at x 13, the
 * work area on the left and rooms A, B, C on the right) and differs in its
 * colours, its back-wall equipment, its rooms and what stands on the desks.
 *
 *   lobby     free seats (8 pods), war-room board, president's office, reception, waiting area
 *   managers  six glass private offices, managers' meeting room, pantry, lounge
 *   analysis  sticky-note wall, workshop, interview booths
 *   spec      kanban wall, planning room, archive
 *   build     monitoring wall, server room, beanbags and ping-pong
 *   qa        results board, device lab, traffic light and bug board
 *   release   release countdown, print and packing room, library
 *
 * Kenney has no model for the boards, racks, glass rooms and the like: those
 * are props, built from boxes by props.ts.
 */

export type PropKind =
  | 'warBoard'
  | 'stickyWall'
  | 'kanban'
  | 'monitorWall'
  | 'resultBoard'
  | 'countdown'
  | 'whiteboard'
  | 'standBoard'
  | 'glassRoom'
  | 'glassOffice'
  | 'partition'
  | 'lowWall'
  | 'counter'
  | 'rack'
  | 'beanbag'
  | 'pingPong'
  | 'devices'
  | 'trafficLight'
  | 'printer'
  | 'paperStack'
  | 'blueprint';

/** Equipment built from boxes. Covers (x‥x+w, z‥z+d); `rot` turns it like furniture. */
export interface Prop {
  kind: PropKind;
  x: number;
  z: number;
  w: number;
  d: number;
  /** Glass rooms and offices: the side with the doorway. */
  door?: 'south' | 'north';
  /** Name plate (glass offices) or wording (boards). */
  text?: string;
  /** Stands on a table or desk of this height. */
  y0?: number;
}

/** Props people cannot walk through; the rest are on walls, on tables, or thin walls between cells. */
const BLOCKING: ReadonlySet<PropKind> = new Set(['standBoard', 'counter', 'rack', 'pingPong', 'trafficLight', 'printer', 'paperStack']);
export const isBlocking = (p: Prop): boolean => BLOCKING.has(p.kind);

/** What stands on each desk of a pod. */
export type DeskKit = 'laptop' | 'screen' | 'dual' | 'screenBooks' | 'screenPhone';

export interface FloorPlan {
  theme: FloorTheme;
  /** Work area, aisle-side rooms A, B, C; the room flagged `room` takes the floor's room name. */
  zones: Zone[];
  aisleColor: number;
  wallColor: number;
  /** The floor's colour: slab band and card edge in the whole-building view. */
  accent: number;
  furniture: Furniture[];
  props: Prop[];
  pods: Pod[];
  /** Pod indices (Pod.index), nearest the door first. */
  podOrder: number[];
  pois: Poi[];
  deskKit: DeskKit;
}

const HALF_PI = Math.PI / 2;
const TABLE = 0.8;

// ------------------------------------------------------------------ shared rooms

const zones = (work: [string, number], a: [string, number], b: [string, number], c: [string, number]): Zone[] => [
  { name: work[0], x: 0, z: 0, w: 13, d: 16, color: work[1] },
  { name: a[0], x: 14, z: 0, w: 10, d: 6, color: a[1], room: true },
  { name: b[0], x: 14, z: 6, w: 10, d: 5, color: b[1] },
  { name: c[0], x: 14, z: 11, w: 10, d: 5, color: c[1] },
];

/** Low glass between the aisle and room A, and between rooms A and B. */
const ROOM_GLASS: Prop[] = [
  { kind: 'partition', x: 14, z: 0, w: 0, d: 5 },
  { kind: 'partition', x: 17, z: 6, w: 7, d: 0 },
];

/** Room A as a meeting room: a long table, eight chairs, a TV on the wall. */
const MEETING: Furniture[] = [
  { model: 'rugRectangle', x: 15, z: 1, w: 7, d: 4, walkable: true },
  { model: 'table', x: 16, z: 2, w: 4, d: 2, h: 0.75 },
  ...[16, 17, 18, 19].map((x): Furniture => ({ model: 'chairCushion', x, z: 1, w: 1, d: 1, h: 0.8 })),
  ...[16, 17, 18, 19].map((x): Furniture => ({ model: 'chairCushion', x, z: 4, w: 1, d: 1, rot: Math.PI, h: 0.8 })),
  { model: 'cabinetTelevision', x: 23, z: 2, w: 1, d: 2, rot: -HALF_PI, h: 0.9 },
  { model: 'pottedPlant', x: 14, z: 0, w: 1, d: 1, h: 1.0 },
];

/** Room B as a pantry: counter along the back, a bar with stools, a ping-pong table. */
const PANTRY: Furniture[] = [
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
];
const PANTRY_PROPS: Prop[] = [{ kind: 'pingPong', x: 21, z: 9, w: 2, d: 1 }];
const PANTRY_POIS: Poi[] = [
  { name: '咖啡機', x: 20, z: 7, facing: 'north', pose: 'stand' },
  { name: '微波爐', x: 22, z: 7, facing: 'north', pose: 'stand' },
  { name: '吧檯', x: 16, z: 8, facing: 'east', pose: 'stand' },
  { name: '桌球桌西', x: 20, z: 9, facing: 'east', pose: 'stand' },
  { name: '桌球桌東', x: 23, z: 9, facing: 'west', pose: 'stand' },
];

/** Room C as a lounge: a sofa round a coffee table, books, a lamp, plants. */
const LOUNGE: Furniture[] = [
  { model: 'rugRound', x: 17, z: 11, w: 5, d: 4, walkable: true },
  { model: 'loungeSofa', x: 18, z: 14, w: 3, d: 1, rot: Math.PI, h: 0.7 },
  { model: 'tableCoffee', x: 18, z: 12, w: 3, d: 1, h: 0.35 },
  { model: 'loungeChairRelax', x: 16, z: 12, w: 1, d: 1, rot: HALF_PI, h: 0.75 },
  { model: 'bookcaseOpen', x: 23, z: 11, w: 1, d: 2, rot: -HALF_PI, h: 1.7 },
  { model: 'lampRoundFloor', x: 22, z: 14, w: 1, d: 1, h: 1.5 },
  { model: 'pottedPlant', x: 23, z: 15, w: 1, d: 1, h: 1.0 },
  { model: 'plantSmall2', x: 14, z: 15, w: 1, d: 1, h: 0.5 },
];
const LOUNGE_POIS: Poi[] = [
  { name: '沙發左', x: 18, z: 13, facing: 'north', pose: 'sit' },
  { name: '沙發右', x: 20, z: 13, facing: 'north', pose: 'sit' },
  { name: '書櫃', x: 22, z: 12, facing: 'east', pose: 'stand' },
];

/** The work area's corners: plants at the back, a coat rack by the elevator. */
const WORK_CORNERS: Furniture[] = [
  { model: 'pottedPlant', x: 0, z: 0, w: 1, d: 1, h: 1.0 },
  { model: 'plantSmall1', x: 12, z: 0, w: 1, d: 1, h: 0.5 },
  { model: 'coatRackStanding', x: 11, z: 15, w: 1, d: 1, h: 1.5 },
];

/** The back-wall equipment of the work area, behind the first pod row. */
const backWall = (kind: PropKind, text?: string): Prop => ({ kind, x: 1, z: 0, w: 11, d: 1, ...(text ? { text } : {}) });

/** A row of bookcases facing the viewer, books on two shelves of each. */
const bookcases = (xs: number[], z: number): Furniture[] =>
  xs.flatMap((x): Furniture[] => [
    { model: 'bookcaseOpen', x, z, w: 2, d: 1, h: 1.7 },
    { model: 'books', x: x + 0.3, z: z + 0.25, w: 0.6, d: 0.45, y0: 0.62, walkable: true },
    { model: 'books', x: x + 1.0, z: z + 0.25, w: 0.6, d: 0.45, y0: 1.12, walkable: true },
  ]);

const department = (
  theme: FloorPlan['theme'],
  colors: { work: number; a: number; b: number; c: number; aisle: number; wall: number; accent: number },
  names: { b: string; c: string },
  deskKit: DeskKit,
  wallEquipment: Prop,
  rooms: { furniture: Furniture[]; props: Prop[]; pois: Poi[] },
): FloorPlan => ({
  theme,
  zones: zones(['工位區', colors.work], ['組長室', colors.a], [names.b, colors.b], [names.c, colors.c]),
  aisleColor: colors.aisle,
  wallColor: colors.wall,
  accent: colors.accent,
  furniture: [...WORK_CORNERS, ...rooms.furniture],
  props: [wallEquipment, ...ROOM_GLASS, ...rooms.props],
  pods: PODS,
  podOrder: POD_ORDER,
  pois: rooms.pois,
  deskKit,
});

// ------------------------------------------------------------------ 1F lobby

/** The free seats: the two pod rows nearest the door; the first row gives way to the war room. */
const LOBBY_PODS = PODS.filter((p) => p.z > 2);

const LOBBY: FloorPlan = {
  theme: 'lobby',
  zones: zones(['自由座位區', 0xe2e0db], ['總裁室', 0xd9dee6], ['接待區', 0xeeeae2], ['等候區', 0xe5ebe3]),
  aisleColor: 0xcfcbc3,
  wallColor: 0xf4f2ee,
  accent: 0x64748b,
  furniture: [
    ...WORK_CORNERS,
    // War room: a rug in front of the board.
    { model: 'rugRectangle', x: 2, z: 1, w: 9, d: 3, walkable: true },
    // President's office.
    { model: 'rugRectangle', x: 16, z: 1, w: 6, d: 4, walkable: true },
    { model: 'desk', x: 18, z: 2, w: 3, d: 1, h: 0.78 },
    { model: 'computerScreen', x: 19.2, z: 2.05, w: 0.6, d: 0.3, h: 0.42, y0: 0.78, rot: Math.PI, walkable: true },
    { model: 'chairModernCushion', x: 19, z: 1, w: 1, d: 1, h: 0.95 },
    { model: 'chairCushion', x: 18, z: 3, w: 1, d: 1, rot: Math.PI, h: 0.8 },
    { model: 'chairCushion', x: 20, z: 3, w: 1, d: 1, rot: Math.PI, h: 0.8 },
    { model: 'bookcaseOpen', x: 23, z: 1, w: 1, d: 2, rot: -HALF_PI, h: 1.7 },
    { model: 'loungeChairRelax', x: 22, z: 4, w: 1, d: 1, rot: -HALF_PI, h: 0.75 },
    { model: 'pottedPlant', x: 15, z: 0, w: 1, d: 1, h: 1.0 },
    // Reception.
    { model: 'chairDesk', x: 18.15, z: 6.15, w: 0.7, d: 0.7, h: 0.6 },
    { model: 'computerScreen', x: 17.2, z: 7.05, w: 0.6, d: 0.3, h: 0.42, y0: 1.0, rot: Math.PI, walkable: true },
    { model: 'pottedPlant', x: 23, z: 6, w: 1, d: 1, h: 1.0 },
    { model: 'plantSmall3', x: 14, z: 6, w: 1, d: 1, h: 0.5 },
    // Waiting area.
    { model: 'rugRound', x: 15, z: 11, w: 8, d: 4, walkable: true },
    { model: 'loungeSofa', x: 15, z: 14, w: 3, d: 1, rot: Math.PI, h: 0.7 },
    { model: 'loungeSofa', x: 19, z: 14, w: 3, d: 1, rot: Math.PI, h: 0.7 },
    { model: 'tableCoffee', x: 16, z: 12, w: 2, d: 1, h: 0.35 },
    { model: 'tableCoffee', x: 20, z: 12, w: 2, d: 1, h: 0.35 },
    { model: 'books', x: 16.6, z: 12.2, w: 0.6, d: 0.5, y0: 0.35, walkable: true },
    { model: 'lampRoundFloor', x: 23, z: 11, w: 1, d: 1, h: 1.5 },
    { model: 'pottedPlant', x: 23, z: 15, w: 1, d: 1, h: 1.0 },
  ],
  props: [
    backWall('warBoard'),
    { kind: 'glassRoom', x: 14, z: 0, w: 10, d: 6, door: 'south' },
    { kind: 'counter', x: 16, z: 7, w: 4, d: 1, text: 'AI 辦公室' },
  ],
  pods: LOBBY_PODS,
  podOrder: POD_ORDER.filter((i) => LOBBY_PODS.some((p) => p.index === i)),
  pois: [
    { name: '看板前左', x: 4, z: 2, facing: 'north', pose: 'stand' },
    { name: '看板前右', x: 8, z: 2, facing: 'north', pose: 'stand' },
    { name: '接待櫃台', x: 18, z: 8, facing: 'north', pose: 'stand' },
    { name: '等候沙發左', x: 16, z: 13, facing: 'north', pose: 'sit' },
    { name: '等候沙發右', x: 20, z: 13, facing: 'north', pose: 'sit' },
    { name: '總裁室', x: 17, z: 4, facing: 'east', pose: 'stand' },
  ],
  deskKit: 'laptop',
};

// ------------------------------------------------------------------ 2F managers

/** Columns and rows of the private offices: 3 × 2, each 4 × 6 cells, corridors at z 6‥7 and 14‥15. */
const OFFICE_X = [0, 4, 8];
const OFFICE_Z = [0, 8];

function privateOffice(x: number, z: number, n: number): { furniture: Furniture[]; prop: Prop } {
  const front = z === 0; // the back row opens to the south, the front row to the north
  const deskZ = front ? z + 2 : z + 3;
  const chairZ = front ? z + 1 : z + 4;
  const visitorZ = front ? z + 3 : z + 2;
  return {
    prop: { kind: 'glassOffice', x, z, w: 4, d: 6, door: front ? 'south' : 'north', text: `經理室 ${n}` },
    furniture: [
      { model: 'rugRectangle', x: x + 0.5, z: z + 1, w: 3, d: 4, walkable: true },
      { model: 'desk', x: x + 1, z: deskZ, w: 2, d: 1, h: 0.75 },
      { model: 'computerScreen', x: x + 1.7, z: deskZ + (front ? 0.05 : 0.65), w: 0.6, d: 0.3, h: 0.42, y0: 0.75, rot: front ? Math.PI : 0, walkable: true },
      { model: 'chairModernCushion', x: x + 1, z: chairZ, w: 1, d: 1, rot: front ? 0 : Math.PI, h: 0.95 },
      { model: 'chairCushion', x: x + 2, z: visitorZ, w: 1, d: 1, rot: front ? Math.PI : 0, h: 0.8 },
      { model: 'bookcaseOpen', x: x + 3, z: front ? z : z + 4, w: 1, d: 2, rot: -HALF_PI, h: 1.5 },
      { model: 'plantSmall1', x, z: front ? z : z + 5, w: 1, d: 1, h: 0.6 },
    ],
  };
}

const OFFICES = OFFICE_Z.flatMap((z, row) => OFFICE_X.map((x, col) => privateOffice(x, z, row * OFFICE_X.length + col + 1)));

const MANAGERS: FloorPlan = {
  theme: 'managers',
  zones: zones(['經理辦公區', 0xbfa27c], ['主管會議室', 0xdde6ee], ['茶水間', 0xf1e6d2], ['休息區', 0xe3eedf]),
  aisleColor: 0xa98d69,
  wallColor: 0xf1ece2,
  accent: 0x7c3aed,
  furniture: [...OFFICES.flatMap((o) => o.furniture), ...MEETING, ...PANTRY, ...LOUNGE],
  props: [...OFFICES.map((o) => o.prop), ...ROOM_GLASS, ...PANTRY_PROPS],
  pods: [],
  podOrder: [],
  pois: [...PANTRY_POIS, ...LOUNGE_POIS],
  deskKit: 'screen',
};

// ------------------------------------------------------------------ 3F‥7F departments

const ANALYSIS = department(
  'analysis',
  { work: 0xf0e0b0, a: 0xf3ead2, b: 0xf6e7c8, c: 0xece4d6, aisle: 0xdcc898, wall: 0xf4ecdc, accent: 0xd97706 },
  { b: '工作坊', c: '訪談室' },
  'laptop',
  backWall('stickyWall'),
  {
    furniture: [
      // Team lead's room: a round table and a whiteboard.
      { model: 'tableRound', x: 17, z: 1, w: 3, d: 3, h: 0.75 },
      { model: 'chairCushion', x: 16, z: 2, w: 1, d: 1, rot: HALF_PI, h: 0.8 },
      { model: 'chairCushion', x: 20, z: 2, w: 1, d: 1, rot: -HALF_PI, h: 0.8 },
      { model: 'chairCushion', x: 18, z: 4, w: 1, d: 1, rot: Math.PI, h: 0.8 },
      { model: 'pottedPlant', x: 14, z: 0, w: 1, d: 1, h: 1.0 },
      // Workshop: round tables with stools, coffee.
      { model: 'tableRound', x: 16, z: 8, w: 2, d: 2, h: 0.75 },
      { model: 'tableRound', x: 20, z: 8, w: 2, d: 2, h: 0.75 },
      { model: 'stoolBar', x: 15, z: 8, w: 1, d: 1, h: 0.65 },
      { model: 'stoolBar', x: 19, z: 9, w: 1, d: 1, h: 0.65 },
      { model: 'stoolBar', x: 22, z: 8, w: 1, d: 1, h: 0.65 },
      { model: 'kitchenCabinet', x: 23, z: 6, w: 1, d: 1, h: 0.86 },
      { model: 'kitchenCoffeeMachine', x: 23, z: 6, w: 0.6, d: 0.6, y0: 0.86, walkable: true },
      // Interview booths: two chairs face to face across a small table.
      { model: 'chairCushion', x: 15, z: 12, w: 1, d: 1, rot: HALF_PI, h: 0.8 },
      { model: 'sideTable', x: 16, z: 12, w: 1, d: 1, h: 0.55 },
      { model: 'chairCushion', x: 17, z: 12, w: 1, d: 1, rot: -HALF_PI, h: 0.8 },
      { model: 'chairCushion', x: 20, z: 12, w: 1, d: 1, rot: HALF_PI, h: 0.8 },
      { model: 'sideTable', x: 21, z: 12, w: 1, d: 1, h: 0.55 },
      { model: 'chairCushion', x: 22, z: 12, w: 1, d: 1, rot: -HALF_PI, h: 0.8 },
      { model: 'plantSmall2', x: 23, z: 15, w: 1, d: 1, h: 0.5 },
    ],
    props: [
      { kind: 'whiteboard', x: 20, z: 0, w: 3, d: 1 },
      { kind: 'standBoard', x: 15, z: 6, w: 2, d: 1 },
      { kind: 'standBoard', x: 20, z: 6, w: 2, d: 1 },
      { kind: 'lowWall', x: 14.5, z: 11, w: 4, d: 0 },
      { kind: 'lowWall', x: 18.5, z: 11, w: 0, d: 3.5 },
      { kind: 'lowWall', x: 19.5, z: 11, w: 4, d: 0 },
    ],
    pois: [
      { name: '白板前', x: 15, z: 7, facing: 'north', pose: 'stand' },
      { name: '白板前二', x: 21, z: 7, facing: 'north', pose: 'stand' },
      { name: '圓桌旁', x: 18, z: 8, facing: 'west', pose: 'stand' },
      { name: '咖啡機', x: 23, z: 7, facing: 'north', pose: 'stand' },
      { name: '訪談室一', x: 16, z: 13, facing: 'north', pose: 'stand' },
      { name: '訪談室二', x: 21, z: 13, facing: 'north', pose: 'stand' },
    ],
  },
);

const SPEC = department(
  'spec',
  { work: 0xd3dbe5, a: 0xdde6ee, b: 0xe3e8ee, c: 0xe8e2d6, aisle: 0xbfc8d3, wall: 0xe9edf1, accent: 0x2563eb },
  { b: '規劃室', c: '資料室' },
  'screenBooks',
  backWall('kanban'),
  {
    furniture: [
      ...MEETING,
      // Planning room: a big table with blueprints, stools.
      { model: 'table', x: 16, z: 7, w: 5, d: 2, h: TABLE },
      ...[16, 18, 20].map((x): Furniture => ({ model: 'stoolBar', x, z: 9, w: 1, d: 1, h: 0.65 })),
      { model: 'pottedPlant', x: 23, z: 10, w: 1, d: 1, h: 1.0 },
      // Archive: a row of bookcases, reading chairs, a lamp.
      ...bookcases([15, 17, 19, 21], 11),
      { model: 'loungeChairRelax', x: 16, z: 14, w: 1, d: 1, rot: Math.PI, h: 0.75 },
      { model: 'sideTable', x: 18, z: 14, w: 1, d: 1, h: 0.55 },
      { model: 'loungeChairRelax', x: 20, z: 14, w: 1, d: 1, rot: Math.PI, h: 0.75 },
      { model: 'lampRoundFloor', x: 23, z: 14, w: 1, d: 1, h: 1.5 },
      { model: 'pottedPlant', x: 23, z: 11, w: 1, d: 1, h: 1.0 },
    ],
    props: [{ kind: 'blueprint', x: 16, z: 7, w: 5, d: 2, y0: TABLE }],
    pois: [
      { name: '規劃桌左', x: 15, z: 8, facing: 'east', pose: 'stand' },
      { name: '規劃桌右', x: 21, z: 8, facing: 'west', pose: 'stand' },
      { name: '規劃桌前', x: 17, z: 9, facing: 'north', pose: 'stand' },
      { name: '書櫃前', x: 16, z: 12, facing: 'north', pose: 'stand' },
      { name: '書櫃前二', x: 20, z: 12, facing: 'north', pose: 'stand' },
    ],
  },
);

const BUILD = department(
  'build',
  { work: 0xc4c8ce, a: 0xd4d9e0, b: 0xbcc2ca, c: 0xd6e2d3, aisle: 0xaeb3ba, wall: 0xd3d7dc, accent: 0x0d9488 },
  { b: '機房', c: '休息區' },
  'dual',
  backWall('monitorWall'),
  {
    furniture: [
      ...MEETING,
      { model: 'cardboardBoxClosed', x: 22, z: 6, w: 1, d: 1, h: 0.5 },
      { model: 'cardboardBoxClosed', x: 23, z: 6, w: 1, d: 1, h: 0.5 },
      { model: 'cardboardBoxClosed', x: 23, z: 6, w: 0.8, d: 0.8, y0: 0.5, walkable: true },
      { model: 'kitchenCabinet', x: 23, z: 11, w: 1, d: 1, h: 0.86 },
      { model: 'kitchenCoffeeMachine', x: 23, z: 11, w: 0.6, d: 0.6, y0: 0.86, walkable: true },
      { model: 'rugRound', x: 14, z: 12, w: 5, d: 3, walkable: true },
      { model: 'plantSmall2', x: 14, z: 15, w: 1, d: 1, h: 0.5 },
    ],
    props: [
      ...[16, 17, 18, 19].map((x): Prop => ({ kind: 'rack', x, z: 6, w: 1, d: 1 })),
      { kind: 'pingPong', x: 21, z: 13, w: 2, d: 1 },
      { kind: 'beanbag', x: 15, z: 13, w: 1, d: 1 },
      { kind: 'beanbag', x: 17, z: 13, w: 1, d: 1 },
    ],
    pois: [
      { name: '機櫃前', x: 17, z: 8, facing: 'north', pose: 'stand' },
      { name: '咖啡機', x: 22, z: 11, facing: 'east', pose: 'stand' },
      { name: '桌球桌西', x: 20, z: 13, facing: 'east', pose: 'stand' },
      { name: '桌球桌東', x: 23, z: 13, facing: 'west', pose: 'stand' },
      { name: '懶骨頭左', x: 15, z: 13, facing: 'north', pose: 'sit' },
      { name: '懶骨頭右', x: 17, z: 13, facing: 'north', pose: 'sit' },
    ],
  },
);

const QA = department(
  'qa',
  { work: 0xd8e9d8, a: 0xe3eee6, b: 0xedf2ed, c: 0xe4eedd, aisle: 0xc2d6c2, wall: 0xf7f8f6, accent: 0x16a34a },
  { b: '裝置實驗室', c: '驗證區' },
  'screenPhone',
  backWall('resultBoard'),
  {
    furniture: [
      ...MEETING,
      // Device lab: two long test benches with chairs.
      ...[15, 17, 20, 22].map((x): Furniture => ({ model: 'desk', x, z: 7, w: 2, d: 1, h: 0.75 })),
      { model: 'chairDesk', x: 16.15, z: 8.15, w: 0.7, d: 0.7, h: 0.6, rot: Math.PI },
      { model: 'chairDesk', x: 21.15, z: 8.15, w: 0.7, d: 0.7, h: 0.6, rot: Math.PI },
      // Checking area: lounge chairs round a small table.
      { model: 'loungeChairRelax', x: 20, z: 13, w: 1, d: 1, rot: Math.PI, h: 0.75 },
      { model: 'sideTable', x: 21, z: 13, w: 1, d: 1, h: 0.55 },
      { model: 'loungeChairRelax', x: 22, z: 13, w: 1, d: 1, rot: Math.PI, h: 0.75 },
      { model: 'pottedPlant', x: 23, z: 11, w: 1, d: 1, h: 1.0 },
      { model: 'plantSmall3', x: 14, z: 15, w: 1, d: 1, h: 0.5 },
    ],
    props: [
      { kind: 'devices', x: 15, z: 7, w: 4, d: 1, y0: 0.75 },
      { kind: 'devices', x: 20, z: 7, w: 4, d: 1, y0: 0.75 },
      { kind: 'trafficLight', x: 15, z: 11, w: 1, d: 1 },
      { kind: 'standBoard', x: 17, z: 11, w: 2, d: 1, text: '錯誤追蹤' },
    ],
    pois: [
      { name: '測試台左', x: 17, z: 8, facing: 'north', pose: 'stand' },
      { name: '測試台右', x: 22, z: 8, facing: 'north', pose: 'stand' },
      { name: '紅綠燈旁', x: 16, z: 12, facing: 'west', pose: 'stand' },
      { name: '錯誤白板前', x: 18, z: 12, facing: 'north', pose: 'stand' },
      { name: '休息區', x: 21, z: 14, facing: 'north', pose: 'stand' },
    ],
  },
);

const RELEASE = department(
  'release',
  { work: 0xe6c9b0, a: 0xeedfd0, b: 0xf0e4d4, c: 0xe9e0cf, aisle: 0xd3b29a, wall: 0xf6eee4, accent: 0xdb2777 },
  { b: '印製區', c: '書庫' },
  'screenBooks',
  backWall('countdown'),
  {
    furniture: [
      ...MEETING,
      // Print and packing: a packing table with boxes, stacked boxes in the corner.
      { model: 'table', x: 19, z: 8, w: 3, d: 1, h: TABLE },
      { model: 'cardboardBoxClosed', x: 19.3, z: 8.1, w: 0.8, d: 0.8, y0: TABLE, walkable: true },
      { model: 'cardboardBoxClosed', x: 20.6, z: 8.2, w: 0.6, d: 0.6, y0: TABLE, walkable: true },
      { model: 'cardboardBoxClosed', x: 22, z: 6, w: 1, d: 1, h: 0.55 },
      { model: 'cardboardBoxClosed', x: 23, z: 6, w: 1, d: 1, h: 0.55 },
      { model: 'cardboardBoxClosed', x: 23, z: 7, w: 1, d: 1, h: 0.55 },
      { model: 'cardboardBoxClosed', x: 23, z: 6, w: 0.8, d: 0.8, y0: 0.55, walkable: true },
      // Library: bookcases, a reading sofa, a lamp.
      ...bookcases([15, 17, 19], 11),
      { model: 'loungeSofa', x: 16, z: 14, w: 3, d: 1, rot: Math.PI, h: 0.7 },
      { model: 'lampRoundFloor', x: 23, z: 14, w: 1, d: 1, h: 1.5 },
      { model: 'pottedPlant', x: 23, z: 11, w: 1, d: 1, h: 1.0 },
    ],
    props: [
      { kind: 'printer', x: 15, z: 6, w: 2, d: 1 },
      { kind: 'paperStack', x: 17, z: 6, w: 1, d: 1 },
    ],
    pois: [
      { name: '印表機前', x: 15, z: 7, facing: 'north', pose: 'stand' },
      { name: '打包桌', x: 20, z: 9, facing: 'north', pose: 'stand' },
      { name: '紙箱旁', x: 22, z: 7, facing: 'east', pose: 'stand' },
      { name: '書櫃前', x: 16, z: 12, facing: 'north', pose: 'stand' },
      { name: '書櫃前二', x: 19, z: 12, facing: 'north', pose: 'stand' },
      { name: '閱讀沙發', x: 17, z: 13, facing: 'north', pose: 'sit' },
    ],
  },
);

export const PLANS: Record<FloorTheme, FloorPlan> = {
  lobby: LOBBY,
  managers: MANAGERS,
  analysis: ANALYSIS,
  spec: SPEC,
  build: BUILD,
  qa: QA,
  release: RELEASE,
};

/** Cells nobody can walk through on this floor: desks, non-walkable furniture and blocking props. */
export function blockedCells(plan: FloorPlan): Set<string> {
  const blocked = new Set<string>();
  const cover = (x0: number, z0: number, w: number, d: number) => {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x++) {
      for (let z = Math.floor(z0); z < Math.ceil(z0 + d); z++) blocked.add(cellKey({ x, z }));
    }
  };
  for (const pod of plan.pods) for (const desk of pod.desks) blocked.add(cellKey(desk));
  for (const f of plan.furniture) if (!f.walkable && !f.y0) cover(f.x, f.z, f.w, f.d);
  for (const p of plan.props) if (isBlocking(p)) cover(p.x, p.z, p.w, p.d);
  return blocked;
}

/** Every cell people must reach on this floor: seats, standing cells, points of interest. */
export function targetsOf(plan: FloorPlan): Cell[] {
  return [...plan.pods.flatMap((p) => [...p.seats, ...p.standing]), ...plan.pois];
}

/** Is a cell on the grid? */
export const onGrid = (c: Cell): boolean => c.x >= 0 && c.x < GRID_W && c.z >= 0 && c.z < GRID_H;

