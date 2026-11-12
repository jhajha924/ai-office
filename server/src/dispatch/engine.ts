import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Department, DispatchSettings } from '../office/config.ts';
import type { OfficeEvent, OfficeEventKind, Seat } from '../office/types.ts';
import { mainActorId } from '../office/types.ts';
import type { DispatchStatus } from './cli.ts';
import { MANAGER_SCHEMA, managerPrompt, normalizeRoute } from './manager.ts';
import type { DispatchStorage } from './persist.ts';
import { checkPresident, PRESIDENT_SCHEMA, presidentPrompt } from './president.ts';
import type { AgentRequest, AgentRunner, CallUsage, Decision, Dispatch, Project, RunResult } from './types.ts';

/**
 * The dispatch engine of cut ③a: request → president → managers → the user
 * confirms each route. One request at a time; nothing runs after "開工" yet
 * (cut ③b). Every state change is saved and announced; the president and the
 * managers show up in the office through ordinary OfficeEvents.
 */

export const TEXT_MAX = 2000;
export const MANAGER_OFFICES = 6;
/** Calls per step before the user is asked (the first try plus one retry). */
const TRIES = 2;
const LABEL_CHARS = 15;
const UNFINISHED = new Set<Dispatch['status']>(['president', 'manager', 'confirm', 'failed']);

export const MESSAGES = {
  busy: '上一件交辦還沒處理完',
  empty: '交辦內容不能是空的',
  tooLong: `交辦內容最多 ${TEXT_MAX} 字`,
  badBody: '回答的格式不對',
  emptyRoute: '路線至少要有一站',
  foreignStop: '路線只能從經理排的站裡刪減',
  interrupted: '伺服器重開，呼叫中斷',
} as const;

export type EngineReply = { ok: true; id?: string } | { ok: false; status: number; message: string };

export interface EngineDeps {
  settings: DispatchSettings;
  status: DispatchStatus;
  departments: () => readonly Department[];
  runner: AgentRunner;
  /** ~/.ai-office/projects (or a test folder); dispatch directories live here. */
  projectsDir: string;
  /** Absent in demo mode: nothing is read or written. */
  storage?: DispatchStorage;
  /** OfficeEvents for the president and the managers. */
  emit: (event: OfficeEvent) => void;
  setLabel: (sessionId: string, label: string) => void;
  /** Manager offices someone sits in right now. */
  occupiedOffices: () => Set<number>;
  now: () => number;
  /** Creates a research project's output folder when it starts; absent in demo mode. */
  makeDir?: (dir: string) => void;
  isDir?: (dir: string) => boolean;
  onChange?: () => void;
}

const chars = (s: string): number => [...s].length;

export const presidentSession = (dispatchId: string): string => `dispatch-${dispatchId}-president`;
export const managerSession = (projectId: string): string => `dispatch-${projectId}-manager`;

