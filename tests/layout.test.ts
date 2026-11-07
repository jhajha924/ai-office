import { describe, expect, it } from 'vitest';

import { blockedCells, cellKey, DOOR, FURNITURE, GRID_H, GRID_W, PODS } from '../web/src/scene/layout.ts';
import { findPath } from '../web/src/scene/pathfinding.ts';
import { placeFor, PodAllocator } from '../web/src/scene/podAllocator.ts';

describe('pod allocation', () => {
  // office-3d-scene spec, Scenario: 第 13 個小組
  it('gives 12 groups a pod each and leaves the 13th out', () => {
    const ids = Array.from({ length: 13 }, (_, i) => `s${i}`);
    const alloc = new PodAllocator();
    alloc.update(ids);
    expect(new Set(ids.slice(0, 12).map((id) => alloc.podOf(id)?.index)).size).toBe(12);
    expect(alloc.podOf('s12')).toBeUndefined();
    expect(alloc.overflow(ids)).toEqual(['s12']);
  });

  it('reuses a freed pod for the next newcomer and keeps the others in place', () => {
    const alloc = new PodAllocator();
    alloc.update(['a', 'b', 'c']);
    const bPod = alloc.podOf('b')!.index;
    const cPod = alloc.podOf('c')!.index;
    alloc.update(['a', 'c', 'd']);
    expect(alloc.podOf('d')!.index).toBe(bPod);
    expect(alloc.podOf('c')!.index).toBe(cPod);
  });

  it('seats the main character first, three members, then the aisle', () => {
    const pod = PODS[0];
    expect(placeFor(pod, 0)).toEqual(pod.seats[0]);
    expect(placeFor(pod, 3)).toEqual(pod.seats[3]);
    expect(placeFor(pod, 4)).toEqual(pod.standing[0]);
  });
});

describe('floor plan', () => {
  const blocked = blockedCells();

  it('keeps every seat, standing cell and the door walkable and inside the grid', () => {
    const cells = [DOOR, ...PODS.flatMap((p) => [...p.seats, ...p.standing])];
    for (const c of cells) {
      expect(blocked.has(cellKey(c)), cellKey(c)).toBe(false);
      expect(c.x >= 0 && c.x < GRID_W && c.z >= 0 && c.z < GRID_H).toBe(true);
    }
  });

  it('puts furniture inside the grid', () => {
    for (const f of FURNITURE) {
      expect(f.x >= 0 && f.x + f.w <= GRID_W && f.z >= 0 && f.z + f.d <= GRID_H, f.model).toBe(true);
    }
  });

  // office-3d-scene spec, Scenario: 子代理出現
  it('finds a route from the door to every seat without crossing furniture', () => {
    for (const pod of PODS) {
      for (const seat of [...pod.seats, ...pod.standing]) {
        const path = findPath(DOOR, seat, blocked);
        expect(path[0]).toEqual(DOOR);
        expect(path[path.length - 1]).toEqual({ x: seat.x, z: seat.z });
        for (const step of path) expect(blocked.has(cellKey(step)), `${pod.index} ${cellKey(step)}`).toBe(false);
        for (let i = 1; i < path.length; i++) {
          expect(Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].z - path[i - 1].z)).toBe(1);
        }
      }
    }
  });

  it('goes around a desk instead of through it', () => {
    const pod = PODS[0];
    const path = findPath(pod.seats[0], pod.seats[2], blocked);
    expect(path.length).toBeGreaterThan(4);
    for (const desk of pod.desks) expect(path.some((c) => c.x === desk.x && c.z === desk.z)).toBe(false);
  });
});
