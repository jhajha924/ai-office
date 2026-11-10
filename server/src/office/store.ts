import type { SessionHome } from './floorRouting.ts';
import type { FeedKind, OfficeEvent, Progress } from './types.ts';
import { mainActorId, skillActorId } from './types.ts';

/**
 * The state store: the only place OfficeEvents land. It keeps raw state —
 * unmasked details included — in memory only; the processing station
 * (view.ts) turns it into the OfficeView the browser is allowed to see.
 *
 * Time-based states (stuck, idle, dozing, a group leaving) are not stored:
 * they are derived from `since` / `lastActivity` whenever a view is built.
 */

export type BaseStatus = 'idle-new' | 'thinking' | 'running' | 'replying' | 'done';

export interface ActorState {
  id: string;
  role: 'main' | 'subagent' | 'skill';
  status: BaseStatus;
  since: number;
  tool?: string;
  detail?: string;
  model?: string;
  subagentType?: string;
  skill?: string;
}

/** How many distinct skills a group remembers (for its floor). */
export const SKILLS_KEPT = 20;

export interface GroupState {
  sessionId: string;
  cwd: string;
  label?: string;
  lastActivity: number;
  /** Main first, then sub-agents in arrival order, the skill employee last. */
  actors: Map<string, ActorState>;
  /** AskUserQuestion / ExitPlanMode calls still waiting for their tool_result. */
  pendingAsks: Set<string>;
  /** A hook said the session waits for the user; cleared by its next transcript event. */
  hookWaiting: boolean;
  /** The main session's tool calls still running (parallel calls end one by one). */
  openTools: Map<string, { tool?: string; detail?: string }>;
  /** Tasks done / total of the change the session works on; absent = cannot tell. */
  progress?: Progress;
  /** Skills the session used, oldest first, each once, at most SKILLS_KEPT. */
  skills: string[];
}

/**
 * One activity moment, raw: the processing station turns it into masked
 * feed text and hand-off arcs. Kept even after its group leaves.
 */
export interface FeedRecord {
  seq: number;
  at: number;
  kind: FeedKind;
  sessionId: string;
  /** The sub-agent for handoff / return; the main actor otherwise. */
  actorId: string;
  cwd: string;
  /** Group label at the time, in case the group has left by the time it is shown. */
  label?: string;
  subagentType?: string;
  /** Unmasked subtask description (handoff only). */
  detail?: string;
}

/** How many feed records the store keeps. */
export const FEED_KEEP = 100;

export interface OutputRecord {
  sessionId: string;
  cwd: string;
  path: string;
  at: number;
}

/** Tools whose open call means the session is waiting for the user's answer. */
const ASK_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

export class OfficeStore {
  readonly groups = new Map<string, GroupState>();
  outputs: OutputRecord[] = [];
  /** Where each session was started; decides its building. Kept after a group leaves. */
  readonly homes = new Map<string, SessionHome>();
  feed: FeedRecord[] = [];
  private feedSeq = 0;
  private listeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private ensureGroup(sessionId: string, cwd: string, at: number): GroupState {
    let group = this.groups.get(sessionId);
    if (!group) {
      const mainId = mainActorId(sessionId);
      group = {
        sessionId,
        cwd,
        lastActivity: at,
        actors: new Map([[mainId, { id: mainId, role: 'main', status: 'idle-new', since: at }]]),
        pendingAsks: new Set(),
        hookWaiting: false,
        openTools: new Map(),
        skills: [],
      };
      this.groups.set(sessionId, group);
    }
    return group;
  }

  /** Any transcript line counts as activity; a line with a cwd may bring a group in. */
  touch(sessionId: string, cwd: string | undefined, at: number): void {
    const group = cwd ? this.ensureGroup(sessionId, cwd, at) : this.groups.get(sessionId);
    if (!group) return;
    if (cwd) group.cwd = cwd;
    if (at > group.lastActivity) {
      group.lastActivity = at;
      this.changed();
    }
  }

  setHome(sessionId: string, home: SessionHome): void {
    const before = this.homes.get(sessionId);
    const next = { ...before, ...Object.fromEntries(Object.entries(home).filter(([, v]) => v)) };
    if (before?.cwd === next.cwd && before?.projectDir === next.projectDir) return;
    this.homes.set(sessionId, next);
    this.changed();
  }

  setLabel(sessionId: string, label: string): void {
    const group = this.groups.get(sessionId);
    if (!group || group.label === label) return;
    group.label = label;
    this.changed();
  }

  removeGroup(sessionId: string): void {
    if (this.groups.delete(sessionId)) this.changed();
  }

  /** Drop groups silent for `leaveMs` and outputs from before today. */
  prune(now: number, leaveMs: number): void {
    let removed = false;
    for (const [sessionId, group] of this.groups) {
      if (now - group.lastActivity >= leaveMs) {
        this.groups.delete(sessionId);
        removed = true;
      }
    }
    const today = startOfLocalDay(now);
    const before = this.outputs.length;
    this.outputs = this.outputs.filter((o) => o.at >= today);
    if (removed || this.outputs.length !== before) this.changed();
  }

