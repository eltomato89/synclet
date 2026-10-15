import { randomBytes } from 'node:crypto';

/**
 * Loader for ESM-only packages (@tus/*, openid-client). A plain `import()` would be compiled to
 * `require()` (module: commonjs), which Jest's CJS runtime cannot use for ES modules; Node itself
 * handles both. The unique comment defeats V8's compile cache for Function sources, which would
 * otherwise bind the import to the first Jest test environment that evaluated this file (no effect
 * outside tests).
 */
export const importEsm = new Function('s', `return import(s); // ${randomBytes(8).toString('hex')}`) as <T>(specifier: string) => Promise<T>;
