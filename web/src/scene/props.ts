import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import type { Prop } from './floorPlans.ts';

/**
 * Equipment Kenney has no model for, built from boxes: boards on the back
 * wall, glass rooms, server racks, test benches and so on. Each builder
 * fills the prop's footprint (x‥x+w, z‥z+d on the grid). Geometries and
 * materials are shared, so the whole-building view can batch them like the
 * furniture.
 */

/** What some props need from the scene: the war-room board's live picture. */
export interface PropContext {
  warBoard: THREE.Texture;
}

const geometries = new Map<string, THREE.BoxGeometry>();
const materials = new Map<string, THREE.Material>();

function boxGeometry(w: number, h: number, d: number): THREE.BoxGeometry {
  const key = `${w.toFixed(3)},${h.toFixed(3)},${d.toFixed(3)}`;
  let g = geometries.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    geometries.set(key, g);
  }
  return g;
}

function material(color: number, opts: { glass?: boolean; glow?: boolean; metal?: boolean } = {}): THREE.Material {
  const key = `${color}|${opts.glass ? 'g' : ''}${opts.glow ? 'l' : ''}${opts.metal ? 'm' : ''}`;
  let m = materials.get(key);
  if (!m) {
    m = opts.glass
      ? new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.28, roughness: 0.1, metalness: 0.1, depthWrite: false })
      : new THREE.MeshStandardMaterial({
          color,
          roughness: opts.metal ? 0.4 : 0.7,
          metalness: opts.metal ? 0.4 : 0,
          ...(opts.glow ? { emissive: color, emissiveIntensity: 0.55 } : {}),
        });
    materials.set(key, m);
  }
  return m;
}

/** A box of size (w, h, d) whose centre is at (x, y, z). */
function box(
  parent: THREE.Object3D,
  w: number,
  h: number,
  d: number,
  color: number,
  x: number,
  y: number,
  z: number,
  opts: { glass?: boolean; glow?: boolean; metal?: boolean } = {},
): THREE.Mesh {
  const m = new THREE.Mesh(boxGeometry(w, h, d), material(color, opts));
  m.position.set(x, y, z);
  m.castShadow = !opts.glass && !opts.glow;
  m.receiveShadow = !opts.glass;
  parent.add(m);
  return m;
}