function localDate(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export class DispatchEngine {
  readonly dispatches: Dispatch[] = [];
  private running: Promise<void> = Promise.resolve();
  private decisionSeq = 0;

  private readonly deps: EngineDeps;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    for (const loaded of deps.storage?.loadAll() ?? []) this.restore(loaded);
  }

  get status(): DispatchStatus {
    return this.deps.status;
  }

  get settings(): DispatchSettings {
    return this.deps.settings;
  }

  /** Resolves when the president / manager calls in flight are finished (tests, shutdown). */
  idle(): Promise<void> {
    return this.running;
  }

  active(): Dispatch | undefined {
    return this.dispatches.find((d) => UNFINISHED.has(d.status));
  }

  submit(rawText: unknown): EngineReply {
    if (this.deps.status === 'off') return { ok: false, status: 404, message: '找不到' };
    if (this.deps.status !== 'ready') return { ok: false, status: 503, message: '派工目前無法使用' };
    if (typeof rawText !== 'string') return { ok: false, status: 400, message: MESSAGES.empty };
    const text = rawText.trim();
    if (chars(text) < 1) return { ok: false, status: 400, message: MESSAGES.empty };
    if (chars(text) > TEXT_MAX) return { ok: false, status: 400, message: MESSAGES.tooLong };
    if (this.active()) return { ok: false, status: 409, message: MESSAGES.busy };

    const at = this.deps.now();
    const dispatch: Dispatch = {
      id: this.nextId(at),
      building: this.deps.settings.building,
      text,
      createdAt: at,
      status: 'president',
      projects: [],
      decisions: [],
      calls: [],
    };
    this.dispatches.push(dispatch);
    this.save(dispatch);
    this.pump(dispatch);
    return { ok: true, id: dispatch.id };
  }

  answer(decisionId: string, body: unknown): EngineReply {
    const found = this.findDecision(decisionId);
    if (!found) return { ok: false, status: 404, message: '找不到這件決策，或已經回答過了' };
    const { dispatch, decision } = found;
    const action = body && typeof body === 'object' ? (body as Record<string, unknown>).action : undefined;

    if (decision.kind === 'retry') {
      if (action === 'retry') {
        decision.status = 'answered';
        const step = dispatch.failedStep ?? { role: 'president' };
        dispatch.status = step.role === 'president' ? 'president' : 'manager';
        if (step.role === 'manager') dispatch.managerIndex = step.index;
        delete dispatch.failedStep;
        delete dispatch.error;
        this.save(dispatch);
        this.pump(dispatch);
        return { ok: true };
      }
      if (action === 'cancel') {
        decision.status = 'answered';
        this.cancelRest(dispatch);
        return { ok: true };
      }
      return { ok: false, status: 400, message: MESSAGES.badBody };
    }

    const project = dispatch.projects.find((p) => p.id === decision.project);
    if (!project) return { ok: false, status: 404, message: '找不到這件決策，或已經回答過了' };
    if (action === 'cancel') {
      decision.status = 'answered';
      project.status = 'cancelled';
      this.managerDone(dispatch, project);
      return { ok: true };
    }
    if (action !== 'start') return { ok: false, status: 400, message: MESSAGES.badBody };
    const route = (body as Record<string, unknown>).route;
    if (!Array.isArray(route) || !route.every((id) => typeof id === 'string')) {
      return { ok: false, status: 400, message: MESSAGES.badBody };
    }
    if (route.length === 0) return { ok: false, status: 400, message: MESSAGES.emptyRoute };
    const known = new Set(project.route.map((s) => s.id));
    if (!route.every((id) => known.has(id))) return { ok: false, status: 400, message: MESSAGES.foreignStop };
    const kept = new Set(route as string[]);
    const missing = project.route.find((s) => s.required && !kept.has(s.id));
    if (missing) {
      const d = this.deps.departments().find((x) => x.id === missing.id);
      return { ok: false, status: 400, message: `改程式的專案一定要經過 ${d ? `${d.floor}F ${d.name}` : missing.id}` };
    }
    decision.status = 'answered';
    project.route = project.route.filter((s) => kept.has(s.id));
    project.status = 'queued';
    if (project.kind === 'research') this.deps.makeDir?.(project.cwd);
    this.managerDone(dispatch, project);
    return { ok: true };
  }

  // ── the pipeline ──────────────────────────────────────────────

  private pump(dispatch: Dispatch): void {
    this.running = this.running.then(() => this.advance(dispatch)).catch(() => undefined);
  }

  private async advance(dispatch: Dispatch): Promise<void> {
    if (dispatch.status === 'president') {
      if (!(await this.runPresident(dispatch))) return;
    }
    while (dispatch.status === 'manager') {
      const index = dispatch.managerIndex ?? 0;
      if (index >= dispatch.projects.length) {
        dispatch.status = 'confirm';
        delete dispatch.managerIndex;
        this.finishIfDone(dispatch);
        this.save(dispatch);
        return;
      }
      if (dispatch.projects[index].status !== 'planning') {
        dispatch.managerIndex = index + 1;
        continue;
      }
      if (!(await this.runManager(dispatch, index))) return;
      dispatch.managerIndex = index + 1;
      this.save(dispatch);
    }
  }

  private async runPresident(dispatch: Dispatch): Promise<boolean> {
    const { settings } = this.deps;
    const session = presidentSession(dispatch.id);
    this.event(session, 'turn.start', { kind: 'president' }, settings.models.president);
    this.deps.setLabel(session, [...dispatch.text].slice(0, LABEL_CHARS).join(''));
    const dir = path.join(this.deps.projectsDir, dispatch.id);
    const request: AgentRequest = {
      role: 'president',
      model: settings.models.president,
      schema: PRESIDENT_SCHEMA,
      cwd: settings.workRoot,
      prompt: presidentPrompt(dispatch.text, this.deps.departments(), settings.workRoot),
      input: { role: 'president', text: dispatch.text },
    };
    const result = await this.call(dispatch, request, undefined, (output) => {
      const check = checkPresident(output, settings.workRoot, dir, this.deps.isDir);
      return check.ok ? { ok: true, value: check.projects } : check;
    });
    this.event(session, 'turn.end', { kind: 'president' });
    if (!result.ok) {
      this.fail(dispatch, { role: 'president' }, result.reason);
      return false;
    }
    dispatch.projects = result.value.map((p, i) => ({
      id: `${dispatch.id}-${i + 1}`,
      ...p,
      route: [],
      notes: [],
      risks: [],
      status: 'planning',
    }));
    dispatch.status = 'manager';
    dispatch.managerIndex = 0;
    this.save(dispatch);
    return true;
  }

  private async runManager(dispatch: Dispatch, index: number): Promise<boolean> {
    const { settings } = this.deps;
    const project = dispatch.projects[index];
    project.office ??= this.freeOffice(index);
    const seat: Seat = { kind: 'manager', office: project.office };
    const session = managerSession(project.id);
    this.event(session, 'turn.start', seat, settings.models.manager);
    this.deps.setLabel(session, project.title);
    this.save(dispatch);
    const departments = this.deps.departments();
    const request: AgentRequest = {
      role: 'manager',
      model: settings.models.manager,
      schema: MANAGER_SCHEMA,
      cwd: project.kind === 'code' ? project.cwd : settings.workRoot,
      prompt: managerPrompt(project, departments),
      input: { role: 'manager', title: project.title, kind: project.kind, brief: project.brief },
    };
    const result = await this.call(dispatch, request, project.id, (output) => {
      const check = normalizeRoute(output, project.kind, departments);
      return check.ok ? { ok: true, value: check } : check;
    });
    if (!result.ok) {
      this.event(session, 'turn.end', seat);
      this.fail(dispatch, { role: 'manager', index }, result.reason);
      return false;
    }
    project.route = result.value.route;
    project.notes = result.value.notes;
    project.risks = result.value.risks;
    project.status = 'confirm';
    dispatch.decisions.push(this.decision('confirm', `確認「${project.title}」的路線`, project.id));
    // The manager now waits for the user: 「等你」, and 1F's board lists it.
    this.event(session, 'waiting', seat);
    return true;
  }

  /** One step: up to TRIES calls; the check turns a structured output into a value or a reason. */
  private async call<T>(
    dispatch: Dispatch,
    request: AgentRequest,
    projectId: string | undefined,
    check: (output: Record<string, unknown>) => { ok: true; value: T } | { ok: false; reason: string },
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    let reason = '';
    for (let attempt = 0; attempt < TRIES; attempt++) {
      let result: RunResult;
      try {
        result = await this.deps.runner.run(request);
      } catch {
        result = { ok: false, reason: request.role === 'president' ? '總裁無法啟動' : '經理無法啟動' };
      }
      const checked = result.ok ? check(result.output) : result;
      this.record(dispatch, request.role, projectId, checked.ok ? undefined : checked.reason, result.usage);
      if (checked.ok) return checked;
      reason = checked.reason;
    }
    return { ok: false, reason };
  }

  // ── helpers ───────────────────────────────────────────────────

  private record(dispatch: Dispatch, role: 'president' | 'manager', project: string | undefined, reason: string | undefined, usage?: CallUsage): void {
    dispatch.calls.push({
      role,
      ...(project ? { project } : {}),
      at: this.deps.now(),
      ok: reason === undefined,
      ...(reason ? { reason } : {}),
      ...(usage ? { usage } : {}),
    });
    this.save(dispatch);
  }

  private fail(dispatch: Dispatch, step: NonNullable<Dispatch['failedStep']>, reason: string): void {
    dispatch.status = 'failed';
    dispatch.failedStep = step;
    dispatch.error = reason;
    dispatch.decisions.push(this.decision('retry', `交辦失敗：${reason}`));
    this.save(dispatch);
  }

  /** Cancel a failed dispatch: what was not confirmed yet is cancelled. */
  private cancelRest(dispatch: Dispatch): void {
    for (const project of dispatch.projects) {
      if (project.status === 'planning' || project.status === 'confirm') {
        if (project.status === 'confirm') this.event(managerSession(project.id), 'turn.end', this.seatOf(project));
        project.status = 'cancelled';
      }
    }
    for (const decision of dispatch.decisions) decision.status = 'answered';
    dispatch.status = 'done';
    delete dispatch.failedStep;
    delete dispatch.error;
    delete dispatch.managerIndex;
    this.save(dispatch);
  }

  private managerDone(dispatch: Dispatch, project: Project): void {
    this.event(managerSession(project.id), 'turn.end', this.seatOf(project));
    this.finishIfDone(dispatch);
    this.save(dispatch);
  }

  private finishIfDone(dispatch: Dispatch): void {
    if (dispatch.status !== 'confirm') return;
    if (dispatch.projects.every((p) => p.status === 'queued' || p.status === 'cancelled')) dispatch.status = 'done';
  }

  private seatOf(project: Project): Seat {
    return { kind: 'manager', office: project.office ?? 1 };
  }

  private freeOffice(index: number): number {
    const taken = this.deps.occupiedOffices();
    for (const d of this.dispatches) for (const p of d.projects) if (p.office && (p.status === 'planning' || p.status === 'confirm')) taken.add(p.office);
    for (let n = 1; n <= MANAGER_OFFICES; n++) if (!taken.has(n)) return n;
    return (index % MANAGER_OFFICES) + 1;
  }

  private decision(kind: Decision['kind'], summary: string, project?: string): Decision {
    return { id: `q${this.deps.now().toString(36)}${(++this.decisionSeq).toString(36)}`, kind, summary, status: 'open', ...(project ? { project } : {}) };
  }

  private findDecision(id: string): { dispatch: Dispatch; decision: Decision } | undefined {
    for (const dispatch of this.dispatches) {
      const decision = dispatch.decisions.find((q) => q.id === id && q.status === 'open');
      if (decision) return { dispatch, decision };
    }
    return undefined;
  }

  private event(sessionId: string, kind: OfficeEventKind, seat: Seat, model?: string): void {
    this.deps.emit({
      kind,
      source: 'dispatch',
      sessionId,
      actorId: mainActorId(sessionId),
      cwd: this.deps.settings.workRoot,
      seat,
      ...(model ? { model } : {}),
      at: this.deps.now(),
    });
  }

  private save(dispatch: Dispatch): void {
    this.deps.storage?.save(dispatch);
    this.deps.onChange?.();
  }

  private nextId(at: number): string {
    const day = localDate(at);
    let max = 0;
    for (const d of this.dispatches) {
      const m = /^d(\d{8})-(\d{3})$/.exec(d.id);
      if (m && m[1] === day) max = Math.max(max, Number(m[2]));
    }
    return `d${day}-${String(max + 1).padStart(3, '0')}`;
  }

  /** A record read at start-up: calls that were in flight are gone, so it asks to retry. */
  private restore(dispatch: Dispatch): void {
    this.dispatches.push(dispatch);
    if (dispatch.status === 'president' || dispatch.status === 'manager') {
      const step: NonNullable<Dispatch['failedStep']> =
        dispatch.status === 'president' ? { role: 'president' } : { role: 'manager', index: dispatch.managerIndex ?? 0 };
      this.fail(dispatch, step, MESSAGES.interrupted);
    }
  }
}

/** The real folder check and creation (not used in demo mode). */
export const realFs = {
  isDir: (dir: string): boolean => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
  makeDir: (dir: string): void => {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // The project still starts; the folder is made again when it is needed.
    }
  },
};
