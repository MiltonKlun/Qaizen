// @ts-check
// Small-sample statistics shared by the evaluations and the metrics.
//
// Pure.

/** z for a two-sided 95% interval. */
const Z_95 = 1.959964;

const round4 = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;

/**
 * The Wilson score interval for `successes` out of `n`, at 95%. It stays
 * inside [0, 1] and is honest at small n, where 7 of 10 is consistent with
 * anything from about 40% to 89%.
 * @param {number} successes
 * @param {number} n
 * @returns {[number, number] | null} null when nothing was tried
 */
export function wilson(successes, n) {
  if (!n) return null;
  const p = successes / n;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [
    round4(Math.max(0, centre - half)),
    round4(Math.min(1, centre + half)),
  ];
}

/**
 * A share with its interval.
 * @param {number} successes
 * @param {number} n
 * @returns {{ value: number | null, wilson_95: [number, number] | null }}
 */
export const rate = (successes, n) => ({
  value: n ? round4(successes / n) : null,
  wilson_95: wilson(successes, n),
});
