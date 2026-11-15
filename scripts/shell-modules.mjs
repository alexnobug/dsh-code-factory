/**
 * Which client module ids may the DSH Web shell `require()`?
 *
 * Single source of truth shared by `tsdown.config.ts` (which decides what to
 * externalize) and `scripts/check-bundle.mjs` (which verifies the emitted
 * bundle). Keeping one implementation is the point: a rule that lives in two
 * places drifts, and this particular rule fails silently in both directions.
 *
 * Two-way hazard, both verified against real shipped artifacts:
 *
 *   • Externalize something the shell does NOT register
 *       → `require()` throws in the browser → the WHOLE plugin fails to
 *         activate. This is what `@deepseek-ai/dsh-brand` would have done.
 *
 *   • Bundle something the shell DOES register
 *       → the bundle carries a SECOND copy of a shared instance (store, slot
 *         core, primitives). Nothing throws; identity comparisons quietly
 *         stop working.
 *
 * Membership is the union of two evidence sources:
 *
 *   1. The package declares `dsh.client` in its manifest (sufficient).
 *   2. The id appears in the factory preamble of a real shipped client bundle
 *      (also sufficient — it proves the shell registers the id, manifest or
 *      not). `@deepseek-ai/dsh-client-ui-slots` is the clearest example: no
 *      `dsh.client` field, yet four official bundles require it.
 *
 * @module dsh-code-factory/shell-modules
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** React is always shell-provided and never carries a plugin manifest. */
export const ALWAYS_EXTERNAL = Object.freeze([
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react-dom/client',
])

/**
 * Ids observed in the preamble `require()` calls of shipped client bundles,
 * despite declaring no `dsh.client` manifest.
 */
export const OBSERVED_SHELL_MODULES = Object.freeze([
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-client-ui-slots',
])

/** Normalize a module id to its owning package (`react/jsx-runtime` -> `react`). */
export function owningPackage(id) {
  const parts = id.split('/')
  return id.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** Every declared dependency name, from the package manifest. */
function declaredDependencies(cwd) {
  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]
}

/**
 * The set of package names the shell can `require()`.
 *
 * @param cwd - project root holding `package.json` and `node_modules`.
 * @returns shell-provided package names.
 */
export function shellModuleIds(cwd = process.cwd()) {
  const ids = new Set([...ALWAYS_EXTERNAL, ...OBSERVED_SHELL_MODULES])
  for (const dependency of declaredDependencies(cwd)) {
    try {
      // Read the file directly: a package.json subpath is not always exported.
      const manifest = JSON.parse(
        readFileSync(join(cwd, 'node_modules', dependency, 'package.json'), 'utf8'),
      )
      if (manifest.dsh?.client) ids.add(dependency)
    } catch {
      // Not installed, or unreadable: fall through to bundling, which is safe.
    }
  }
  return ids
}
