import type { Poi } from './layout.ts';
import { cellKey } from './layout.ts';

/**
 * Idle life: where an idle employee goes next and how long it stays. Pure
 * choices with an injectable random source; the scene does the walking.
 */

export const DWELL_MIN_MS = 20_000;
export const DWELL_MAX_MS = 40_000;

/** A random point of interest nobody occupies, or undefined when all are taken. */
export function choosePoi(pois: readonly Poi[], occupied: ReadonlySet<string>, rng: () => number = Math.random): Poi | undefined {
  const free = pois.filter((p) => !occupied.has(cellKey(p)));
  if (free.length === 0) return undefined;
  return free[Math.min(free.length - 1, Math.floor(rng() * free.length))];
}

/** How long to stay at a point of interest: 20–40 seconds. */
export function dwellMs(rng: () => number = Math.random): number {
  return DWELL_MIN_MS + Math.floor(rng() * (DWELL_MAX_MS - DWELL_MIN_MS + 1));
}
