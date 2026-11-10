import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import type { FloorTheme } from '../../../server/src/office/types.ts';
import type { BoardContent } from '../board.ts';
import { TEXT } from '../text.ts';
import { PLANS } from './floorPlans.ts';
import { ELEVATOR, GRID_H, GRID_W } from './layout.ts';

/**
 * The whole-building view: a cutaway of the building seen from the side.
 * Every floor carries the furniture of its own one-floor view (its theme's
 * plan) — copied with instancing, so floors sharing models cost one draw call
 * per model, not one per copy — on a thick slab with its theme's colour band and a big floor number
 * on its front edge. Glass walls and corner columns wrap the stack, a roof
 * carries the building's name, a plaza lies around the foot, and an elevator
 * shaft runs through every floor. Characters are not drawn here; the office
 * puts them at their floor's height.
 */

/** Vertical distance between two floors, in grid units. */
export const FLOOR_GAP = 4;
/**
 * The whole-building view looks from lower down than the one-floor view (from
 * the vertical, in radians), like a cutaway of the building: from the usual
 * isometric height every slab would hide the floor below it.
 */
export const OVERVIEW_POLAR = 1.3;
const SLAB_THICKNESS = 0.3;
/** How far slabs, glass and roof reach past the floor plan. */
const RIM = 0.35;
/** Lines per column on the overview's war-room card. */
const OVERVIEW_BOARD_ITEMS = 2;
const ALERT_COLOR = { stuck: 0xdc2626, waiting: 0xea580c } as const;

/** What one floor's slab shows. */
export interface Slab {
  level: number;
  /** How the floor looks: its furniture and its colour. */
  theme: FloorTheme;
  /** 「5F 工程組｜2 組｜工作中 1・等你 1」 */
  label: string;
  alert?: 'stuck' | 'waiting';
}

interface SlabParts {
  edge: THREE.LineSegments;
  label: HTMLDivElement;
  base: THREE.Mesh;
}

export class Overview {
  readonly root = new THREE.Group();
  /** The furniture copies: rebuilt when the floors or the template change. */
  private copies = new THREE.Group();
  private shell = new THREE.Group();
  private slabs = new Map<number, SlabParts>();
  private index = new Map<number, number>();
  /** The one-floor scene of a theme, to copy onto the floors of that theme. */
  private template?: (theme: FloorTheme) => THREE.Object3D;
  private themes = new Map<number, FloorTheme>();
  private sign?: HTMLDivElement;
  /** Beside the lobby: what its war-room board says (the board itself hangs where the floor above hides it). */
  private board?: HTMLDivElement;
  private boardContent?: BoardContent;
  private buildingName = '';
  private key = '';

  constructor() {
    this.root.add(this.shell, this.copies);
  }

  /** Height of a floor's surface; floors are stacked by their order, so gaps in floor numbers close up. */
  heightOf(level: number): number {
    return (this.index.get(level) ?? 0) * FLOOR_GAP;
  }

  /** Height of the top floor's surface. */
  get top(): number {
    return Math.max(0, this.index.size - 1) * FLOOR_GAP;
  }

  /** Where to get each theme's one-floor scene (call once the models are in). */
  setTemplates(template: (theme: FloorTheme) => THREE.Object3D): void {
    this.template = template;
    this.copyFurniture();
  }

  /** What the lobby's war-room board says, shown in a card beside 1F. */
  setBoard(content: BoardContent): void {
    this.boardContent = content;
    this.renderBoard();
  }

  private renderBoard(): void {
    if (!this.board || !this.boardContent) return;
    const rows = this.boardContent.columns.map((col, i) => {
      const row = document.createElement('div');
      row.className = `board-row board-col-${i}`;
      const title = document.createElement('b');
      title.textContent = col.title;
      const items = document.createElement('span');
      items.textContent = col.items.slice(0, OVERVIEW_BOARD_ITEMS).join('、');
      row.append(title, items);
      return row;
    });
    const head = document.createElement('div');
    head.className = 'board-head';
    head.textContent = TEXT.boardHeading;
    this.board.replaceChildren(head, ...rows);
  }

  /** The name on the roof sign. */
  setBuilding(name: string): void {
    this.buildingName = name;
    if (this.sign) this.sign.textContent = name;
  }

