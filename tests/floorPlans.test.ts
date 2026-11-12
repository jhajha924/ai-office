import { describe, expect, it } from 'vitest';

import { roomName } from '../web/src/levels.ts';
import { blockedCells, fixedSeat, isBlocking, onGrid, PLANS, targetsOf } from '../web/src/scene/floorPlans.ts';
import { cellKey, DOOR, ELEVATOR } from '../web/src/scene/layout.ts';
import { findPath } from '../web/src/scene/pathfinding.ts';

const plans = Object.values(PLANS);

describe('floor plans', () => {
  // office-building-floors spec, Example: 樓面骨架
  it.each([
    ['lobby', 8, '總裁室', 'warBoard'],
    ['managers', 0, '主管會議室', 'glassOffice'],
    ['analysis', 12, '組長室', 'stickyWall'],
    ['spec', 12, '組長室', 'kanban'],
    ['build', 12, '組長室', 'monitorWall'],
    ['qa', 12, '組長室', 'resultBoard'],
    ['release', 12, '組長室', 'countdown'],
  ] as const)('%s: %i pods, room A named %s, back wall %s', (theme, pods, room, equipment) => {
    const plan = PLANS[theme];
    expect(plan.theme).toBe(theme);
    expect(plan.pods).toHaveLength(pods);
    expect(plan.podOrder).toHaveLength(pods);
    expect(plan.zones.find((z) => z.room)?.name).toBe(room);
    expect(plan.props.some((p) => p.kind === equipment)).toBe(true);
    const kind = theme === 'lobby' ? 'lobby' : theme === 'managers' ? 'managers' : 'department';
    expect(roomName(kind)).toBe(room);
  });

  // office-building-floors spec, Scenario: 2F 經理室
  it('gives the managers six glass offices, 經理室 1 to 6', () => {
    const offices = PLANS.managers.props.filter((p) => p.kind === 'glassOffice');
    expect(offices.map((o) => o.text)).toEqual(['經理室 1', '經理室 2', '經理室 3', '經理室 4', '經理室 5', '經理室 6']);
  });

  // office-dispatch spec「總裁與經理坐在自己的位置」: the chairs are on the walkable, reachable targets above.
  it('gives the president a chair on 1F and each of the six managers one on 2F', () => {
    const president = PLANS.lobby.presidentSeat!;
    expect(president).toEqual({ x: 19, z: 1, facing: 'south' });
    expect(targetsOf(PLANS.lobby)).toContainEqual(president);
    const seats = PLANS.managers.managerSeats!;
    expect(seats).toHaveLength(6);
    expect(new Set(seats.map(cellKey)).size).toBe(6);
    for (const seat of seats) expect(targetsOf(PLANS.managers)).toContainEqual(seat);
    // Each chair is inside its own glass office.
    const offices = PLANS.managers.props.filter((p) => p.kind === 'glassOffice');
    seats.forEach((s, i) => {
      const o = offices[i];
      expect(s.x >= o.x && s.x < o.x + o.w && s.z >= o.z && s.z < o.z + o.d, `經理室 ${i + 1}`).toBe(true);
    });
  });

  it('finds the chair of a dispatch seat (fixedSeat)', () => {
    expect(fixedSeat(PLANS.lobby, { kind: 'president' })).toEqual(PLANS.lobby.presidentSeat);
    expect(fixedSeat(PLANS.managers, { kind: 'manager', office: 3 })).toEqual(PLANS.managers.managerSeats![2]);
    expect(fixedSeat(PLANS.managers, { kind: 'manager', office: 7 })).toBeUndefined();
    expect(fixedSeat(PLANS.build, { kind: 'president' })).toBeUndefined();
  });

  it.each(plans)('$theme keeps the door, the elevator, every seat and point of interest walkable and connected', (plan) => {
    const blocked = blockedCells(plan);
    for (const cell of [DOOR, ELEVATOR, ...targetsOf(plan)]) {
      expect(onGrid(cell), cellKey(cell)).toBe(true);
      expect(blocked.has(cellKey(cell)), `${plan.theme} ${cellKey(cell)}`).toBe(false);
    }
    for (const target of [DOOR, ...targetsOf(plan)]) {
      for (const from of [ELEVATOR, DOOR]) {
        const path = findPath(from, target, blocked);
        expect(path[path.length - 1], `${plan.theme} ${cellKey(from)} → ${cellKey(target)}`).toEqual({ x: target.x, z: target.z });
        for (let i = 1; i < path.length; i++) {
          expect(Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].z - path[i - 1].z)).toBe(1);
        }
      }
    }
  });

  it.each(plans)('$theme keeps furniture and equipment on the grid and has at least 4 points of interest', (plan) => {
    for (const f of plan.furniture) {
      expect(f.x >= 0 && f.x + f.w <= 24 && f.z >= 0 && f.z + f.d <= 16, `${plan.theme} ${f.model} ${f.x},${f.z}`).toBe(true);
    }
    for (const p of plan.props) {
      expect(p.x >= 0 && p.x + p.w <= 24 && p.z >= 0 && p.z + p.d <= 16, `${plan.theme} ${p.kind}`).toBe(true);
    }
    expect(plan.pois.length).toBeGreaterThanOrEqual(4);
    expect(new Set(plan.pois.map(cellKey)).size).toBe(plan.pois.length);
  });

  it('makes all seven floors different from each other', () => {
    const looks = plans.map((p) =>
      JSON.stringify({ furniture: p.furniture.map((f) => [f.model, f.x, f.z]), props: p.props.map((x) => [x.kind, x.x, x.z]), kit: p.deskKit, colors: p.zones.map((z) => z.color) }),
    );
    expect(new Set(looks).size).toBe(7);
    expect(new Set(plans.map((p) => p.accent)).size).toBe(7);
  });

  it('blocks the cells of standing equipment, not of boards on the wall', () => {
    const build = PLANS.build;
    const blocked = blockedCells(build);
    const rack = build.props.find((p) => p.kind === 'rack')!;
    expect(isBlocking(rack)).toBe(true);
    expect(blocked.has(cellKey(rack))).toBe(true);
    expect(isBlocking(build.props.find((p) => p.kind === 'monitorWall')!)).toBe(false);
  });
});
