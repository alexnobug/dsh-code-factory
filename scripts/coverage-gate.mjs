#!/usr/bin/env node
/**
 * coverage-gate — the repo's answer to "which `src/` modules never execute?".
 *
 * WHY THIS EXISTS
 *   An engineering review scored the 测试有效性 axis partly on the claim that
 *   "46.9% of src/ never executes", and an independent audit then found the repo
 *   carried NO coverage instrumentation at all — nothing under `scripts/` set
 *   `NODE_V8_COVERAGE` or instrumented anything. That made the 46.9% figure
 *   unreproducible and, worse, unguarded: the auditor's own (narrower)
 *   measurement was 17/48 src modules never executed by the two offline drills,
 *   which proves the number moves and nobody would notice. This script turns
 *   "which src/ modules never execute" into a number the repo can produce on
 *   demand and refuses to let regress silently.
 *
 * HOW IT MEASURES — real execution, not static analysis
 *   1. make a fresh temp dir and point `NODE_V8_COVERAGE` at it;
 *   2. spawn the two real drills as child processes, inheriting that env:
 *        node scripts/engine-drill.mjs --quiet
 *        node scripts/gates-drill.mjs  --quiet
 *      (the env var propagates into the drills' own grandchildren as well, so
 *      the temp dir fills up with the whole process tree's coverage);
 *   3. read every `*.json` the run produced, take each entry's `url` +
 *      `functions[].ranges[].count`, and map the URL back to a `src/` module.
 *
 *   V8 reports the **compiled JavaScript that actually ran**, so the URLs are
 *   `lib/**` (and the drills' own `scripts/*.mjs`), never `src/**`. The mapping
 *   `lib/<stem>.js` -> `src/<stem>.ts|tsx` is therefore the load-bearing step,
 *   including the two extra places client code is compiled to:
 *       lib/client/client/<x>.js  <- src/client/<x>.tsx   (tsc, tsconfig.client.json)
 *       lib/client/<domain|shared>/<x>.js <- src/<domain|shared>/<x>.ts  (browser copies)
 *   and the one output that has no single source module: `lib/client.js`, the
 *   tsdown browser bundle. On Windows the URL path arrives as `/D:/...`, which
 *   is normalised back to `D:/...` before the repo-root prefix is stripped.
 *
 * WHAT "EXECUTED" MEANS HERE — read this before quoting the number
 *   A module counts as executed when at least one of its function counts is
 *   above zero. Because V8 counts the module-wrapper function, an imported but
 *   never-called module already counts as executed. This gate therefore measures
 *   **reach** (the module was loaded and evaluated by some real process), NOT
 *   per-statement or per-branch exercise. A module can be fully "covered" here
 *   while most of its lines never run. Do not read `covered 31/48` as "31
 *   modules are tested"; read it as "17 modules are never even loaded".
 *
 * BASELINE
 *   Measured 2026-10-15 on Windows, node v24.12.0, pnpm 10.32.1, both figures
 *   from real runs (two consecutive runs were byte-identical):
 *       covered 31/48 src modules   17 unexecuted, all allowlisted
 *       covered 32/49 src modules   17 unexecuted, all allowlisted
 *   The second line is the same tree after `src/runtime/tokens.ts` was added by
 *   concurrent work and then built. Note what moved and what did not: the
 *   denominator grew by one and the unexecuted count stayed at 17, because the
 *   new module was properly wired (`src/tools/engine/members.ts:20` imports it),
 *   so it added coverage rather than a hole. That is why MAX_UNEXECUTED_MODULES
 *   stays 17 — it counts holes, not modules. In between, that file spent a few
 *   minutes unexecuted and with no compiled output, and this gate went red on it
 *   (exit 1) while the staleness guard reported the same condition as exit 2.
 *   Every one of the 17 hangs off one of two roots that nothing imports: the
 *   host plugin entry `src/index.ts` (loaded by the DSH host through the package
 *   export map, never by an `import`) and the browser plugin entry
 *   `src/client/index.tsx` (loaded by the `lib/client.js` bundle through
 *   `window.__ModuleLoader__`). Nothing else is unreachable — see ALLOWLIST.
 *
 * WHAT IS NOT CHECKED
 *   - Reach only, never line/branch/statement coverage (see above).
 *   - Only the two drills are measured, and that choice is what creates almost
 *     all of the 17. Measured on the same tree, 2026-10-15, by running each
 *     suite under its own NODE_V8_COVERAGE and taking set unions:
 *         scripts/verify.mjs --quiet      25/49 covered (own zero set)
 *         scripts/load-smoke.mjs          41/49 covered (own zero set)
 *         union of all three suites       44/49 covered
 *         still dark in the union         the 5 src/client/* modules only
 *     The load-bearing part: of the 31 modules the two drills reach, ZERO are
 *     reached by no other suite — every module the drills cover, verify.mjs or
 *     load-smoke.mjs also covers. Meanwhile load-smoke.mjs uniquely reaches 10
 *     (src/index.ts, src/command.ts, src/prompt/{index,captain-protocol}.ts,
 *     src/tools/{index,captain,member}.ts, src/web/{routes,snapshot}.ts,
 *     src/runtime/tokens.ts) and verify.mjs uniquely reaches 2 (src/domain/index.ts,
 *     src/runtime/index.ts). So the current 17 is largely a statement about the
 *     SUBJECT, not about untestability: nothing in the 17 is unreachable, and
 *     `src/index.ts` etc. are reachable by a script this repo already has.
 *     Widening DRILLS is therefore the obvious next move, but it is a real
 *     trade — load-smoke.mjs packs the artifact, runs `pnpm --offline` and
 *     spawns 8 dsh processes, which makes the gate far slower. Whoever does it
 *     must change DRILLS and MAX_UNEXECUTED_MODULES in the same commit and
 *     re-measure the baseline, or the number stops being comparable to the
 *     auditor's 17/48.
 *   - No staleness *repair*: like the sibling gates this refuses to grade a
 *     `lib/` older than `src/` (exit 2) instead of building it — the repo forbids
 *     an implicit build here.
 *
 * WHEN THIS GOES RED
 *   Make the module execute, or — only if it is genuinely unreachable from any
 *   process the drills can start — add an ALLOWLIST entry carrying a structural
 *   reason and the thing that would have to change to reach it. Raising
 *   MAX_UNEXECUTED_MODULES is not a fix; it is the silent regression this gate
 *   exists to prevent. A brand-new module whose compiled output does not exist
 *   yet will also show up here as unexecuted, and the staleness guard reports the
 *   same condition as exit 2 — build first, then re-run.
 *
 * EXIT CODES
 *   0  measured, unexecuted count within `MAX_UNEXECUTED_MODULES`, every
 *      unexecuted module allowlisted
 *   1  a rule failed: count over threshold, or an unexecuted module that is not
 *      on the allowlist (a new hole), or a drill exited non-zero
 *   2  prerequisite failure: `lib/` is missing or older than `src/` — nothing to
 *      grade. `--allow-stale` is the deliberate escape hatch, matching
 *      `scripts/verify.mjs --allow-stale`.
 *
 * USAGE
 *   node scripts/coverage-gate.mjs                 # grade the current lib/
 *   node scripts/coverage-gate.mjs --quiet         # only failures + summary
 *   node scripts/coverage-gate.mjs --allow-stale   # grade a stale lib/ anyway
 *   node scripts/coverage-gate.mjs --selftest      # prove the gate can go red
 *
 * @module dsh-code-factory/scripts/coverage-gate
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const rel = (p) => relative(repoRoot, p).split('\\').join('/')

const QUIET = process.argv.includes('--quiet')
const ALLOW_STALE = process.argv.includes('--allow-stale')
const SELFTEST = process.argv.includes('--selftest')
const VERBOSE = process.argv.includes('--verbose')

function line(text) {
  if (!QUIET) process.stdout.write(text + '\n')
}
/** Always printed, even under --quiet: failures and the summary must survive. */
function always(text) {
  process.stdout.write(text + '\n')
}

