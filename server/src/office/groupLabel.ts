/**
 * Group label, shown under a session's main character so several sessions
 * can be told apart: the conversation title Claude Code writes into the
 * transcript (ai-title records, the latest one wins), or — while there is no
 * title yet — the session's first user message. Both are shortened the same
 * way. The label lives in memory only and is never written to a file or a log.
 */

/** How many transcript lines from the head are searched for a title and the first user message. */
export const LABEL_HEAD_LINES = 200;

/** Wrapper elements the harness or the IDE injects into user turns: dropped whole. */
const INJECTED_ELEMENTS = [
  'system-reminder',
  'ide_opened_file',
  'ide_selection',
  'local-command-stdout',
  'local-command-stderr',
  'local-command-caveat',
];

/** Readable text of one user text block, or '' when it holds nothing the user typed. */
export function userTextOf(raw: string): string {
  const commandName = /<command-name>([\s\S]*?)<\/command-name>/.exec(raw);
  if (commandName) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw);
    return `${commandName[1].trim()} ${args ? args[1].trim() : ''}`.trim();
  }
  let text = raw;
  for (const tag of INJECTED_ELEMENTS) {
    text = text.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'g'), ' ');
  }
  // Keep what is inside any remaining wrapper (e.g. pasted_content), drop the tags.
  text = text.replace(/<\/?[a-z_-]+(?:\s[^>]*)?>/gi, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

/** The text blocks of a user record, or [] when it is not something the user typed. */
export function userTextBlocks(record: {
  type?: unknown;
  isMeta?: unknown;
  message?: { content?: unknown };
}): string[] {
  if (record.type !== 'user' || record.isMeta === true) return [];
  const content = record.message?.content;
  const blocks: unknown[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  const out: string[] = [];
  for (const block of blocks) {
    const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown };
    if (type === 'text' && typeof text === 'string') out.push(text);
  }
  return out;
}

/** The first thing the user typed in a transcript's JSONL lines, if any. */
export function firstUserMessage(lines: Iterable<string>): string | undefined {
  for (const line of lines) {
    let record: Parameters<typeof userTextBlocks>[0];
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    for (const text of userTextBlocks(record)) {
      const userText = userTextOf(text);
      if (userText) return userText;
    }
  }
  return undefined;
}

/** The aiTitle of an ai-title record, or undefined for any other record. */
export function titleOf(record: { type?: unknown; aiTitle?: unknown }): string | undefined {
  if (record.type !== 'ai-title' || typeof record.aiTitle !== 'string') return undefined;
  const title = record.aiTitle.replace(/\s+/g, ' ').trim();
  return title || undefined;
}

/** The latest conversation title among the lines, if any. */
export function latestTitle(lines: Iterable<string>): string | undefined {
  let found: string | undefined;
  for (const line of lines) {
    if (!line.includes('"ai-title"')) continue;
    try {
      found = titleOf(JSON.parse(line)) ?? found;
    } catch {
      // A broken line: keep looking.
    }
  }
  return found;
}

/** First `max` characters (code points), with an ellipsis when cut. */
export function shortenLabel(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/** "對話 <first 4 of the session id>", shown until a title or a first user message is found. */
export function placeholderLabel(sessionId: string): string {
  return `對話 ${sessionId.slice(0, 4)}`;
}

/** The shortened title, else first user message, among the head lines; undefined while there is neither. */
export function labelFromLines(lines: string[], maxChars: number): string | undefined {
  const head = lines.slice(0, LABEL_HEAD_LINES);
  const text = latestTitle(head) ?? firstUserMessage(head);
  return text ? shortenLabel(text, maxChars) : undefined;
}