  /** Rebuild when the floors change; otherwise only labels and edges. */
  update(slabs: Slab[]): void {
    const sorted = [...slabs].sort((a, b) => a.level - b.level);
    const key = sorted.map((s) => `${s.level}:${s.theme}`).join(',');
    if (key !== this.key) this.build(sorted, key);
    for (const s of sorted) {
      const parts = this.slabs.get(s.level);
      if (!parts) continue;
      // The big number already says the floor: the card's text starts after it.
      parts.label.textContent = s.label.replace(`${s.level}F `, '');
      const card = parts.label.parentElement!;
      card.classList.toggle('alert-stuck', s.alert === 'stuck');
      card.classList.toggle('alert-waiting', s.alert === 'waiting');
      parts.edge.visible = !!s.alert;
      if (s.alert) (parts.edge.material as THREE.LineBasicMaterial).color.setHex(ALERT_COLOR[s.alert]);
    }
  }

  /** The floor whose slab the ray hits first, if any. */
  pick(raycaster: THREE.Raycaster): number | undefined {
    const bases = [...this.slabs.values()].map((p) => p.base);
    const hit = raycaster.intersectObjects(bases, false)[0];
    return hit ? (hit.object.userData.level as number) : undefined;
  }

  private build(slabs: Slab[], key: string): void {
    const levels = slabs.map((s) => s.level);
    this.themes = new Map(slabs.map((s) => [s.level, s.theme]));
    for (const child of [...this.shell.children]) this.shell.remove(child);
    for (const parts of this.slabs.values()) parts.label.parentElement?.remove();
    this.sign?.remove();
    this.board?.remove();
    this.board = undefined;
    this.slabs.clear();
    this.index = new Map(levels.map((level, i) => [level, i]));
    this.key = key;
    for (const s of slabs) this.slabs.set(s.level, this.slab(s.level, this.heightOf(s.level), PLANS[s.theme].accent));
    this.buildShell();
    if (this.index.has(1)) {
      // On the lobby's front left corner, out to the left where the view has room.
      const board = document.createElement('div');
      board.className = 'overview-board';
      const tag = new CSS2DObject(board);
      tag.position.set(-RIM, this.heightOf(1) + 1.2, GRID_H + RIM);
      tag.center.set(1.06, 0.5);
      this.shell.add(tag);
      this.board = board;
      this.renderBoard();
    }
    this.copyFurniture();
  }