/**
 * The measured baseline. Raising this is a deliberate act — it is the one place
 * where "more src/ modules stopped executing" is acknowledged in a diff.
 */
const MAX_UNEXECUTED_MODULES = 17

/**
 * Modules no Node drill can reach, each with a one-line structural reason and
 * the named thing that would have to change for it to become reachable. Every
 * entry was derived from a real reverse-import scan of `src/`, `scripts/` and
 * `.github/`, not from reading the filenames.
 *
 * Two roots are never imported by anything:
 *   src/index.ts         the host plugin entry — the DSH host loads it through
 *                        the package export map; no offline drill instantiates a
 *                        Cordis host, so the whole tree behind it stays dark.
 *   src/client/index.tsx the browser plugin entry — the shipped `lib/client.js`
 *                        bundle registers it via `window.__ModuleLoader__`; a
 *                        Node process has no such global and cannot evaluate it.
 */
const ALLOWLIST = [
  // --- root 1: the host plugin entry, and the closure hanging off it ---------
  {
    path: 'src/index.ts',
    why: 'host plugin entry (apply/inject + the order-118 prompt section); reachable only through the package export map in a live DSH host, which no drill starts',
  },
  {
    path: 'src/command.ts',
    why: 'the /factory command; imported only by src/index.ts, so it needs both a live host and a CommandRuntime.execute() dispatch',
  },
  {
    path: 'src/prompt/index.ts',
    why: 're-export barrel under the host entry (src/index.ts); the drills import src/prompt/member-brief.ts by concrete path instead',
  },
  {
    path: 'src/prompt/captain-protocol.ts',
    why: 'text-only prompt constants; imported only by src/prompt/index.ts, which itself is only reached from the host entry',
  },
  {
    path: 'src/tools/index.ts',
    why: 're-export barrel plus registerFactoryTools(); called only from src/index.ts apply(), so registering the tool surface needs a live host',
  },
  {
    path: 'src/tools/captain.ts',
    why: 'the 12 captain defineTool definitions; imported only by src/tools/index.ts, i.e. only via the host entry',
  },
  {
    path: 'src/tools/member.ts',
    why: 'the 3 member defineTool definitions; imported only by src/tools/index.ts, i.e. only via the host entry',
  },
  {
    path: 'src/web/routes.ts',
    why: 'host HTTP route table; imported only by src/index.ts and needs a live DSH web server to be dispatched',
  },
  {
    path: 'src/web/snapshot.ts',
    why: 'pure FactoryState->FactorySnapshot projection; its only importer is src/web/routes.ts, so it rides on the same live-host requirement',
  },
  {
    path: 'src/domain/alerts.ts',
    why: 'imported only by src/domain/index.ts and src/web/snapshot.ts, both unreached by the drills (scripts/verify.mjs J9 does exercise it)',
  },
  {
    path: 'src/domain/index.ts',
    why: 'pure re-export barrel; no drill imports the barrel path (scripts/verify.mjs does load lib/domain/index.js, which is why only the drill run shows it as unexecuted)',
  },
  {
    path: 'src/runtime/index.ts',
    why: 'pure re-export barrel with no importer in src/ at all; scripts/verify.mjs loads lib/runtime/index.js directly, the drills import the concrete modules',
  },
  // --- root 2: the browser plugin entry, and the closure hanging off it ------
  {
    path: 'src/client/index.tsx',
    why: 'browser plugin entry; only ever evaluated by the lib/client.js classic-script bundle through window.__ModuleLoader__, which does not exist in a Node drill',
  },
  {
    path: 'src/client/FactoryCockpit.tsx',
    why: 'browser-only Cockpit panel; imported only by the browser entry src/client/index.tsx',
  },
  {
    path: 'src/client/api.ts',
    why: 'browser-side inject/service accessors; imported only by src/client/*.tsx, i.e. only inside the browser bundle',
  },
  {
    path: 'src/client/locales.ts',
    why: 'client-side t() dictionaries; imported only by src/client/*.tsx inside the browser bundle',
  },
  {
    path: 'src/client/styles.ts',
    why: 'client <style> text; imported only by src/client/*.tsx inside the browser bundle',
  },
]

