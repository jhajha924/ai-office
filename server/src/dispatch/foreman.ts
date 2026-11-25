import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Department, DispatchSettings } from '../office/config.ts';
import { DEFAULT_WORKER } from '../office/config.ts';
import type { OfficeEvent, OfficeEventKind, Seat } from '../office/types.ts';
import { mainActorId } from '../office/types.ts';
import type { AgentRunner, CallUsage, Decision, DecisionKind, Dispatch, Project, RunResult } from './types.ts';
import { INVALID_REPLY, parseWorker, QA_CHOICES, QA_QUESTION, stopDepartment, workerRequest, type WorkerOutput } from './worker.ts';

/**
 * The foreman (組長) of cut ③b: a program, not an AI. It takes the oldest
 * started project off the queue, calls one worker per stop of its route,
 * writes a hand-off after each stop, sends 6F rejections back to 5F, turns a
 * worker's question into a decision and resumes the same session with the
 * answer. One project holds the work slot at a time — also while it waits for
 * the user — so progress is easy to follow and to budget.
 */

/** Calls per stop before the user is asked (the first try plus one retry). */
const TRIES = 2;
/** qa rejections before the user decides instead of an automatic redo. */
const REJECT_LIMIT = 3;
/** Questions in a row from one stop; one more is treated as a failure. */
const QUESTION_LIMIT = 5;
const LABEL_CHARS = 15;
export const ANSWER_MAX = 2000;

export const FOREMAN_MESSAGES = {
  badBody: '回答的格式不對',
  emptyAnswer: '回答不能是空的',
  longAnswer: `回答最多 ${ANSWER_MAX} 字`,
  requiredSkip: '必經站不能跳過',
  interrupted: '伺服器重開，執行中斷',
  notFound: '找不到這個專案，或它已經結束',
} as const;

export type ForemanReply = { ok: true } | { ok: false; status: number; message: string };

export interface ForemanDeps {
  settings: DispatchSettings;
  departments: () => readonly Department[];
  runner: AgentRunner;
  /** ~/.ai-office/projects; hand-offs go to <dispatch>/handoffs/. */
  projectsDir: string;
  dispatches: () => readonly Dispatch[];
  save: (dispatch: Dispatch) => void;
  /** Adds an open decision to the dispatch and returns it. */
  decide: (dispatch: Dispatch, kind: DecisionKind, summary: string, project: string, extra?: Partial<Decision>) => Decision;
  emit: (event: OfficeEvent) => void;
  setLabel: (sessionId: string, label: string) => void;
  now: () => number;
  newSession: () => string;
  /** Does this folder use speclink? Absent in demo mode: no check. */
  speclinkReady?: (cwd: string) => Promise<boolean>;
  /** Writes one hand-off file; absent in demo mode: nothing is written. */
  writeHandoff?: (file: string, text: string) => void;
}

const cut = (s: string, max: number): string => [...s].slice(0, max).join('');
const chars = (s: string): number => [...s].length;

function folderName(project: Project): string {
  return path.win32.basename(project.cwd.replace(/[\\/]+$/, '')) || project.cwd;
}

export class Foreman {
  private readonly deps: ForemanDeps;
  private work: Promise<void> = Promise.resolve();
  private driving = false;

  constructor(deps: ForemanDeps) {
    this.deps = deps;
  }

  /** Resolves when no worker call is in flight. */
  idle(): Promise<void> {
    return this.work;
  }

  /** The project holding the work slot (running or waiting for the user), if any. */
  current(): { dispatch: Dispatch; project: Project } | undefined {
    for (const dispatch of this.deps.dispatches()) {
      for (const project of dispatch.projects) {
        if (project.status === 'running' || project.status === 'waiting') return { dispatch, project };
      }
    }
    return undefined;
  }

  /** Queued projects in the order they will run. */
  queue(): { dispatch: Dispatch; project: Project }[] {
    const out: { dispatch: Dispatch; project: Project }[] = [];
    for (const dispatch of this.deps.dispatches()) {
      for (const project of dispatch.projects) if (project.status === 'queued') out.push({ dispatch, project });
    }
    return out.sort(
      (a, b) => (a.project.startedAt ?? a.dispatch.createdAt) - (b.project.startedAt ?? b.dispatch.createdAt) || a.project.id.localeCompare(b.project.id),
    );
  }

  /** Start working if the slot is free or the current project may go on. */
  drive(): void {
    if (this.driving) return;
    this.driving = true;
    this.work = (async () => {
      try {
        for (;;) {
          const next = this.pick();
          if (!next) break;
          while (next.project.status === 'running') await this.runStop(next.dispatch, next.project);
        }
      } catch {
        // A bug must not leave the slot spinning; the project stays as saved.
      } finally {
        this.driving = false;
      }
    })();
  }

