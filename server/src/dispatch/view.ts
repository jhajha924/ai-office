import * as path from 'node:path';

import type { Department } from '../office/config.ts';
import type { DecisionView, DispatchPanelView, DispatchView, ProjectView, WorkView } from '../office/types.ts';
import type { Decision, Dispatch, Project } from './types.ts';

/**
 * Turns the server-side dispatch state into what the browser may see: no
 * cwd, no work root — a folder shows as its last segment only.
 */

export const RECENT_SHOWN = 5;
export const RESEARCH_FOLDER = '產出資料夾';

function folderName(project: Project): string {
  if (project.kind === 'research') return RESEARCH_FOLDER;
  return path.win32.basename(project.cwd.replace(/[\\/]+$/, '')) || RESEARCH_FOLDER;
}

const SUMMARY_SHOWN = 100;

function stopAt(project: Project, departments: readonly Department[]): { level: number; name: string } | undefined {
  const stop = project.route[project.stopIndex ?? 0];
  if (!stop) return undefined;
  const d = departments.find((x) => x.id === stop.id);
  return { level: d?.floor ?? 0, name: d?.name ?? stop.id };
}

function decisionView(q: Decision): DecisionView {
  return {
    id: q.id,
    kind: q.kind,
    summary: q.summary,
    ...(q.project ? { project: q.project } : {}),
    ...(q.options ? { options: [...q.options] } : {}),
    ...(q.findings ? { findings: [...q.findings] } : {}),
  };
}

function projectView(project: Project, departments: readonly Department[], ahead?: Map<string, number>): ProjectView {
  const at = project.status === 'running' ? stopAt(project, departments) : undefined;
  return {
    id: project.id,
    title: project.title,
    kind: project.kind,
    folder: folderName(project),
    route: project.route.map((stop) => {
      const d = departments.find((x) => x.id === stop.id);
      return { id: stop.id, level: d?.floor ?? 0, name: d?.name ?? stop.id, doneWhen: stop.doneWhen, required: stop.required };
    }),
    notes: [...project.notes],
    risks: [...project.risks],
    status: project.status,
    ...(project.status === 'queued' && ahead?.has(project.id) ? { ahead: ahead.get(project.id)! } : {}),
    ...(at ? { at } : {}),
    ...(project.status === 'done' && project.summary ? { summary: [...project.summary].slice(0, SUMMARY_SHOWN).join('') } : {}),
  };
}

export function dispatchView(dispatch: Dispatch, departments: readonly Department[], ahead?: Map<string, number>): DispatchView {
  const usage = { turns: 0, durationMs: 0 };
  for (const call of dispatch.calls) {
    usage.turns += call.usage?.turns ?? 0;
    usage.durationMs += call.usage?.durationMs ?? 0;
  }
  return {
    id: dispatch.id,
    text: dispatch.text,
    status: dispatch.status,
    ...(dispatch.status === 'manager'
      ? { step: { index: Math.min((dispatch.managerIndex ?? 0) + 1, dispatch.projects.length), total: dispatch.projects.length } }
      : {}),
    ...(dispatch.status === 'failed' && dispatch.error ? { error: dispatch.error } : {}),
    projects: dispatch.projects.map((p) => projectView(p, departments, ahead)),
    // Planning decisions only; a running project's decisions travel in WorkView.
    decisions: dispatch.decisions.filter((q) => q.status === 'open' && (q.kind === 'confirm' || q.kind === 'retry')).map(decisionView),
    usage,
  };
}

export interface PanelSource {
  status: DispatchPanelView['status'];
  building?: string;
  dispatches: readonly Dispatch[];
  active(): Dispatch | undefined;
  /** cut ③b: the project holding the work slot, and the queue behind it. */
  current?(): { dispatch: Dispatch; project: Project } | undefined;
  queue?(): { dispatch: Dispatch; project: Project }[];
}

function workView(dispatch: Dispatch, project: Project, departments: readonly Department[]): WorkView {
  const index = project.stopIndex ?? 0;
  const stop = project.route[Math.min(index, project.route.length - 1)];
  const d = departments.find((x) => x.id === stop?.id);
  return {
    dispatch: dispatch.id,
    project: project.id,
    title: project.title,
    status: project.status === 'waiting' ? 'waiting' : 'running',
    stop: {
      index: Math.min(index + 1, project.route.length),
      total: project.route.length,
      level: d?.floor ?? 0,
      name: d?.name ?? stop?.id ?? '',
      required: stop?.required ?? false,
    },
    rejections: project.rejections ?? 0,
    decisions: dispatch.decisions.filter((q) => q.status === 'open' && q.project === project.id && q.kind !== 'confirm' && q.kind !== 'retry').map(decisionView),
  };
}

export function panelView(source: PanelSource, departments: readonly Department[]): DispatchPanelView {
  if (source.status === 'off') return { status: 'off', recent: [] };
  const active = source.active();
  const queue = source.queue?.() ?? [];
  const ahead = new Map(queue.map((q, i) => [q.project.id, i + (source.current?.() ? 1 : 0)]));
  const current = source.current?.();
  const recent = source.dispatches
    .filter((d) => d.status === 'done')
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    .slice(0, RECENT_SHOWN)
    .map((d) => dispatchView(d, departments, ahead));
  return {
    status: source.status,
    ...(source.building ? { building: source.building } : {}),
    ...(active ? { active: dispatchView(active, departments, ahead) } : {}),
    recent,
    ...(current ? { work: workView(current.dispatch, current.project, departments) } : {}),
    ...(queue.length > 0 ? { queued: queue.length } : {}),
  };
}
