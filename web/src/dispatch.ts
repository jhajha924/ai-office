import type { DecisionView, DispatchPanelView, DispatchView, ProjectView } from '../../server/src/office/types.ts';
import type { LevelChoice } from './levels.ts';
import { TEXT } from './text.ts';

/**
 * The 交辦 button in the top bar and its drawer. The models (what to show)
 * are pure functions so they can be tested without a page; DispatchPanel
 * draws them and talks to POST /api/dispatch and /api/decisions/<id>.
 */

export const TEXT_MAX = 2000;
const UI_HEADERS = { 'X-AI-Office': 'ui', 'Content-Type': 'application/json' };

export interface ButtonModel {
  hidden: boolean;
  disabled: boolean;
  title: string;
  /** Open decisions; 0 = no badge. */
  badge: number;
}

export function buttonModel(panel: DispatchPanelView): ButtonModel {
  const badge = panel.active?.decisions.length ?? 0;
  switch (panel.status) {
    case 'off':
      return { hidden: true, disabled: true, title: '', badge: 0 };
    case 'missing-claude':
      return { hidden: false, disabled: true, title: TEXT.dispatchMissingClaude, badge: 0 };
    case 'missing-speclink':
      return { hidden: false, disabled: true, title: TEXT.dispatchMissingSpeclink, badge: 0 };
    default:
      return { hidden: false, disabled: false, title: TEXT.dispatchButtonTitle(panel.building ?? ''), badge };
  }
}

export interface ChipModel {
  id: string;
  text: string;
  doneWhen: string;
  /** Required stops have no × and explain why. */
  removable: boolean;
  removed: boolean;
}

export interface ConfirmCardModel {
  decision: string;
  project: string;
  title: string;
  kind: string;
  folder: string;
  chips: ChipModel[];
  notes: string[];
  risks: string[];
}

export type DrawerModel =
  | { kind: 'form'; building: string; recent: RecentModel[]; hint?: string }
  | { kind: 'busy'; text: string; cards: ConfirmCardModel[] }
  | { kind: 'confirm'; cards: ConfirmCardModel[] }
  | { kind: 'failed'; error: string; decision?: string; cards: ConfirmCardModel[] };

export interface RecentModel {
  text: string;
  projects: { title: string; status: string }[];
  usage: string;
}

export function confirmCards(active: DispatchView, removed: ReadonlyMap<string, ReadonlySet<string>> = new Map()): ConfirmCardModel[] {
  const out: ConfirmCardModel[] = [];
  for (const decision of active.decisions) {
    if (decision.kind !== 'confirm') continue;
    const project = active.projects.find((p) => p.id === decision.project);
    if (!project) continue;
    out.push(cardModel(decision, project, removed.get(project.id) ?? new Set()));
  }
  return out;
}

function cardModel(decision: DecisionView, project: ProjectView, removed: ReadonlySet<string>): ConfirmCardModel {
  return {
    decision: decision.id,
    project: project.id,
    title: project.title,
    kind: project.kind === 'code' ? TEXT.dispatchKindCode : TEXT.dispatchKindResearch,
    folder: project.folder,
    chips: project.route.map((stop) => ({
      id: stop.id,
      text: `${stop.level}F ${stop.name}`,
      doneWhen: stop.doneWhen,
      removable: !stop.required,
      removed: !stop.required && removed.has(stop.id),
    })),
    notes: project.notes,
    risks: project.risks,
  };
}

/** The route sent with 開工: every stop not taken off. */
export function routeToStart(card: ConfirmCardModel): string[] {
  return card.chips.filter((c) => !c.removed).map((c) => c.id);
}

export function recentModel(dispatch: DispatchView): RecentModel {
  return {
    text: dispatch.text,
    projects: dispatch.projects.map((p) => ({
      title: p.title,
      status: p.status === 'queued' ? TEXT.dispatchQueued : p.status === 'cancelled' ? TEXT.dispatchCancelled : '',
    })),
    usage: TEXT.dispatchUsage(dispatch.usage.turns, Math.round(dispatch.usage.durationMs / 1000)),
  };
}

/** Shown under 最近的交辦 while something is queued: 開工 does not start the floors yet (③b). */
export const QUEUED_HINT = TEXT.dispatchQueuedHint;

