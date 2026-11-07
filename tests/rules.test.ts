import { describe, expect, it } from 'vitest';

import { TWO_FLOORS } from './fixtures/config.ts';
import { floorForCwd, floorForProjectDir, floorForSession } from '../server/src/office/floorRouting.ts';
import { firstUserMessage, labelFromLines, placeholderLabel, shortenLabel } from '../server/src/office/groupLabel.ts';
import { mcpServerName, mcpWindowName, skillTitle, subagentTitle } from '../server/src/office/roster.ts';
import { toolStatus } from '../server/src/office/statusText.ts';

const config = TWO_FLOORS;

describe('floorRouting', () => {
  // office-floor-routing spec, Example: 前綴比對結果
  it.each([
    ['D:\\work\\app', '工作樓'],
    ['d:/WORK/tools/', '工作樓'],
    ['D:\\home\\recipes', '私人樓'],
    ['D:\\workX\\demo', '私人樓'],
    ['C:\\Users\\User\\Downloads', '私人樓'],
  ])('routes cwd %s to %s', (cwd, floor) => {
    expect(floorForCwd(cwd, config).floor).toBe(floor);
  });

  it('prefers the longest matching prefix', () => {
    const nested = {
      ...config,
      floors: {
        ...config.floors,
        rules: [...config.floors.rules, { prefix: 'D:\\work\\dashboard', floor: '看板樓', mask: false }],
      },
    };
    expect(floorForCwd('D:\\work\\dashboard\\backend', nested)).toEqual({ floor: '看板樓', mask: false });
    expect(floorForCwd('D:\\work\\app', nested).floor).toBe('工作樓');
  });

  it.each([
    ['d--work-app', '工作樓'],
    ['D--work-tools', '工作樓'],
    ['d--home-notes', '私人樓'],
    ['d--workX-demo', '私人樓'],
    ['C--Users-User', '私人樓'],
  ])('routes project folder %s to %s', (dir, floor) => {
    expect(floorForProjectDir(dir, config).floor).toBe(floor);
  });

  it('decides a session floor by its start cwd, then its folder, then its latest cwd', () => {
    const temp = 'C:/Users/User/AppData/Local/Temp/x';
    expect(floorForSession({ cwd: 'D:/work/app', projectDir: 'x' }, temp, config).floor).toBe('工作樓');
    expect(floorForSession({ projectDir: 'd--work-app' }, temp, config).floor).toBe('工作樓');
    expect(floorForSession(undefined, 'D:/work/a', config).floor).toBe('工作樓');
  });

  it('carries the mask flag of each floor', () => {
    expect(floorForCwd('D:\\work\\x', config).mask).toBe(true);
    expect(floorForCwd('D:\\home\\x', config).mask).toBe(false);
  });
});

describe('roster', () => {
  // office-staff-roster spec, Example: 子代理職稱對應
  it.each([
    ['Explore', '資料調查員'],
    ['Plan', '系統架構師'],
    ['general-purpose', '支援專員'],
    ['claude-code-guide', '支援專員'],
  ])('titles subagent_type %s as %s', (subagentType, title) => {
    expect(subagentTitle(subagentType, '私人樓', config)).toBe(title);
  });

  it('falls back to the fallback subagent title when no type is given', () => {
    expect(subagentTitle(undefined, '私人樓', config)).toBe('支援專員');
  });

  it('applies the floor override before the roster', () => {
    expect(skillTitle('speclink-apply', '工作樓', config)).toBe('專案開發工程師');
    expect(skillTitle('speclink-apply', '私人樓', config)).toBe('開發工程師');
    expect(skillTitle('speclink-review', '工作樓', config)).toBe('品管工程師');
  });

  it('builds a fallback skill title from the template', () => {
    expect(skillTitle('dataviz', '私人樓', config)).toBe('dataviz 專員');
  });

  it('names the MCP window from the server segment of the tool name', () => {
    expect(mcpWindowName('mcp__github__create_issue', config)).toBe('github 外包窗口');
    expect(mcpServerName('mcp__my_server__do_thing')).toBe('my_server');
    expect(mcpWindowName('mcp__claude-vscode__getDiagnostics', config)).toBe('claude-vscode 外包窗口');
    expect(mcpWindowName('Read', config)).toBeUndefined();
    expect(mcpWindowName('mcp__github', config)).toBeUndefined();
  });
});