  /**
   * Copy every mesh of each floor's one-floor scene onto that floor. Meshes
   * that share geometry and material (all the chairs, all the screens…, on
   * any floor) become one InstancedMesh with an instance per occurrence.
   */
  private copyFurniture(): void {
    for (const child of [...this.copies.children]) {
      this.copies.remove(child);
      (child as THREE.InstancedMesh).dispose();
    }
    if (!this.template || this.index.size === 0) return;
    const groups = new Map<string, { mesh: THREE.Mesh; matrices: THREE.Matrix4[] }>();
    const lift = new THREE.Matrix4();
    for (const [level, theme] of this.themes) {
      const template = this.template(theme);
      template.updateMatrixWorld(true);
      lift.makeTranslation(0, this.heightOf(level), 0);
      template.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const key = `${mesh.geometry.uuid}|${materials.map((m) => m.uuid).join(',')}`;
        let group = groups.get(key);
        if (!group) {
          group = { mesh, matrices: [] };
          groups.set(key, group);
        }
        group.matrices.push(lift.clone().multiply(mesh.matrixWorld));
      });
    }
    for (const { mesh, matrices } of groups.values()) {
      const copy = new THREE.InstancedMesh(mesh.geometry, mesh.material, matrices.length);
      matrices.forEach((m, i) => copy.setMatrixAt(i, m));
      copy.instanceMatrix.needsUpdate = true;
      copy.computeBoundingSphere();
      copy.renderOrder = mesh.renderOrder;
      this.copies.add(copy);
    }
  }

  /** Glass walls, corner columns, roof with the building's name, plaza, elevator shaft. */
  private buildShell(): void {
    const height = this.top + FLOOR_GAP;
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geometry, material);
      m.position.set(x, y, z);
      this.shell.add(m);
      return m;
    };

    const plaza = add(
      new THREE.CircleGeometry(GRID_W * 1.6, 48),
      new THREE.MeshStandardMaterial({ color: 0xe6e0d4, roughness: 1 }),
      GRID_W / 2,
      -SLAB_THICKNESS - 0.02,
      GRID_H / 2,
    );
    plaza.rotation.x = -Math.PI / 2;
    add(
      new THREE.BoxGeometry(GRID_W + 4, 0.12, GRID_H + 4),
      new THREE.MeshStandardMaterial({ color: 0xcfc6b6, roughness: 0.9 }),
      GRID_W / 2,
      -SLAB_THICKNESS - 0.06,
      GRID_H / 2,
    );

    const glass = new THREE.MeshStandardMaterial({
      color: 0xbcd8ec,
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
      side: THREE.DoubleSide,
      roughness: 0.1,
      metalness: 0.2,
    });
    const front = add(new THREE.PlaneGeometry(GRID_W + RIM * 2, height), glass, GRID_W / 2, height / 2 - SLAB_THICKNESS, GRID_H + RIM);
    front.renderOrder = 2;
    const side = add(new THREE.PlaneGeometry(GRID_H + RIM * 2, height), glass, GRID_W + RIM, height / 2 - SLAB_THICKNESS, GRID_H / 2);
    side.rotation.y = Math.PI / 2;
    side.renderOrder = 2;

    const column = new THREE.MeshStandardMaterial({ color: 0x5b6470, roughness: 0.5, metalness: 0.3 });
    for (const [x, z] of [
      [-RIM, -RIM],
      [GRID_W + RIM, -RIM],
      [-RIM, GRID_H + RIM],
      [GRID_W + RIM, GRID_H + RIM],
    ]) {
      add(new THREE.BoxGeometry(0.3, height, 0.3), column, x, height / 2 - SLAB_THICKNESS, z);
    }

    const roofY = this.top + FLOOR_GAP - 0.2;
    add(
      new THREE.BoxGeometry(GRID_W + RIM * 2 + 0.3, 0.4, GRID_H + RIM * 2 + 0.3),
      new THREE.MeshStandardMaterial({ color: 0x4b5260, roughness: 0.7 }),
      GRID_W / 2,
      roofY,
      GRID_H / 2,
    );
    const sign = document.createElement('div');
    sign.className = 'roof-sign';
    sign.textContent = this.buildingName;
    const signTag = new CSS2DObject(sign);
    signTag.position.set(GRID_W / 2, roofY + 0.6, GRID_H / 2);
    signTag.center.set(0.5, 1);
    this.shell.add(signTag);
    this.sign = sign;

    add(
      new THREE.BoxGeometry(0.9, height + 0.4, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x8a939c, transparent: true, opacity: 0.4, roughness: 0.4 }),
      ELEVATOR.x + 0.5,
      height / 2 - SLAB_THICKNESS,
      ELEVATOR.z + 0.5,
    );
  }

  /** A thick slab with a coloured band and the floor number on its front edges, its label, and its alert edge. */
  private slab(level: number, y: number, accent: number): SlabParts {
    const group = new THREE.Group();
    group.position.y = y;

    const base = new THREE.Mesh(
      new THREE.BoxGeometry(GRID_W + RIM * 2, SLAB_THICKNESS, GRID_H + RIM * 2),
      new THREE.MeshStandardMaterial({ color: 0xece6db, roughness: 0.85 }),
    );
    base.position.set(GRID_W / 2, -SLAB_THICKNESS / 2 - 0.01, GRID_H / 2);
    base.userData.level = level;
    group.add(base);

    const band = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.6 });
    const along = new THREE.Mesh(new THREE.BoxGeometry(GRID_W + RIM * 2 + 0.02, SLAB_THICKNESS * 0.45, 0.04), band);
    along.position.set(GRID_W / 2, -SLAB_THICKNESS * 0.5, GRID_H + RIM + 0.01);
    group.add(along);
    const across = new THREE.Mesh(new THREE.BoxGeometry(0.04, SLAB_THICKNESS * 0.45, GRID_H + RIM * 2 + 0.02), band);
    across.position.set(GRID_W + RIM + 0.01, -SLAB_THICKNESS * 0.5, GRID_H / 2);
    group.add(across);

    // On the front corner, where the view has room: the big floor number, and under it what the floor is doing.
    const card = document.createElement('div');
    card.className = 'slab-card';
    card.style.borderColor = `#${accent.toString(16).padStart(6, '0')}`;
    const number = document.createElement('div');
    number.className = 'slab-number';
    number.textContent = `${level}F`;
    const label = document.createElement('div');
    label.className = 'slab-label';
    card.append(number, label);
    const cardTag = new CSS2DObject(card);
    cardTag.position.set(GRID_W + RIM, -SLAB_THICKNESS / 2, GRID_H + RIM);
    cardTag.center.set(-0.08, 0.5);
    group.add(cardTag);

    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(GRID_W + RIM * 2 + 0.1, SLAB_THICKNESS + 0.05, GRID_H + RIM * 2 + 0.1)),
      new THREE.LineBasicMaterial({ color: ALERT_COLOR.waiting }),
    );
    edge.position.copy(base.position);
    edge.visible = false;
    group.add(edge);

    this.shell.add(group);
    return { edge, label, base };
  }
}