const ALLOWLIST_PATHS = new Set(ALLOWLIST.map((e) => e.path))

/** The two suites this gate measures. Both are dependency-free offline drills. */
const DRILLS = [
  { file: 'scripts/engine-drill.mjs', label: 'engine' },
  { file: 'scripts/gates-drill.mjs', label: 'gates' },
]

const STALE_TOLERANCE_MS = 1000
const SELFTEST_MODULE = 'src/__coverage-gate-selftest__.ts'

// ---------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(abs, out)
    else out.push(abs)
  }
  return out
}

/** Repo-relative POSIX paths of every `src/**` TypeScript module, sorted. */
function walkSrcModules() {
  return walkFiles(join(repoRoot, 'src'))
    .map(rel)
    .filter((p) => /\.tsx?$/.test(p) && !p.endsWith('.d.ts'))
    .sort()
}

/** `src/domain/router.ts` -> `map['domain/router'] = 'src/domain/router.ts'` */
function stemIndex(modules) {
  const index = new Map()
  for (const m of modules) index.set(m.replace(/^src\//, '').replace(/\.tsx?$/, ''), m)
  return index
}

// ---------------------------------------------------------------------------
// URL -> src module
// ---------------------------------------------------------------------------

/** `file:///D:/repo/lib/x.js` -> `D:/repo/lib/x.js`, or null when it is not a file URL. */
function urlToAbsolute(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return null
  let p = decodeURIComponent(url.slice('file://'.length))
  p = p.split('\\').join('/')
  // Windows drive URLs arrive as /D:/... — drop the leading slash.
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
  return p.replace(/\/{2,}/g, '/')
}

/**
 * Map a coverage URL to the `src/` module whose execution it proves, or null for
 * anything that is not one of our source modules (node internals, the drills
 * themselves, `node_modules/**`, the browser bundle, source maps, .d.ts).
 *
 * The repo-root prefix must be stripped *before* deciding whether the remainder
 * starts with `lib/`, because `node_modules/.pnpm/<pkg>/lib/index.js` also
 * contains `/lib/` and would otherwise be misread as one of our own modules.
 */
function srcModuleFromUrl(url, byStem) {
  const abs = urlToAbsolute(url)
  if (!abs) return null
  const root = repoRoot.split('\\').join('/').replace(/\/+$/, '')
  if (abs.toLowerCase() === root.toLowerCase()) return null
  if (!abs.toLowerCase().startsWith(root.toLowerCase() + '/')) return null
  const rem = abs.slice(root.length + 1)

  if (rem.endsWith('.js.map') || rem.endsWith('.d.ts') || rem.endsWith('.d.ts.map')) return null
  if (rem.startsWith('src/')) return byStem.has(rem.replace(/^src\//, '').replace(/\.tsx?$/, '')) ? rem : null
  if (!rem.startsWith('lib/')) return null
  if (rem === 'lib/client.js') return null // tsdown browser bundle: no single source module
  if (!rem.endsWith('.js')) return null

  let stem = rem.slice('lib/'.length, -'.js'.length)
  if (stem.startsWith('client/client/')) stem = 'client/' + stem.slice('client/client/'.length)
  else if (stem.startsWith('client/')) stem = stem.slice('client/'.length)
  return byStem.get(stem) ?? null
}

/** true when at least one function in this coverage entry has a non-zero count. */
function entryExecuted(entry) {
  if (!Array.isArray(entry.functions)) return false
  for (const fn of entry.functions) {
    if (!Array.isArray(fn.ranges)) continue
    for (const range of fn.ranges) if ((range.count ?? 0) > 0) return true
  }
  return false
}

function readCoverage(covDir) {
  const files = existsSync(covDir) ? readdirSync(covDir).filter((f) => f.endsWith('.json')).sort() : []
  const entries = []
  for (const f of files) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(covDir, f), 'utf8'))
    } catch (err) {
      throw new Error(`unreadable coverage file ${f}: ${err.message}`)
    }
    for (const entry of parsed.result ?? []) entries.push(entry)
  }
  return { files: files.length, entries }
}

