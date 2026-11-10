import type { ActorStatus, GroupView, OfficeView } from '../../server/src/office/types.ts';
import type { LevelChoice } from './levels.ts';
import { levelTag } from './levels.ts';
import { TEXT } from './text.ts';

/**
 * The HTML around the office: building tabs with their waiting counts, the stats
 * bar of the building on screen, and the sidebar sorting groups into
 * 需要你 / 工作中 / 已完成.
 */

const NEEDS_YOU: ReadonlySet<ActorStatus> = new Set(['waiting', 'stuck']);
const WORKING: ReadonlySet<ActorStatus> = new Set(['thinking', 'running', 'replying']);

export type Column = 'needs' | 'working' | 'done';

export function columnOf(group: GroupView): Column {
  const main = group.actors.find((a) => a.role === 'main') ?? group.actors[0];
  if (main && NEEDS_YOU.has(main.status)) return 'needs';
  if (main && WORKING.has(main.status)) return 'working';
  return 'done';
}

/**
 * The building to show: the remembered one while it still exists, otherwise the
 * first building of the list (the config file may have changed since).
 */
export function pickBuilding(saved: string | undefined, buildings: string[]): string {
  if (saved !== undefined && buildings.includes(saved)) return saved;
  return buildings[0] ?? saved ?? '';
}

/** Tabs are only worth showing when there is more than one building. */
export function showTabs(buildings: string[]): boolean {
  return buildings.length > 1;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export interface UiHandlers {
  onBuilding(building: string): void;
  onLevel(level: LevelChoice): void;
  onGroup(sessionId: string): void;
}

export class Ui {
  private readonly tabs = document.getElementById('tabs')!;
  private readonly levels = document.getElementById('levels')!;
  private readonly stats = document.getElementById('stats')!;
  private readonly columns = {
    needs: document.getElementById('col-needs')!,
    working: document.getElementById('col-working')!,
    done: document.getElementById('col-done')!,
  };
  private readonly overflowNote = document.getElementById('overflow')!;
  private readonly empty = document.getElementById('empty')!;
  private readonly offline = document.getElementById('offline')!;
  private readonly handlers: UiHandlers;

  constructor(handlers: UiHandlers) {
    this.handlers = handlers;
  }

  setOnline(online: boolean): void {
    this.offline.hidden = online;
  }

  render(view: OfficeView, building: string, level: LevelChoice, overflow: string[]): void {
    this.tabs.hidden = !showTabs(view.buildings.map((f) => f.name));
    this.tabs.replaceChildren(
      ...view.buildings.map((f) => {
        const tab = el('button', f.name === building ? 'tab active' : 'tab', f.name);
        tab.type = 'button';
        tab.dataset.building = f.name;
        const badge = el('span', f.stats.waiting > 0 ? 'badge alert' : 'badge', String(f.stats.waiting));
        badge.title = TEXT.waitingBadge;
        tab.append(badge);
        tab.addEventListener('click', () => this.handlers.onBuilding(f.name));
        return tab;
      }),
    );

    // The whole building first, then the floors, top floor first, each with the number of groups on it.
    const levels = view.buildings.find((f) => f.name === building)?.levels ?? [];
    const all = el('button', level === 'all' ? 'level all active' : 'level all');
    all.type = 'button';
    all.dataset.level = 'all';
    all.append(el('span', 'level-tag', levelTag('all')), el('span', 'level-name', ''), el('span', 'level-count', String(levels.reduce((n, l) => n + l.groups, 0))));
    all.addEventListener('click', () => this.handlers.onLevel('all'));
    this.levels.replaceChildren(
      all,
      ...[...levels].reverse().map((l) => {
        const button = el('button', l.level === level ? 'level active' : 'level');
        button.type = 'button';
        button.dataset.level = String(l.level);
        button.append(
          el('span', 'level-tag', levelTag(l.level)),
          el('span', 'level-name', l.name),
          el('span', l.groups > 0 ? 'level-count busy' : 'level-count', String(l.groups)),
        );
        button.title = TEXT.levelButton(levelTag(l.level), l.name);
        button.addEventListener('click', () => this.handlers.onLevel(l.level));
        return button;
      }),
    );

    const stats = view.buildings.find((f) => f.name === building)?.stats ?? { working: 0, outputs: 0, waiting: 0 };
    this.stats.replaceChildren(
      el('span', 'stat', TEXT.statWorking(stats.working)),
      el('span', 'dot', '·'),
      el('span', 'stat', TEXT.statOutputs(stats.outputs)),
      el('span', 'dot', '·'),
      el('span', stats.waiting > 0 ? 'stat alert' : 'stat', TEXT.statWaiting(stats.waiting)),
    );

    const groups = view.groups.filter((g) => g.building === building);
    const unseated = new Set(overflow);
    for (const column of Object.values(this.columns)) column.querySelector('ul')!.replaceChildren();
    for (const group of groups) {
      const main = group.actors.find((a) => a.role === 'main') ?? group.actors[0];
      const row = el('li', `row status-${main?.status ?? 'idle'}`);
      row.dataset.session = group.sessionId;
      const label = el('div', 'row-label');
      label.append(el('span', group.level === level ? 'row-level here' : 'row-level', levelTag(group.level)), group.label);
      row.append(label, el('div', 'row-bubble', main?.bubble ?? ''));
      if (unseated.has(group.sessionId)) row.append(el('div', 'row-note', TEXT.unseated));
      row.addEventListener('click', () => this.handlers.onGroup(group.sessionId));
      this.columns[columnOf(group)].querySelector('ul')!.append(row);
    }
    for (const [name, column] of Object.entries(this.columns)) {
      const count = column.querySelector('ul')!.children.length;
      column.querySelector('.count')!.textContent = String(count);
      column.classList.toggle('empty-col', count === 0 && name !== 'needs');
    }

    this.overflowNote.hidden = overflow.length === 0;
    this.overflowNote.textContent = TEXT.overflow(overflow.length);
    this.empty.hidden = groups.length > 0;
  }
}
