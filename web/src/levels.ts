import type { ActorStatus, ActorView, LevelView, OfficeView } from '../../server/src/office/types.ts';
import { STATUS_TEXT, TEXT } from './text.ts';

/**
 * Floors inside a building, on the page side: what to show (the whole
 * building or one floor), how a floor is labelled, what the room on it is
 * called, and what its slab says in the whole-building view.
 */

/** The whole building, or one of its floors. */
export type LevelChoice = 'all' | number;

/**
 * What to show: the remembered floor while the building still has it;
 * the whole building otherwise (no record, the whole building remembered,
 * or a floor that is gone).
 */
export function pickLevel(saved: LevelChoice | undefined, levels: LevelView[]): LevelChoice {
  if (typeof saved === 'number' && levels.some((l) => l.level === saved)) return saved;
  return 'all';
}

/** 5 → "5F"; the whole building → 「整棟」. */
export function levelTag(level: LevelChoice): string {
  return level === 'all' ? TEXT.allFloors : `${level}F`;
}

/** The room where the meeting room is on a one-floor office: the president's, the managers', or the team lead's. */
export function roomName(kind: LevelView['kind']): string {
  return kind === 'lobby' ? TEXT.roomPresident : kind === 'managers' ? TEXT.roomManagers : TEXT.roomLead;
}

const WORKING: ReadonlySet<ActorStatus> = new Set(['thinking', 'running', 'replying']);

export interface LevelSummary {
  groups: number;
  working: number;
  waiting: number;
  stuck: number;
  /** The slab edge: red when anyone is stuck, else orange when anyone waits. */
  alert?: 'stuck' | 'waiting';
  /** 「5F 工程組｜2 組｜工作中 1・等你 1」 */
  label: string;
}

/** What a floor's slab says in the whole-building view; counts main characters only, like the stats bar. */
export function levelSummary(view: OfficeView, building: string, level: number): LevelSummary {
  const floor = view.buildings.find((b) => b.name === building)?.levels.find((l) => l.level === level);
  const groups = view.groups.filter((g) => g.building === building && g.level === level);
  let working = 0;
  let waiting = 0;
  let stuck = 0;
  for (const group of groups) {
    const main = group.actors.find((a) => a.role === 'main');
    if (!main) continue;
    if (WORKING.has(main.status)) working += 1;
    if (main.status === 'waiting') waiting += 1;
    if (main.status === 'stuck') stuck += 1;
  }
  const alert = stuck > 0 ? 'stuck' : waiting > 0 ? 'waiting' : undefined;
  const label = TEXT.slabLabel(levelTag(level), floor?.name ?? '', groups.length, working, waiting);
  return { groups: groups.length, working, waiting, stuck, ...(alert ? { alert } : {}), label };
}

/** What a name plate says in the whole-building view: the status word only — never a tool, file or command. */
export function overviewTagText(actor: Pick<ActorView, 'status'>): string {
  return STATUS_TEXT[actor.status];
}
