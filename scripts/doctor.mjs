#!/usr/bin/env node
/**
 * scripts/doctor.mjs — installation self-check for the dsh-code-factory bundle.
 *
 * Answers one question: "is what is sitting on disk a *loadable, consistent*
 * DSH bundle?" It inspects the packaged metadata (package.json,
 * compatibility.json, cordis.patch.yml), the two bundle halves (lib/index.js for
 * the host, lib/client.js for the Web shell) and the installed `@deepseek-ai/*`
 * generation, then prints one OK/FAIL line per item plus a score.
 *
 * Nothing is executed and nothing is mounted: this is a static inspection, so it
 * is safe to run against a profile that is live.
 *
 * Usage
 *   node scripts/doctor.mjs                    (or: pnpm run doctor)
 *   node scripts/doctor.mjs --against <dir>    check another tree (e.g. a profile)
 *
 * NOTE: use `pnpm run doctor`, not bare `pnpm doctor` — pnpm ships a built-in
 * `doctor` command that silently shadows a `doctor` script of the same name.
 *
 * Exit codes
 *   0  every item passed
 *   1  at least one item failed (each FAIL prints its own fix hint)
 *   2  the target is not a dsh-code-factory tree (package.json missing/unreadable)
 *
 * @module dsh-code-factory/scripts/doctor
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/* ------------------------------------------------- which tree is under inspection */

/**
 * This script used to answer "is the installation healthy?" by reading
 * `<this checkout>/node_modules` unconditionally. Run from a source checkout it
 * therefore always printed 8/8 — even when the profile the DSH application
 * actually loads resolves this plugin, and every `@deepseek-ai/*` peer, from a
 * completely different directory. A self-check that cannot name the tree it
 * inspected has not certified anything, so the target is now explicit, printed,
 * and cross-examined against the profiles that really exist.
 */
const argv = process.argv.slice(2)
const againstAt = argv.indexOf('--against')
const againstValue = againstAt === -1 ? undefined : argv[againstAt + 1]
if (againstAt !== -1 && (againstValue === undefined || againstValue.startsWith('--'))) {
  process.stderr.write('doctor: --against needs a directory, e.g. --against ~/.dsh/profiles/desktop\n')
  process.exit(2)
}

const scriptRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = againstValue === undefined ? scriptRoot : resolve(againstValue)
const inNodeModules = repoRoot.split(/[\\/]/).includes('node_modules')

const rel = (path) => relative(repoRoot, path).split('\\').join('/')
const line = (text) => process.stdout.write(`${text}\n`)

/** Every `~/.dsh/profiles/<name>` that has a package.json, i.e. a real install. */
function installedProfiles() {
  const root = join(homedir(), '.dsh', 'profiles')
  if (!existsSync(root)) return []
  const found = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    if (existsSync(join(dir, 'package.json'))) found.push({ name: entry.name, dir })
  }
  return found
}

/**
 * Resolve `name` the way Node will: nearest `node_modules` walking up from the
 * target. Returns the package.json path and the `node_modules` root that served
 * it, so the report can attribute each version to a concrete directory instead
 * of asserting a number with no address.
 */
function resolveInstalled(name, from = repoRoot) {
  const parts = name.split('/')
  let dir = from
  for (;;) {
    const modules = join(dir, 'node_modules')
    const candidate = join(modules, ...parts, 'package.json')
    if (existsSync(candidate)) return { path: candidate, modules }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** realpath that degrades to the input when the path is missing. */
const safeRealpath = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const readText = (path) => readFileSync(path, 'utf8').replace(/^\uFEFF/, '')

function readJson(path) {
  return JSON.parse(readText(path))
}

/* --------------------------------------------------------------- semver-ish */

/**
 * Parse a version into its numeric core plus its prerelease identifiers.
 *
 * Prerelease is kept because every `@deepseek-ai/*` package currently ships as
 * `0.2.0-rc.N`. A matcher that dropped the tag could not even PARSE a range like
 * `^0.2.0-rc.2` (the clause ends in `-rc.2`, which the numeric pattern rejects),
 * so it silently reported "does not satisfy" for a correct declaration — the
 * worst possible failure for an installation check.
 */
function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    String(version).trim(),
  )
  if (!match) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** semver §11 ordering: -1 / 0 / 1, prerelease included. */
function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1
  }
  // A release outranks every prerelease of the same core tuple.
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const left = a.pre[index]
    const right = b.pre[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1 // numeric identifiers rank below alphanumeric
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  return 0
}

