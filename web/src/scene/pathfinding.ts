import type { Cell } from './layout.ts';
import { cellKey, GRID_H, GRID_W } from './layout.ts';

/**
 * A* on the office grid, 4 neighbours, unit cost. The start and goal cells may
 * themselves be blocked-looking (a chair cell is a goal), but the path never
 * passes through a blocked cell on the way. Returns the cells from start to
 * goal inclusive, or [start, goal] when no route exists.
 */
export function findPath(from: Cell, to: Cell, blocked: ReadonlySet<string>, w = GRID_W, h = GRID_H): Cell[] {
  const startKey = cellKey(from);
  const goalKey = cellKey(to);
  if (startKey === goalKey) return [from];

  const heuristic = (c: Cell) => Math.abs(c.x - to.x) + Math.abs(c.z - to.z);
  const open: Array<{ cell: Cell; f: number }> = [{ cell: from, f: heuristic(from) }];
  const came = new Map<string, Cell>();
  const g = new Map<string, number>([[startKey, 0]]);
  const closed = new Set<string>();

  while (open.length > 0) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[best].f) best = i;
    const { cell } = open.splice(best, 1)[0];
    const key = cellKey(cell);
    if (key === goalKey) {
      const path = [cell];
      let k = key;
      while (came.has(k)) {
        const prev = came.get(k)!;
        path.unshift(prev);
        k = cellKey(prev);
      }
      return path;
    }
    if (closed.has(key)) continue;
    closed.add(key);

    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const next = { x: cell.x + dx, z: cell.z + dz };
      if (next.x < 0 || next.z < 0 || next.x >= w || next.z >= h) continue;
      const nextKey = cellKey(next);
      if (nextKey !== goalKey && blocked.has(nextKey)) continue;
      if (closed.has(nextKey)) continue;
      const cost = (g.get(key) ?? 0) + 1;
      if (cost < (g.get(nextKey) ?? Infinity)) {
        g.set(nextKey, cost);
        came.set(nextKey, cell);
        open.push({ cell: next, f: cost + heuristic(next) });
      }
    }
  }
  return [from, to];
}
