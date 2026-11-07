/**
 * Day and night by the browser's local clock: three phases, checked once a
 * minute. ?hour=0..23 pins the hour so screenshots of each phase can be taken.
 */

export type Phase = 'day' | 'dusk' | 'night';

/** 07:00–16:59 day, 17:00–18:59 dusk, 19:00–06:59 night. */
export function phaseAt(hour: number): Phase {
  if (hour >= 7 && hour < 17) return 'day';
  if (hour >= 17 && hour < 19) return 'dusk';
  return 'night';
}

/** The pinned hour from a query string; undefined unless it is an integer 0–23. */
export function hourFromQuery(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('hour');
  if (raw === null || !/^\d{1,2}$/.test(raw)) return undefined;
  const hour = Number(raw);
  return hour <= 23 ? hour : undefined;
}

export interface Lighting {
  background: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sunColor: number;
  sunIntensity: number;
  /** Floor lamp and desk-area lights. */
  lampsOn: boolean;
}

export const LIGHTING: Record<Phase, Lighting> = {
  day: { background: 0xf4f1ea, hemiSky: 0xfffaf0, hemiGround: 0x8a7d6a, hemiIntensity: 1.1, sunColor: 0xfff1dc, sunIntensity: 1.7, lampsOn: false },
  dusk: { background: 0xe9d3bf, hemiSky: 0xffd2a8, hemiGround: 0x6e5a4a, hemiIntensity: 0.85, sunColor: 0xffa15c, sunIntensity: 1.1, lampsOn: true },
  night: { background: 0x2a3142, hemiSky: 0x8fa3d6, hemiGround: 0x2a2633, hemiIntensity: 0.55, sunColor: 0x9fb4ff, sunIntensity: 0.35, lampsOn: true },
};
