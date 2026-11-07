import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error plain JavaScript module without type declarations
import { findHits, formatHit, isBinary, main } from '../scripts/check-public.mjs';

type Hit = { path: string; line: number; rule: string };
// The spec's example values, assembled at run time so this file itself passes the check.
const PERSONAL_WORD = ['side', 'project'].join('_');
const PRIVATE_EMAIL = ['someone', 'gmail.com'].join('@');
const hits = (text: string, blocklist: string[] = []): Hit[] => findHits([{ path: 'a.md', text }], blocklist);

describe('check:public', () => {
  // office-public-distribution spec, Example: 內建信箱規則
  it.each([
    [PRIVATE_EMAIL, true],
    ['12345+jhajha924@users.noreply.github.com', false],
    ['user@example.com', false],
    ['沒有信箱的一般文字', false],
  ])('%s → hit %s', (text, hit) => {
    expect(hits(text).length > 0).toBe(hit);
  });

  // office-public-distribution spec, Scenario: 誤加了個人路徑
  it('reports a blocklisted string with its file and line, case-insensitively', () => {
    const readme = [...Array.from({ length: 11 }, (_, i) => `第 ${i + 1} 行`), `D:\\${PERSONAL_WORD.toUpperCase()}\\demo`].join('\n');
    const found: Hit[] = findHits([{ path: 'README.md', text: readme }], [PERSONAL_WORD]);
    expect(found.map(formatHit)).toEqual([`README.md:12: 黑名單 ${PERSONAL_WORD}`]);
  });

  it('skips binary files', () => {
    expect(isBinary(Buffer.from([0x89, 0x50, 0x00, 0x47]))).toBe(true);
    expect(isBinary(Buffer.from('純文字', 'utf-8'))).toBe(false);
  });

  // office-public-distribution spec, Scenario: 乾淨的程式庫
  it('finds no personal data in the tracked files of this repository', () => {
    const lines: string[] = [];
    const code = main(path.join(import.meta.dirname, '..'), undefined, (l: string) => lines.push(l));
    expect(lines).toEqual(['沒有發現個人資料']);
    expect(code).toBe(0);
  });
});
