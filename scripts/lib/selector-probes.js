// @ts-check
// Selector survival from reviewed probes (task group 9.1, finding I7).
//
// A probe is reviewed benchmark code: `locate(page)` returns the exact
// Playwright locator a test relies on, `cardinality` is 1 (one intended
// target), and an optional `usable(locator)` states what "usable" means for
// that target (visible by default). The module's `prepare(page, { baseURL })`
// performs the navigation or login the targets need.
//
// The survival rule, per probe:
//   * on the named baseline it must resolve exactly one usable target, or the
//     measurement is invalid;
//   * on every later version it survives only when the same function still
//     resolves exactly one usable target. Two matches fail strictness, as the
//     original single-element action would.
// Rate = probes surviving every later version / valid baseline probes. If a
// setup, a probe, or a version cannot be measured, the rate is null with the
// reason: a hard case is never dropped to improve the number.

/**
 * @typedef {import('@playwright/test').Page} Page
 * @typedef {import('@playwright/test').Locator} Locator
 * @typedef {{ id: string, cardinality: number,
 *   locate: (page: Page) => Locator,
 *   usable?: (locator: Locator) => unknown }} Probe
 * @typedef {{probe: string, count: number|null, usable: boolean|null,
 *   resolved: boolean, error?: string}} ProbeResult
 * @typedef {{name: string, setup_error?: string,
 *   results?: ProbeResult[]}} VersionEvidence
 */

/**
 * Check a loaded probe module; returns the problems (empty when usable).
 * @param {any} mod the imported module, not yet trusted
 * @returns {string[]}
 */
export function probeModuleProblems(mod) {
  /** @type {string[]} */
  const problems = [];
  if (typeof mod?.prepare !== 'function') {
    problems.push('it must export prepare(page, { baseURL })');
  }
  const probes = mod?.probes;
  if (!Array.isArray(probes) || probes.length === 0) {
    problems.push('it must export a non-empty `probes` array');
    return problems;
  }
  /** @type {Set<string>} */
  const ids = new Set();
  for (const [i, p] of probes.entries()) {
    const at = `probes[${i}]`;
    if (typeof p?.id !== 'string' || !p.id) problems.push(`${at} needs an id`);
    else if (ids.has(p.id)) problems.push(`probe id "${p.id}" is repeated`);
    else ids.add(p.id);
    if (typeof p?.locate !== 'function') {
      problems.push(`${at} needs locate(page)`);
    }
    if (p?.cardinality !== 1) {
      problems.push(
        `${at} must declare cardinality: 1 (one intended target; other cardinalities are not measured)`
      );
    }
    if (p?.usable !== undefined && typeof p.usable !== 'function') {
      problems.push(`${at}.usable must be a function of the locator`);
    }
  }
  return problems;
}

/**
 * Run every probe against one prepared page.
 * @param {Page} page
 * @param {Probe[]} probes
 * @returns {Promise<ProbeResult[]>}
 */
export async function runProbes(page, probes) {
  /** @type {ProbeResult[]} */
  const out = [];
  for (const p of probes) {
    try {
      const loc = p.locate(page);
      const count = await loc.count();
      /** @type {boolean | null} */
      let usable = null;
      if (count === 1) {
        usable = p.usable
          ? Boolean(await p.usable(loc))
          : await loc.isVisible();
      }
      out.push({
        probe: p.id,
        count,
        usable,
        resolved: count === 1 && usable === true,
      });
    } catch (e) {
      out.push({
        probe: p.id,
        count: null,
        usable: null,
        resolved: false,
        error: e instanceof Error ? e.message.split('\n')[0] : String(e),
      });
    }
  }
  return out;
}

/**
 * The survival result from per-version evidence.
 * @param {string[]} probeIds
 * @param {VersionEvidence} baseline
 * @param {VersionEvidence[]} later
 */
export function survivalResult(probeIds, baseline, later) {
  const unmeasurable = (/** @type {string} */ reason) => ({
    selector_survival_rate: null,
    numerator: null,
    denominator: null,
    reason,
  });
  const byProbe = (/** @type {VersionEvidence} */ v) =>
    new Map((v.results ?? []).map((r) => [r.probe, r]));

  if (later.length === 0) {
    return unmeasurable('fewer than two distinct app versions');
  }
  if (baseline.setup_error) {
    return unmeasurable(
      `setup failed on the baseline ${baseline.name}: ${baseline.setup_error}`
    );
  }
  const base = byProbe(baseline);
  const broken = probeIds.filter((id) => !base.get(id)?.resolved);
  if (broken.length) {
    return unmeasurable(
      `on the baseline ${baseline.name}, ${broken
        .map((id) => {
          const r = base.get(id);
          return r?.error
            ? `${id} could not be evaluated (${r.error})`
            : `${id} found ${r?.count ?? 0} target(s)${r?.count === 1 ? ' but not a usable one' : ''}`;
        })
        .join('; ')}: the probes do not identify their intended unique targets`
    );
  }
  for (const v of later) {
    if (v.setup_error) {
      return unmeasurable(`setup failed on ${v.name}: ${v.setup_error}`);
    }
    const errored = (v.results ?? []).filter((r) => r.error);
    if (errored.length) {
      return unmeasurable(
        `on ${v.name}, ${errored.map((r) => `${r.probe} could not be evaluated (${r.error})`).join('; ')}`
      );
    }
  }
  const survived = probeIds.filter((id) =>
    later.every((v) => byProbe(v).get(id)?.resolved === true)
  );
  return {
    selector_survival_rate: survived.length / probeIds.length,
    numerator: survived.length,
    denominator: probeIds.length,
    survived,
    lost: probeIds.filter((id) => !survived.includes(id)),
  };
}
