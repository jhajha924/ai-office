/**
 * Transcript lines in the shape Claude Code writes them: one JSON record per
 * line, one line per content block, each assistant line carrying the
 * message's final stop_reason.
 */

export const CWD = 'D:\\home\\notes';
export const WORK_CWD = 'D:\\work\\app';

let clock = Date.UTC(2026, 9, 31, 2, 0, 0);
export function resetClock(at: number): void {
  clock = at;
}
const stamp = (at?: number): string => new Date(at ?? (clock += 1_000)).toISOString();

interface Opts {
  cwd?: string;
  at?: number;
  sidechain?: boolean;
}

export function userText(text: string, o: Opts = {}): string {
  return JSON.stringify({
    type: 'user',
    isSidechain: o.sidechain ?? false,
    cwd: o.cwd ?? CWD,
    timestamp: stamp(o.at),
    message: { role: 'user', content: text },
  });
}

export function toolResult(toolUseId: string, o: Opts = {}): string {
  return JSON.stringify({
    type: 'user',
    isSidechain: false,
    cwd: o.cwd ?? CWD,
    timestamp: stamp(o.at),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
  });
}

export function assistantBlock(block: Record<string, unknown>, stopReason: string | null, o: Opts = {}): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: o.sidechain ?? false,
    cwd: o.cwd ?? CWD,
    timestamp: stamp(o.at),
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [block], stop_reason: stopReason },
  });
}

export const thinking = (o: Opts = {}) => assistantBlock({ type: 'thinking', thinking: '...' }, 'tool_use', o);
export const text = (stop: string, o: Opts = {}) => assistantBlock({ type: 'text', text: '好的' }, stop, o);
export const toolUse = (name: string, id: string, input: Record<string, unknown>, o: Opts = {}) =>
  assistantBlock({ type: 'tool_use', id, name, input }, 'tool_use', o);
export const aiTitle = (title: string) => JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: 'x' });
export const attachment = (o: Opts = {}) =>
  JSON.stringify({ type: 'attachment', cwd: o.cwd ?? CWD, timestamp: stamp(o.at), attachment: {} });