  /** At start-up: a stop that was running when the server stopped waits for the user. */
  restore(): void {
    for (const dispatch of this.deps.dispatches()) {
      for (const project of dispatch.projects) {
        if (project.status !== 'running') continue;
        // A call that never returned may have left its session half-made: start a new one.
        if (project.sessionId && !project.sessionStarted) delete project.sessionId;
        project.resumeText = `${FOREMAN_MESSAGES.interrupted}：請從目前的狀態繼續這一站。`;
        this.stuck(dispatch, project, FOREMAN_MESSAGES.interrupted);
      }
    }
  }

  private pick(): { dispatch: Dispatch; project: Project } | undefined {
    const now = this.current();
    if (now) return now.project.status === 'running' ? now : undefined;
    const next = this.queue()[0];
    if (!next) return undefined;
    const { dispatch, project } = next;
    if (project.startedAt === undefined) {
      // Queued under ③a, where 開工 only meant "queue": ask before anyone edits code.
      project.status = 'waiting';
      this.deps.decide(dispatch, 'blocked', `「${project.title}」是派工引擎上線前排隊的專案：按重試開始執行，或停止專案`, project.id);
      this.deps.save(dispatch);
      return undefined;
    }
    project.status = 'running';
    project.stopIndex ??= 0;
    this.deps.save(dispatch);
    return next;
  }

  // ── one stop ─────────────────────────────────────────────────

  private async runStop(dispatch: Dispatch, project: Project): Promise<void> {
    const { deps } = this;
    if (project.kind === 'code' && !project.checked && deps.speclinkReady) {
      const ready = await deps.speclinkReady(project.cwd).catch(() => false);
      if (project.status !== 'running') return;
      if (!ready) {
        project.status = 'waiting';
        deps.decide(dispatch, 'blocked', `「${folderName(project)}」還沒有 speclink：請先在那個資料夾執行 speclink init，再按重試`, project.id);
        deps.save(dispatch);
        return;
      }
      project.checked = true;
    }
    const index = project.stopIndex ?? 0;
    if (index >= project.route.length) return this.finish(dispatch, project);

    const departments = deps.departments();
    const stop = project.route[index];
    const { department, theme } = stopDepartment(stop, departments);
    project.sessionId ??= deps.newSession();
    const session = project.sessionId;
    const seat = this.seatOf(project);
    if (theme === 'qa' && project.kind === 'code' && !project.qaMode) {
      // The user picks the check first; the worker waits on its floor meanwhile.
      project.status = 'waiting';
      deps.decide(dispatch, 'qa', QA_QUESTION, project.id, { options: QA_CHOICES.map((c) => c.label) });
      this.event(session, 'waiting', seat, deps.settings.models.worker ?? DEFAULT_WORKER.model);
      deps.setLabel(session, cut(`${project.title}・${department?.name ?? stop.id}`, LABEL_CHARS));
      deps.save(dispatch);
      return;
    }
    this.event(session, 'turn.start', seat, deps.settings.models.worker ?? DEFAULT_WORKER.model);
    deps.setLabel(session, cut(`${project.title}・${department?.name ?? stop.id}`, LABEL_CHARS));
    deps.save(dispatch);

    const request = workerRequest(project, stop, departments, deps.settings);
    let result: RunResult;
    try {
      result = await deps.runner.run(request);
    } catch {
      result = { ok: false, reason: '組員無法啟動' };
    }
    if (project.status !== 'running') return; // stopped meanwhile
    if (result.usage) project.sessionStarted = true;

    let checked: { ok: true; value: WorkerOutput } | { ok: false; reason: string } = result.ok ? parseWorker(result.output, theme) : result;
    if (checked.ok && checked.value.outcome === 'failed') checked = { ok: false, reason: '組員執行失敗' };
    if (checked.ok && checked.value.outcome === 'question' && (project.questionCount ?? 0) >= QUESTION_LIMIT) {
      checked = { ok: false, reason: INVALID_REPLY };
    }
    this.record(dispatch, project, stop.id, checked.ok ? undefined : checked.reason, result.usage);

    if (!checked.ok) {
      project.attempt = (project.attempt ?? 0) + 1;
      if (project.attempt < TRIES) {
        project.resumeText = `上一次執行失敗：${checked.reason}。請從目前的狀態繼續這一站。`;
        deps.save(dispatch);
        return;
      }
      this.event(session, 'turn.end', seat);
      this.stuck(dispatch, project, checked.reason);
      return;
    }

    const out = checked.value;
    project.attempt = 0;
    delete project.resumeText;
    project.notes.push(...out.notes);
    if (out.discussion) project.discussion = out.discussion;
    if (out.change) project.change = out.change;

    if (out.outcome === 'question') {
      project.questionCount = (project.questionCount ?? 0) + 1;
      project.status = 'waiting';
      deps.decide(dispatch, 'question', out.question!.text, project.id, { options: out.question!.options });
      this.event(session, 'waiting', seat);
      deps.save(dispatch);
      return;
    }

    this.handoff(dispatch, project, index, out, result.usage);
    this.event(session, 'turn.end', seat);
    if (out.outcome === 'done') {
      if (theme === 'build') delete project.findings;
      return this.moveTo(dispatch, project, index + 1);
    }
    // rejected (a qa stop)
    project.rejections = (project.rejections ?? 0) + 1;
    const build = this.buildBefore(project, index);
    if (project.rejections < REJECT_LIMIT && build >= 0) {
      project.findings = out.findings;
      return this.moveTo(dispatch, project, build);
    }
    project.status = 'waiting';
    const name = department ? `${department.floor}F` : stop.id;
    deps.decide(dispatch, 'rejected', `${name} 第 ${project.rejections} 次不合格：${out.findings![0]}`, project.id, { findings: out.findings });
    this.resetStop(project);
    deps.save(dispatch);
  }

