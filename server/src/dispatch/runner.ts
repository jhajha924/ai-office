import { spawn } from 'node:child_process';

import type { AgentRequest, AgentRunner, CallUsage, RunResult } from './types.ts';

/**
 * Runs one president / manager call through `claude -p`. Never through a
 * shell, never with bypassPermissions: read-only tools under dontAsk, no
 * session saved (so the transcript observer never sees these calls), the
 * prompt on stdin instead of the command line.
 *
 * Measured with Claude Code 2.1.118 (see design.md「用量紀錄」): the JSON
 * result carries the structured output in `structured_output`; `result` is
 * then an empty string.
 */

export const CALL_TIMEOUT_MS = 5 * 60_000;
/** stdout above this is not a result we can use. */
const MAX_STDOUT = 4 * 1024 * 1024;

export const READ_ONLY_TOOLS = 'Read,Glob,Grep';

/** The full argument list for one call. */
export function claudeArgs(request: Pick<AgentRequest, 'model' | 'schema'>): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(request.schema),
    '--model',
    request.model,
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    READ_ONLY_TOOLS,
    '--no-session-persistence',
  ];
}

const ROLE_NAME = { president: '總裁', manager: '經理' } as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Reads one `--output-format json` result; exported for the tests. */
export function parseResult(stdout: string, role: AgentRequest['role']): RunResult {
  const who = ROLE_NAME[role];
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: `${who}的回覆不是 JSON` };
  }
  if (!isObject(json)) return { ok: false, reason: `${who}的回覆不是 JSON` };
  const usage: CallUsage = {
    turns: typeof json.num_turns === 'number' ? json.num_turns : 0,
    durationMs: typeof json.duration_ms === 'number' ? json.duration_ms : 0,
    ...(isObject(json.usage) ? { tokens: json.usage } : {}),
    ...(typeof json.total_cost_usd === 'number' ? { costUsd: json.total_cost_usd } : {}),
  };
  if (json.is_error === true || (typeof json.subtype === 'string' && json.subtype !== 'success')) {
    return { ok: false, reason: `${who}執行失敗`, usage };
  }
  let output: unknown = json.structured_output;
  if (!isObject(output) && typeof json.result === 'string') {
    try {
      output = JSON.parse(json.result);
    } catch {
      output = undefined;
    }
  }
  if (!isObject(output)) return { ok: false, reason: `${who}沒有給出規定格式的結果`, usage };
  return { ok: true, output, usage };
}

export interface ClaudeRunnerOptions {
  /** The claude executable (found by cli.ts). */
  file: string;
  /** Arguments placed before claudeArgs; the tests run a node script this way. */
  prefixArgs?: string[];
  timeoutMs?: number;
}

export class ClaudeRunner implements AgentRunner {
  private readonly options: ClaudeRunnerOptions;

  constructor(options: ClaudeRunnerOptions) {
    this.options = options;
  }

  run(request: AgentRequest): Promise<RunResult> {
    const who = ROLE_NAME[request.role];
    const timeoutMs = this.options.timeoutMs ?? CALL_TIMEOUT_MS;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: RunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.options.file, [...(this.options.prefixArgs ?? []), ...claudeArgs(request)], {
          cwd: request.cwd,
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch {
        resolve({ ok: false, reason: `${who}無法啟動` });
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        finish({ ok: false, reason: `${who}逾時` });
      }, timeoutMs);
      let stdout = '';
      let tooBig = false;
      child.stdout!.setEncoding('utf-8');
      child.stdout!.on('data', (chunk: string) => {
        if (tooBig) return;
        stdout += chunk;
        if (stdout.length > MAX_STDOUT) {
          tooBig = true;
          child.kill();
        }
      });
      child.on('error', () => finish({ ok: false, reason: `${who}無法啟動` }));
      child.on('close', (code) => {
        if (tooBig) return finish({ ok: false, reason: `${who}的回覆太長` });
        if (code !== 0) return finish({ ok: false, reason: `${who}執行失敗` });
        finish(parseResult(stdout, request.role));
      });
      // A closed pipe (the program died early) must not crash the server.
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(request.prompt, 'utf-8');
    });
  }
}
