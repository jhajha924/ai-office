#!/usr/bin/env node
/**
 * npm run check:public — make sure no personal data goes into the public repository.
 *
 * Scans every file a commit would take — tracked or new, not ignored —
 * (binary files skipped) for:
 * - e-mail addresses, except users.noreply.github.com and example.com ones;
 * - every string in the personal blocklist at ~/.ai-office/public-blocklist.txt
 *   (one per line, case-insensitive, # starts a comment). The blocklist lives in
 *   the home folder on purpose: it is personal data itself.
 *
 * Prints "<file>:<line>: <rule>" per hit and exits 1, or prints
 * 「沒有發現個人資料」 and exits 0.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const ALLOWED_EMAIL_DOMAINS = ['users.noreply.github.com', 'example.com'];
/** A NUL byte in this much of a file's head marks it binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;

export function defaultBlocklistPath() {
  return path.join(os.homedir(), '.ai-office', 'public-blocklist.txt');
}

/** The blocklist entries, or [] when the file does not exist. */
export function loadBlocklist(file = defaultBlocklistPath()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export function isBinary(buffer) {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * Hits in the given text files.
 * @param {{ path: string, text: string }[]} files
 * @param {string[]} blocklist
 * @returns {{ path: string, line: number, rule: string }[]}
 */
export function findHits(files, blocklist) {
  const words = blocklist.map((w) => ({ word: w, lower: w.toLowerCase() }));
  const hits = [];
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const match of text.matchAll(EMAIL)) {
        const domain = match[1].toLowerCase();
        if (!ALLOWED_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) {
          hits.push({ path: file.path, line: i + 1, rule: `信箱 ${match[0]}` });
        }
      }
      const lower = text.toLowerCase();
      for (const { word, lower: w } of words) {
        if (lower.includes(w)) hits.push({ path: file.path, line: i + 1, rule: `黑名單 ${word}` });
      }
    });
  }
  return hits;
}

export function formatHit(hit) {
  return `${hit.path}:${hit.line}: ${hit.rule}`;
}

/**
 * The text files that would go into a commit: tracked ones plus new files
 * git does not ignore, with forward-slash paths.
 */
export function trackedTextFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf-8',
  });
  const files = [];
  for (const rel of out.split('\0').filter(Boolean)) {
    let buffer;
    try {
      buffer = fs.readFileSync(path.join(root, rel));
    } catch {
      continue; // deleted in the working tree but still in the index
    }
    if (!isBinary(buffer)) files.push({ path: rel.replace(/\\/g, '/'), text: buffer.toString('utf-8') });
  }
  return files;
}

/** Runs the whole check; returns the exit code. */
export function main(root = process.cwd(), blocklistFile = defaultBlocklistPath(), log = console.log) {
  const hits = findHits(trackedTextFiles(root), loadBlocklist(blocklistFile));
  if (hits.length === 0) {
    log('沒有發現個人資料');
    return 0;
  }
  for (const hit of hits) log(formatHit(hit));
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
