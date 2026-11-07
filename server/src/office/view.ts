import type { OfficeConfig } from './config.ts';
import { buildFeed, buildHandoffs, nameFor, outputToken } from './feed.ts';
import { floorForSession, floorList } from './floorRouting.ts';
import { placeholderLabel } from './groupLabel.ts';
import { skillTitle, subagentTitle } from './roster.ts';
import { baseName, STATE_BUBBLES, subtaskStatus, toolStatus } from './statusText.ts';
import type { ActorState, GroupState, OfficeStore } from './store.ts';
import { startOfLocalDay } from './store.ts';
import type { ActorStatus, ActorView, FloorView, GroupView, ModelFamily, OfficeView, OutputRef } from './types.ts';

/**
 * The processing station: store state → OfficeView. Floor, title, Chinese
 * status and masking all happen here, on the server, so a masked floor's file
 * names, commands and subtask descriptions never reach the browser. The view
 * carries no cwd, no full path and no raw detail.
 */

export const MAIN_TITLE = '主對話';

export function modelFamily(model: string | undefined): ModelFamily {
  const m = (model ?? '').toLowerCase();
  for (const family of ['opus', 'sonnet', 'haiku', 'fable'] as const) {
    if (m.includes(family)) return family;
  }
  return 'other';
}

/** Outputs listed on a main actor's card at most. */
export const OUTPUTS_SHOWN = 20;

/**
 * Base status plus the time rules: long silences turn into 卡住？, a finished
 * turn into 閒置 and later 打瞌睡. `canStall` is false where silence is
 * expected: a sub-agent's own steps are not watched, and its main session
 * waits quietly while it works.
 */
function timedStatus(actor: ActorState, now: number, config: OfficeConfig, canStall: boolean): ActorStatus {
  const age = now - actor.since;
  const { stuckRunningMs, stuckThinkingMs, idleAfterDoneMs, dozeAfterIdleMs } = config.timing;
  if (canStall && actor.status === 'running' && age >= stuckRunningMs) return 'stuck';
  if (canStall && actor.status === 'thinking' && age >= stuckThinkingMs) return 'stuck';
  if (actor.status === 'done' && age >= idleAfterDoneMs + dozeAfterIdleMs) return 'dozing';
  if (actor.status === 'done' && age >= idleAfterDoneMs) return 'idle';
  return actor.status;
}

function baseBubble(actor: ActorState, mask: boolean, config: OfficeConfig): string {
  if (actor.role === 'subagent') return subtaskStatus(actor.detail, mask);
  if (actor.status === 'running' && actor.tool) return toolStatus(actor.tool, actor.detail, mask, config);
  if (actor.status === 'running') return '工作中';
  return STATE_BUBBLES[actor.status];
}

const WORKING: ReadonlySet<ActorStatus> = new Set(['thinking', 'running', 'replying']);

/** A session's output files today: distinct by path, newest first. */
function sessionOutputs(store: OfficeStore, sessionId: string, now: number): { path: string }[] {
  const today = startOfLocalDay(now);
  const seen = new Set<string>();
  const out: { path: string }[] = [];
  for (let i = store.outputs.length - 1; i >= 0; i--) {
    const o = store.outputs[i];
    if (o.sessionId !== sessionId || o.at < today || o.at > now) continue;
    const key = o.path.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: o.path });
  }
  return out;
}

