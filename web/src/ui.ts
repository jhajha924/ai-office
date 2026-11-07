import type { ActorStatus, GroupView, OfficeView } from '../../server/src/office/types.ts';
import { TEXT } from './text.ts';

/**
 * The HTML around the office: floor tabs with their waiting counts, the stats
 * bar of the floor on screen, and the sidebar sorting groups into
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
 * The floor to show: the remembered one while it still exists, otherwise the
 * first floor of the list (the config file may have changed since).
 */
export function pickFloor(saved: string | undefined, floors: string[]): string {
  if (saved !== undefined && floors.includes(saved)) return saved;
  return floors[0] ?? saved ?? '';
}

/** Tabs are only worth showing when there is more than one floor. */
export function showTabs(floors: string[]): boolean {
  return floors.length > 1;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export interface UiHandlers {
  onFloor(floor: string): void;
  onGroup(sessionId: string): void;
}

export class Ui {
  private readonly tabs = document.getElementById('tabs')!;
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

  render(view: OfficeView, floor: string, overflow: string[]): void {
    this.tabs.hidden = !showTabs(view.floors.map((f) => f.name));
    this.tabs.replaceChildren(
      ...view.floors.map((f) => {
        const tab = el('button', f.name === floor ? 'tab active' : 'tab', f.name);
        tab.type = 'button';
        tab.dataset.floor = f.name;
        const badge = el('span', f.stats.waiting > 0 ? 'badge alert' : 'badge', String(f.stats.waiting));
        badge.title = TEXT.waitingBadge;
        tab.append(badge);
        tab.addEventListener('click', () => this.handlers.onFloor(f.name));
        return tab;
      }),
    );

    const stats = view.floors.find((f) => f.name === floor)?.stats ?? { working: 0, outputs: 0, waiting: 0 };
    this.stats.replaceChildren(
      el('span', 'stat', TEXT.statWorking(stats.working)),
      el('span', 'dot', '·'),
      el('span', 'stat', TEXT.statOutputs(stats.outputs)),
      el('span', 'dot', '·'),
      el('span', stats.waiting > 0 ? 'stat alert' : 'stat', TEXT.statWaiting(stats.waiting)),
    );

    const groups = view.groups.filter((g) => g.floor === floor);
    const unseated = new Set(overflow);
    for (const column of Object.values(this.columns)) column.querySelector('ul')!.replaceChildren();
    for (const group of groups) {
      const main = group.actors.find((a) => a.role === 'main') ?? group.actors[0];
      const row = el('li', `row status-${main?.status ?? 'idle'}`);
      row.dataset.session = group.sessionId;
      row.append(el('div', 'row-label', group.label), el('div', 'row-bubble', main?.bubble ?? ''));
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
