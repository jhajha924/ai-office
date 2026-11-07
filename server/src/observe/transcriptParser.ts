import { titleOf, userTextBlocks, userTextOf } from '../office/groupLabel.ts';
import type { OfficeEvent } from '../office/types.ts';
import { mainActorId, skillActorId, subActorId } from '../office/types.ts';

/**
 * One Claude Code transcript line → OfficeEvents.
 *
 * Claude Code writes one JSON record per line, one line per content block;
 * each assistant line carries the message's final stop_reason. Lines that are
 * not JSON, sidechain lines and record types we do not know produce no event
 * and never stop the lines after them.
 */

/** Tool name per tool_use id, so a tool_result can be paired with its call. */
export type ToolNames = Map<string, string>;

export interface ParsedLine {
  events: OfficeEvent[];
  /** The line's cwd and time, for activity tracking even when it yields no event. */
  cwd?: string;
  at: number;
  /** The conversation title an ai-title record carries; it yields no event. */
  title?: string;
  /** The speclink / spectra change this line shows the session working on (the last one in the line). */
  change?: ChangeHint;
}

export interface ChangeHint {
  name: string;
  /** The change folder, when the line names a file inside it. */
  dir?: string;
}

const CHANGE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit']);

/**
 * Which change a tool call shows the session working on, if any:
 * a speclink-/spectra- Skill whose args start with a change name, a --change
 * flag in a shell command, or a file inside openspec/changes/<name>/ (the
 * archive folder excepted).
 */
export function changeHint(tool: string, input: Json): ChangeHint | undefined {
  if (tool === 'Skill') {
    const skill = str(input.skill);
    const first = str(input.args)?.trim().split(/\s+/)[0];
    if (skill && /^(speclink|spectra)-/.test(skill) && first && CHANGE_NAME.test(first)) return { name: first };
    return undefined;
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const m = /--change(?:=|\s+)["']?([a-z0-9][a-z0-9-]*)/.exec(str(input.command) ?? '');
    return m ? { name: m[1] } : undefined;
  }
  if (FILE_TOOLS.has(tool)) {
    const file = str(input.file_path);
    const m = file ? /^(.*[\\/]openspec[\\/]changes[\\/]([^\\/]+))[\\/]/.exec(file) : null;
    if (!m || m[2] === 'archive' || !CHANGE_NAME.test(m[2])) return undefined;
    return { name: m[2], dir: m[1] };
  }
  return undefined;
}

const SPAWN_TOOLS = new Set(['Agent', 'Task']);
const OUTPUT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const INTERRUPTED = '[Request interrupted by user';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

/** The unmasked detail worth keeping for a tool call (masking happens later, in the view). */
export function toolDetail(tool: string, input: Json): string | undefined {
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return str(input.file_path);
    case 'NotebookEdit':
      return str(input.notebook_path);
    case 'Bash':
    case 'PowerShell':
      return str(input.command);
    case 'Agent':
    case 'Task':
      return str(input.description);
    default:
      return undefined;
  }
}

export function parseLine(line: string, sessionId: string, toolNames: ToolNames, now: number, fallbackCwd = ''): ParsedLine | null {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObject(record)) return null;
  if (record.isSidechain === true) return null;

  const stamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  const at = Number.isFinite(stamp) ? stamp : now;
  const cwd = str(record.cwd);
  const events: OfficeEvent[] = [];
  let change: ChangeHint | undefined;
  const main = mainActorId(sessionId);
  const base = { source: 'observe' as const, sessionId, cwd: cwd ?? fallbackCwd, at };
  const message = isObject(record.message) ? record.message : undefined;

  if (record.type === 'user' && message) {
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isObject(block) || block.type !== 'tool_result') continue;
        const toolUseId = str(block.tool_use_id);
        const tool = toolUseId ? toolNames.get(toolUseId) : undefined;
        events.push({ ...base, kind: 'tool.end', actorId: main, tool, toolUseId });
        if (toolUseId && tool && SPAWN_TOOLS.has(tool)) {
          events.push({ ...base, kind: 'handoff.back', actorId: subActorId(sessionId, toolUseId), tool, toolUseId });
        }
      }
    }
    const texts = userTextBlocks(record as Parameters<typeof userTextBlocks>[0]);
    if (texts.some((t) => t.includes(INTERRUPTED))) {
      events.push({ ...base, kind: 'turn.end', actorId: main });
    } else if (texts.some((t) => userTextOf(t).length > 0)) {
      events.push({ ...base, kind: 'turn.start', actorId: main });
    }
  } else if (record.type === 'assistant' && message) {
    const model = str(message.model);
    const withModel = model && model !== '<synthetic>' ? { ...base, model } : base;
    const endTurn = message.stop_reason === 'end_turn';
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const block of blocks) {
      if (!isObject(block)) continue;
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        events.push({ ...withModel, kind: 'thinking', actorId: main });
      } else if (block.type === 'text') {
        if (!endTurn) events.push({ ...withModel, kind: 'reply', actorId: main });
      } else if (block.type === 'tool_use') {
        const tool = str(block.name);
        const toolUseId = str(block.id);
        if (!tool) continue;
        const input = isObject(block.input) ? block.input : {};
        if (toolUseId) toolNames.set(toolUseId, tool);
        change = changeHint(tool, input) ?? change;
        const detail = toolDetail(tool, input);
        events.push({ ...withModel, kind: 'tool.start', actorId: main, tool, toolUseId, detail });
        if (SPAWN_TOOLS.has(tool) && toolUseId) {
          events.push({
            ...withModel,
            kind: 'handoff.out',
            actorId: subActorId(sessionId, toolUseId),
            tool,
            toolUseId,
            subagentType: str(input.subagent_type),
            detail: str(input.description),
          });
        } else if (tool === 'Skill') {
          const skill = str(input.skill);
          if (skill) events.push({ ...withModel, kind: 'actor.join', actorId: skillActorId(sessionId), tool, toolUseId, skill });
        } else if (OUTPUT_TOOLS.has(tool) && detail) {
          events.push({ ...withModel, kind: 'output.add', actorId: main, tool, toolUseId, detail });
        }
      }
    }
    if (endTurn) events.push({ ...withModel, kind: 'turn.end', actorId: main });
  }

  return { events, cwd, at, title: titleOf(record), ...(change ? { change } : {}) };
}
