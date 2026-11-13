// @ts-check
// Module resolve hook (register.js): `@playwright/test` or `playwright/test`,
// imported by the project's own code (a test, a fixtures module), resolves
// to the shim, so a test's `test` records its action targets. Imports from
// the shim itself or from installed packages (`@playwright/test` itself
// imports `playwright/test`) resolve as usual, and so does everything else.

const SHIM = new URL('./shim.js', import.meta.url).href;
const NAMES = new Set(['@playwright/test', 'playwright/test']);

/**
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {(specifier: string, context: any) => Promise<any>} next
 */
export async function resolve(specifier, context, next) {
  const parent = context.parentURL ?? '';
  if (
    NAMES.has(specifier) &&
    parent !== SHIM &&
    !/[/\\]node_modules[/\\]/.test(parent)
  )
    return { url: SHIM, shortCircuit: true };
  return next(specifier, context);
}