describe('statusText', () => {
  // office-staff-roster spec, Example: 中文泡泡對照（未遮罩）
  it.each([
    ['Read', '/p/proposal.md', '讀取 proposal.md'],
    ['Edit', '/p/main.ts', '修改 main.ts'],
    ['Write', '/p/notes.md', '新增 notes.md'],
    ['Bash', 'npm test', '執行指令：npm test'],
    ['Grep', undefined, '搜尋程式'],
    ['WebFetch', undefined, '查網路'],
    ['Agent', '找出工單程式', '派出子任務：找出工單程式'],
    ['AskUserQuestion', undefined, '等你回答'],
  ])('translates %s to Chinese', (tool, detail, expected) => {
    expect(toolStatus(tool, detail, false, config)).toBe(expected);
  });

  // office-staff-roster spec, Example: 遮罩前後
  it.each([
    ['Read', 'D:\\work\\app\\Billing.pas', '讀取 Billing.pas', '讀取檔案'],
    ['Bash', 'sqlcmd -S db -U sa -P secret', '執行指令：sqlcmd -S db -U sa -P secret', '執行指令'],
    ['Agent', '找批價程式', '派出子任務：找批價程式', '派出子任務'],
  ])('masks %s on a masked floor', (tool, detail, plain, masked) => {
    expect(toolStatus(tool, detail, false, config)).toBe(plain);
    expect(toolStatus(tool, detail, true, config)).toBe(masked);
  });

  it('never lets any part of a Bash command through when masked', () => {
    const masked = toolStatus('Bash', 'sqlcmd -S db -U sa -P secret', true, config);
    for (const part of ['sqlcmd', 'db', 'sa', 'secret']) expect(masked).not.toContain(part);
  });

  it('shows an MCP call as its outsourcing window, masked or not', () => {
    expect(toolStatus('mcp__github__create_issue', undefined, false, config)).toBe('呼叫 github 外包窗口');
    expect(toolStatus('mcp__github__create_issue', undefined, true, config)).toBe('呼叫 github 外包窗口');
  });

  it('keeps other tools as "使用 <tool>"', () => {
    expect(toolStatus('TodoWrite', undefined, true, config)).toBe('使用 TodoWrite');
  });
});

/** One transcript line per record, in the shape Claude Code writes. */
const user = (content: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

describe('groupLabel', () => {
  // office-session-groups spec, Example: 名稱擷取
  it.each([
    [user('SY010 包裝明細 Hint'), 'SY010 包裝明細 Hint'],
    [user('Order 同群組批價更新時要一併更新同採購單號的其他明細'), 'Order 同群組批價更新時要…'],
    [
      user(
        '<command-message>speclink-apply</command-message>\n<command-name>/speclink-apply</command-name>\n<command-args>add-dark-mode</command-args>',
      ),
      '/speclink-apply…',
    ],
  ])('labels %s', (line, label) => {
    expect(labelFromLines([line], 15)).toBe(label);
  });

  it('skips meta records, system reminders, IDE context and tool results', () => {
    const lines = [
      JSON.stringify({ type: 'summary', summary: 'x' }),
      user([{ type: 'text', text: 'Base directory for this skill: …' }], { isMeta: true }),
      user([
        { type: 'text', text: '<ide_opened_file>The user opened d:\\a.md</ide_opened_file>' },
        { type: 'text', text: '<system-reminder>be nice</system-reminder>' },
      ]),
      user([{ type: 'tool_result', tool_use_id: 't', content: 'output' }]),
      assistant('hello'),
      user([{ type: 'text', text: '<system-reminder>ctx</system-reminder>\n\n看板樓放 git' }]),
    ];
    expect(labelFromLines(lines, 15)).toBe('看板樓放 git');
  });

  it('keeps the text inside a pasted block', () => {
    expect(firstUserMessage([user('\n\n<pasted_content id="06ee">\n這是新的需求\n</pasted_content>')])).toBe(
      '這是新的需求',
    );
  });

  it('has no label while the head holds no user message, and a placeholder for that case', () => {
    expect(labelFromLines([assistant('hi')], 15)).toBeUndefined();
    expect(placeholderLabel('8f3c1234')).toBe('對話 8f3c');
  });

  it('only looks at the first 200 lines', () => {
    const lines = [...Array.from({ length: 200 }, () => assistant('x')), user('太晚了')];
    expect(labelFromLines(lines, 15)).toBeUndefined();
  });

  it('cuts by characters, not bytes', () => {
    expect(shortenLabel('一二三四五六', 5)).toBe('一二三四五…');
    expect(shortenLabel('一二三四五', 5)).toBe('一二三四五');
  });
});
