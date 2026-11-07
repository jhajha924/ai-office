import { describe, expect, it } from 'vitest';

import { parseLine } from '../server/src/observe/transcriptParser.ts';
import type { ToolNames } from '../server/src/observe/transcriptParser.ts';
import { attachment, text, thinking, toolResult, toolUse, userText } from './fixtures/lines.ts';

const SID = '8f3c1234-aaaa';
const kinds = (line: string, names: ToolNames = new Map()) =>
  parseLine(line, SID, names, 0)?.events.map((e) => e.kind) ?? null;

describe('transcript parser', () => {
  // office-transcript-observer spec, Example: 紀錄內容與事件對照
  it.each([
    ['user input', userText('幫我看一下'), ['turn.start']],
    ['user interrupt', userText('[Request interrupted by user]'), ['turn.end']],
    ['thinking block', thinking(), ['thinking']],
    ['text block before the end', text('tool_use'), ['reply']],
    ['Read tool_use', toolUse('Read', 't1', { file_path: 'D:\\a\\b.md' }), ['tool.start']],
    ['Skill tool_use', toolUse('Skill', 't2', { skill: 'speclink-review' }), ['tool.start', 'actor.join']],
    ['Write tool_use', toolUse('Write', 't3', { file_path: 'a.md', content: 'x' }), ['tool.start', 'output.add']],
    ['end_turn', text('end_turn'), ['turn.end']],
    ['not JSON', '{"type":"user", broken', null],
    ['unknown record type', attachment(), []],
  ])('%s', (_name, line, expected) => {
    expect(kinds(line)).toEqual(expected);
  });

  it('keeps tool and detail on tool.start', () => {
    const [e] = parseLine(toolUse('Read', 't1', { file_path: 'D:\\a\\b.md' }), SID, new Map(), 0)!.events;
    expect(e).toMatchObject({ tool: 'Read', toolUseId: 't1', detail: 'D:\\a\\b.md', model: 'claude-opus-5-5' });
  });

  it('marks the Skill employee with its skill name', () => {
    const events = parseLine(toolUse('Skill', 't2', { skill: 'speclink-review' }), SID, new Map(), 0)!.events;
    expect(events[1]).toMatchObject({ actorId: `${SID}:skill`, skill: 'speclink-review' });
  });

  // office-transcript-observer spec, Scenario: 呼叫子代理
  it('turns an Agent call into tool.start plus handoff.out', () => {
    const events = parseLine(
      toolUse('Agent', 'toolu_9', { subagent_type: 'Explore', description: '找出工單程式', prompt: '...' }),
      SID,
      new Map(),
      0,
    )!.events;
    expect(events.map((e) => e.kind)).toEqual(['tool.start', 'handoff.out']);
    expect(events[1]).toMatchObject({ actorId: `${SID}:sub:toolu_9`, subagentType: 'Explore', detail: '找出工單程式' });
  });

  it('pairs the tool_result of an Agent call with handoff.back', () => {
    const names: ToolNames = new Map();
    parseLine(toolUse('Agent', 'toolu_9', { subagent_type: 'Explore' }), SID, names, 0);
    const events = parseLine(toolResult('toolu_9'), SID, names, 0)!.events;
    expect(events.map((e) => e.kind)).toEqual(['tool.end', 'handoff.back']);
    expect(events[1].actorId).toBe(`${SID}:sub:toolu_9`);
  });

  it('skips sidechain lines', () => {
    expect(kinds(userText('子代理內部', { sidechain: true }))).toBeNull();
  });

  it('ignores user turns that hold only injected context', () => {
    expect(kinds(userText('<system-reminder>context</system-reminder>'))).toEqual([]);
  });

  it('keeps going after a broken line', () => {
    const names: ToolNames = new Map();
    const lines = ['not json', thinking(), '{', toolUse('Bash', 'b1', { command: 'ls' })];
    const all = lines.flatMap((l) => parseLine(l, SID, names, 0)?.events ?? []).map((e) => e.kind);
    expect(all).toEqual(['thinking', 'tool.start']);
  });
});
