import type { OfficeConfig } from './config.ts';
import { mcpWindowName } from './roster.ts';

/**
 * Chinese status bubbles, with masking for buildings that hide details.
 *
 * A masked building keeps only the kind of action: no file names, commands or
 * subtask descriptions. Tool names are not sensitive, so an unknown tool still
 * shows as "使用 <tool>" on every building.
 */

const COMMAND_MAX_CHARS = 40;

/** Last path segment of a file path, either separator. */
export function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : filePath;
}

/** One line, at most `max` characters, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(oneLine);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : oneLine;
}

interface ToolRule {
  /** Unmasked text from the (already trimmed) detail; may be empty. */
  plain: (detail: string) => string;
  masked: string;
}

const withDetail =
  (verb: string, separator: string, fallback: string, shape: (d: string) => string = (d) => d) =>
  (detail: string): string =>
    detail ? `${verb}${separator}${shape(detail)}` : fallback;

const fixed = (text: string): ToolRule => ({ plain: () => text, masked: text });

const TOOL_RULES: Record<string, ToolRule> = {
  Read: { plain: withDetail('讀取', ' ', '讀取檔案', baseName), masked: '讀取檔案' },
  Edit: { plain: withDetail('修改', ' ', '修改檔案', baseName), masked: '修改檔案' },
  MultiEdit: { plain: withDetail('修改', ' ', '修改檔案', baseName), masked: '修改檔案' },
  Write: { plain: withDetail('新增', ' ', '新增檔案', baseName), masked: '新增檔案' },
  NotebookEdit: fixed('修改筆記本'),
  Bash: {
    plain: withDetail('執行指令', '：', '執行指令', (d) => clip(d, COMMAND_MAX_CHARS)),
    masked: '執行指令',
  },
  PowerShell: {
    plain: withDetail('執行指令', '：', '執行指令', (d) => clip(d, COMMAND_MAX_CHARS)),
    masked: '執行指令',
  },
  Agent: { plain: withDetail('派出子任務', '：', '派出子任務'), masked: '派出子任務' },
  Task: { plain: withDetail('派出子任務', '：', '派出子任務'), masked: '派出子任務' },
  Glob: fixed('搜尋檔案'),
  Grep: fixed('搜尋程式'),
  WebSearch: fixed('搜尋網路'),
  WebFetch: fixed('查網路'),
  AskUserQuestion: fixed('等你回答'),
  ExitPlanMode: fixed('規劃中'),
  EnterPlanMode: fixed('規劃中'),
  Skill: fixed('叫用技能'),
  SendMessage: fixed('傳送訊息'),
  TeamCreate: fixed('建立團隊'),
};

/** Chinese bubble for a tool call; `mask` drops every detail but the kind of action. */
export function toolStatus(
  tool: string,
  detail: string | undefined,
  mask: boolean,
  config: OfficeConfig,
): string {
  const window = mcpWindowName(tool, config);
  if (window !== undefined) return `呼叫 ${window}`;
  const rule = TOOL_RULES[tool];
  if (!rule) return `使用 ${tool}`;
  return mask ? rule.masked : rule.plain((detail ?? '').trim());
}

/** Bubble of a sub-agent at its desk: what it was sent to do. */
export function subtaskStatus(detail: string | undefined, mask: boolean): string {
  const text = (detail ?? '').trim();
  return mask || !text ? '處理子任務' : clip(text, COMMAND_MAX_CHARS);
}

/** Bubbles for the states that are not a tool call. */
export const STATE_BUBBLES = {
  'idle-new': '待命',
  thinking: '思考中…',
  replying: '回覆中',
  done: '完成了',
  waiting: '等你核准',
  idle: '閒置',
  dozing: '打瞌睡',
} as const;
