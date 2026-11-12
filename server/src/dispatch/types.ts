/**
 * Dispatch (交辦) state, server side. This is the full state — cwd included —
 * kept in memory and in ~/.ai-office/projects/<id>/dispatch.json; the browser
 * only ever sees the DispatchPanelView built from it (no full paths).
 */

export type DispatchState = 'president' | 'manager' | 'confirm' | 'failed' | 'done';
export type ProjectKind = 'code' | 'research';
export type ProjectStatus = 'planning' | 'confirm' | 'queued' | 'cancelled';

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
}

export interface Decision {
  id: string;
  kind: 'confirm' | 'retry';
  /** Project id (confirm only). */
  project?: string;
  summary: string;
  status: 'open' | 'answered';
}

/** One claude call, for the usage record. */
export interface CallRecord {
  role: 'president' | 'manager';
  project?: string;
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

/** What a runner gets for one president or manager call. */
export interface AgentRequest {
  role: 'president' | 'manager';
  model: string;
  /** JSON Schema of the structured output. */
  schema: object;
  cwd: string;
  /** Sent on stdin. */
  prompt: string;
  /** The structured input the prompt was made from (the demo runner answers from it). */
  input:
    | { role: 'president'; text: string }
    | { role: 'manager'; title: string; kind: ProjectKind; brief: string };
}

export type RunResult =
  | { ok: true; output: Record<string, unknown>; usage: CallUsage }
  | { ok: false; reason: string; usage?: CallUsage };

export interface AgentRunner {
  run(request: AgentRequest): Promise<RunResult>;
}