  // ── answers ──────────────────────────────────────────────────

  /** A decision of kind question / stuck / rejected / blocked. */
  answer(dispatch: Dispatch, decision: Decision, body: unknown): ForemanReply {
    const project = dispatch.projects.find((p) => p.id === decision.project);
    if (!project || project.status !== 'waiting') return { ok: false, status: 404, message: FOREMAN_MESSAGES.notFound };
    const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const action = b.action;
    const bad: ForemanReply = { ok: false, status: 400, message: FOREMAN_MESSAGES.badBody };
    const index = project.stopIndex ?? 0;

    if (action === 'stop' && decision.kind !== 'question') {
      decision.status = 'answered';
      return this.stop(project.id);
    }
    switch (decision.kind) {
      case 'question': {
        if (action !== 'answer' || typeof b.text !== 'string') return bad;
        const text = b.text.trim();
        if (chars(text) < 1) return { ok: false, status: 400, message: FOREMAN_MESSAGES.emptyAnswer };
        if (chars(text) > ANSWER_MAX) return { ok: false, status: 400, message: FOREMAN_MESSAGES.longAnswer };
        project.resumeText = `使用者回答：${text}`;
        break;
      }
      case 'stuck': {
        if (action === 'retry') {
          project.attempt = 0;
          break;
        }
        if (action !== 'skip') return bad;
        if (project.route[index]?.required) return { ok: false, status: 400, message: FOREMAN_MESSAGES.requiredSkip };
        decision.status = 'answered';
        this.moveTo(dispatch, project, index + 1, false);
        return this.resume(dispatch, project);
      }
      case 'rejected': {
        if (action === 'redo') {
          decision.status = 'answered';
          project.rejections = 0;
          project.findings = decision.findings;
          const build = this.buildBefore(project, index);
          this.moveTo(dispatch, project, build >= 0 ? build : index, false);
          return this.resume(dispatch, project);
        }
        if (action !== 'accept') return bad;
        decision.status = 'answered';
        delete project.findings;
        this.moveTo(dispatch, project, index + 1, false);
        return this.resume(dispatch, project);
      }
      case 'qa': {
        const choice = QA_CHOICES.find((c) => c.mode === b.mode);
        if (action !== 'qa' || !choice) return bad;
        project.qaMode = choice.mode;
        break;
      }
      case 'blocked': {
        if (action !== 'retry') return bad;
        project.startedAt ??= this.deps.now();
        break;
      }
      default:
        return bad;
    }
    decision.status = 'answered';
    return this.resume(dispatch, project);
  }

  /** 停止專案: ends its worker, closes its decisions, frees the slot. */
  stop(projectId: string): ForemanReply {
    for (const dispatch of this.deps.dispatches()) {
      const project = dispatch.projects.find((p) => p.id === projectId);
      if (!project) continue;
      if (project.status !== 'queued' && project.status !== 'running' && project.status !== 'waiting') break;
      const session = project.sessionId;
      project.status = 'stopped';
      if (session) {
        this.deps.runner.cancel?.(session);
        this.event(session, 'turn.end', this.seatOf(project));
      }
      for (const q of dispatch.decisions) if (q.project === project.id && q.status === 'open') q.status = 'answered';
      this.deps.save(dispatch);
      this.drive();
      return { ok: true };
    }
    return { ok: false, status: 404, message: FOREMAN_MESSAGES.notFound };
  }

