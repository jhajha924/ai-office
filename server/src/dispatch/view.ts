import * as path from 'node:path';

import type { Department } from '../office/config.ts';
import type { DispatchPanelView, DispatchView, ProjectView } from '../office/types.ts';
import type { Dispatch, Project } from './types.ts';

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

function projectView(project: Project, departments: readonly Department[]): ProjectView {
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
  };
}

export function dispatchView(dispatch: Dispatch, departments: readonly Department[]): DispatchView {
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
    projects: dispatch.projects.map((p) => projectView(p, departments)),
    decisions: dispatch.decisions
      .filter((q) => q.status === 'open')
      .map((q) => ({ id: q.id, kind: q.kind, summary: q.summary, ...(q.project ? { project: q.project } : {}) })),
    usage,
  };
}

export interface PanelSource {
  status: DispatchPanelView['status'];
  building?: string;
  dispatches: readonly Dispatch[];
  active(): Dispatch | undefined;
}

export function panelView(source: PanelSource, departments: readonly Department[]): DispatchPanelView {
  if (source.status === 'off') return { status: 'off', recent: [] };
  const active = source.active();
  const recent = source.dispatches
    .filter((d) => d.status === 'done')
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    .slice(0, RECENT_SHOWN)
    .map((d) => dispatchView(d, departments));
  return {
    status: source.status,
    ...(source.building ? { building: source.building } : {}),
    ...(active ? { active: dispatchView(active, departments) } : {}),
    recent,
  };
}
