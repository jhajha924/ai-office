/**
 * The one seam of the office: every source (transcript observer, hook
 * receiver, demo script; later the dispatcher) only produces OfficeEvent, and
 * the browser only ever sees OfficeView. Nothing downstream of the store knows
 * where an event came from.
 */

export type OfficeEventKind =
  | 'turn.start'
  | 'thinking'
  | 'tool.start'
  | 'tool.end'
  | 'reply'
  | 'handoff.out'
  | 'handoff.back'
  | 'output.add'
  | 'turn.end'
  | 'waiting'
  | 'actor.join'
  | 'blocked'
  | 'progress';

export type OfficeEventSource = 'observe' | 'hook' | 'demo';

export interface OfficeEvent {
  kind: OfficeEventKind;
  source: OfficeEventSource;
  sessionId: string;
  /** `${sessionId}:main`, `${sessionId}:sub:${toolUseId}` or `${sessionId}:skill`. */
  actorId: string;
  cwd: string;
  tool?: string;
  /** Pairs a tool.start with its tool.end (and a handoff.out with its handoff.back). */
  toolUseId?: string;
  /** Unmasked detail (file path, command, subtask description). Server memory only. */
  detail?: string;
  /** e.g. claude-opus-5-5 */
  model?: string;
  subagentType?: string;
  skill?: string;
  /** progress only: tasks done / total of the change being worked on; absent = cannot tell. */
  progress?: Progress;
  /** Epoch milliseconds. */
  at: number;
}

export interface Progress {
  done: number;
  total: number;
}

export type ActorStatus =
  | 'idle-new'
  | 'thinking'
  | 'running'
  | 'replying'
  | 'done'
  | 'waiting'
  | 'idle'
  | 'dozing'
  | 'stuck';

export type ActorRole = 'main' | 'subagent' | 'skill';

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'other';

export interface ActorView {
  id: string;
  role: ActorRole;
  title: string;
  model: ModelFamily;
  status: ActorStatus;
  /** Chinese status text, already masked on a masked floor. */
  bubble: string;
  tool?: string;
  since: number;
  /** Name from the roster's name list, fixed per actor id. */
  name: string;
  /** Current task: group label (main), subtask description (sub-agent), skill title (skill employee). */
  task: string;
  /** Absent = no progress bar. */
  progress?: Progress | 'indeterminate';
  /** Main actor on an unmasked floor only: today's output files, newest first, at most 20. */
  outputs?: OutputRef[];
  /** Main actor only: today's distinct output files of the session. */
  outputCount?: number;
}

export interface OutputRef {
  /** Opaque id for GET /api/output/<token>; never a path. */
  token: string;
  name: string;
}

export interface GroupView {
  sessionId: string;
  floor: string;
  label: string;
  actors: ActorView[];
  lastActivity: number;
}

export interface FloorStats {
  working: number;
  outputs: number;
  waiting: number;
}

export interface FloorView {
  name: string;
  masked: boolean;
  stats: FloorStats;
}

export type FeedKind = 'done' | 'handoff' | 'return' | 'waiting';

export interface FeedEntryView {
  id: string;
  at: number;
  floor: string;
  kind: FeedKind;
  text: string;
}

export interface HandoffView {
  id: string;
  at: number;
  floor: string;
  /** Actor ids: main → sub-agent on a hand-off, sub-agent → main on a return. */
  from: string;
  to: string;
  label: string;
}

export interface OfficeView {
  floors: FloorView[];
  groups: GroupView[];
  /** Latest 30 activity entries, newest first. */
  feed: FeedEntryView[];
  /** Hand-offs and returns of the last 15 seconds. */
  handoffs: HandoffView[];
  generatedAt: number;
}

export const mainActorId = (sessionId: string): string => `${sessionId}:main`;
export const subActorId = (sessionId: string, toolUseId: string): string =>
  `${sessionId}:sub:${toolUseId}`;
export const skillActorId = (sessionId: string): string => `${sessionId}:skill`;