/** Minimal range matcher: `a || b`, `^`, `~`, `>=`, `>`, `<=`, `<`, exact. */
function satisfiesRange(version, range) {
  const actual = parseVersion(version)
  if (!actual) return false
  return String(range)
    .split('||')
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) => {
      if (clause === '*' || clause === '' || clause === 'latest') return true
      const match = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(
        clause,
      )
      if (!match) return false
      const operator = match[1] ?? '='
      const bound = {
        core: [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)],
        pre: match[5] === undefined ? [] : match[5].split('.'),
      }
      // semver §11: a prerelease version only satisfies a range when some
      // comparator in that clause carries a prerelease on the SAME core tuple.
      // `^0.2.0-rc.2` therefore accepts 0.2.0-rc.3 and 0.2.0, but `>=0.1.0`
      // does NOT accept 0.2.0-rc.2.
      if (actual.pre.length > 0 && bound.pre.length === 0) {
        const sameTuple = actual.core.every((part, index) => part === bound.core[index])
        if (!sameTuple) return false
      }
      const order = compareVersions(actual, bound)
      switch (operator) {
        case '^': {
          // Caret: same leftmost non-zero component (npm semantics for 0.x).
          if (bound.core[0] !== 0) return actual.core[0] === bound.core[0] && order >= 0
          if (bound.core[1] !== 0) {
            return actual.core[0] === 0 && actual.core[1] === bound.core[1] && order >= 0
          }
          return order === 0
        }
        case '~':
          return actual.core[0] === bound.core[0] && actual.core[1] === bound.core[1] && order >= 0
        case '>=':
          return order >= 0
        case '>':
          return order > 0
        case '<=':
          return order <= 0
        case '<':
          return order < 0
        default:
          return order === 0
      }
    })
}

/**
 * The matcher's own truth table, evaluated at load time.
 *
 * A range matcher that is wrong in the "too strict" direction reports a healthy
 * installation as broken, and in the "too loose" direction certifies a broken
 * one. Both are silent. These cases are the ones this project actually depends
 * on; if they ever stop holding, the tool exits 2 rather than printing a verdict
 * nobody should trust.
 */
const RANGE_CASES = [
  // [version, range, expected]
  ['0.2.0-rc.2', '^0.2.0-rc.2', true],
  ['0.2.0-rc.3', '^0.2.0-rc.2', true],
  ['0.2.0', '^0.2.0-rc.2', true],
  ['0.2.5', '^0.2.0-rc.2', true],
  ['0.3.0-rc.1', '^0.2.0-rc.2', false],
  ['0.1.9', '^0.2.0-rc.2', false],
  ['0.2.0-rc.2', '0.2.0-rc.2', true],
  ['0.2.0-rc.1', '0.2.0-rc.2', false],
  ['0.2.0-rc.2', '^0.2.0', false],
  ['0.2.0-rc.2', '>=0.1.0', false],
  ['0.2.0-rc.2', '0.2.0-rc.1 || 0.2.0-rc.2', true],
  ['0.1.7-rc.2', '0.2.0-rc.2 || 0.1.7-rc.2', true],
  ['22.19.0', '^22.19.0 || >=24', true],
  ['23.5.0', '^22.19.0 || >=24', false],
  ['24.1.0', '^22.19.0 || >=24', true],
  ['4.0.4', '^4.0.2', true],
  ['5.0.0', '^4.0.2', false],
  ['3.18.4', '~3.18.2', true],
  ['3.19.0', '~3.18.2', false],
  ['0.2.0-rc.2', '*', true],
]
for (const [version, range, expected] of RANGE_CASES) {
  if (satisfiesRange(version, range) !== expected) {
    line(`[FAIL] doctor's own range matcher is broken: ${version} vs "${range}" should be ${expected}`)
    process.exit(2)
  }
}