  private record(group: GroupState, kind: FeedKind, at: number, extra: Partial<FeedRecord> = {}): void {
    this.feed.push({
      seq: ++this.feedSeq,
      at,
      kind,
      sessionId: group.sessionId,
      actorId: mainActorId(group.sessionId),
      cwd: group.cwd,
      label: group.label,
      ...extra,
    });
    if (this.feed.length > FEED_KEEP) this.feed.splice(0, this.feed.length - FEED_KEEP);
  }

  apply(event: OfficeEvent): void {
    const group = this.ensureGroup(event.sessionId, event.cwd, event.at);
    const wasWaiting = isWaiting(group);
    if (event.cwd) group.cwd = event.cwd;
    if (event.at > group.lastActivity) group.lastActivity = event.at;
    if (event.source !== 'hook') group.hookWaiting = false;

    const main = group.actors.get(mainActorId(event.sessionId))!;
    const skill = group.actors.get(skillActorId(event.sessionId));
    if (event.model && event.actorId === main.id) main.model = event.model;

    const set = (actor: ActorState, status: BaseStatus, tool?: string, detail?: string): void => {
      actor.status = status;
      actor.since = event.at;
      actor.tool = tool;
      actor.detail = detail;
    };
    const target = group.actors.get(event.actorId) ?? main;

    switch (event.kind) {
      case 'turn.start':
        group.pendingAsks.clear();
        group.openTools.clear();
        set(main, 'thinking');
        break;
      case 'thinking':
        set(target, 'thinking');
        break;
      case 'reply':
        set(target, 'replying');
        break;
      case 'tool.start':
        set(target, 'running', event.tool, event.detail);
        if (target === main && event.toolUseId) {
          group.openTools.set(event.toolUseId, { tool: event.tool, detail: event.detail });
        }
        if (event.tool && ASK_TOOLS.has(event.tool) && event.toolUseId) {
          group.pendingAsks.add(event.toolUseId);
        }
        if (skill && target === main && event.tool !== 'Skill') {
          set(skill, 'running', event.tool, event.detail);
        }
        break;
      case 'tool.end':
        if (event.toolUseId) {
          group.pendingAsks.delete(event.toolUseId);
          group.openTools.delete(event.toolUseId);
        }
        if (target === main && group.openTools.size > 0) {
          // Another parallel call is still running: stay at work on it.
          const [still] = [...group.openTools.values()].slice(-1);
          set(main, 'running', still.tool, still.detail);
          if (skill) set(skill, 'running', still.tool, still.detail);
          break;
        }
        set(target, 'thinking');
        if (skill && target === main) set(skill, 'thinking');
        break;
      case 'handoff.out':
        this.record(group, 'handoff', event.at, {
          actorId: event.actorId,
          subagentType: event.subagentType,
          detail: event.detail,
        });
        group.actors.set(event.actorId, {
          id: event.actorId,
          role: 'subagent',
          status: 'running',
          since: event.at,
          detail: event.detail,
          subagentType: event.subagentType,
          model: event.model,
        });
        break;
      case 'handoff.back': {
        const sub = group.actors.get(event.actorId);
        if (sub) this.record(group, 'return', event.at, { actorId: sub.id, subagentType: sub.subagentType });
        group.actors.delete(event.actorId);
        break;
      }
      case 'actor.join': {
        // One skill employee per session: the next Skill replaces it.
        const id = skillActorId(event.sessionId);
        group.actors.delete(id);
        group.actors.set(id, {
          id,
          role: 'skill',
          status: 'thinking',
          since: event.at,
          skill: event.skill,
          model: main.model,
        });
        break;
      }
      case 'output.add':
        if (event.detail) this.outputs.push({ sessionId: event.sessionId, cwd: event.cwd, path: event.detail, at: event.at });
        break;
      case 'turn.end':
        group.pendingAsks.clear();
        group.openTools.clear();
        set(main, 'done');
        for (const [id, actor] of group.actors) if (actor.role !== 'main') group.actors.delete(id);
        this.record(group, 'done', event.at);
        break;
      case 'waiting':
        group.hookWaiting = true;
        break;
      case 'progress':
        group.progress = event.progress && event.progress.total > 0 ? event.progress : undefined;
        break;
      case 'skill.use':
        if (event.skill) {
          group.skills = [...group.skills.filter((s) => s !== event.skill), event.skill].slice(-SKILLS_KEPT);
        }
        break;
      case 'blocked':
        break;
    }
    // One record per stretch of waiting: only the moment it starts.
    if (!wasWaiting && isWaiting(group)) this.record(group, 'waiting', event.at);
    this.changed();
  }
}

/** The session waits for the user: an unanswered question, or a hook's permission prompt. */
export function isWaiting(group: GroupState): boolean {
  return group.pendingAsks.size > 0 || group.hookWaiting;
}

/** Epoch ms of local midnight on the day of `now`. */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
