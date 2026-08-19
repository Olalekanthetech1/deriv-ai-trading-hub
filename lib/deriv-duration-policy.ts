/**
 * Canonical Deriv duration bands used by the application.
 *
 * Deriv's proposal API accepts the same elapsed duration through multiple
 * units (for example, 60 seconds and 1 minute). We intentionally keep those
 * units semantically distinct in the UI and ML pipeline so a duration does
 * not drift into an unrelated unit merely because the broker accepts the
 * equivalent number of seconds.
 *
 * Deriv's public guidance describes the overall options duration window as
 * 15 seconds through 365 days. The application exposes that window through
 * explicit unit bands:
 *   seconds: 15-60
 *   minutes: 1-60
 *   hours: 1-24
 *   days: 1-365
 *
 * Tick durations remain separately discovered and are not changed by this
 * policy.
 */
export type DerivTimeDurationUnit = 's' | 'm' | 'h' | 'd';

export type DerivDurationBand = {
  min: number;
  max: number;
};

export const DERIV_DURATION_POLICY_VERSION = 'v2';

export const DERIV_TIME_DURATION_BANDS: Record<DerivTimeDurationUnit, DerivDurationBand> = {
  s: { min: 15, max: 60 },
  m: { min: 1, max: 60 },
  h: { min: 1, max: 24 },
  d: { min: 1, max: 365 },
};

export function getDerivDurationBand(unit: DerivTimeDurationUnit): DerivDurationBand {
  return DERIV_TIME_DURATION_BANDS[unit];
}

export function isWithinDerivDurationBand(value: number, unit: DerivTimeDurationUnit): boolean {
  if (!Number.isSafeInteger(value)) return false;
  const band = getDerivDurationBand(unit);
  return value >= band.min && value <= band.max;
}
