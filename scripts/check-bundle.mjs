/**
 * Post-build assertion on `lib/client.js`.
 *
 * Runs as the last step of `pnpm build`. It turns the two silent client-bundling
 * hazards into a hard failure:
 *
 *   A. The bundle `require()`s an id the shell does not register
 *      → activation throws in the browser. (What `dsh-brand` would have done.)
 *
 *   B. The bundle INLINES a package the shell does register
 *      → a duplicate shared instance; identity comparisons break silently.
 *
 * Exit 0 when both hold, exit 1 with a precise diff otherwise.
 *
 * @module dsh-code-factory/scripts/check-bundle
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { owningPackage, shellModuleIds } from './shell-modules.mjs'

const BUNDLE = join(process.cwd(), 'lib', 'client.js')

/** `require("...")` ids referenced by the emitted factory. */
export function requiredIds(source) {
  return new Set([...source.matchAll(/require\("([^"]+)"\)/g)].map(match => match[1]))
}

/**
 * Packages whose source was inlined, read from rolldown's `//#region` markers.
 * Two layouts occur, and BOTH must parse:
 *
 *   //#region node_modules/.pnpm/@deepseek-ai+dsh-brand@0.2.0-rc.2_<peer>/lib/index.js
 *   //#region node_modules/@deepseek-ai/dsh-client-store/lib/index.js
 *
 * (pnpm's virtual store uses `@scope+name@version`, the hoisted layout uses
 * `@scope/name`.) Scope and name segments exclude `@`, `/` and `+` so the match
 * cannot run past the package boundary. A greedy capture here over-reads into
 * `@scope/name@version_hash`, which would make check (B) MISS a genuine
 * duplication — the exact silent failure this script exists to prevent.
 * `selfTest()` pins both layouts.
 */
export function inlinedPackages(source) {
  const found = new Set()
  const pattern = /\/\/#region\s+node_modules\/(?:\.pnpm\/)?@([^@/+]+)(?:\+([^@/+]+)@|\/([^@/+]+)\/)/g
  for (const match of source.matchAll(pattern)) {
    const name = match[2] ?? match[3]
    if (name) found.add(`@${match[1]}/${name}`)
  }
  return found
}

/** Guard the two parsers against silent regressions. */
function selfTest() {
  const synthetic = [
    '//#region node_modules/.pnpm/@deepseek-ai+dsh-brand@0.2.0-rc.2_@deepseek-ai+cordis@4.0.4/node_modules/@deepseek-ai/dsh-brand/lib/index.js',
    '//#region node_modules/@deepseek-ai/dsh-client-store/lib/index.js',
    '//#region lib/client/api.js',
  ].join('\n')
  const got = [...inlinedPackages(synthetic)].sort().join(',')
  const want = ['@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-client-store'].sort().join(',')
  if (got !== want) {
    console.error(`check-bundle: SELF-TEST FAILED — inlinedPackages parsed {${got}}, expected {${want}}`)
    process.exit(1)
  }
  const reqs = [...requiredIds('require("react");require("@deepseek-ai/cordis")')].sort().join(',')
  if (reqs !== '@deepseek-ai/cordis,react') {
    console.error(`check-bundle: SELF-TEST FAILED — requiredIds parsed {${reqs}}`)
    process.exit(1)
  }

  /*
   * Closure regression guard for the historical fatal bug.
   *
   * Checks (A) and (B) compare the bundle against the shell set, so they are
   * CIRCULAR with respect to the set's own curation: adding a wrong name to the
   * list makes (A) pass while the emitted `require()` crashes at activation.
   * (Verified by mutation: adding `dsh-brand` to the observed list produced
   * `requires = {@deepseek-ai/dsh-brand, ...}` and the check still said OK.)
   *
   * The set is therefore only as trustworthy as its evidence, and these two
   * assertions pin the endpoints of that evidence rule:
   *   • a package with NO `dsh.client` manifest and NO observed preamble use
   *     must never be externalized  → `@deepseek-ai/dsh-brand` is the canary;
   *   • a package that DOES declare `dsh.client` must be externalized
   *     → `@deepseek-ai/dsh-client-ui-renderer` proves the manifest path works.
   */
  const shell = shellModuleIds()
  if (shell.has('@deepseek-ai/dsh-brand')) {
    console.error(
      'check-bundle: SELF-TEST FAILED — `@deepseek-ai/dsh-brand` is in the shell set.\n' +
        '  It declares no `dsh.client` manifest and appears in no shipped bundle preamble.\n' +
        '  Externalizing it emits a require() the shell cannot resolve, which aborts\n' +
        '  activation of the entire plugin. Remove it from the shell set.',
    )
    process.exit(1)
  }
  if (!shell.has('@deepseek-ai/dsh-client-ui-renderer')) {
    console.error(
      'check-bundle: SELF-TEST FAILED — `@deepseek-ai/dsh-client-ui-renderer` is missing from the shell set.\n' +
        '  It declares `dsh.client.platform = web`, so the manifest path is broken.',
    )
    process.exit(1)
  }
}

function main() {
  selfTest()

  let source
  try {
    source = readFileSync(BUNDLE, 'utf8')
  } catch {
    console.error(`check-bundle: ${BUNDLE} not found — run the build first.`)
    process.exit(1)
  }

  const shell = shellModuleIds()
  const requires = requiredIds(source)
  const inlined = inlinedPackages(source)

  // ── A. every require() must be shell-registered ────────────────────────────
  const foreign = [...requires].filter(id => !shell.has(owningPackage(id)))

  // ── B. nothing shell-registered may be inlined ─────────────────────────────
  const duplicated = [...inlined].filter(pkg => shell.has(pkg))

  console.log(`check-bundle: requires   = {${[...requires].sort().join(', ')}}`)
  console.log(`check-bundle: inlined    = {${[...inlined].sort().join(', ') || '—'}}`)

  if (foreign.length > 0 || duplicated.length > 0) {
    if (foreign.length > 0) {
      console.error(
        `\nFAIL (A) the bundle requires ids the shell does not register: ${foreign.join(', ')}\n` +
          `  This throws at activation and takes the whole plugin down.\n` +
          `  Fix: make tsdown bundle them (remove from the shell set) or stop importing them at runtime.`,
      )
    }
    if (duplicated.length > 0) {
      console.error(
        `\nFAIL (B) the bundle inlined shell-registered packages: ${duplicated.join(', ')}\n` +
          `  This creates a second copy of a shared instance; identity checks break silently.\n` +
          `  Fix: they must be externalized, not bundled.`,
      )
    }
    process.exit(1)
  }

  console.log('check-bundle: OK — no foreign requires, no duplicated shell modules')
}

main()