/** A flat picture with words, for boards and signs. */
const textures = new Map<string, THREE.CanvasTexture>();
export function textTexture(lines: string[], opts: { bg: string; fg: string; size?: number; width?: number; height?: number }): THREE.CanvasTexture {
  const key = JSON.stringify([lines, opts]);
  const cached = textures.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = opts.width ?? 512;
  canvas.height = opts.height ?? 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = opts.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = opts.fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const size = opts.size ?? 56;
  ctx.font = `bold ${size}px "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
  lines.forEach((line, i) => ctx.fillText(line, canvas.width / 2, canvas.height / 2 + (i - (lines.length - 1) / 2) * size * 1.25));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  textures.set(key, texture);
  return texture;
}

/** A panel showing a picture, facing the viewer (+z). */
function panel(parent: THREE.Object3D, w: number, h: number, x: number, y: number, z: number, map: THREE.Texture): THREE.Mesh {
  const key = `panel|${map.uuid}`;
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map, roughness: 0.8, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.25 });
    materials.set(key, m);
  }
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

const STICKY = [0xfde047, 0xf9a8d4, 0x93c5fd, 0x86efac, 0xfdba74];

/** A board hung on the back wall (z = 0), its bottom at `bottom`, `h` tall, framed. */
function wallBoard(g: THREE.Group, p: Prop, h: number, bottom: number, face: number, frame = 0x475569): { x0: number; x1: number; y0: number; y1: number; z: number } {
  const cx = p.x + p.w / 2;
  box(g, p.w, h, 0.08, frame, cx, bottom + h / 2, 0.1);
  box(g, p.w - 0.16, h - 0.16, 0.02, face, cx, bottom + h / 2, 0.15);
  return { x0: p.x + 0.15, x1: p.x + p.w - 0.15, y0: bottom + 0.15, y1: bottom + h - 0.15, z: 0.17 };
}

/** Deterministic pseudo-random numbers, so every floor of a theme looks the same each time. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const BUILDERS: Record<Prop['kind'], (g: THREE.Group, p: Prop, ctx: PropContext) => void> = {
  warBoard(g, p, ctx) {
    const b = wallBoard(g, p, 2.9, 0.3, 0x0f172a, 0x1e293b);
    panel(g, b.x1 - b.x0, b.y1 - b.y0, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.z + 0.01, ctx.warBoard);
    // Status lamps on top: red, orange, green.
    [0xdc2626, 0xea580c, 0x16a34a].forEach((c, i) => box(g, 0.25, 0.12, 0.06, c, p.x + p.w - 1.2 + i * 0.4, 0.3 + 2.95, 0.12, { glow: true }));
  },
  stickyWall(g, p) {
    const b = wallBoard(g, p, 1.6, 0.6, 0xfafafa);
    const rnd = seeded(3);
    for (let x = b.x0 + 0.15; x < b.x1 - 0.15; x += 0.32) {
      for (let y = b.y0 + 0.15; y < b.y1 - 0.1; y += 0.32) {
        if (rnd() < 0.3) continue;
        box(g, 0.24, 0.24, 0.01, STICKY[Math.floor(rnd() * STICKY.length)], x + (rnd() - 0.5) * 0.06, y, b.z + 0.005);
      }
    }
  },
  kanban(g, p) {
    const b = wallBoard(g, p, 1.6, 0.6, 0xf8fafc);
    const cols = ['待辦', '進行中', '完成'];
    const colW = (b.x1 - b.x0) / cols.length;
    const rnd = seeded(5);
    cols.forEach((title, i) => {
      const x0 = b.x0 + i * colW;
      panel(g, colW - 0.2, 0.22, x0 + colW / 2, b.y1 - 0.15, b.z + 0.01, textTexture([title], { bg: '#334155', fg: '#ffffff', size: 64 }));
      if (i > 0) box(g, 0.03, b.y1 - b.y0, 0.01, 0x94a3b8, x0, (b.y0 + b.y1) / 2, b.z);
      const cards = [5, 3, 4][i];
      for (let k = 0; k < cards; k++) {
        const col = k % 3;
        const row = Math.floor(k / 3);
        box(g, 0.6, 0.3, 0.01, [0x93c5fd, 0xfde047, 0x86efac][i], x0 + 0.5 + col * 0.75 + rnd() * 0.05, b.y1 - 0.55 - row * 0.4, b.z + 0.005);
      }
    });
  },
  monitorWall(g, p) {
    const cols = 3;
    const rows = 2;
    const w = (p.w - 0.6) / cols;
    const rnd = seeded(7);
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const cx = p.x + 0.3 + w * c + w / 2;
        const cy = 0.75 + r * 0.85 + 0.4;
        box(g, w - 0.1, 0.78, 0.08, 0x111827, cx, cy, 0.1);
        box(g, w - 0.24, 0.64, 0.01, 0x0b1220, cx, cy, 0.145, { glow: true });
        // Bars: green builds, a red one here and there.
        for (let k = 0; k < 6; k++) {
          const hgt = 0.1 + rnd() * 0.42;
          const color = rnd() < 0.15 ? 0xef4444 : rnd() < 0.5 ? 0x22c55e : 0x38bdf8;
          box(g, 0.16, hgt, 0.01, color, cx - (w - 0.5) / 2 + k * ((w - 0.5) / 5), cy - 0.28 + hgt / 2, 0.152, { glow: true });
        }
      }
    }
  },
  resultBoard(g, p) {
    const b = wallBoard(g, p, 1.6, 0.6, 0x1f2937, 0x111827);
    panel(g, 2.4, 0.26, b.x0 + 1.4, b.y1 - 0.18, b.z + 0.01, textTexture(['測試結果'], { bg: '#111827', fg: '#e5e7eb', size: 64 }));
    const rnd = seeded(11);
    for (let y = b.y1 - 0.5; y > b.y0 + 0.05; y -= 0.24) {
      for (let x = b.x0 + 0.2; x < b.x1 - 0.1; x += 0.3) {
        box(g, 0.16, 0.16, 0.01, rnd() < 0.12 ? 0xef4444 : rnd() < 0.08 ? 0xf59e0b : 0x22c55e, x, y, b.z + 0.005, { glow: true });
      }
    }
  },
  countdown(g, p) {
    const b = wallBoard(g, p, 1.6, 0.6, 0x3b0a2a, 0x500724);
    panel(g, b.x1 - b.x0, b.y1 - b.y0, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.z + 0.01, textTexture(['發佈倒數', '3 天 04:12'], { bg: '#3b0a2a', fg: '#fbcfe8', size: 92, width: 1024, height: 256 }));
  },
  whiteboard(g, p) {
    const b = wallBoard(g, p, 1.1, 0.8, 0xffffff, 0x9ca3af);
    const rnd = seeded(13);
    for (let i = 0; i < 6; i++) box(g, 0.22, 0.22, 0.01, STICKY[i % STICKY.length], b.x0 + 0.3 + rnd() * (b.x1 - b.x0 - 0.6), b.y0 + 0.2 + rnd() * 0.6, b.z + 0.005);
  },
  standBoard(g, p) {
    const cx = p.x + p.w / 2;
    const cz = p.z + 0.5;
    for (const dx of [-p.w / 2 + 0.15, p.w / 2 - 0.15]) box(g, 0.05, 1.7, 0.05, 0x6b7280, cx + dx, 0.85, cz, { metal: true });
    box(g, p.w - 0.1, 1.0, 0.05, 0x9ca3af, cx, 1.15, cz);
    box(g, p.w - 0.2, 0.9, 0.01, 0xffffff, cx, 1.15, cz + 0.03);
    if (p.text) panel(g, p.w - 0.4, 0.2, cx, 1.5, cz + 0.04, textTexture([p.text], { bg: '#ffffff', fg: '#b91c1c', size: 64 }));
    const rnd = seeded(17 + p.x);
    for (let i = 0; i < 7; i++) {
      const color = p.text ? (rnd() < 0.6 ? 0xfca5a5 : 0xfde047) : STICKY[i % STICKY.length];
      box(g, 0.18, 0.18, 0.01, color, cx - (p.w - 0.5) / 2 + rnd() * (p.w - 0.5), 0.85 + rnd() * 0.5, cz + 0.04);
    }
  },
  glassRoom(g, p) {
    // Glass on the aisle side (x) and the front (z + d), a doorway in the front.
    const h = 1.5;
    const doorX = p.x + 3;
    box(g, 0.06, h, p.d, 0xbcd4e6, p.x, h / 2, p.z + p.d / 2, { glass: true });
    box(g, doorX - p.x, h, 0.06, 0xbcd4e6, p.x + (doorX - p.x) / 2, h / 2, p.z + p.d, { glass: true });
    const right = p.x + p.w;
    box(g, right - (doorX + 1), h, 0.06, 0xbcd4e6, (doorX + 1 + right) / 2, h / 2, p.z + p.d, { glass: true });
    box(g, 0.06, h, 0.06, 0x94a3b8, p.x, h / 2, p.z + p.d, { metal: true });
    box(g, p.w, 0.04, 0.06, 0x94a3b8, p.x + p.w / 2, h, p.z + p.d, { metal: true });
  },
  glassOffice(g, p) {
    const h = 1.45;
    const front = p.door === 'south' ? p.z + p.d : p.z;
    const back = p.door === 'south' ? p.z : p.z + p.d;
    const frame = (w: number, d: number, x: number, z: number) => box(g, w, 0.04, d, 0x94a3b8, x, h, z, { metal: true });
    // Side walls (x = left and right edge) and the wall at the doorway side, with a 1-cell doorway.
    for (const x of [p.x, p.x + p.w]) {
      box(g, 0.05, h, p.d, 0xbcd4e6, x, h / 2, p.z + p.d / 2, { glass: true });
      frame(0.06, p.d, x, p.z + p.d / 2);
    }
    box(g, 1, h, 0.05, 0xbcd4e6, p.x + 0.5, h / 2, front, { glass: true });
    box(g, p.w - 2, h, 0.05, 0xbcd4e6, p.x + 2 + (p.w - 2) / 2, h / 2, front, { glass: true });
    frame(p.w, 0.06, p.x + p.w / 2, front);
    if (back !== 0) box(g, p.w, h, 0.05, 0xbcd4e6, p.x + p.w / 2, h / 2, back, { glass: true });
    // Door leaf, open.
    box(g, 0.05, h - 0.1, 0.9, 0x94a3b8, p.x + 1.05, (h - 0.1) / 2, front + (p.door === 'south' ? -0.45 : 0.45), { glass: true });
    if (p.text) {
      const el = document.createElement('div');
      el.className = 'zone-label office-plate';
      el.textContent = p.text;
      const tag = new CSS2DObject(el);
      tag.position.set(p.x + 1.5, h + 0.1, front);
      g.add(tag);
    }
  },
  partition(g, p) {
    const w = Math.max(p.w, 0.06);
    const d = Math.max(p.d, 0.06);
    box(g, w, 0.9, d, 0xbcd4e6, p.x + p.w / 2, 0.45, p.z + p.d / 2, { glass: true });
  },
  lowWall(g, p) {
    const w = Math.max(p.w, 0.1);
    const d = Math.max(p.d, 0.1);
    box(g, w, 1.1, d, 0xcbbfa8, p.x + p.w / 2, 0.55, p.z + p.d / 2);
  },
  counter(g, p) {
    const cx = p.x + p.w / 2;
    const cz = p.z + p.d / 2;
    box(g, p.w, 1.0, p.d * 0.7, 0xf5f5f4, cx, 0.5, cz);
    box(g, p.w + 0.1, 0.06, p.d * 0.8, 0x78716c, cx, 1.03, cz);
    box(g, p.w - 0.2, 0.18, 0.02, 0x0ea5e9, cx, 0.75, cz + p.d * 0.36, { glow: true });
    if (p.text) panel(g, 1.6, 0.28, cx, 0.45, cz + p.d * 0.36, textTexture([p.text], { bg: '#f5f5f4', fg: '#0f172a', size: 64 }));
  },
  rack(g, p) {
    const cx = p.x + 0.5;
    const cz = p.z + 0.5;
    box(g, 0.8, 1.9, 0.8, 0x1f2937, cx, 0.95, cz, { metal: true });
    for (let i = 0; i < 8; i++) {
      box(g, 0.66, 0.16, 0.02, 0x374151, cx, 0.3 + i * 0.2, cz + 0.41);
      box(g, 0.05, 0.05, 0.01, i % 3 === 0 ? 0xf59e0b : 0x22c55e, cx + 0.24, 0.3 + i * 0.2, cz + 0.425, { glow: true });
    }
  },
  beanbag(g, p) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), material([0xef4444, 0x3b82f6, 0xf59e0b][p.x % 3]));
    m.scale.set(1, 0.55, 1);
    m.position.set(p.x + 0.5, 0.22, p.z + 0.5);
    m.castShadow = true;
    g.add(m);
  },
  pingPong(g, p) {
    const cx = p.x + p.w / 2;
    const cz = p.z + p.d / 2;
    box(g, p.w * 0.92, 0.05, p.d * 0.8, 0x1f6f4a, cx, 0.72, cz);
    box(g, p.w * 0.92, 0.052, 0.02, 0xffffff, cx, 0.721, cz);
    box(g, 0.02, 0.12, p.d * 0.86, 0xf1f1f1, cx, 0.8, cz);
    for (const [lx, lz] of [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ]) {
      box(g, 0.05, 0.7, 0.05, 0x333333, cx + lx * p.w * 0.4, 0.35, cz + lz * p.d * 0.32);
    }
  },
  devices(g, p) {
    // Phones, tablets and a laptop lid along a bench, screens lit.
    const y = (p.y0 ?? 0.75) + 0.01;
    const rnd = seeded(19 + p.x);
    for (let x = p.x + 0.3; x < p.x + p.w - 0.2; x += 0.45) {
      const tablet = rnd() < 0.35;
      const w = tablet ? 0.32 : 0.14;
      const h = tablet ? 0.24 : 0.26;
      box(g, w, h, 0.03, 0x111827, x, y + h / 2 + 0.03, p.z + 0.35);
      box(g, w - 0.03, h - 0.04, 0.005, [0x38bdf8, 0x22c55e, 0xf472b6][Math.floor(rnd() * 3)], x, y + h / 2 + 0.03, p.z + 0.37, { glow: true });
      box(g, w + 0.04, 0.03, 0.12, 0x6b7280, x, y + 0.015, p.z + 0.4);
    }
  },
  trafficLight(g, p) {
    const cx = p.x + 0.5;
    const cz = p.z + 0.5;
    box(g, 0.5, 0.06, 0.5, 0x374151, cx, 0.03, cz);
    box(g, 0.08, 1.6, 0.08, 0x4b5563, cx, 0.8, cz, { metal: true });
    box(g, 0.3, 0.8, 0.26, 0x111827, cx, 1.8, cz);
    [0xef4444, 0xf59e0b, 0x22c55e].forEach((c, i) => {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), material(c, { glow: i !== 1 }));
      lamp.position.set(cx, 2.05 - i * 0.25, cz + 0.13);
      g.add(lamp);
    });
  },
  printer(g, p) {
    const cx = p.x + p.w / 2;
    const cz = p.z + p.d / 2;
    box(g, p.w * 0.85, 0.9, p.d * 0.75, 0xe5e7eb, cx, 0.45, cz);
    box(g, p.w * 0.6, 0.06, p.d * 0.4, 0xffffff, cx, 0.93, cz + 0.1);
    box(g, p.w * 0.7, 0.05, 0.02, 0x22c55e, cx, 0.7, cz + p.d * 0.38, { glow: true });
    box(g, p.w * 0.85, 0.1, p.d * 0.75, 0x9ca3af, cx, 0.05, cz);
  },
  paperStack(g, p) {
    const cx = p.x + 0.5;
    const cz = p.z + 0.5;
    for (let i = 0; i < 4; i++) box(g, 0.45, 0.18, 0.32, i % 2 ? 0xfafafa : 0xf1f5f9, cx + (i % 2) * 0.03, 0.09 + i * 0.18, cz);
  },
  blueprint(g, p) {
    // Three sheets round the middle of the table: the table model is narrower than its footprint.
    const y = (p.y0 ?? 0.8) + 0.008;
    const rnd = seeded(23);
    for (let i = 0; i < 3; i++) {
      const sheet = box(g, 0.85, 0.01, 0.6, 0x1d4ed8, p.x + p.w / 2 + (i - 1) * 0.95, y, p.z + p.d / 2 + (rnd() - 0.5) * 0.3);
      sheet.rotation.y = (rnd() - 0.5) * 0.3;
      box(g, 0.7, 0.012, 0.02, 0xbfdbfe, sheet.position.x, y + 0.002, sheet.position.z - 0.15);
      box(g, 0.02, 0.012, 0.4, 0xbfdbfe, sheet.position.x - 0.2, y + 0.002, sheet.position.z);
    }
  },
};

/** Build one prop. */
export function buildProp(prop: Prop, ctx: PropContext): THREE.Group {
  const g = new THREE.Group();
  g.name = `prop:${prop.kind}`;
  BUILDERS[prop.kind](g, prop, ctx);
  return g;
}
