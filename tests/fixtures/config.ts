import type { OfficeConfig } from '../../server/src/office/config.ts';
import { DEFAULT_CONFIG } from '../../server/src/office/config.ts';

/**
 * The two-floor setup most tests run against: D:\work\ is a masked 工作樓,
 * everything else the 私人樓, and one per-floor title override. The built-in
 * defaults have a single 辦公室 floor, so tests about floors and masking use
 * this instead.
 */
export const TWO_FLOORS: OfficeConfig = {
  ...DEFAULT_CONFIG,
  floors: {
    rules: [{ prefix: 'D:\\work\\', floor: '工作樓', mask: true }],
    default: { floor: '私人樓', mask: false },
  },
  floorOverrides: { 工作樓: { skills: { 'speclink-apply': '專案開發工程師' } } },
};
