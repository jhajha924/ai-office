import type { DispatchSettings } from '../office/config.ts';
import type { AgentRequest, AgentRunner, RunResult } from './types.ts';

/**
 * Demo mode's president, managers and workers: fixed answers after a short
 * delay, so anyone can try 交辦 without claude. Never starts a program, never
 * writes a file; the folders are made up. The 3F worker asks one question
 * first, so the decision card shows up too (and 6F, like a real run, first
 * asks which check to run).
 */

export const DEMO_DISPATCH: DispatchSettings = {
  building: '私人樓',
  workRoot: 'C:\\Projects\\personal\\',
  models: { president: 'opus', manager: 'sonnet' },
};

export const DEMO_DELAY_MS = 3_000;
export const DEMO_FOLDER = '示範專案';
const RESEARCH_WORDS = ['研究', '調查', '整理'];
const TITLE_CHARS = 15;

export const DEMO_ROUTES = {
  research: ['analysis', 'release'],
  code: ['analysis', 'spec', 'build', 'qa', 'release'],
} as const;

export const DEMO_QUESTION = { text: '這頁要放幾件作品？', options: ['6 件', '12 件'] };
export const DEMO_CHANGE = 'demo-portfolio';

export function demoAnswer(request: AgentRequest): Record<string, unknown> {
  if (request.input.role === 'worker') {
    const { theme, resumed } = request.input;
    if (theme === 'analysis' && !resumed) {
      return { outcome: 'question', summary: '列出了三個假設，請你確認', handoff: '', question: { ...DEMO_QUESTION, options: [...DEMO_QUESTION.options] } };
    }
    return {
      outcome: 'done',
      summary: `示範：${theme} 站完成`,
      handoff: `示範：交給下一站的重點（${theme}）`,
      ...(theme === 'spec' ? { change: DEMO_CHANGE } : {}),
    };
  }
  if (request.input.role === 'president') {
    const text = request.input.text;
    const research = RESEARCH_WORDS.some((w) => text.includes(w));
    return {
      projects: [
        {
          title: [...text].slice(0, TITLE_CHARS).join(''),
          kind: research ? 'research' : 'code',
          cwd: research ? null : `${DEMO_DISPATCH.workRoot}${DEMO_FOLDER}`,
          brief: text,
        },
      ],
    };
  }
  return { route: [...DEMO_ROUTES[request.input.kind]], doneWhen: {}, risks: [] };
}

export class DemoRunner implements AgentRunner {
  private readonly delayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(delayMs = DEMO_DELAY_MS, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.delayMs = delayMs;
    this.sleep = sleep;
  }

  async run(request: AgentRequest): Promise<RunResult> {
    await this.sleep(this.delayMs);
    return { ok: true, output: demoAnswer(request), usage: { turns: 0, durationMs: 0 } };
  }
}
