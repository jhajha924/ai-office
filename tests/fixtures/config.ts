import type { OfficeConfig } from '../../server/src/office/config.ts';
import { DEFAULT_CONFIG } from '../../server/src/office/config.ts';

/**
 * The two-building setup most tests run against: D:\work\ is a masked 工作樓,
 * everything else the 私人樓, and one per-building title override. The built-in
 * defaults have a single 辦公室 building, so tests about buildings and masking use
 * this instead.
 */
export const TWO_BUILDINGS: OfficeConfig = {
  ...DEFAULT_CONFIG,
  buildings: {
    rules: [{ prefix: 'D:\\work\\', building: '工作樓', mask: true }],
    default: { building: '私人樓', mask: false },
  },
  buildingOverrides: { 工作樓: { skills: { 'speclink-apply': '專案開發工程師' } } },
};
