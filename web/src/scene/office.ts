import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import type { ActorStatus, ActorView, FloorTheme, GroupView, OfficeView } from '../../../server/src/office/types.ts';
import type { BoardContent } from '../board.ts';
import { WarBoard } from './board.ts';
import type { Phase } from './daylight.ts';
import { LIGHTING } from './daylight.ts';
import { choosePoi, dwellMs } from './idleLife.ts';
import type { Cell, Facing, Furniture } from './layout.ts';
import { cellKey, DOOR, ELEVATOR, GRID_H, GRID_W } from './layout.ts';
import type { FloorPlan } from './floorPlans.ts';
import { blockedCells, PLANS } from './floorPlans.ts';
import { buildProp } from './props.ts';
import { findPath } from './pathfinding.ts';
import { placeFor, PodAllocator } from './podAllocator.ts';
import type { LevelChoice } from '../levels.ts';
import { overviewTagText } from '../levels.ts';
import { TEXT } from '../text.ts';
import type { Slab } from './overview.ts';
import { FLOOR_GAP, Overview, OVERVIEW_POLAR } from './overview.ts';

/**
 * The 3D isometric office. Turns OfficeView into characters at desks: one pod
 * per group, characters walking in from the door along A* paths and back out
 * when they leave, name plates and bubbles as CSS2D overlays. Idle employees
 * wander to the pantry and lounge and come back when work starts; the light
 * follows the time of day. It never talks to the server; main.ts hands it
 * each view.
 */

const CHARACTERS = ['male-a', 'female-a', 'male-b', 'female-b', 'male-c', 'female-c', 'male-d', 'female-d', 'male-e', 'female-e', 'male-f', 'female-f'];
const CHAR_HEIGHT = 0.9;
const WALK_SPEED = 2.2; // cells per second
const SEAT_LIFT = 0.12;
const DESK_HEIGHT = 0.75;
const WALL_HEIGHT = 1.6;
/** Polar angle of an isometric view: 90° − 35.26° elevation. */
const ISO_POLAR = Math.acos(1 / Math.sqrt(3));
const FACING_YAW: Record<Facing, number> = { south: 0, north: Math.PI, east: Math.PI / 2, west: -Math.PI / 2 };
const MODEL_LETTER: Record<ActorView['model'], string> = { opus: 'O', sonnet: 'S', haiku: 'H', fable: 'F', other: '' };

/** Where a character is headed: its seat, a standing cell, or a point of interest. */
interface Place {
  x: number;
  z: number;
  facing?: Facing;
  /** Seats sit; points of interest say; standing cells have no facing. */
  pose?: 'sit' | 'stand';
}

interface Visual {
  id: string;
  building: string;
  /** The floor the character is on now (during a ride: the one it is leaving). */
  level: number;
  /** On its way to the elevator: the floor and seat to go to once there. */
  transfer?: { level: number; seat: Place };
  /** Riding the shaft in the whole-building view: heights and progress (0..1). */
  ride?: { from: number; to: number; t: number };
  obj: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Record<string, THREE.AnimationAction>;
  current?: string;
  path: THREE.Vector3[];
  /** Current target. */
  place?: Place;
  /** The character's own seat in its group's pod. */
  seat?: Place;
  status?: ActorStatus;
  /** While idle: when to move on from the current point of interest. */
  wanderUntil?: number;
  leaving: boolean;
  /** Scale that makes the model CHAR_HEIGHT tall on a single floor. */
  scale: number;
  tag: CSS2DObject;
  tagEl: HTMLDivElement;
  tagKey: string;
}

/** Where people come in and go out: the door on the lobby, the elevator everywhere else. */
const entranceOf = (level: number): Cell => (level === 1 ? DOOR : ELEVATOR);
/** Models every desk kit may use, loaded with the furniture. */
const DESK_MODELS = ['desk', 'chairDesk', 'computerScreen', 'computerKeyboard', 'laptop', 'books'];
/** A phone lying on a desk (the testers' floor). */
const PHONE_GEOMETRY = new THREE.BoxGeometry(0.12, 0.015, 0.22);
const PHONE_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x111827, emissive: 0x38bdf8, emissiveIntensity: 0.25 });
/** How much larger characters are in the whole-building view. */
const OVERVIEW_CHARACTER_SCALE = 1.6;