/**
 * The package name mounted by `cordis.patch.yml`. Reads the first `name:` entry
 * under the `insert:` block; falls back to any `name:` line. Hand-parsed on
 * purpose — a YAML dependency for one field would be silly.
 */
function patchName(text) {
  const findName = (chunk) => {
    for (const raw of chunk.split(/\r?\n/)) {
      const match = /^\s*name:\s*(['"]?)([^'"#\s]+)\1\s*$/.exec(raw)
      if (match) return match[2]
    }
    return undefined
  }
  const insertIndex = text.search(/^\s*-\s*insert:\s*$/m)
  if (insertIndex >= 0) {
    const underInsert = findName(text.slice(insertIndex))
    if (underInsert) return underInsert
  }
  return findName(text)
}

/* ------------------------------------------------------------------- context */

line('dsh-code-factory - installation doctor')
line(`repo: ${repoRoot}`)
line(
  `mode: ${
    againstValue !== undefined
      ? 'explicit --against target'
      : inNodeModules
        ? 'installed copy'
        : 'source checkout'
  }`,
)
line(`node: ${process.version}`)

const packagePath = join(repoRoot, 'package.json')
if (!existsSync(packagePath)) {
  line(`\n[FAIL] ${rel(packagePath)} not found - this is not a dsh-code-factory checkout`)
  process.exit(2)
}

let pkg
try {
  pkg = readJson(packagePath)
} catch (error) {
  line(`\n[FAIL] ${rel(packagePath)} is not readable JSON: ${error.message}`)
  process.exit(2)
}

/*
 * `--against` is easy to aim one level too high: a profile root has a
 * package.json (the profile manifest), so the run proceeds and prints a wall of
 * nonsense failures about `dsh-profile-desktop@undefined`. Detect the wrong
 * shape and name the path that would have worked.
 */
if (againstValue !== undefined && typeof pkg.dsh?.bundle !== 'object') {
  const nested = join(repoRoot, 'node_modules', 'dsh-code-factory')
  line(`\n[FAIL] ${repoRoot} is not a dsh-code-factory tree - it declares "${pkg.name ?? '?'}"`)
  line(`       --against takes the package directory, not the profile that contains it`)
  if (existsSync(join(nested, 'package.json'))) line(`       did you mean: --against "${nested}"`)
  process.exit(2)
}

line(`package: ${pkg.name}@${pkg.version}`)

const patchRel = pkg.dsh?.bundle?.patch
const patchPath = typeof patchRel === 'string' ? join(repoRoot, patchRel) : undefined
const compatibilityPath = join(repoRoot, 'compatibility.json')
const hostEntry = join(repoRoot, 'lib', 'index.js')
const clientEntry = join(repoRoot, 'lib', 'client.js')

/* -------------------------------------------------------------------- checks */

const checks = [
  {
    title: 'node version satisfies engines.node',
    run() {
      const range = pkg.engines?.node
      if (!range) return { ok: false, detail: 'package.json declares no engines.node', hint: 'declare the supported Node range' }
      const ok = satisfiesRange(process.versions.node, range)
      return {
        ok,
        detail: `node ${process.version} against "${range}"`,
        hint: ok ? undefined : `install Node ${range}`,
      }
    },
  },
  {
    title: 'host bundle lib/index.js exists',
    run() {
      const ok = existsSync(hostEntry)
      return {
        ok,
        detail: rel(hostEntry),
        hint: ok ? undefined : 'run `pnpm build` (the host half is emitted by tsc)',
      }
    },
  },
  {
    title: 'web bundle lib/client.js exists',
    run() {
      const ok = existsSync(clientEntry)
      return {
        ok,
        detail: rel(clientEntry),
        hint: ok ? undefined : 'run `pnpm build` (the web half is emitted by tsdown)',
      }
    },
  },
  {
    title: 'lib/client.js registers on window.__ModuleLoader__',
    run() {
      if (!existsSync(clientEntry)) return { ok: false, detail: 'missing', hint: 'run `pnpm build`' }
      const first = readText(clientEntry).split(/\r?\n/, 1)[0].trim()
      const expected = 'window.__ModuleLoader__.load('
      const ok = first.startsWith(expected)
      return {
        ok,
        detail: first.slice(0, 96),
        hint: ok ? undefined : `first line must start with ${expected} — rebuild with \`pnpm build\``,
      }
    },
  },
  {
    title: 'dsh.bundle.patch target exists',
    run() {
      if (typeof patchRel !== 'string') {
        return { ok: false, detail: 'package.json declares no dsh.bundle.patch', hint: 'declare the bundle patch file' }
      }
      const ok = existsSync(patchPath)
      return {
        ok,
        detail: `${patchRel} (${pkg.dsh?.bundle ? 'dsh.bundle.patch' : '?'})`,
        hint: ok ? undefined : `${patchRel} is missing from the package`,
      }
    },
  },
  {
    title: 'cordis.patch.yml name equals package.json name',
    run() {
      if (!patchPath || !existsSync(patchPath)) {
        return { ok: false, detail: 'patch file unreadable', hint: 'run `pnpm build` / restore cordis.patch.yml' }
      }
      const mounted = patchName(readText(patchPath))
      const ok = mounted === pkg.name
      return {
        ok,
        detail: mounted ? `mounts "${mounted}"` : 'no name: entry found under insert:',
        hint: ok ? undefined : `the mounted name must be the node-resolvable package name "${pkg.name}"`,
      }
    },
  },
  {
    title: 'compatibility.json declares this plugin and a DSH target',
    run() {
      if (!existsSync(compatibilityPath)) {
        return { ok: false, detail: 'compatibility.json missing', hint: 'restore compatibility.json' }
      }
      let compat
      try {
        compat = readJson(compatibilityPath)
      } catch (error) {
        return { ok: false, detail: `not readable JSON: ${error.message}`, hint: 'fix compatibility.json' }
      }
      const problems = []
      if (compat.name !== pkg.name) problems.push(`name "${compat.name}" != "${pkg.name}"`)
      if (compat.version !== pkg.version) {
        problems.push(`version "${compat.version}" != package.json "${pkg.version}" - bump both together`)
      }
      if (!compat.dsh?.target) problems.push('no dsh.target')
      if (!compat.packages || Object.keys(compat.packages).length === 0) problems.push('no packages listed')
      const ok = problems.length === 0
      return {
        ok,
        detail: `dsh ${compat.dsh?.target ?? '?'} · ${Object.keys(compat.packages ?? {}).length} packages`,
        hint: ok ? undefined : problems.join('; '),
      }
    },
  },
  {
    title: 'installed @deepseek-ai/* satisfy the declared versions',
    run() {
      if (!existsSync(compatibilityPath)) {
        return { ok: false, detail: 'compatibility.json missing', hint: 'restore compatibility.json' }
      }
      const compat = readJson(compatibilityPath)
      const declared = Object.entries(compat.packages ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/'))
      if (declared.length === 0) return { ok: false, detail: 'nothing declared', hint: 'declare the @deepseek-ai/* packages' }
      const bad = []
      const absent = []
      const roots = new Set()
      for (const [name, spec] of declared) {
        const range = typeof spec === 'string' ? spec : spec?.range
        const hit = resolveInstalled(name)
        if (!hit) {
          absent.push(name)
          continue
        }
        roots.add(hit.modules)
        let installed
        try {
          installed = readJson(hit.path).version
        } catch {
          bad.push(`${name} (unreadable)`)
          continue
        }
        if (!range || !satisfiesRange(installed, range)) bad.push(`${name} ${installed} !~ ${range}`)
      }
      const ok = bad.length === 0 && absent.length === 0
      const where = roots.size === 0 ? 'nowhere' : [...roots].map(safeRealpath).join(' + ')
      const detail = ok
        ? `${declared.length}/${declared.length} packages match · resolved from ${where}`
        : [
            ...bad,
            ...absent.map((name) => `${name} not installed`),
            `(resolution start: ${repoRoot})`,
          ].join('; ')
      return {
        ok,
        detail,
        hint: ok
          ? undefined
          : inNodeModules || againstValue !== undefined
            ? `the DSH host supplies these from resources/app.asar, not from ${repoRoot} - run \`pnpm install\` here only if you mean to check versions against this tree`
            : `run \`pnpm install\` in ${repoRoot} (or fix the declared range)`,
      }
    },
  },
  {
    title: 'the copy the runtime loads is identifiable (no same-version ambiguity)',
    run() {
      const here = safeRealpath(repoRoot)
      const profiles = installedProfiles()
      if (profiles.length === 0) {
        return {
          ok: true,
          detail: `no ~/.dsh/profiles/*/package.json — inspecting ${here} only`,
        }
      }
      const loading = []
      const ambiguous = []
      for (const profile of profiles) {
        const hit = resolveInstalled(pkg.name, profile.dir)
        if (!hit) continue
        const there = safeRealpath(dirname(hit.path))
        let version = '?'
        try {
          version = readJson(hit.path).version
        } catch {
          version = 'unreadable'
        }
        loading.push(`${profile.name} → ${there === here ? 'this tree' : there} (${version})`)
        // Same version, different bytes-to-be: provenance is unresolvable, so a
        // green result here would describe a tree the runtime never loads.
        if (there !== here && version === pkg.version) ambiguous.push(`${profile.name} → ${there}`)
      }
      if (loading.length === 0) {
        return { ok: true, detail: `${profiles.length} profile(s), none load ${pkg.name}` }
      }
      const ok = ambiguous.length === 0
      return {
        ok,
        detail: loading.join(' · '),
        hint: ok
          ? undefined
          : `same version ${pkg.version} is installed from a different tree (${ambiguous.join('; ')}): reinstall so one of them wins, or check that tree with --against`,
      }
    },
  },
]

/* --------------------------------------------------------------------- run */

let passed = 0
const failures = []
for (const [index, item] of checks.entries()) {
  let outcome
  try {
    outcome = item.run()
  } catch (error) {
    outcome = { ok: false, detail: error.message, hint: 'unexpected error while inspecting the installation' }
  }
  const label = `[${outcome.ok ? ' ok ' : 'FAIL'}]`
  line(`  ${label} ${index + 1}. ${item.title}`)
  line(`         ${outcome.detail}`)
  if (outcome.ok) passed += 1
  else {
    failures.push({ title: item.title, hint: outcome.hint })
    if (outcome.hint) line(`         -> ${outcome.hint}`)
  }
}

const total = checks.length
line(`\n${'-'.repeat(66)}`)
if (failures.length === 0) {
  line(`SUCCESS: ${passed}/${total} installation checks passed (${pkg.name}@${pkg.version})`)
  line('next: mount the bundle with `dsh plugin --profile <name> add <this package>`')
  process.exit(0)
}

line(`FAILURE: ${passed}/${total} installation checks passed, ${failures.length} failed`)
for (const failure of failures) line(`  - ${failure.title}${failure.hint ? ` -> ${failure.hint}` : ''}`)
line('next: fix the failing items above, then re-run `node scripts/doctor.mjs`')
process.exit(1)