// ---------------------------------------------------------------------------
// staleness (mirrors scripts/verify.mjs:294-335 so the house behaves the same)
// ---------------------------------------------------------------------------

/**
 * Staleness of the compiled `lib/` relative to the `src/` snapshot under test
 * (mirrors scripts/verify.mjs:294-335 so the house behaves the same).
 *
 * Takes the module snapshot as an argument rather than walking `src/` itself:
 * the gate must grade one coherent tree, and this repo has other agents building
 * into `lib/` while it runs.
 */
function staleSubjects(modules) {
  const stale = []
  for (const name of modules) {
    const stem = name.replace(/^src\//, '').replace(/\.tsx?$/, '')
    // src/client/** compiles into lib/client/client/** (tsconfig.client.json),
    // which tsdown then bundles into the single shipped file lib/client.js.
    const out = stem.startsWith('client/')
      ? join(repoRoot, 'lib', 'client', 'client', `${stem.slice('client/'.length)}.js`)
      : join(repoRoot, 'lib', `${stem}.js`)
    if (!existsSync(out)) {
      stale.push(`${rel(out)} is missing (compiled from ${name})`)
      continue
    }
    if (statSync(join(repoRoot, name)).mtimeMs > statSync(out).mtimeMs + STALE_TOLERANCE_MS) {
      stale.push(`${rel(out)} is older than ${name}`)
    }
  }
  const bundle = join(repoRoot, 'lib', 'client.js')
  if (!existsSync(bundle)) {
    stale.push('lib/client.js is missing (the shipped client bundle)')
  } else {
    const bundleMtime = statSync(bundle).mtimeMs
    for (const input of walkFiles(join(repoRoot, 'lib', 'client'))) {
      if (!input.endsWith('.js')) continue
      if (statSync(input).mtimeMs > bundleMtime + STALE_TOLERANCE_MS) {
        stale.push(`${rel(input)} is newer than lib/client.js (bundle not rebuilt)`)
      }
    }
  }
  return stale
}

// ---------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------

/**
 * Run both drills under NODE_V8_COVERAGE and return the measured picture.
 * Every field comes from a real child process; nothing here is estimated.
 *
 * `modules` is the `src/` snapshot the caller already validated as fresh, so the
 * reported denominator and the URL mapping always describe the same tree.
 */
function measure({ modules: snapshot, keepCoverageDir = false } = {}) {
  const covDir = mkdtempSync(join(tmpdir(), 'dsh-coverage-gate-'))
  const drills = []
  try {
    const env = { ...process.env, NODE_V8_COVERAGE: covDir }
    for (const drill of DRILLS) {
      const started = Date.now()
      const run = spawnSync(process.execPath, [join(repoRoot, drill.file), '--quiet'], {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      const stdout = run.stdout ?? ''
      const summary = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
      drills.push({
        label: drill.label,
        file: drill.file,
        status: run.status,
        summary,
        elapsedMs: Date.now() - started,
        stderr: (run.stderr ?? '').trim(),
      })
    }

    const { files, entries } = readCoverage(covDir)
    const modules = snapshot ?? walkSrcModules()
    const byStem = stemIndex(modules)
    const counts = new Map()
    let unmappedRepoUrls = new Set()
    for (const entry of entries) {
      const mod = srcModuleFromUrl(entry.url, byStem)
      if (!mod) {
        // Anything that is a repo-local URL but not one of our modules is worth
        // surfacing once under --verbose: it is how a layout change shows up.
        const abs = urlToAbsolute(entry.url)
        const root = repoRoot.split('\\').join('/').replace(/\/+$/, '')
        if (abs && abs.toLowerCase().startsWith(root.toLowerCase() + '/')) {
          unmappedRepoUrls.add(abs.slice(root.length + 1))
        }
        continue
      }
      if (!entryExecuted(entry)) continue
      counts.set(mod, (counts.get(mod) ?? 0) + 1)
    }
    const covered = modules.filter((m) => counts.has(m))
    const unexecuted = modules.filter((m) => !counts.has(m))
    return {
      covDir,
      drills,
      coverageFiles: files,
      coverageEntries: entries.length,
      modules,
      covered,
      unexecuted,
      unmappedRepoUrls: [...unmappedRepoUrls].sort(),
    }
  } finally {
    if (!keepCoverageDir) rmSync(covDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// verdict (pure, so --selftest can exercise it without spawning anything)
// ---------------------------------------------------------------------------

/**
 * The whole gate decision, as a pure function of the measurement.
 * Exported so the self-test can drive the failure paths directly.
 */
export function decideVerdict({ unexecuted, allowlistPaths, maxUnexecuted }) {
  const notAllowlisted = unexecuted.filter((m) => !allowlistPaths.has(m)).sort()
  const overThreshold = unexecuted.length > maxUnexecuted
  const staleAllowlistEntries = [...allowlistPaths].filter((p) => !unexecuted.includes(p)).sort()
  return {
    ok: !overThreshold && notAllowlisted.length === 0,
    overThreshold,
    notAllowlisted,
    staleAllowlistEntries,
  }
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function reportStale(stale, { allowed }) {
  if (stale.length === 0) {
    line('[ ok ] lib/ is at least as new as src/ (subject is fresh)')
    return
  }
  if (allowed) {
    line(`[warn] ${stale.length} stale subject(s) ignored by --allow-stale:`)
    for (const s of stale.slice(0, 20)) line(`       ${s}`)
    if (stale.length > 20) line(`       … and ${stale.length - 20} more`)
    return
  }
  always(`[FAIL] the subject under test is stale (${stale.length} module(s)) — nothing to grade`)
  for (const s of stale.slice(0, 20)) always(`       ${s}`)
  if (stale.length > 20) always(`       … and ${stale.length - 20} more`)
  always('')
  always('       Run:  pnpm build        (请先 pnpm build)')
  always('       Or:   node scripts/coverage-gate.mjs --allow-stale   to grade the old artifact anyway')
  always('')
  always('coverage-gate: lib/ is older than src/ → run `pnpm build` first (exit 2)')
  process.exit(2)
}

function reportMeasurement(result) {
  for (const d of result.drills) {
    const mark = d.status === 0 ? '[ ok ]' : '[FAIL]'
    line(`${mark} ${d.file} --quiet → exit ${d.status}${d.summary ? `  (${d.summary})` : ''}`)
  }
  line(`[ ok ] read ${result.coverageFiles} NODE_V8_COVERAGE file(s), ${result.coverageEntries} result entries`)
  if (VERBOSE && result.unmappedRepoUrls.length > 0) {
    line(`[note] ${result.unmappedRepoUrls.length} repo-local coverage URL(s) mapped to no src module:`)
    for (const u of result.unmappedRepoUrls.slice(0, 20)) line(`       ${u}`)
    if (result.unmappedRepoUrls.length > 20) line(`       … and ${result.unmappedRepoUrls.length - 20} more`)
  }
  for (const d of result.drills) {
    if (d.status !== 0 && d.stderr) for (const l of d.stderr.split(/\r?\n/).slice(-10)) always(`       ${l}`)
  }
}

function reportVerdict(result, verdict) {
  const total = result.modules.length
  always(`covered ${result.covered.length}/${total} src modules`)
  if (result.unexecuted.length === 0) {
    always('unexecuted: (none)')
  } else {
    always(`unexecuted (${result.unexecuted.length}):`)
    for (const m of result.unexecuted) {
      const entry = ALLOWLIST.find((e) => e.path === m)
      always(`  ${entry ? '[allow]' : '[ NEW ]'} ${m}`)
      if (entry) line(`           why: ${entry.why}`)
      else always('           why: NOT on the allowlist — either restore its execution or justify it in ALLOWLIST')
    }
  }
  if (verdict.staleAllowlistEntries.length > 0) {
    line(`[note] ${verdict.staleAllowlistEntries.length} allowlist entr(ies) now execute — the allowlist can be tightened:`)
    for (const p of verdict.staleAllowlistEntries) line(`       ${p}`)
  }
}

function reportOutcome(result, verdict) {
  const failures = []
  for (const d of result.drills) if (d.status !== 0) failures.push(`${d.file} exited ${d.status}`)
  if (verdict.overThreshold) {
    failures.push(`${result.unexecuted.length} unexecuted modules > MAX_UNEXECUTED_MODULES (${MAX_UNEXECUTED_MODULES})`)
  }
  if (verdict.notAllowlisted.length > 0) {
    failures.push(`${verdict.notAllowlisted.length} unexecuted module(s) not on the allowlist: ${verdict.notAllowlisted.join(', ')}`)
  }

  if (failures.length === 0) {
    line(`[ ok ] ${result.unexecuted.length} unexecuted module(s) ≤ MAX_UNEXECUTED_MODULES (${MAX_UNEXECUTED_MODULES}), all allowlisted`)
    always(
      `SUCCESS: coverage gate — covered ${result.covered.length}/${result.modules.length} src modules, ` +
        `${result.unexecuted.length} unexecuted (≤ ${MAX_UNEXECUTED_MODULES}, all allowlisted)`,
    )
    return 0
  }
  for (const f of failures) always(`[FAIL] ${f}`)
  always(`FAIL: coverage gate — ${failures.length} 项不合格`)
  return 1
}

// ---------------------------------------------------------------------------
// --selftest
// ---------------------------------------------------------------------------

/**
 * Exercise the real failure path end to end.
 *
 * The live case adds one module to `src/` that nothing imports, so it can never
 * appear in any coverage report, and asserts that the gate goes red *naming it*.
 * The pure cases drive `decideVerdict` through the threshold and allowlist rules
 * without spawning anything, so each rule has its own failing witness.
 */
function selftest() {
  const cases = []
  const record = (name, ok, detail) => {
    cases.push({ name, ok, detail })
    const mark = ok ? '[ ok ]' : '[FAIL]'
    always(`  ${mark} ${name} — ${detail}`)
  }

  // --- pure cases ---------------------------------------------------------
  const allow = new Set(['src/index.ts'])
  {
    const v = decideVerdict({ unexecuted: ['src/index.ts', 'src/index.ts2'], allowlistPaths: allow, maxUnexecuted: 1 })
    record('threshold rule fires', v.ok === false && v.overThreshold === true, `count 2 > max 1 → overThreshold=${v.overThreshold}`)
  }
  {
    const v = decideVerdict({ unexecuted: ['src/index.ts', 'src/new-hole.ts'], allowlistPaths: allow, maxUnexecuted: 5 })
    record(
      'allowlist rule fires on a new hole',
      v.ok === false && v.overThreshold === false && v.notAllowlisted.join() === 'src/new-hole.ts',
      `caught ${v.notAllowlisted.join(', ') || '(nothing)'}`,
    )
  }
  {
    const v = decideVerdict({ unexecuted: ['src/index.ts'], allowlistPaths: allow, maxUnexecuted: 1 })
    record('green when at threshold and allowlisted', v.ok === true, `count 1 ≤ max 1, allowlisted → ok=${v.ok}`)
  }

  // --- live case ----------------------------------------------------------
  const target = join(repoRoot, SELFTEST_MODULE)
  if (existsSync(target)) {
    always(`[FAIL] refusing to run: ${SELFTEST_MODULE} already exists — restore the tree first`)
    return 1
  }
  let injected = false
  const cleanup = () => {
    if (injected && existsSync(target)) {
      try {
        unlinkSync(target)
      } catch {
        /* reported below */
      }
    }
  }
  process.on('exit', cleanup)
  // Counted BEFORE injecting, so "restored exactly" compares against the real
  // pre-existing inventory rather than the injected one.
  const before = walkSrcModules().length
  try {
    writeFileSync(
      target,
      '// injected by scripts/coverage-gate.mjs --selftest; nothing imports this.\n' +
        '// It exists only to prove the gate notices a module that never executes.\n' +
        'export const COVERAGE_GATE_SELFTEST = true\n',
      'utf8',
    )
    injected = true

    const withModule = measure()
    const injectedCounted = withModule.unexecuted.includes(SELFTEST_MODULE)
    const verdict = decideVerdict({
      unexecuted: withModule.unexecuted,
      allowlistPaths: ALLOWLIST_PATHS,
      maxUnexecuted: MAX_UNEXECUTED_MODULES,
    })
    record(
      'live: an unexecuted, unallowlisted module turns the gate red',
      injectedCounted && verdict.ok === false && verdict.notAllowlisted.includes(SELFTEST_MODULE),
      `src modules ${before}→${withModule.modules.length}, ${SELFTEST_MODULE} reported unexecuted=${injectedCounted}, ok=${verdict.ok}, named in notAllowlisted=${verdict.notAllowlisted.includes(SELFTEST_MODULE)}`,
    )

    unlinkSync(target)
    injected = false
    const after = walkSrcModules()
    record(
      'live: the tree is restored exactly',
      after.length === before && !after.includes(SELFTEST_MODULE),
      `${before} → ${withModule.modules.length} (injected) → ${after.length} (restored), file present=${existsSync(target)}`,
    )
    injected = false

    const clean = measure()
    record(
      'live: the injected module disappears again once removed',
      !clean.unexecuted.includes(SELFTEST_MODULE) && clean.modules.length === before,
      `unexecuted still lists it=${clean.unexecuted.includes(SELFTEST_MODULE)}, src modules=${clean.modules.length}`,
    )
  } finally {
    cleanup()
  }

  const failed = cases.filter((c) => !c.ok)
  always('')
  always('what this proves : the gate goes red for an unexpected unexecuted module (real measurement,')
  always('                   real coverage data) and the threshold + allowlist rules each have a witness.')
  always('what it does NOT : prove the unexecuted count stays under threshold for a FUTURE src/ edit,')
  always('                   or that "executed" means exercised — reach only (see the header).')
  if (failed.length === 0) {
    always(`SUCCESS: coverage-gate selftest — ${cases.length}/${cases.length} 个用例通过`)
    return 0
  }
  always(`FAIL: coverage-gate selftest — ${failed.length} 项不合格`)
  return 1
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * This repo is built by several agents at once. If `src/` changed while the
 * drills were running, the figure describes a tree that no longer exists —
 * say so loudly rather than letting it be quoted as current.
 */
function reportTreeDrift(before) {
  const after = walkSrcModules()
  const swapped = after.length !== before.length || after.some((m, i) => m !== before[i])
  if (!swapped) return
  always('')
  always(`[warn] src/ changed while the drills were running (${before.length} → ${after.length} modules)`)
  for (const m of after) if (!before.includes(m)) always(`       added:   ${m}`)
  for (const m of before) if (!after.includes(m)) always(`       removed: ${m}`)
  always('       The figure below describes the tree at the START of the run — re-run for a coherent number.')
}

function main() {
  if (SELFTEST) {
    always('coverage-gate selftest')
    return selftest()
  }

  line('dsh-code-factory — src/ execution coverage gate')
  line(`repo: ${repoRoot}`)
  line(`node: ${process.version}`)
  line('')

  // One snapshot of src/ drives both the freshness check and the reported
  // denominator; see reportTreeDrift for why that matters in this repo.
  const modules = walkSrcModules()
  reportStale(staleSubjects(modules), { allowed: ALLOW_STALE })

  const result = measure({ modules })
  reportMeasurement(result)
  reportTreeDrift(modules)
  const verdict = decideVerdict({
    unexecuted: result.unexecuted,
    allowlistPaths: ALLOWLIST_PATHS,
    maxUnexecuted: MAX_UNEXECUTED_MODULES,
  })
  always('')
  reportVerdict(result, verdict)
  always('')
  return reportOutcome(result, verdict)
}

// Run only when invoked as a script: the module also exports decideVerdict, and
// spawning two drills as an import side effect would be a trap for any caller.
const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (invokedDirectly) process.exitCode = main()
