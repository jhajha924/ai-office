import type { DispatchSettings } from '../office/config.ts';
import type { AgentRequest, AgentRunner, RunResult } from './types.ts';

/**
 * Demo mode's president and managers: fixed answers after a short delay, so
 * anyone can try 交辦 without claude. Never starts a program, never writes a
 * file; the folders are made up.
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

export function demoAnswer(request: AgentRequest): Record<string, unknown> {
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
