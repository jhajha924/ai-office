import type { DecisionView, DispatchPanelView, DispatchView, ProjectView, WorkView } from '../../server/src/office/types.ts';
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
  // Planning decisions plus the running project's (cut ③b).
  const badge = (panel.active?.decisions.length ?? 0) + (panel.work?.decisions.length ?? 0);
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
  | { kind: 'form'; building: string; recent: RecentModel[] }
  | { kind: 'busy'; text: string; cards: ConfirmCardModel[] }
  | { kind: 'confirm'; cards: ConfirmCardModel[] }
  | { kind: 'failed'; error: string; decision?: string; cards: ConfirmCardModel[] };

export interface RecentModel {
  text: string;
  projects: { title: string; status: string; summary?: string }[];
  usage: string;
}

/** One open decision of the running project, as a card. */
export type WorkCardModel =
  | { kind: 'question'; decision: string; text: string; options: string[] }
  | { kind: 'stuck'; decision: string; text: string; canSkip: boolean }
  | { kind: 'rejected'; decision: string; text: string; findings: string[] }
  | { kind: 'blocked'; decision: string; text: string }
  | { kind: 'qa'; decision: string; text: string; choices: { mode: 'review' | 'verify' | 'both'; label: string }[] };

/** The 執行中 block on top of the drawer (cut ③b). */
export interface WorkModel {
  project: string;
  /** 「<專案標題>：<樓層> <部門名>（第 n／共 m 站）」 */
  line: string;
  waiting: boolean;
  cards: WorkCardModel[];
}

export function workModel(work: WorkView | undefined): WorkModel | undefined {
  if (!work) return undefined;
  const { stop } = work;
  const cards: WorkCardModel[] = [];
  for (const q of work.decisions) {
    if (q.kind === 'question') cards.push({ kind: 'question', decision: q.id, text: q.summary, options: q.options ?? [] });
    else if (q.kind === 'stuck') cards.push({ kind: 'stuck', decision: q.id, text: q.summary, canSkip: !stop.required });
    else if (q.kind === 'rejected') cards.push({ kind: 'rejected', decision: q.id, text: q.summary, findings: q.findings ?? [] });
    else if (q.kind === 'blocked') cards.push({ kind: 'blocked', decision: q.id, text: q.summary });
    else if (q.kind === 'qa') cards.push({ kind: 'qa', decision: q.id, text: q.summary, choices: TEXT.dispatchQaChoices.map((c) => ({ ...c })) });
  }
  return {
    project: work.project,
    line: TEXT.dispatchWorkLine(work.title, stop.level, stop.name, stop.index, stop.total),
    waiting: work.status === 'waiting',
    cards,
  };
}

