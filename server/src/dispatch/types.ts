/**
 * Dispatch (交辦) state, server side. This is the full state — cwd included —
 * kept in memory and in ~/.ai-office/projects/<id>/dispatch.json; the browser
 * only ever sees the DispatchPanelView built from it (no full paths).
 */

export type DispatchState = 'president' | 'manager' | 'confirm' | 'failed' | 'done';
export type ProjectKind = 'code' | 'research';
export type ProjectStatus = 'planning' | 'confirm' | 'queued' | 'cancelled' | 'running' | 'waiting' | 'done' | 'stopped';

export interface RouteStop {
  /** Department id. */
  id: string;
  doneWhen: string;
  /** Cannot be removed when confirming (the qa stop of a code project). */
  required: boolean;
}

export interface Project {
  id: string;
  title: string;
  kind: ProjectKind;
  /** Absolute folder; for research it is the output folder under the dispatch's own directory. */
  cwd: string;
  brief: string;
  route: RouteStop[];
  notes: string[];
  risks: string[];
  status: ProjectStatus;
  /** 2F office number of its manager (1..6), once the manager was called. */
  office?: number;

  // ── execution (cut ③b) ──
  /** When the user pressed 開工 under ③b; absent on projects queued in ③a. */
  startedAt?: number;
  /** Index into route of the stop at work (or next to work). */
  stopIndex?: number;
  /** qa stops that came back rejected since the last reset. */
  rejections?: number;
  /** questions in a row from the current stop. */
  questionCount?: number;
  /** claude session of the current stop. */
  sessionId?: string;
  /** The current stop's session exists (a call produced a result), so the next call resumes it. */
  sessionStarted?: boolean;
  /** Failed calls of the current stop in a row. */
  attempt?: number;
  /** What the next call of the current stop says instead of the station task (an answer, a failure note). */
  resumeText?: string;
  /** qa findings handed to the build stop that redoes the work. */
  findings?: string[];
  /** The speclink discussion slug from the analysis stop, and the change from the spec stop. */
  discussion?: string;
  change?: string;
  /** The check the qa stop runs, chosen by the user. */
  qaMode?: QaMode;
  /** The speclink check passed (code projects, once). */
  checked?: boolean;
  /** Hand-off files written so far (their sequence number). */
  handoffs?: number;
  /** Last hand-off of every stop id, for the next stops' prompts. */
  handoffNotes?: { stop: string; summary: string; handoff: string }[];
  summary?: string;
  doneAt?: number;
}

export type DecisionKind = 'confirm' | 'retry' | 'question' | 'stuck' | 'rejected' | 'blocked' | 'qa';

/** Which speclink check the qa stop runs; the user picks it the first time (cut ③b). */
export type QaMode = 'review' | 'verify' | 'both';

export interface Decision {
  id: string;
  kind: DecisionKind;
  /** Project id (confirm only). */
  project?: string;
  summary: string;
  status: 'open' | 'answered';
  /** question: the worker's suggested answers (0..4). */
  options?: string[];
  /** rejected: the qa findings. */
  findings?: string[];
}

/** One claude call, for the usage record. */
export interface CallRecord {
  role: AgentRole;
  project?: string;
  /** worker: the stop's department id. */
  stop?: string;
  at: number;
  ok: boolean;
  reason?: string;
  usage?: CallUsage;
}

export interface CallUsage {
  turns: number;
  durationMs: number;
  /** As reported by the CLI (input/output/cache tokens). */
  tokens?: Record<string, unknown>;
  /** The CLI's priced estimate; a subscription is not charged this. */
  costUsd?: number;
}

export interface Dispatch {
  id: string;
  building: string;
  text: string;
  createdAt: number;
  status: DispatchState;
  /** manager: index of the project whose manager runs (0-based). */
  managerIndex?: number;
  /** failed: which step to retry. */
  failedStep?: { role: 'president' } | { role: 'manager'; index: number };
  error?: string;
  projects: Project[];
  decisions: Decision[];
  calls: CallRecord[];
}

export type AgentRole = 'president' | 'manager' | 'worker';

/** What a runner gets for one president, manager or worker call. */
export interface AgentRequest {
  role: AgentRole;
  model: string;
  /** JSON Schema of the structured output. */
  schema: object;
  cwd: string;
  /** Sent on stdin. */
  prompt: string;
  /** The structured input the prompt was made from (the demo runner answers from it). */
  input:
    | { role: 'president'; text: string }
    | { role: 'manager'; title: string; kind: ProjectKind; brief: string }
    | { role: 'worker'; theme: string; kind: ProjectKind; title: string; resumed: boolean };
  /** worker: allowed tools (comma list); others get the read-only set. */
  tools?: string;
  /** worker: the claude session; with resume the call continues it instead of starting it. */
  sessionId?: string;
  resume?: boolean;
  maxTurns?: number;
  timeoutMs?: number;
}

export type RunResult =
  | { ok: true; output: Record<string, unknown>; usage: CallUsage }
  | { ok: false; reason: string; usage?: CallUsage };

export interface AgentRunner {
  run(request: AgentRequest): Promise<RunResult>;
  /** Ends the call running under this session, if any (停止專案). */
  cancel?(sessionId: string): void;
}