export interface ViewPlace {
  building: string;
  level: LevelChoice;
}

/**
 * Where to look after 送出: an accepted dispatch in another building moves to
 * that building's whole view so the 總裁 is in sight; inside the dispatch
 * building the floor stays; a refused one changes nothing.
 */
export function viewAfterDispatch(current: ViewPlace, dispatchBuilding: string, accepted: boolean): ViewPlace {
  if (!accepted || !dispatchBuilding || current.building === dispatchBuilding) return current;
  return { building: dispatchBuilding, level: 'all' };
}

export function drawerModel(panel: DispatchPanelView, removed: ReadonlyMap<string, ReadonlySet<string>> = new Map()): DrawerModel {
  const active = panel.active;
  if (!active) {
    const form: DrawerModel = { kind: 'form', building: panel.building ?? '', recent: panel.recent.map(recentModel) };
    const queued = panel.recent.some((d) => d.projects.some((p) => p.status === 'queued'));
    return queued ? { ...form, hint: QUEUED_HINT } : form;
  }
  const cards = confirmCards(active, removed);
  switch (active.status) {
    case 'president':
      return { kind: 'busy', text: TEXT.dispatchPresident, cards };
    case 'manager':
      return { kind: 'busy', text: TEXT.dispatchManager(active.step?.index ?? 1, active.step?.total ?? active.projects.length), cards };
    case 'failed':
      return { kind: 'failed', error: active.error ?? '', decision: active.decisions.find((q) => q.kind === 'retry')?.id, cards };
    default:
      return { kind: 'confirm', cards };
  }
}

// ── the page part ─────────────────────────────────────────────

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

async function postJson(url: string, body: unknown): Promise<string | undefined> {
  try {
    const res = await fetch(url, { method: 'POST', headers: UI_HEADERS, body: JSON.stringify(body) });
    if (res.ok) return undefined;
    return (await res.text()) || TEXT.dispatchSendFailed;
  } catch {
    return TEXT.dispatchSendFailed;
  }
}

export class DispatchPanel {
  private readonly button: HTMLButtonElement;
  private readonly drawer: HTMLElement;
  private panel: DispatchPanelView = { status: 'off', recent: [] };
  /** Stops the user took off, per project, until 開工. */
  private readonly removed = new Map<string, Set<string>>();
  private draft = '';
  private message = '';
  private open = false;
  private lastKey = '';

  private readonly onSent: (accepted: boolean, building: string) => void;

  constructor(button: HTMLButtonElement, drawer: HTMLElement, onSent: (accepted: boolean, building: string) => void = () => {}) {
    this.button = button;
    this.drawer = drawer;
    this.onSent = onSent;
    button.addEventListener('click', () => {
      this.open = !this.open;
      this.render(true);
    });
  }

  update(panel: DispatchPanelView): void {
    this.panel = panel;
    this.render(false);
  }

  private render(force: boolean): void {
    const b = buttonModel(this.panel);
    this.button.hidden = b.hidden;
    this.button.disabled = b.disabled;
    this.button.title = b.title;
    this.button.replaceChildren(el('span', '', TEXT.dispatchButton));
    if (b.badge > 0) this.button.append(el('span', 'badge alert', String(b.badge)));
    if (b.hidden || b.disabled) this.open = false;
    this.drawer.hidden = !this.open;
    if (!this.open) return;
    // Redraw only when what the drawer shows changed, so typing is never interrupted.
    const model = drawerModel(this.panel, this.removed);
    const key = JSON.stringify([model, this.message]);
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.drawer.replaceChildren(...this.drawerNodes(model));
  }