function actorView(
  actor: ActorState,
  group: GroupState,
  floor: string,
  mask: boolean,
  now: number,
  config: OfficeConfig,
  store: OfficeStore,
  label: string,
): ActorView {
  const helpersAtWork = [...group.actors.values()].some((a) => a.role === 'subagent');
  const canStall = actor.role === 'skill' || (actor.role === 'main' && !helpersAtWork);
  let status = timedStatus(actor, now, config, canStall);
  let bubble = baseBubble(actor, mask, config);
  let tool = actor.status === 'running' && actor.role !== 'subagent' ? actor.tool : undefined;

  if (actor.role === 'main') {
    const skill = [...group.actors.values()].find((a) => a.role === 'skill');
    if (group.pendingAsks.size > 0 || group.hookWaiting) {
      status = 'waiting';
      bubble = group.pendingAsks.size > 0 ? '等你回答' : STATE_BUBBLES.waiting;
      tool = undefined;
    } else if (skill && actor.status === 'running') {
      // While a skill employee is in, the work shows on its bubble instead.
      bubble = `交給 ${skillTitle(skill.skill ?? '', floor, config)}`;
      tool = undefined;
    }
  }
  if (status === 'stuck') bubble = `卡住？（${bubble}）`;
  if (status === 'idle') bubble = STATE_BUBBLES.idle;
  if (status === 'dozing') bubble = STATE_BUBBLES.dozing;

  const title =
    actor.role === 'main'
      ? MAIN_TITLE
      : actor.role === 'subagent'
        ? subagentTitle(actor.subagentType, floor, config)
        : skillTitle(actor.skill ?? '', floor, config);

  const task = actor.role === 'main' ? label : actor.role === 'subagent' ? subtaskStatus(actor.detail, mask) : title;

  // A known ratio shows on the main actor and the skill employee doing its
  // work; otherwise anyone at work gets the indeterminate bar.
  const known = actor.role !== 'subagent' ? group.progress : undefined;
  const progress = known ? { ...known } : WORKING.has(status) ? ('indeterminate' as const) : undefined;

  let outputs: OutputRef[] | undefined;
  let outputCount: number | undefined;
  if (actor.role === 'main') {
    const files = sessionOutputs(store, group.sessionId, now);
    outputCount = files.length;
    if (!mask) {
      outputs = files
        .slice(0, OUTPUTS_SHOWN)
        .map((f) => ({ token: outputToken(group.sessionId, f.path), name: baseName(f.path) }));
    }
  }

  return {
    id: actor.id,
    role: actor.role,
    title,
    model: modelFamily(actor.model),
    status,
    bubble,
    ...(tool ? { tool } : {}),
    since: actor.since,
    name: nameFor(actor.id, config),
    task,
    ...(progress ? { progress } : {}),
    ...(outputs ? { outputs } : {}),
    ...(outputCount !== undefined ? { outputCount } : {}),
  };
}

export function buildView(store: OfficeStore, config: OfficeConfig, now: number): OfficeView {
  const groups: GroupView[] = [];
  for (const group of store.groups.values()) {
    if (now - group.lastActivity >= config.timing.groupLeaveMs) continue;
    const { floor, mask } = floorForSession(store.homes.get(group.sessionId), group.cwd, config);
    const label = group.label ?? placeholderLabel(group.sessionId);
    const actors = [...group.actors.values()].map((a) => actorView(a, group, floor, mask, now, config, store, label));
    groups.push({
      sessionId: group.sessionId,
      floor,
      label,
      actors,
      lastActivity: group.lastActivity,
    });
  }

  const floors: FloorView[] = floorList(config).map((f) => ({
    name: f.floor,
    masked: f.mask,
    stats: { working: 0, outputs: 0, waiting: 0 },
  }));
  const floorOf = (name: string): FloorView => {
    let found = floors.find((f) => f.name === name);
    if (!found) {
      found = { name, masked: false, stats: { working: 0, outputs: 0, waiting: 0 } };
      floors.push(found);
    }
    return found;
  };

  for (const group of groups) {
    const main = group.actors.find((a) => a.role === 'main');
    const stats = floorOf(group.floor).stats;
    if (main && WORKING.has(main.status)) stats.working += 1;
    if (main && main.status === 'waiting') stats.waiting += 1;
  }

  const today = startOfLocalDay(now);
  const seen = new Map<string, Set<string>>();
  for (const output of store.outputs) {
    if (output.at < today || output.at > now) continue;
    const floor = floorForSession(store.homes.get(output.sessionId), output.cwd, config).floor;
    const files = seen.get(floor) ?? new Set<string>();
    files.add(output.path.replace(/\\/g, '/').toLowerCase());
    seen.set(floor, files);
  }
  for (const [floor, files] of seen) floorOf(floor).stats.outputs = files.size;

  return { floors, groups, feed: buildFeed(store, config), handoffs: buildHandoffs(store, config, now), generatedAt: now };
}