const cellCenter = (c: Cell, y = 0) => new THREE.Vector3(c.x + 0.5, y, c.z + 0.5);
const samePlace = (a: Place | undefined, b: Place | undefined) => !!a && !!b && a.x === b.x && a.z === b.z;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class Office {
  readonly ready: Promise<void>;
  private renderer: THREE.WebGLRenderer;
  private labels: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private controls: OrbitControls;
  private clock = new THREE.Clock();
  private models: Record<string, THREE.Object3D> = {};
  private characters: { scene: THREE.Object3D; animations: THREE.AnimationClip[] }[] = [];
  private visuals = new Map<string, Visual>();
  private allocators = new Map<string, { theme: FloorTheme; alloc: PodAllocator }>();
  /** Cells nobody walks through, per floor plan. */
  private blocked = new Map<FloorTheme, Set<string>>();
  /** The theme of each floor of each building ("building#level"), from the view. */
  private themes = new Map<string, FloorTheme>();
  private building = '';
  /** The room name of the floor on screen. */
  private room = '';
  /** The whole building, or one floor. */
  private level: LevelChoice = 1;
  /** The one-floor scenes, one per floor theme (built when first needed); only the one on screen shows. */
  private floors = new Map<FloorTheme, { group: THREE.Group; room?: HTMLDivElement }>();
  private floorRoot = new THREE.Group();
  /** The theme of the floor on screen. */
  private theme: FloorTheme = 'lobby';
  /** The lobby's war-room board: one picture shared by every lobby. */
  private warBoard = new WarBoard();
  private overview = new Overview();
  /** Called when a slab is clicked in the whole-building view. */
  onPickLevel?: (level: number) => void;
  private synced = false;
  private loadFailed = false;
  private focus?: { from: THREE.Vector3; to: THREE.Vector3; t: number };
  private readonly container: HTMLElement;
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private lamps: THREE.PointLight[] = [];
  private phase?: Phase;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    container.appendChild(this.labels.domElement);

    this.scene.background = new THREE.Color(0xf4f1ea);
    this.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);
    const center = new THREE.Vector3(GRID_W / 2, 0, GRID_H / 2);
    // Seen from the open (+x, +z) corner at the isometric angle.
    const r = 30;
    const s = Math.sin(ISO_POLAR) / Math.SQRT2;
    this.camera.position.set(center.x + r * s, r * Math.cos(ISO_POLAR), center.z + r * s);
    this.controls = new OrbitControls(this.camera, this.labels.domElement);
    this.controls.target.copy(center);
    // Horizontal rotation and zoom only: the polar angle is pinned, so the
    // camera can never tip below the floor.
    this.controls.minPolarAngle = ISO_POLAR;
    this.controls.maxPolarAngle = ISO_POLAR;
    this.controls.enableDamping = true;
    this.controls.minZoom = 0.6;
    this.controls.maxZoom = 3.5;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.update();

    this.hemi = new THREE.HemisphereLight(0xfffaf0, 0x8a7d6a, 1.1);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xfff1dc, 1.7);
    this.sun = sun;
    sun.position.set(center.x - 8, 18, center.z + 6);
    sun.target.position.copy(center);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16 });
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun, sun.target);

    // Warm lamps for dusk and night: the floor lamp and three over the desks.
    for (const [x, y, z, power] of [
      [22.5, 1.4, 14.5, 6],
      [4, 2.6, 5, 9],
      [9, 2.6, 5, 9],
      [6.5, 2.6, 12, 9],
    ]) {
      const lamp = new THREE.PointLight(0xffc27a, power, 9, 1.6);
      lamp.position.set(x, y, z);
      lamp.visible = false;
      this.lamps.push(lamp);
      this.scene.add(lamp);
    }

    this.scene.add(this.floorRoot, this.overview.root);
    this.overview.root.visible = false;
    this.listenForSlabClicks();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.ready = this.load().catch((err: unknown) => {
      // Without models there is no office to draw: say so instead of a blank canvas.
      this.loadFailed = true;
      const note = document.createElement('div');
      note.className = 'load-error';
      note.textContent = TEXT.sceneLoadFailed(err instanceof Error ? err.message : String(err));
      this.container.appendChild(note);
    });
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------------------------------------------------------------- assets

  private async load(): Promise<void> {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const get = (url: string) => loader.loadAsync(url);
    const names = [...new Set([...Object.values(PLANS).flatMap((plan) => plan.furniture.map((f) => f.model)), ...DESK_MODELS])];
    const [chars, furniture] = await Promise.all([
      Promise.all(CHARACTERS.map((c) => get(`/assets/kenney/characters/character-${c}.glb`))),
      Promise.all(names.map((n) => get(`/assets/kenney/furniture/${n}.glb`).then((g) => [n, g.scene] as const))),
    ]);
    this.characters = chars.map((g) => ({ scene: g.scene, animations: g.animations }));
    for (const [name, model] of furniture) {
      model.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      this.models[name] = model;
    }
    // Every floor of the whole-building view gets the furniture of its own theme.
    this.overview.setTemplates((theme) => this.floorScene(theme).group);
    this.showFloor();
  }

  /** Place a model so its footprint fills (x, z, w, d), standing on y0. */
  private place(f: Furniture, parent: THREE.Object3D): THREE.Object3D | undefined {
    const src = this.models[f.model];
    if (!src) return undefined;
    const m = src.clone(true);
    m.rotation.y = f.rot ?? 0;
    m.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(m);
    const size = box.getSize(new THREE.Vector3());
    const fit = Math.min(f.w / size.x, f.d / size.z);
    m.scale.setScalar(f.h ? Math.min(f.h / size.y, fit * 1.15) : fit);
    m.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(m);
    const c = box.getCenter(new THREE.Vector3());
    m.position.set(f.x + f.w / 2 - c.x, (f.y0 ?? 0) - box.min.y, f.z + f.d / 2 - c.z);
    parent.add(m);
    return m;
  }

  /** The one-floor scene of a theme, built the first time it is needed (models must be loaded). */
  private floorScene(theme: FloorTheme): { group: THREE.Group; room?: HTMLDivElement } {
    let floor = this.floors.get(theme);
    if (!floor) {
      floor = this.buildFloor(PLANS[theme]);
      floor.group.visible = false;
      this.floorRoot.add(floor.group);
      this.floors.set(theme, floor);
    }
    return floor;
  }

  /** Tiles, walls, equipment, elevator and furniture of one floor plan. */
  private buildFloor(plan: FloorPlan): { group: THREE.Group; room?: HTMLDivElement } {
    const group = new THREE.Group();
    group.name = `floor:${plan.theme}`;
    let room: HTMLDivElement | undefined;
    for (const zone of plan.zones) {
      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(zone.w, zone.d),
        new THREE.MeshStandardMaterial({ color: zone.color, roughness: 0.95 }),
      );
      tile.rotation.x = -Math.PI / 2;
      tile.position.set(zone.x + zone.w / 2, 0, zone.z + zone.d / 2);
      tile.receiveShadow = true;
      group.add(tile);

      const el = document.createElement('div');
      el.className = 'zone-label';
      el.textContent = zone.name;
      if (zone.room) room = el;
      const label = new CSS2DObject(el);
      label.position.set(zone.x + 0.6, 0.02, zone.z + 0.4);
      label.center.set(0, 0);
      group.add(label);
    }
    // The aisle column between the work area and the rooms.
    const aisle = new THREE.Mesh(new THREE.PlaneGeometry(1, GRID_H), new THREE.MeshStandardMaterial({ color: plan.aisleColor }));
    aisle.rotation.x = -Math.PI / 2;
    aisle.position.set(13.5, -0.001, GRID_H / 2);
    aisle.receiveShadow = true;
    group.add(aisle);

    const grid = new THREE.GridHelper(GRID_W, GRID_W, 0xcfc8ba, 0xcfc8ba);
    grid.scale.set(1, 1, GRID_H / GRID_W);
    grid.position.set(GRID_W / 2, 0.002, GRID_H / 2);
    (grid.material as THREE.Material).opacity = 0.25;
    (grid.material as THREE.Material).transparent = true;
    group.add(grid);

    // Back walls on the far edges; the near edges stay open towards the viewer.
    const wallMat = new THREE.MeshStandardMaterial({ color: plan.wallColor, roughness: 0.9 });
    const wall = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_HEIGHT, d), wallMat);
      m.position.set(x, WALL_HEIGHT / 2, z);
      m.receiveShadow = true;
      m.castShadow = true;
      group.add(m);
    };
    wall(GRID_W, 0.12, GRID_W / 2, -0.06);
    wall(0.12, GRID_H, -0.06, GRID_H / 2);

    for (const prop of plan.props) group.add(buildProp(prop, { warBoard: this.warBoard.texture }));
    this.buildElevator(group);

    if (plan.theme === 'lobby') {
      const mat = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x8c6f4e }));
      mat.rotation.x = -Math.PI / 2;
      mat.position.copy(cellCenter(DOOR, 0.004));
      group.add(mat);
    }
    this.furnish(plan, group);
    return { group, ...(room ? { room } : {}) };
  }

  /** The elevator next to the door: a grey cab people walk into on one floor and out of on another. */
  private buildElevator(parent: THREE.Object3D): void {
    const { x, z } = ELEVATOR;
    const box = (bw: number, bh: number, bd: number, color: number, px: number, py: number, pz: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3 }));
      m.position.set(px, py, pz);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
    };
    box(0.08, 1.9, 0.9, 0x8a939c, x + 0.04, 0.95, z + 0.5);
    box(0.08, 1.9, 0.9, 0x8a939c, x + 0.96, 0.95, z + 0.5);
    box(1, 0.12, 1, 0x6f7881, x + 0.5, 1.96, z + 0.5);
    box(0.84, 1.8, 0.04, 0xb9c2ca, x + 0.5, 0.9, z + 0.96);
    const el = document.createElement('div');
    el.className = 'zone-label elevator-label';
    el.textContent = TEXT.elevator;
    const label = new CSS2DObject(el);
    label.position.set(x + 0.5, 2.1, z + 0.5);
    parent.add(label);
  }

  /** Day, dusk or night light. */
  setPhase(phase: Phase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    const l = LIGHTING[phase];
    (this.scene.background as THREE.Color).setHex(l.background);
    this.hemi.color.setHex(l.hemiSky);
    this.hemi.groundColor.setHex(l.hemiGround);
    this.hemi.intensity = l.hemiIntensity;
    this.sun.color.setHex(l.sunColor);
    this.sun.intensity = l.sunIntensity;
    for (const lamp of this.lamps) lamp.visible = l.lampsOn;
  }

  private furnish(plan: FloorPlan, parent: THREE.Object3D): void {
    for (const f of plan.furniture) this.place(f, parent);
    for (const pod of plan.pods) {
      // Two desks of 2 × 1; on each, facing its seat, what this floor works with; a chair per seat.
      this.place({ model: 'desk', x: pod.x, z: pod.z, w: 2, d: 1, h: DESK_HEIGHT }, parent);
      this.place({ model: 'desk', x: pod.x, z: pod.z + 1, w: 2, d: 1, h: DESK_HEIGHT }, parent);
      pod.seats.forEach((seat, i) => {
        const yaw = FACING_YAW[seat.facing];
        const deskZ = seat.facing === 'south' ? seat.z + 1 : seat.z - 1;
        const back = seat.facing === 'south' ? 0.62 : 0.08;
        const near = seat.facing === 'south' ? 0.15 : 0.6;
        const put = (model: string, dx: number, dz: number, w: number, d: number, h?: number) =>
          this.place({ model, x: seat.x + dx, z: deskZ + dz, w, d, ...(h ? { h } : {}), y0: DESK_HEIGHT, rot: yaw }, parent);
        switch (plan.deskKit) {
          case 'laptop':
            put('laptop', 0.25, seat.facing === 'south' ? 0.2 : 0.35, 0.5, 0.45);
            break;
          case 'dual':
            put('computerScreen', 0.02, back, 0.48, 0.3, 0.38);
            put('computerScreen', 0.5, back, 0.48, 0.3, 0.38);
            put('computerKeyboard', 0.25, near, 0.5, 0.25);
            break;
          default:
            put('computerScreen', 0.2, back, 0.6, 0.3, 0.42);
            put('computerKeyboard', 0.25, near, 0.5, 0.25);
            if (plan.deskKit === 'screenBooks' && i % 2 === 0) put('books', 0.72, near, 0.25, 0.3, 0.18);
            if (plan.deskKit === 'screenPhone') {
              const phone = new THREE.Mesh(PHONE_GEOMETRY, PHONE_MATERIAL);
              phone.position.set(seat.x + 0.85, DESK_HEIGHT + 0.01, deskZ + near + 0.1);
              phone.rotation.y = yaw;
              parent.add(phone);
            }
        }
        this.place({ model: 'chairDesk', x: seat.x + 0.15, z: seat.z + 0.15, w: 0.7, d: 0.7, h: 0.6, rot: yaw }, parent);
      });
    }
  }

  // ---------------------------------------------------------------- view

  /**
   * Show one building: all its floors stacked (`level` = 'all', `slabs` say
   * what each slab shows), or one floor (`room` names the room on it).
   */
  setView(building: string, level: LevelChoice, room: string, slabs: Slab[]): void {
    const wasAll = this.level === 'all';
    this.building = building;
    this.level = level;
    if (level !== 'all') this.theme = slabs.find((s) => s.level === level)?.theme ?? this.theme;
    this.room = room;
    this.showFloor();
    this.overview.setBuilding(building);
    this.overview.update(slabs);
    const all = level === 'all';
    // The sun's shadow covers one floor; over the whole building it would only cut off.
    this.sun.castShadow = !all;
    for (const v of this.visuals.values()) this.applyScale(v);
    this.floorRoot.visible = !all;
    this.overview.root.visible = all;
    this.labels.domElement.classList.toggle('overview', all);
    if (all !== wasAll) this.frameCamera();
    for (const v of this.visuals.values()) this.applyVisibility(v);
  }

  /** Show the one-floor scene of the floor on screen (once the models are in). */
  private showFloor(): void {
    if (this.characters.length === 0) return;
    const current = this.floorScene(this.theme);
    for (const floor of this.floors.values()) floor.group.visible = floor === current;
    if (current.room) current.room.textContent = this.room;
  }

  /** What the lobby's war-room board says (the building on screen). */
  setBoard(content: BoardContent): void {
    this.warBoard.draw(content);
    this.overview.setBoard(content);
  }

  /** The plan of a floor of a building; floors the view has not named yet look like a department. */
  private planOf(building: string, level: number): FloorPlan {
    const theme = this.themes.get(`${building}#${level}`) ?? (level === 1 ? 'lobby' : level === 2 ? 'managers' : 'build');
    return PLANS[theme];
  }

  private blockedOf(plan: FloorPlan): Set<string> {
    let b = this.blocked.get(plan.theme);
    if (!b) {
      b = blockedCells(plan);
      this.blocked.set(plan.theme, b);
    }
    return b;
  }

  /** Characters are larger in the whole-building view, so people stand out from the furniture. */
  private applyScale(v: Visual): void {
    v.obj.scale.setScalar(v.scale * (this.level === 'all' ? OVERVIEW_CHARACTER_SCALE : 1));
  }

  /** Whole building: frame every floor; one floor: back to the plain floor view. */
  private frameCamera(): void {
    const all = this.level === 'all';
    const target = new THREE.Vector3(GRID_W / 2, all ? this.overview.top / 2 - 1 : 0, GRID_H / 2);
    // Keep the direction the user turned to, change only how high the camera looks from.
    const polar = all ? OVERVIEW_POLAR : ISO_POLAR;
    const around = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    around.phi = polar;
    this.camera.position.copy(target).add(new THREE.Vector3().setFromSpherical(around));
    this.controls.target.copy(target);
    this.controls.minPolarAngle = polar;
    this.controls.maxPolarAngle = polar;
    // Projected height of the building, roof and plaza included, at this angle; zoom so it fills the view.
    const height = this.overview.top + FLOOR_GAP * 1.3;
    const extent = height * Math.sin(polar) + (GRID_W + GRID_H) * Math.SQRT1_2 * Math.cos(polar);
    this.camera.zoom = all ? 10.5 / (extent / 2 + 6) : 1;
    this.controls.minZoom = all ? this.camera.zoom * 0.8 : 0.6;
    this.camera.updateProjectionMatrix();
    this.focus = undefined;
  }

  /** A click (not a drag) on a slab in the whole-building view opens that floor. */
  private listenForSlabClicks(): void {
    const el = this.labels.domElement;
    let down: { x: number; y: number } | undefined;
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', (e) => {
      if (this.level !== 'all' || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(ndc, this.camera);
      const level = this.overview.pick(raycaster);
      if (level !== undefined) this.onPickLevel?.(level);
    });
  }

  /** Is this character on screen: same building, and its floor (or every floor in the whole-building view). */
  private isShown(v: Visual): boolean {
    return v.building === this.building && (this.level === 'all' || v.level === this.level);
  }

  /** Height a character stands at: its floor's slab in the whole-building view, the ground otherwise. */
  private baseY(v: Visual): number {
    if (this.level !== 'all') return 0;
    if (v.ride) return v.ride.from + (v.ride.to - v.ride.from) * v.ride.t;
    return this.overview.heightOf(v.level);
  }

  /** A character and its name plate show only on the building and floor being viewed. */
  private applyVisibility(v: Visual): void {
    const shown = this.isShown(v);
    v.obj.visible = shown;
    v.tag.visible = shown;
    v.tagEl.style.display = shown ? '' : 'none';
  }

  /** One pod allocator per floor of each building. */
  private allocator(building: string, level: number): PodAllocator {
    const key = `${building}#${level}`;
    const plan = this.planOf(building, level);
    let a = this.allocators.get(key);
    // A floor that changed theme (settings edited) starts over with its new pods.
    if (!a || a.theme !== plan.theme) {
      a = { theme: plan.theme, alloc: new PodAllocator(plan.pods, plan.podOrder) };
      this.allocators.set(key, a);
    }
    return a.alloc;
  }

  /** Session ids of a building that have no pod on their floor (the sidebar lists them as overflow). */
  overflow(view: OfficeView, building: string): string[] {
    return view.groups
      .filter((g) => g.building === building && !this.allocator(g.building, g.level).podOf(g.sessionId))
      .map((g) => g.sessionId);
  }

  update(view: OfficeView): void {
    if (this.loadFailed) return;
    if (this.characters.length === 0) {
      // Models still loading: apply this view once they are in.
      void this.ready.then(() => this.update(view));
      return;
    }
    const desired = new Map<string, { group: GroupView; actor: ActorView; place: { x: number; z: number; facing?: Facing } }>();
    // Every floor of every building, so a group that moved away frees its pod.
    const floors = new Map<string, { building: string; level: number; groups: GroupView[] }>();
    const floorOf = (building: string, level: number) => {
      const key = `${building}#${level}`;
      let f = floors.get(key);
      if (!f) {
        f = { building, level, groups: [] };
        floors.set(key, f);
      }
      return f;
    };
    for (const b of view.buildings) {
      for (const l of b.levels) {
        this.themes.set(`${b.name}#${l.level}`, l.theme);
        floorOf(b.name, l.level);
      }
    }
    for (const g of view.groups) floorOf(g.building, g.level).groups.push(g);
    for (const { building, level, groups } of floors.values()) {
      const alloc = this.allocator(building, level);
      alloc.update(groups.map((g) => g.sessionId));
      for (const group of groups) {
        const pod = alloc.podOf(group.sessionId);
        if (!pod) continue;
        group.actors.forEach((actor, i) => {
          const place = placeFor(pod, i);
          if (place) desired.set(actor.id, { group, actor, place });
        });
      }
    }

    for (const v of this.visuals.values()) {
      if (!desired.has(v.id) && !v.leaving) this.leave(v);
    }
    for (const [id, { group, actor, place }] of desired) {
      let v = this.visuals.get(id);
      const seat: Place = place.facing ? { ...place, pose: 'sit' } : { x: place.x, z: place.z };
      const instant = !this.synced || group.building !== this.building || (this.level !== 'all' && group.level !== this.level);
      if (!v || v.leaving) {
        if (v) this.dispose(v);
        v = this.spawn(actor, group, instant ? seat : entranceOf(group.level));
        v.seat = seat;
        if (!instant) this.walkTo(v, seat);
        else v.place = seat;
      } else if (v.building !== group.building) {
        // The group moved to another building (e.g. edited building rules): take its seat there at once.
        v.building = group.building;
        v.level = group.level;
        v.transfer = undefined;
        v.seat = seat;
        this.teleport(v, seat);
        this.applyVisibility(v);
      } else if (v.level !== group.level || v.transfer) {
        this.moveFloors(v, group.level, seat);
      } else if (!v.seat || v.seat.x !== seat.x || v.seat.z !== seat.z) {
        v.seat = seat;
        if (actor.status !== 'idle') {
          if (instant) this.teleport(v, seat);
          else this.walkTo(v, seat);
        }
      }
      // Leaving idle (new work, or dozing off): back to the seat.
      if (actor.status !== 'idle' && v.wanderUntil !== undefined && !v.transfer) {
        v.wanderUntil = undefined;
        if (v.seat && !samePlace(v.place, v.seat)) this.walkTo(v, v.seat);
      }
      v.status = actor.status;
      this.updateTag(v, actor, group);
    }
    this.synced = true;
  }

  private spawn(actor: ActorView, group: GroupView, at: Cell): Visual {
    const src = this.characters[hash(actor.id) % this.characters.length];
    const obj = cloneSkinned(src.scene);
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    const box = new THREE.Box3().setFromObject(obj);
    const scale = (CHAR_HEIGHT * (actor.role === 'main' ? 1 : 0.88)) / (box.max.y - box.min.y);
    obj.scale.setScalar(scale);
    obj.position.copy(cellCenter(at));
    const mixer = new THREE.AnimationMixer(obj);
    const actions: Record<string, THREE.AnimationAction> = {};
    for (const clip of src.animations) actions[clip.name] = mixer.clipAction(clip);
    this.scene.add(obj);

    const tagEl = document.createElement('div');
    tagEl.className = 'tag';
    const tag = new CSS2DObject(tagEl);
    tag.center.set(0.5, 1);
    this.scene.add(tag);

    const v: Visual = { id: actor.id, building: group.building, level: group.level, scale, obj, mixer, actions, path: [], leaving: false, tag, tagEl, tagKey: '' };
    this.visuals.set(actor.id, v);
    this.applyVisibility(v);
    this.applyScale(v);
    return v;
  }

  private teleport(v: Visual, place: Place): void {
    v.obj.position.copy(cellCenter(place));
    v.path = [];
    v.place = place;
  }

  /** Idle employees on their way or at a point of interest, by cell: so two never pick the same one. */
  private occupiedPois(except: Visual): Set<string> {
    const taken = new Set<string>();
    for (const v of this.visuals.values()) {
      const sameFloor = v.building === except.building && v.level === except.level;
      if (v !== except && sameFloor && v.wanderUntil !== undefined && v.place) taken.add(cellKey(v.place));
    }
    return taken;
  }

  /** An idle employee whose stay is over picks the next free point of interest (or stays put when none is free). */
  private wander(v: Visual, now: number): void {
    if (v.status !== 'idle' || v.leaving || v.path.length > 0) return;
    if (v.wanderUntil !== undefined && now < v.wanderUntil) return;
    const poi = choosePoi(this.planOf(v.building, v.level).pois, this.occupiedPois(v));
    if (!poi) {
      v.wanderUntil = now + dwellMs();
      return;
    }
    this.walkTo(v, { x: poi.x, z: poi.z, facing: poi.facing, pose: poi.pose });
    v.wanderUntil = now + (v.path.length / WALK_SPEED) * 1000 + dwellMs();
  }

  private currentCell(v: Visual): Cell {
    return { x: Math.floor(v.obj.position.x), z: Math.floor(v.obj.position.z) };
  }

  private walkTo(v: Visual, place: Place): void {
    v.place = place;
    v.path = findPath(this.currentCell(v), place, this.blockedOf(this.planOf(v.building, v.level)))
      .slice(1)
      .map((c) => cellCenter(c));
  }

  /**
   * The group went to another floor: walk into the elevator here and come out
   * there. Seen from another floor (or before the first view), just move.
   */
  private moveFloors(v: Visual, level: number, seat: Place): void {
    v.seat = seat;
    if (level === v.level) {
      // Called back before the elevator came: back to the seat.
      v.transfer = undefined;
      this.walkTo(v, seat);
      return;
    }
    if (!this.isShown(v) || !this.synced) {
      v.level = level;
      v.transfer = undefined;
      this.teleport(v, seat);
      this.applyVisibility(v);
      return;
    }
    v.transfer = { level, seat };
    v.wanderUntil = undefined;
    this.walkTo(v, { x: ELEVATOR.x, z: ELEVATOR.z });
  }

  /** At the elevator: leave this floor and step out on the new one. */
  private arrive(v: Visual): void {
    const { level, seat } = v.transfer!;
    v.transfer = undefined;
    v.ride = undefined;
    v.level = level;
    v.obj.position.copy(cellCenter(ELEVATOR));
    this.applyVisibility(v);
    if (this.isShown(v)) this.walkTo(v, seat);
    else this.teleport(v, seat);
  }

  /** In the whole-building view the elevator is a shaft: ride it up or down before stepping out. */
  private atElevator(v: Visual, dt: number): void {
    if (this.level !== 'all') return this.arrive(v);
    const to = this.overview.heightOf(v.transfer!.level);
    if (!v.ride) v.ride = { from: this.overview.heightOf(v.level), to, t: 0 };
    const seconds = Math.max(0.6, (Math.abs(v.ride.to - v.ride.from) / FLOOR_GAP) * 0.8);
    v.ride.t = Math.min(1, v.ride.t + dt / seconds);
    if (v.ride.t >= 1) this.arrive(v);
  }

  private leave(v: Visual): void {
    v.leaving = true;
    v.transfer = undefined;
    v.ride = undefined;
    v.place = undefined;
    if (!this.isShown(v)) return this.dispose(v);
    v.path = findPath(this.currentCell(v), entranceOf(v.level), this.blockedOf(this.planOf(v.building, v.level)))
      .slice(1)
      .map((c) => cellCenter(c));
    v.tagEl.classList.add('leaving');
  }

  private dispose(v: Visual): void {
    this.scene.remove(v.obj, v.tag);
    v.tagEl.remove();
    v.mixer.stopAllAction();
    this.visuals.delete(v.id);
  }

  private updateTag(v: Visual, actor: ActorView, group: GroupView): void {
    const key = JSON.stringify([actor.status, actor.bubble, actor.tool, actor.title, actor.model, group.label]);
    if (key === v.tagKey) return;
    v.tagKey = key;
    v.tagEl.className = `tag status-${actor.status} role-${actor.role}`;
    v.tagEl.replaceChildren();
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = actor.bubble;
    if (actor.tool) {
      const tool = document.createElement('span');
      tool.className = 'tool';
      tool.textContent = actor.tool;
      bubble.append(' ', tool);
    }
    const name = document.createElement('div');
    name.className = 'name';
    const badge = document.createElement('span');
    badge.className = `model model-${actor.model}`;
    badge.textContent = MODEL_LETTER[actor.model];
    badge.title = actor.model;
    name.append(badge, actor.title);
    // Shown only in the whole-building view (see style.css): the status word, never tools, files or commands.
    const mini = document.createElement('div');
    mini.className = 'mini';
    mini.textContent = overviewTagText(actor);
    v.tagEl.append(bubble, name, mini);
    if (actor.role === 'main') {
      const label = document.createElement('div');
      label.className = 'group';
      label.textContent = group.label;
      v.tagEl.append(label);
    }
  }

  /** Glide the camera to a group's pod. */
  focusGroup(building: string, level: number, sessionId: string): boolean {
    const pod = this.allocator(building, level).podOf(sessionId);
    if (!pod) return false;
    const y = this.level === 'all' ? this.overview.heightOf(level) : 0;
    this.focus = { from: this.controls.target.clone(), to: new THREE.Vector3(pod.center.x, y, pod.center.z), t: 0 };
    return true;
  }

  // ---------------------------------------------------------------- loop

  private play(v: Visual, name: string): void {
    if (v.current === name) return;
    const next = v.actions[name] ?? v.actions.idle;
    if (!next) return;
    next.reset().fadeIn(0.2).play();
    if (v.current && v.actions[v.current]) v.actions[v.current].fadeOut(0.2);
    v.current = name;
  }

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.focus) {
      this.focus.t = Math.min(1, this.focus.t + dt / 0.6);
      const k = 1 - (1 - this.focus.t) ** 3;
      const next = this.focus.from.clone().lerp(this.focus.to, k);
      this.camera.position.add(next.clone().sub(this.controls.target));
      this.controls.target.copy(next);
      if (this.focus.t >= 1) this.focus = undefined;
    }
    this.controls.update();

    const now = performance.now();
    for (const v of [...this.visuals.values()]) {
      v.mixer.update(dt);
      this.wander(v, now);
      const base = this.baseY(v);
      if (v.path.length > 0) {
        const target = v.path[0].clone().setY(base);
        const pos = v.obj.position;
        pos.y = base;
        const step = WALK_SPEED * dt;
        const delta = target.clone().sub(pos);
        if (delta.length() <= step) {
          pos.copy(target);
          v.path.shift();
        } else {
          pos.add(delta.setLength(step));
        }
        v.obj.rotation.y = Math.atan2(delta.x, delta.z);
        this.play(v, 'walk');
      } else if (v.leaving) {
        this.dispose(v);
        continue;
      } else if (v.transfer) {
        this.atElevator(v, dt);
        v.obj.position.y = this.baseY(v);
        this.play(v, 'idle');
      } else if (v.place?.facing && v.place.pose === 'stand') {
        v.obj.position.set(v.place.x + 0.5, base, v.place.z + 0.5);
        v.obj.rotation.y = FACING_YAW[v.place.facing];
        this.play(v, 'idle');
      } else if (v.place?.facing) {
        v.obj.position.set(v.place.x + 0.5, base + SEAT_LIFT, v.place.z + 0.5);
        v.obj.rotation.y = FACING_YAW[v.place.facing];
        this.play(v, 'sit');
      } else {
        v.obj.position.y = base;
        this.play(v, 'idle');
      }
      v.tag.position.set(v.obj.position.x, v.obj.position.y + CHAR_HEIGHT + 0.25, v.obj.position.z);
    }
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const aspect = w / h;
    const half = 10.5;
    Object.assign(this.camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
  }
}