  // ── helpers ──────────────────────────────────────────────────

  private resume(dispatch: Dispatch, project: Project): ForemanReply {
    if (project.status === 'waiting') project.status = 'running';
    this.deps.save(dispatch);
    this.drive();
    return { ok: true };
  }

  private stuck(dispatch: Dispatch, project: Project, reason: string): void {
    const stop = project.route[project.stopIndex ?? 0];
    const { department } = stop ? stopDepartment(stop, this.deps.departments()) : {};
    const where = department ? `${department.floor}F ${department.name}` : (stop?.id ?? '');
    project.status = 'waiting';
    this.deps.decide(dispatch, 'stuck', `${where} 執行失敗：${reason}`, project.id);
    this.deps.save(dispatch);
  }

  /** Go to another stop (a fresh session); past the end the project is done. */
  private moveTo(dispatch: Dispatch, project: Project, index: number, run = true): void {
    project.stopIndex = index;
    this.resetStop(project);
    if (index >= project.route.length) {
      this.finish(dispatch, project);
      return;
    }
    if (run) this.deps.save(dispatch);
  }

  private resetStop(project: Project): void {
    delete project.sessionId;
    delete project.sessionStarted;
    delete project.resumeText;
    project.attempt = 0;
    project.questionCount = 0;
  }

  private finish(dispatch: Dispatch, project: Project): void {
    project.status = 'done';
    project.doneAt = this.deps.now();
    project.summary = (project.handoffNotes ?? []).map((n) => n.summary).filter(Boolean).join('；');
    this.resetStop(project);
    this.deps.save(dispatch);
  }

  /** The nearest build stop before index, or -1. */
  private buildBefore(project: Project, index: number): number {
    const departments = this.deps.departments();
    for (let i = index - 1; i >= 0; i--) if (stopDepartment(project.route[i], departments).theme === 'build') return i;
    return -1;
  }

  private handoff(dispatch: Dispatch, project: Project, index: number, out: WorkerOutput, usage: CallUsage | undefined): void {
    const stop = project.route[index];
    const notes = (project.handoffNotes ?? []).filter((n) => n.stop !== stop.id);
    notes.push({ stop: stop.id, summary: out.summary, handoff: out.handoff });
    project.handoffNotes = notes;
    project.handoffs = (project.handoffs ?? 0) + 1;
    const write = this.deps.writeHandoff;
    if (!write) return;
    const { department } = stopDepartment(stop, this.deps.departments());
    const file = path.join(this.deps.projectsDir, dispatch.id, 'handoffs', `${project.id}-${String(project.handoffs).padStart(2, '0')}-${stop.id}.md`);
    const lines = [
      `# ${department ? `${department.floor}F ${department.name}` : stop.id}：${project.title}`,
      '',
      `- 時間：${new Date(this.deps.now()).toISOString()}`,
      `- 結果：${out.outcome === 'done' ? '完成' : '不合格'}`,
      ...(usage ? [`- 用量：${usage.turns} 回合・${Math.round(usage.durationMs / 1000)} 秒`] : []),
      ...(project.change ? [`- change：${project.change}`] : []),
      '',
      '## 做了什麼',
      '',
      out.summary,
      '',
      '## 交接',
      '',
      out.handoff,
      ...(out.findings?.length ? ['', '## 不合格的理由', '', ...out.findings.map((f) => `- ${f}`)] : []),
      '',
    ];
    write(file, lines.join('\n'));
  }

  private record(dispatch: Dispatch, project: Project, stop: string, reason: string | undefined, usage?: CallUsage): void {
    dispatch.calls.push({
      role: 'worker',
      project: project.id,
      stop,
      at: this.deps.now(),
      ok: reason === undefined,
      ...(reason ? { reason } : {}),
      ...(usage ? { usage } : {}),
    });
  }

  private seatOf(project: Project): Seat {
    const stop = project.route[project.stopIndex ?? 0];
    const { department } = stop ? stopDepartment(stop, this.deps.departments()) : {};
    return { kind: 'station', level: department?.floor ?? 1 };
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
}

/** Hand-off files on disk; a failure is only a warning (dispatch.json stays the record). */
export function fileHandoffWriter(warn: (message: string) => void): (file: string, text: string) => void {
  return (file, text) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, 'utf-8');
    } catch (err) {
      warn(`[AI 辦公室] 交接單 ${path.basename(file)} 寫不進去（${(err as NodeJS.ErrnoException).code ?? '寫檔失敗'}）`);
    }
  };
}
