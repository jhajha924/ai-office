import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

import type { ActorStatus, ActorView, GroupView, OfficeView } from '../../../server/src/office/types.ts';
import type { Phase } from './daylight.ts';
import { LIGHTING } from './daylight.ts';
import { choosePoi, dwellMs } from './idleLife.ts';
import type { Cell, Facing, Furniture } from './layout.ts';
import { blockedCells, cellKey, DOOR, FURNITURE, GRID_H, GRID_W, PING_PONG, PODS, POIS, ZONES } from './layout.ts';
import { findPath } from './pathfinding.ts';
import { placeFor, PodAllocator } from './podAllocator.ts';
import { TEXT } from '../text.ts';

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
  floor: string;
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
  tag: CSS2DObject;
  tagEl: HTMLDivElement;
  tagKey: string;
}

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
  private allocators = new Map<string, PodAllocator>();
  private blocked = blockedCells();
  private floor = '';
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

    this.buildRoom();
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
    const names = [...new Set([...FURNITURE.map((f) => f.model), 'desk', 'chairDesk', 'computerScreen', 'computerKeyboard', 'rugRectangle'])];
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
    this.furnish();
  }

  /** Place a model so its footprint fills (x, z, w, d), standing on y0. */
  private place(f: Furniture): THREE.Object3D | undefined {
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
    this.scene.add(m);
    return m;
  }

  private buildRoom(): void {
    for (const zone of ZONES) {
      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(zone.w, zone.d),
        new THREE.MeshStandardMaterial({ color: zone.color, roughness: 0.95 }),
      );
      tile.rotation.x = -Math.PI / 2;
      tile.position.set(zone.x + zone.w / 2, 0, zone.z + zone.d / 2);
      tile.receiveShadow = true;
      this.scene.add(tile);

      const el = document.createElement('div');
      el.className = 'zone-label';
      el.textContent = zone.name;
      const label = new CSS2DObject(el);
      label.position.set(zone.x + 0.6, 0.02, zone.z + 0.4);
      label.center.set(0, 0);
      this.scene.add(label);
    }
    // The aisle column between the desk area and the rooms.
    const aisle = new THREE.Mesh(new THREE.PlaneGeometry(1, GRID_H), new THREE.MeshStandardMaterial({ color: 0xd8d1c4 }));
    aisle.rotation.x = -Math.PI / 2;
    aisle.position.set(13.5, -0.001, GRID_H / 2);
    aisle.receiveShadow = true;
    this.scene.add(aisle);

    const grid = new THREE.GridHelper(GRID_W, GRID_W, 0xcfc8ba, 0xcfc8ba);
    grid.scale.set(1, 1, GRID_H / GRID_W);
    grid.position.set(GRID_W / 2, 0.002, GRID_H / 2);
    (grid.material as THREE.Material).opacity = 0.35;
    (grid.material as THREE.Material).transparent = true;
    this.scene.add(grid);

    // Back walls on the far edges; the near edges stay open towards the viewer.
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xefe9de, roughness: 0.9 });
    const wall = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_HEIGHT, d), wallMat);
      m.position.set(x, WALL_HEIGHT / 2, z);
      m.receiveShadow = true;
      m.castShadow = true;
      this.scene.add(m);
    };
    wall(GRID_W, 0.12, GRID_W / 2, -0.06);
    wall(0.12, GRID_H, -0.06, GRID_H / 2);
    // Low glass-like partitions marking the rooms on the right.
    const glass = new THREE.MeshStandardMaterial({ color: 0xbcd4e6, transparent: true, opacity: 0.35 });
    const partition = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.9, d), glass);
      m.position.set(x, 0.45, z);
      this.scene.add(m);
    };
    partition(0.06, 5, 14, 2.5);
    partition(7, 0.06, 20.5, 6);

    this.buildPingPong();

    const mat = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0x8c6f4e }));
    mat.rotation.x = -Math.PI / 2;
    mat.position.copy(cellCenter(DOOR, 0.004));
    this.scene.add(mat);
  }

  /** The ping-pong table: green top, white line, net, four legs. */
  private buildPingPong(): void {
    const { x, z, w, d } = PING_PONG;
    const box = (bw: number, bh: number, bd: number, color: number, px: number, py: number, pz: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));
      m.position.set(px, py, pz);
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
    };
    const cx = x + w / 2;
    const cz = z + d / 2;
    box(w * 0.92, 0.05, d * 0.8, 0x1f6f4a, cx, 0.72, cz);
    box(w * 0.92, 0.052, 0.02, 0xffffff, cx, 0.721, cz);
    box(0.02, 0.12, d * 0.86, 0xf1f1f1, cx, 0.8, cz);
    for (const [lx, lz] of [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ]) {
      box(0.05, 0.7, 0.05, 0x333333, cx + lx * w * 0.4, 0.35, cz + lz * d * 0.32);
    }
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

  private furnish(): void {
    for (const f of FURNITURE) this.place(f);
    for (const pod of PODS) {
      // Two desks of 2 × 1, a screen and keyboard facing each seat, a chair per seat.
      this.place({ model: 'desk', x: pod.x, z: pod.z, w: 2, d: 1, h: DESK_HEIGHT });
      this.place({ model: 'desk', x: pod.x, z: pod.z + 1, w: 2, d: 1, h: DESK_HEIGHT });
      for (const seat of pod.seats) {
        const yaw = FACING_YAW[seat.facing];
        const deskZ = seat.facing === 'south' ? seat.z + 1 : seat.z - 1;
        const back = seat.facing === 'south' ? 0.62 : 0.08;
        this.place({ model: 'computerScreen', x: seat.x + 0.2, z: deskZ + back, w: 0.6, d: 0.3, h: 0.42, y0: DESK_HEIGHT, rot: yaw });
        this.place({ model: 'computerKeyboard', x: seat.x + 0.25, z: deskZ + (seat.facing === 'south' ? 0.15 : 0.6), w: 0.5, d: 0.25, y0: DESK_HEIGHT, rot: yaw });
        this.place({ model: 'chairDesk', x: seat.x + 0.15, z: seat.z + 0.15, w: 0.7, d: 0.7, h: 0.6, rot: yaw });
      }
    }
  }

  // ---------------------------------------------------------------- view

  setFloor(floor: string): void {
    this.floor = floor;
    for (const v of this.visuals.values()) this.applyVisibility(v);
  }

  /** A character and its name plate show only on the floor being viewed. */
  private applyVisibility(v: Visual): void {
    const shown = v.floor === this.floor;
    v.obj.visible = shown;
    v.tag.visible = shown;
    v.tagEl.style.display = shown ? '' : 'none';
  }

  private allocator(floor: string): PodAllocator {
    let a = this.allocators.get(floor);
    if (!a) {
      a = new PodAllocator();
      this.allocators.set(floor, a);
    }
    return a;
  }

  /** Session ids on a floor that have no pod (the sidebar lists them as overflow). */
  overflow(view: OfficeView, floor: string): string[] {
    const ids = view.groups.filter((g) => g.floor === floor).map((g) => g.sessionId);
    return this.allocator(floor).overflow(ids);
  }

  update(view: OfficeView): void {
    if (this.loadFailed) return;
    if (this.characters.length === 0) {
      // Models still loading: apply this view once they are in.
      void this.ready.then(() => this.update(view));
      return;
    }
    const desired = new Map<string, { group: GroupView; actor: ActorView; place: { x: number; z: number; facing?: Facing } }>();
    for (const floor of new Set(view.groups.map((g) => g.floor).concat(view.floors.map((f) => f.name)))) {
      const groups = view.groups.filter((g) => g.floor === floor);
      const alloc = this.allocator(floor);
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
      const instant = !this.synced || group.floor !== this.floor;
      if (!v || v.leaving) {
        if (v) this.dispose(v);
        v = this.spawn(actor, group, instant ? seat : DOOR);
        v.seat = seat;
        if (!instant) this.walkTo(v, seat);
        else v.place = seat;
      } else if (v.floor !== group.floor) {
        // The group moved to another floor (e.g. edited floor rules): take its seat there at once.
        v.floor = group.floor;
        v.seat = seat;
        this.teleport(v, seat);
        this.applyVisibility(v);
      } else if (!v.seat || v.seat.x !== seat.x || v.seat.z !== seat.z) {
        v.seat = seat;
        if (actor.status !== 'idle') {
          if (instant) this.teleport(v, seat);
          else this.walkTo(v, seat);
        }
      }
      // Leaving idle (new work, or dozing off): back to the seat.
      if (actor.status !== 'idle' && v.wanderUntil !== undefined) {
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
    obj.scale.setScalar((CHAR_HEIGHT * (actor.role === 'main' ? 1 : 0.88)) / (box.max.y - box.min.y));
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

    const v: Visual = { id: actor.id, floor: group.floor, obj, mixer, actions, path: [], leaving: false, tag, tagEl, tagKey: '' };
    this.visuals.set(actor.id, v);
    this.applyVisibility(v);
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
      if (v !== except && v.wanderUntil !== undefined && v.place) taken.add(cellKey(v.place));
    }
    return taken;
  }

  /** An idle employee whose stay is over picks the next free point of interest (or stays put when none is free). */
  private wander(v: Visual, now: number): void {
    if (v.status !== 'idle' || v.leaving || v.path.length > 0) return;
    if (v.wanderUntil !== undefined && now < v.wanderUntil) return;
    const poi = choosePoi(POIS, this.occupiedPois(v));
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
    v.path = findPath(this.currentCell(v), place, this.blocked).slice(1).map((c) => cellCenter(c));
  }

  private leave(v: Visual): void {
    v.leaving = true;
    v.place = undefined;
    if (v.floor !== this.floor) return this.dispose(v);
    v.path = findPath(this.currentCell(v), DOOR, this.blocked).slice(1).map((c) => cellCenter(c));
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
    v.tagEl.append(bubble, name);
    if (actor.role === 'main') {
      const label = document.createElement('div');
      label.className = 'group';
      label.textContent = group.label;
      v.tagEl.append(label);
    }
  }

  /** Glide the camera to a group's pod. */
  focusGroup(floor: string, sessionId: string): boolean {
    const pod = this.allocator(floor).podOf(sessionId);
    if (!pod) return false;
    this.focus = { from: this.controls.target.clone(), to: new THREE.Vector3(pod.center.x, 0, pod.center.z), t: 0 };
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
      if (v.path.length > 0) {
        const target = v.path[0];
        const pos = v.obj.position;
        pos.y = 0;
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
      } else if (v.place?.facing && v.place.pose === 'stand') {
        v.obj.position.set(v.place.x + 0.5, 0, v.place.z + 0.5);
        v.obj.rotation.y = FACING_YAW[v.place.facing];
        this.play(v, 'idle');
      } else if (v.place?.facing) {
        v.obj.position.set(v.place.x + 0.5, SEAT_LIFT, v.place.z + 0.5);
        v.obj.rotation.y = FACING_YAW[v.place.facing];
        this.play(v, 'sit');
      } else {
        v.obj.position.y = 0;
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