/** What 最近的交辦 says about one project. */
export function projectStatusText(p: ProjectView): string {
  switch (p.status) {
    case 'queued':
      return p.ahead ? TEXT.dispatchQueuedAhead(p.ahead) : TEXT.dispatchQueued;
    case 'running':
      return p.at ? TEXT.dispatchRunningAt(p.at.level, p.at.name) : TEXT.dispatchRunning;
    case 'waiting':
      return TEXT.dispatchWaiting;
    case 'done':
      return TEXT.dispatchDone;
    case 'stopped':
      return TEXT.dispatchStopped;
    case 'cancelled':
      return TEXT.dispatchCancelled;
    default:
      return '';
  }
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
      status: projectStatusText(p),
      ...(p.status === 'done' && p.summary ? { summary: p.summary } : {}),
    })),
    usage: TEXT.dispatchUsage(dispatch.usage.turns, Math.round(dispatch.usage.durationMs / 1000)),
  };
}

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
  if (!active) return { kind: 'form', building: panel.building ?? '', recent: panel.recent.map(recentModel) };
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
  /** Unsent answers to worker questions, by decision. */
  private readonly answers = new Map<string, string>();
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
    const work = workModel(this.panel.work);
    const key = JSON.stringify([model, work, this.message]);
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    const nodes = this.drawerNodes(model);
    // The running project's block goes right under the title (and any message).
    if (work) nodes.splice(this.message ? 2 : 1, 0, this.workNode(work));
    this.drawer.replaceChildren(...nodes);
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
        const list = el('ul', 'dispatch-recent');
        for (const r of model.recent) {
          const item = el('li');
          item.append(el('div', 'recent-text', r.text));
          for (const p of r.projects) {
            item.append(el('div', 'recent-project', `${p.title}：${p.status}`));
            if (p.summary) item.append(el('div', 'recent-summary', p.summary));
          }
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

  private workNode(work: WorkModel): HTMLElement {
    const box = el('section', work.waiting ? 'dispatch-work waiting' : 'dispatch-work');
    const head = el('div', 'work-head');
    head.append(el('h3', '', TEXT.dispatchWorkTitle));
    const stop = el('button', 'dispatch-action work-stop', TEXT.dispatchStop);
    stop.type = 'button';
    stop.addEventListener('click', () => {
      if (!window.confirm(TEXT.dispatchStopConfirm)) return;
      stop.disabled = true;
      void this.post(`/api/projects/${work.project}/stop`, {});
    });
    head.append(stop);
    box.append(head, el('p', 'work-line', work.line));
    for (const card of work.cards) box.append(this.workCard(card));
    return box;
  }

  private workCard(card: WorkCardModel): HTMLElement {
    const node = el('div', `work-card ${card.kind}`);
    node.append(el('p', 'work-card-text', card.text));
    const actions = el('div', 'confirm-actions');
    const answer = (body: unknown) => () => this.answer(card.decision, body);
    switch (card.kind) {
      case 'question': {
        const area = el('textarea');
        area.rows = 3;
        area.maxLength = TEXT_MAX;
        area.placeholder = TEXT.dispatchAnswerPlaceholder;
        area.value = this.answers.get(card.decision) ?? '';
        area.addEventListener('input', () => this.answers.set(card.decision, area.value));
        if (card.options.length > 0) {
          const options = el('div', 'work-options');
          for (const option of card.options) {
            const b = el('button', 'dispatch-option', option);
            b.type = 'button';
            b.addEventListener('click', () => {
              area.value = option;
              this.answers.set(card.decision, option);
            });
            options.append(b);
          }
          node.append(options);
        }
        node.append(area);
        actions.append(this.action(TEXT.dispatchAnswer, 'primary', () => this.answer(card.decision, { action: 'answer', text: area.value })));
        break;
      }
      case 'stuck':
        actions.append(this.action(TEXT.dispatchRetry, 'primary', answer({ action: 'retry' })));
        if (card.canSkip) actions.append(this.action(TEXT.dispatchSkip, '', answer({ action: 'skip' })));
        break;
      case 'rejected': {
        const list = el('ul', 'done-when');
        for (const f of card.findings) list.append(el('li', '', f));
        node.append(list);
        actions.append(this.action(TEXT.dispatchRedo, 'primary', answer({ action: 'redo' })), this.action(TEXT.dispatchAccept, '', answer({ action: 'accept' })));
        break;
      }
      case 'blocked':
        actions.append(this.action(TEXT.dispatchRetry, 'primary', answer({ action: 'retry' })));
        break;
      case 'qa':
        // One button per check; the label says in Chinese what it does.
        actions.classList.add('qa-choices');
        for (const choice of card.choices) actions.append(this.action(choice.label, choice.mode === 'both' ? 'primary' : '', answer({ action: 'qa', mode: choice.mode })));
        break;
    }
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
    if (!error) this.answers.delete(decision);
    this.message = error ?? '';
    this.render(true);
  }

  private async post(url: string, body: unknown): Promise<void> {
    const error = await postJson(url, body);
    this.message = error ?? '';
    this.render(true);
  }
}
