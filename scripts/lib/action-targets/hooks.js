// @ts-check
// Module resolve hook (register.js): `@playwright/test`, imported from
// anywhere but the shim itself, resolves to the shim, so a test's `test`
// records its action targets. Every other import resolves as usual.

const SHIM = new URL('./shim.js', import.meta.url).href;

/**
 * @param {string} specifier
 * @param {{ parentURL?: string }} context
 * @param {(specifier: string, context: any) => Promise<any>} next
 */
export async function resolve(specifier, context, next) {
  if (specifier === '@playwright/test' && context.parentURL !== SHIM)
    return { url: SHIM, shortCircuit: true };
  return next(specifier, context);
}