  private drawerNodes(model: DrawerModel): HTMLElement[] {
    const head = el('div', 'dispatch-head');
    const close = el('button', 'dispatch-close', '×');
    close.type = 'button';
    close.title = TEXT.dispatchClose;
    close.addEventListener('click', () => {
      this.open = false;
      this.render(true);
    });
    head.append(el('h2', '', TEXT.dispatchTitle), close);
    const nodes: HTMLElement[] = [head];
    if (this.message) nodes.push(el('p', 'dispatch-message', this.message));

    if (model.kind === 'form') {
      const form = el('form', 'dispatch-form');
      form.append(el('label', 'dispatch-building', TEXT.dispatchBuilding(model.building)));
      const area = el('textarea');
      area.maxLength = TEXT_MAX;
      area.rows = 5;
      area.placeholder = TEXT.dispatchPlaceholder;
      area.value = this.draft;
      area.addEventListener('input', () => (this.draft = area.value));
      const send = el('button', 'dispatch-send', TEXT.dispatchSend);
      send.type = 'submit';
      form.append(area, send);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        void this.send(area.value);
      });
      nodes.push(form);
      if (model.recent.length > 0) {
        nodes.push(el('h3', '', TEXT.dispatchRecent));
        if (model.hint) nodes.push(el('p', 'dispatch-hint', model.hint));
        const list = el('ul', 'dispatch-recent');
        for (const r of model.recent) {
          const item = el('li');
          item.append(el('div', 'recent-text', r.text));
          for (const p of r.projects) item.append(el('div', 'recent-project', `${p.title}：${p.status}`));
          item.append(el('div', 'recent-usage', r.usage));
          list.append(item);
        }
        nodes.push(list);
      }
      return nodes;
    }
    if (model.kind === 'busy') nodes.push(el('p', 'dispatch-busy', model.text));
    if (model.kind === 'failed') {
      const box = el('div', 'dispatch-failed');
      box.append(el('p', '', model.error));
      if (model.decision) {
        const id = model.decision;
        box.append(this.action(TEXT.dispatchRetry, 'primary', () => this.answer(id, { action: 'retry' })));
        box.append(this.action(TEXT.dispatchCancel, '', () => this.answer(id, { action: 'cancel' })));
      }
      nodes.push(box);
    }
    for (const card of model.cards) nodes.push(this.cardNode(card));
    return nodes;
  }

  private cardNode(card: ConfirmCardModel): HTMLElement {
    const node = el('section', 'confirm-card');
    node.append(el('h3', '', card.title), el('div', 'confirm-meta', `${card.kind}・${card.folder}`));
    const chips = el('div', 'route-chips');
    for (const chip of card.chips) {
      const c = el('span', chip.removed ? 'chip removed' : 'chip', chip.text);
      if (chip.removable) {
        const x = el('button', 'chip-x', chip.removed ? '↺' : '×');
        x.type = 'button';
        x.title = chip.removed ? TEXT.dispatchRestore : TEXT.dispatchRemove;
        x.addEventListener('click', () => this.toggle(card.project, chip.id));
        c.append(x);
      } else {
        c.classList.add('required');
        c.title = TEXT.dispatchRequired;
      }
      chips.append(c);
    }
    node.append(chips);
    const done = el('ul', 'done-when');
    for (const chip of card.chips) if (!chip.removed) done.append(el('li', '', `${chip.text}：${chip.doneWhen}`));
    node.append(done);
    for (const note of card.notes) node.append(el('p', 'confirm-note', note));
    if (card.risks.length > 0) node.append(el('p', 'confirm-risks', TEXT.dispatchRisks(card.risks.join('、'))));
    const actions = el('div', 'confirm-actions');
    actions.append(
      this.action(TEXT.dispatchStart, 'primary', () => this.answer(card.decision, { action: 'start', route: routeToStart(card) })),
      this.action(TEXT.dispatchCancel, '', () => this.answer(card.decision, { action: 'cancel' })),
    );
    node.append(actions);
    return node;
  }

  private action(text: string, className: string, run: () => Promise<void>): HTMLButtonElement {
    const b = el('button', className ? `dispatch-action ${className}` : 'dispatch-action', text);
    b.type = 'button';
    b.addEventListener('click', () => {
      b.disabled = true;
      void run();
    });
    return b;
  }

  private toggle(project: string, stop: string): void {
    const set = this.removed.get(project) ?? new Set<string>();
    if (set.has(stop)) set.delete(stop);
    else set.add(stop);
    this.removed.set(project, set);
    this.render(true);
  }

  private async send(text: string): Promise<void> {
    const error = await postJson('/api/dispatch', { text });
    this.message = error ?? '';
    if (!error) this.draft = '';
    this.render(true);
    this.onSent(!error, this.panel.building ?? '');
  }

  private async answer(decision: string, body: unknown): Promise<void> {
    const error = await postJson(`/api/decisions/${decision}`, body);
    this.message = error ?? '';
    this.render(true);
  }
}
