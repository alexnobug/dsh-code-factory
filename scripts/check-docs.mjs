#!/usr/bin/env node
/**
 * scripts/check-docs.mjs — keeps the documentation's *numbers* honest.
 *
 * WHY THIS EXISTS
 * ---------------
 * The docs used to state verification counts by hand. They drifted twice: the
 * verify suite went 33 → 43 checks and `verify.mjs` grew from 881 to 1382 lines
 * while five documents still advertised 33 / 881. The check that would have
 * caught it (`check-docs.mjs`) lived *outside* the repository, so nobody ran it.
 * **A check outside the repo does not exist.** This is that check, in the repo.
 *
 * STRATEGY (chosen over "delete the numbers")
 * -------------------------------------------
 * The numbers stay in the docs — a reader gets real value from "43/43, sections
 * A–G" — and this script derives every one of them from its source of truth
 * (a live tool run, a file's real line count, or the compiled domain layer) and
 * *fails* when a document disagrees. Three layers, from precise to paranoid:
 *
 *   1. CLAIMS      every code-derived quantity has an explicit pattern. A wrong
 *                  (or missing) number is reported as `file:line`, expected vs
 *                  found. This is the main contract.
 *   2. TABLES      the role / pipeline / DoD tables are compared cell by cell
 *                  against `lib/domain`, so a stale table row fails too.
 *   3. STALE BAN   values that were *once* correct and are not any more must not
 *                  reappear anywhere in the scanned docs (cheap regression net),
 *                  plus a generic rule: every `N/M` ratio or `N 项检查|checks|
 *                  sections|行` token must be explained by a claim or by an
 *                  explicitly reasoned exception below.
 *
 * LINE-COUNT CONVENTION (exactly one, editor semantics)
 * -----------------------------------------------------
 * Every line count this script asserts — `src/**` modules, `scripts/*.mjs`, JSON —
 * is the number of newlines (`\n` occurrences): exactly what an editor shows for
 * a file whose last line ends with `\n`.
 *
 * **Do not use `content.split('\n').length`.** For a file that ends with `\n` it
 * counts one extra (the empty trailing element): `scripts/verify.mjs` is 1381
 * lines by the newline count and the split form reports 1382. That mistake shipped
 * once in this repo (t19/t24) and cost a re-sync. If a second convention ever
 * becomes genuinely necessary, name it explicitly *and* write down why — two
 * unnamed conventions in one repo is precisely how this drift happened.
 *
 * CONCURRENCY (§6.3 of docs/API-CONTRACTS.md)
 * ------------------------------------------
 * Other members edit `src/**` while this runs. Text is read through
 * `readStable()`, which re-reads until two consecutive reads agree (up to 4
 * tries, 120 ms apart), and the module-line rules are only asserted when the
 * files they describe have stopped changing. If a build artefact is older than
 * the sources it was produced from, the script exits **2** with "run pnpm build"
 * rather than comparing the docs against stale code — a stale artefact would
 * make every count wrong in a way that looks like doc drift.
 *
 * WHAT IS *NOT* SCANNED (on purpose)
 *   - `docs/VERIFICATION.md`  — a dated historical snapshot (t7); its numbers are
 *     supposed to stay frozen.
 *   - `docs/API-CONTRACTS.md` — the frozen API contract; it states no counts of
 *     the kind checked here (verified: no `33/43/881/1382` tokens).
 *   - `docs/usage.md`         — optional and possibly still being written by
 *     another member; every assertion about it is existence-aware, and it stays
 *     out of the STALE / counter scans so a concurrent author is never blocked.
 *   - `README*.md` prose about the GUI/profile — not derivable from this repo.
 *
 * LIMITATION DISCLOSURE (section 3.6)
 * -----------------------------------
 * `docs/limitations.md` states *behaviour*, not numbers: what the plugin cannot
 * do. Numbers can be derived; a claim like "the member brief never mentions the
 * files you already have" cannot. So that one is checked as text — the brownfield
 * gap must lead the document, its mechanism evidence (`file:line`) must be quoted,
 * the proposals must be marked unimplemented, and both READMEs must advertise the
 * gap as the FIRST bullet of their Known-limitations section and link the file.
 * A limitation that is not disclosed where the reader decides is not disclosed.
 *
 * EXIT CODES
 *   0  every checked number matches its source of truth
 *   1  at least one document disagrees (or a claim disappeared)
 *   2  prerequisite missing: `lib/` absent or older than `src/` → run `pnpm build`
 *
 * USAGE
 *   node scripts/check-docs.mjs            (add `--quiet` to print only failures)
 *
 * @module dsh-code-factory/scripts/check-docs
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const rel = (p) => relative(repoRoot, p).split('\\').join('/')
const QUIET = process.argv.includes('--quiet')
/**
 * §6.3's churn window is **opt-in** since B7/M18 were fixed. It used to be on by
 * default, which silently downgraded real drift to a warning for ten minutes
 * after any `src/` write — i.e. exactly the "edit code → run check → commit"
 * loop it was supposed to police, and the loop everyone actually runs.
 * `--concurrent` restores it for a genuine multi-writer session; `--strict` is
 * still accepted (as a no-op alias) so existing callers keep working.
 */
const CONCURRENT = process.argv.includes('--concurrent')
const STRICT = !CONCURRENT
/** A module directory written to this recently is treated as "in flight". */
const CHURN_WINDOW_MS = 10 * 60 * 1000
/** Rules the churn window let through. Counted apart from `checks.ran`. */
const suppressed = []

/* --------------------------------------------------------------- plumbing */

const checks = { ran: 0, failed: 0 }
const failures = []
const warnings = []
const notes = []

/** Reads a file as UTF-8, re-reading until two consecutive reads agree. */
function readStable(path, tries = 4) {
  let previous = null
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const text = readFileSync(path, 'utf8')
    if (text === previous) return text
    previous = text
    sleep(120)
  }
  return previous ?? readFileSync(path, 'utf8')
}

function sleep(ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    /* deliberate: this script must stay dependency-free */
  }
}

/**
 * The one and only line count: newlines, i.e. what an editor shows.
 * `split('\n').length` would add 1 for every file that ends with a newline.
 */
function editorLines(path) {
  return (readStable(path).match(/\n/g) ?? []).length
}

function newestMtime(root, filter) {
  let newest = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (filter(full)) newest = Math.max(newest, statSync(full).mtimeMs)
    }
  }
  walk(root)
  return newest
}

const DOCS = {
  readme: 'README.md',
  readmeZh: 'README_ZH.md',
  rollback: 'ROLLBACK.md',
  architecture: 'docs/architecture.md',
  roles: 'docs/roles-and-pipelines.md',
  e2e: 'docs/E2E-ACCEPTANCE.md',
  limitations: 'docs/limitations.md',
  conventions: 'docs/conventions.md',
}
/**
 * Documents another member may still be writing. They are deliberately kept out
 * of `SCANNED` (and therefore out of the STALE + counter scans): a generic rule
 * that fires on someone else's half-written file would block their task, and a
 * red build for a doc that does not exist yet would block this one. Assertions
 * about them must be existence-guarded. Currently: `docs/usage.md` (tool
 * reference, store-dev's task).
 */
const OPTIONAL_DOCS = { usage: 'docs/usage.md' }
const SCANNED = Object.values(DOCS)

/** Document text plus a `lineOf(index)` helper for `file:line` reporting. */
function loadDoc(path) {
  const text = readStable(join(repoRoot, path))
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1)
  const lineOf = (index) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= index) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
  return { path, text, lineOf }
}
const loaded = new Map(SCANNED.map((p) => [p, loadDoc(p)]))

/**
 * Repairable failures, as exact character spans.
 *
 * M20: a numeric drift this script can *prove* is a drift — because it measured
 * the real value itself — is a drift the script can also write back. Each entry
 * carries `start`/`end` offsets taken from a `d`-flagged clone of the rule's own
 * regex, so `--update` never has to guess which occurrence on the line was meant.
 * That guess is exactly what an ad-hoc "replace the first standalone number on
 * this line" script gets wrong, and this repo has already paid for it once.
 */
const repairs = []

function fail(rule, doc, index, message, repair) {
  checks.failed += 1
  const where = doc ? `${doc.path}:${doc.lineOf(index)}` : rule
  failures.push(`  ✗ [${rule}] ${where}\n      ${message}`)
  if (repair !== undefined && doc) repairs.push({ rule, path: doc.path, ...repair })
}

function pass(label) {
  checks.ran += 1
  if (!QUIET) notes.push(`  ✓ ${label}`)
}

/* ------------------------------------------------------ section 0: tools */

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: 'utf8' })
  return { status: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const LIB_DOMAIN = join(repoRoot, 'lib/domain/index.js')
const LIB_STORE = join(repoRoot, 'lib/store/store.js')
if (!existsSync(LIB_DOMAIN) || !existsSync(LIB_STORE)) {
  console.error('check-docs: lib/ is missing → run `pnpm build` first (exit 2)')
  process.exit(2)
}
{
  const srcNewest = Math.max(
    newestMtime(join(repoRoot, 'src/domain'), (f) => f.endsWith('.ts')),
    newestMtime(join(repoRoot, 'src/shared'), (f) => f.endsWith('.ts')),
  )
  const libOldest = Math.min(statSync(LIB_DOMAIN).mtimeMs, statSync(LIB_STORE).mtimeMs)
  if (srcNewest > libOldest + 1000) {
    console.error(
      'check-docs: src/{domain,shared} is newer than lib/ → run `pnpm build` first (exit 2)\n' +
        '            (comparing docs against a stale artefact would report false drift)',
    )
    process.exit(2)
  }
}

const D = await import(`file://${LIB_DOMAIN.replace(/\\/g, '/')}`)

/** `defineTool` counts per tool module — the "12 + 3 tools" claims derive from this. */
const TOOLS = (() => {
  const dir = join(repoRoot, 'src/tools')
  const count = (file) => (readStable(join(dir, file)).match(/name: 'factory_/g) ?? []).length
  const captain = count('captain.ts')
  const member = count('member.ts')
  return { captain, member, total: captain + member }
})()

/* -------------------------------------------------- section 1: tool truth */

const verifyRun = runNode('scripts/verify.mjs')
const doctorRun = runNode('scripts/doctor.mjs')

const verifyMatch = /SUCCESS: (\d+)\/(\d+) checks passed/.exec(verifyRun.out)
const verifySections = [...verifyRun.out.matchAll(/^--- ([A-Z]) /gm)].map((m) => m[1])
const doctorMatch = /(SUCCESS|FAILURE): (\d+)\/(\d+) installation checks passed/.exec(doctorRun.out)

if (!verifyMatch || !doctorMatch) {
  console.error('check-docs: could not parse the verify/doctor summaries (exit 2)')
  console.error(`  verify exit=${verifyRun.status}\n${verifyRun.out.slice(-800)}`)
  console.error(`  doctor exit=${doctorRun.status}\n${doctorRun.out.slice(-800)}`)
  process.exit(2)
}

/*
 * The two offline drills are separate programs on purpose (see
 * `.github/workflows/ci.yml`), and that is exactly why the README quoted their
 * ratios as prose: no gate observed them. A ratio nobody derives is a ratio that
 * drifts the way `43/43` once did while every table said `64/64`. So the doc gate
 * runs them too and derives the numbers the README prints.
 *
 * `scripts/load-smoke.mjs` is deliberately NOT run here: it needs `dsh` on PATH,
 * which a CI runner does not have. Its ratio is therefore derived a different
 * way — by counting the `STAGES` array in its source. Running the program is
 * what proves the ratio; reading the array is what keeps the README's copy of it
 * from drifting, and the drift is the failure this gate exists to catch.
 */
const engineDrillRun = runNode('scripts/engine-drill.mjs', ['--quiet'])
const gatesDrillRun = runNode('scripts/gates-drill.mjs', ['--quiet'])
/*
 * `ROLLBACK.md` ships in the tarball, so its stage count is a claim a user can act
 * on. It was `12 关` for two releases after the drill had grown to 14 — nothing
 * observed it, because the file was not in `DOCS` at all. Running the drill is
 * the same derivation the other two ratios get.
 */
const backupDrillRun = runNode('scripts/profile-backup.mjs', ['drill'])

const engineDrill = /SUCCESS: engine drill — (\d+)\/(\d+) stages passed/.exec(engineDrillRun.out)
const gatesDrill = /SUCCESS: gates drill — (\d+)\/(\d+) stages passed/.exec(gatesDrillRun.out)
const backupDrill = /drill: all (\d+) stages behaved as designed/.exec(backupDrillRun.out)

if (!engineDrill || !gatesDrill || !backupDrill) {
  console.error('check-docs: could not parse the drill summaries (exit 2)')
  console.error(`  engine exit=${engineDrillRun.status}\n${engineDrillRun.out.slice(-800)}`)
  console.error(`  gates exit=${gatesDrillRun.status}\n${gatesDrillRun.out.slice(-800)}`)
  console.error(`  backup exit=${backupDrillRun.status}\n${backupDrillRun.out.slice(-800)}`)
  process.exit(2)
}

/**
 * Counts the stages `scripts/load-smoke.mjs` declares.
 *
 * The drill cannot run in CI (no `dsh` on PATH), but both READMEs print its
 * `n/n` ratio, so the number has to come from somewhere other than prose. This
 * reads the declared `STAGES` array instead of trusting a count in a comment: if
 * the array is reshaped, the gate fails loudly rather than quietly counting zero.
 */
function loadSmokeStages() {
  const source = readFileSync(join(repoRoot, 'scripts', 'load-smoke.mjs'), 'utf8')
  const block = /^const STAGES = \[([\s\S]*?)^\]/m.exec(source)
  if (!block) {
    console.error('check-docs: could not find the STAGES array in scripts/load-smoke.mjs (exit 2)')
    process.exit(2)
  }
  const entries = block[1].split(/\r?\n/).filter((line) => /^\s*['"]/.test(line))
  if (entries.length < 2) {
    console.error(`check-docs: scripts/load-smoke.mjs declares only ${entries.length} stage(s) — refusing to derive a ratio from that (exit 2)`)
    process.exit(2)
  }
  return entries.length
}

/** The single source of truth every claim below is compared against. */
const V = {
  verifyChecks: Number(verifyMatch[1]),
  verifyTotal: Number(verifyMatch[2]),
  verifySections: verifySections.length,
  verifySectionList: verifySections.join(''),
  verifyExit: verifyRun.status,
  doctorPass: Number(doctorMatch[2]),
  doctorChecks: Number(doctorMatch[3]),
  doctorExit: doctorRun.status,
  engineDrillPass: Number(engineDrill[1]),
  engineDrillStages: Number(engineDrill[2]),
  gatesDrillPass: Number(gatesDrill[1]),
  gatesDrillStages: Number(gatesDrill[2]),
  backupDrillStages: Number(backupDrill[1]),
  loadSmokeStages: loadSmokeStages(),
  verifyLines: editorLines(join(repoRoot, 'scripts/verify.mjs')),
  doctorLines: editorLines(join(repoRoot, 'scripts/doctor.mjs')),
  compatibilityLines: editorLines(join(repoRoot, 'compatibility.json')),
  roles: D.ROLES.length,
  extraRoles: D.EXTRA_ROLES.length,
  prototypeAliases: Object.keys(D.PROTOTYPE_ROLE_ID_ALIASES).length,
  roleAliases: Object.keys(D.ROLE_ALIASES).length,
  pipelines: D.PIPELINE_IDS.length,
  stages: D.PIPELINE_IDS.reduce((n, id) => n + D.getPipeline(id).length, 0),
  stagesPerPipeline: D.PIPELINE_IDS.map((id) => `${id}=${D.getPipeline(id).length}`).join(', '),
  dod: D.DOD_ITEMS.length,
  triggers: D.SECURITY_TRIGGERS.length,
  maxMembers: D.DEFAULT_MAX_MEMBERS,
}

/** `src/**` module inventory, as claimed in `docs/architecture.md` §3 / §8. */
const SRC_GROUPS = {
  shared: ['src/shared', ['.ts']],
  domain: ['src/domain', ['.ts']],
  store: ['src/store', ['.ts']],
  runtime: ['src/runtime', ['.ts']],
  tools: ['src/tools', ['.ts']],
  client: ['src/client', ['.ts', '.tsx']],
  prompt: ['src/prompt', ['.ts']],
  web: ['src/web', ['.ts']],
  'index+command': [null, ['.ts']], // src/index.ts + src/command.ts
}
/**
 * Every source file under `dir`, **recursively**, as repo-relative POSIX paths.
 *
 * This walk used to be a single `readdirSync`, which silently stopped seeing
 * anything in a subdirectory. Review finding M5 split `src/tools/engine.ts` into
 * `src/tools/engine/*.ts` and the `tools` group immediately reported 1601 lines
 * instead of ~4900 — the rule did not notice ~3.3k lines of the codebase, and a
 * module the inventory cannot see is a module the inventory cannot guard. The
 * sort is for the failure messages: the module list must not depend on
 * filesystem enumeration order.
 */
function sourceFilesUnder(dir, extensions) {
  const found = []
  const walk = (rel) => {
    for (const entry of readdirSync(join(repoRoot, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile() && extensions.includes(entry.name.slice(entry.name.lastIndexOf('.')))) found.push(child)
    }
  }
  walk(dir)
  return found.sort()
}

function measureGroup(name) {
  const [dir, extensions] = SRC_GROUPS[name]
  const files =
    dir === null
      ? ['src/index.ts', 'src/command.ts'].filter((f) => existsSync(join(repoRoot, f)))
      : sourceFilesUnder(dir, extensions)
  const lines = files.reduce((n, f) => n + editorLines(join(repoRoot, f)), 0)
  return { modules: files.length, lines, files }
}
const MODULES = Object.fromEntries(Object.keys(SRC_GROUPS).map((g) => [g, measureGroup(g)]))

pass(
  `tool truth: verify ${V.verifyChecks}/${V.verifyTotal} (exit ${V.verifyExit}, sections ${V.verifySectionList}), ` +
    `doctor ${V.doctorPass}/${V.doctorChecks} (exit ${V.doctorExit}), ` +
    `verify.mjs ${V.verifyLines} lines, doctor.mjs ${V.doctorLines} lines`,
)

pass(
  `drill truth: engine ${V.engineDrillPass}/${V.engineDrillStages} stages (exit ${engineDrillRun.status}), ` +
    `gates ${V.gatesDrillPass}/${V.gatesDrillStages} stages (exit ${gatesDrillRun.status})`,
)

/* ------------------------------------------------------- section 2: claims */

/**
 * One entry per code-derived quantity a document states.
 * `expect(match)` returns the value(s) the captured group(s) must equal.
 * `min` = how many occurrences the rule requires (a claim may legitimately
 * appear in several documents).
 */
const CLAIMS = [
  // ---- verify: check count ------------------------------------------------
  {
    id: 'verify checks (README dev block)',
    files: [DOCS.readme],
    re: /verify\.mjs \((\d+) checks, (\d+) sections/g,
    expect: () => [V.verifyChecks, V.verifySections],
  },
  {
    id: 'verify checks (README_ZH dev block)',
    files: [DOCS.readmeZh],
    re: /verify\.mjs（(\d+) 项检查，(\d+) 个分区）/g,
    expect: () => [V.verifyChecks, V.verifySections],
  },
  {
    id: 'verify checks (architecture §7)',
    files: [DOCS.architecture],
    re: /verify\.mjs` (\d+)\/(\d+)/g,
    expect: () => [V.verifyChecks, V.verifyTotal],
  },
  {
    id: 'verify checks (architecture M7 row)',
    files: [DOCS.architecture],
    re: /verify\.mjs`（\d+ 行，`node scripts\/verify\.mjs` → (\d+)\/(\d+) exit 0/g,
    expect: () => [V.verifyChecks, V.verifyTotal],
  },
  {
    id: 'verify checks (roles-and-pipelines §8)',
    files: [DOCS.roles],
    re: /跑 (\d+) 项检查/g,
    expect: () => [V.verifyChecks],
  },
  {
    id: 'verify checks (E2E G3 row)',
    files: [DOCS.e2e],
    re: /`SUCCESS: (\d+)\/(\d+)`/g,
    expect: () => [V.verifyChecks, V.verifyTotal],
  },

  // ---- verify: pass ratio ------------------------------------------------
  {
    id: 'verify ratio (README table)',
    files: [DOCS.readme],
    re: /exit 0 — (\d+)\/(\d+) green/g,
    expect: () => [V.verifyChecks, V.verifyTotal],
  },
  {
    id: 'verify ratio (README_ZH table)',
    files: [DOCS.readmeZh],
    re: /exit 0，(\d+)\/(\d+) 绿/g,
    expect: () => [V.verifyChecks, V.verifyTotal],
  },
  {
    id: 'verify ratio (roles-and-pipelines §8)',
    files: [DOCS.roles],
    re: /实测 \*\*(\d+)\/(\d+) 绿、exit (\d+)\*\*/g,
    expect: () => [V.verifyChecks, V.verifyTotal, V.verifyExit],
  },
  {
    id: 'verify ratio (E2E §6.2 row)',
    files: [DOCS.e2e],
    re: /verify exit (\d+) \/ (\d+)-(\d+) 绿/g,
    expect: () => [V.verifyExit, V.verifyChecks, V.verifyChecks],
  },
  {
    id: 'verify ratio (architecture §7)',
    files: [DOCS.architecture],
    re: /`node scripts\/verify\.mjs` (\d+)\/(\d+)/g,
    expect: () => [V.verifyChecks, V.verifyTotal],
  },
  {
    /*
     * The status paragraph at the bottom of both READMEs. This is the exact site
     * that carried `43/43` for several refreshes while the tables said `64/64`:
     * every other ratio rule keys off a table row, and this sentence has a
     * different shape, so nothing watched it. `verify checks (README dev block)`
     * could not catch it either -- it looks for the script's own wording.
     */
    id: 'verify ratio (README status paragraph)',
    files: [DOCS.readme, DOCS.readmeZh],
    re: /`node scripts\/verify\.mjs` (\d+)\/(\d+)[,、]/g,
    expect: () => [V.verifyChecks, V.verifyTotal, V.verifyChecks, V.verifyTotal],
  },

  // ---- drills: stage ratios ----------------------------------------------
  {
    /*
     * Both READMEs quote these two lines verbatim, backticks included: they are
     * real program output, so the pattern matches the output shape instead of a
     * sentence describing it. Two values per occurrence — each capture group
     * carries one half of the ratio.
     */
    id: 'engine drill ratio (README tables)',
    files: [DOCS.readme, DOCS.readmeZh],
    re: /`SUCCESS: engine drill — (\d+)\/(\d+) stages passed`/g,
    expect: () => [V.engineDrillPass, V.engineDrillStages],
  },
  {
    id: 'gates drill ratio (README tables)',
    files: [DOCS.readme, DOCS.readmeZh],
    re: /`SUCCESS: gates drill — (\d+)\/(\d+) stages passed`/g,
    expect: () => [V.gatesDrillPass, V.gatesDrillStages],
  },
  {
    /*
     * `ROLLBACK.md` ships inside the tarball (`files` lists it), so a wrong stage
     * count there is a wrong instruction in the reader's hands during an
     * incident. It said `12 关` while the drill ran 14, and nothing noticed
     * because the runbook was outside this gate entirely.
     */
    id: 'backup drill stages (ROLLBACK.md)',
    files: [DOCS.rollback],
    re: /自检 (\d+) 关|`drill` 的 (\d+) 关/g,
    expect: () => [V.backupDrillStages, V.backupDrillStages],
  },
  {
    /*
     * The loaded-smoke ratio is derived by counting the drill's own `STAGES`
     * array, because this gate cannot run it (it needs `dsh` on PATH). Before
     * this rule the number was hand-copied into both READMEs with nothing
     * observing it — which is how a drill grows a stage and the table keeps
     * claiming the old total.
     */
    id: 'load smoke ratio (README tables)',
    files: [DOCS.readme, DOCS.readmeZh],
    re: /`SUCCESS: load smoke — (\d+)\/(\d+) stages passed`/g,
    expect: () => [V.loadSmokeStages, V.loadSmokeStages],
  },

  // ---- verify: script lines ----------------------------------------------
  {
    id: 'verify.mjs lines (architecture M7)',
    files: [DOCS.architecture],
    re: /`scripts\/verify\.mjs`（(\d+) 行/g,
    expect: () => [V.verifyLines],
  },
  {
    id: 'verify.mjs lines (README tree)',
    files: [DOCS.readme, DOCS.readmeZh],
    re: /verify\.mjs \(L1 offline, (\d+) checks\)|verify\.mjs（L1 离线，(\d+) 项检查）/g,
    expect: () => [V.verifyChecks, V.verifyChecks],
  },

  // ---- doctor ------------------------------------------------------------
  {
    id: 'doctor checks (README dev block)',
    files: [DOCS.readme],
    re: /doctor\.mjs \((\d+) checks\)/g,
    expect: () => [V.doctorChecks],
  },
  {
    id: 'doctor checks (README_ZH dev block)',
    files: [DOCS.readmeZh],
    re: /doctor\.mjs（(\d+) 项检查）/g,
    expect: () => [V.doctorChecks],
  },
  {
    id: 'doctor lines + checks (architecture M7)',
    files: [DOCS.architecture],
    re: /`scripts\/doctor\.mjs`（(\d+) 行，(\d+) 项自检/g,
    expect: () => [V.doctorLines, V.doctorChecks],
  },
  {
    id: 'doctor ratio (README table)',
    files: [DOCS.readme],
    re: /doctor:install` \| ✅ exit 0 — (\d+)\/(\d+)/g,
    expect: () => [V.doctorPass, V.doctorChecks],
  },
  {
    id: 'doctor ratio (README_ZH table)',
    files: [DOCS.readmeZh],
    re: /doctor:install` \| ✅ exit 0，(\d+)\/(\d+)/g,
    expect: () => [V.doctorPass, V.doctorChecks],
  },
  {
    id: 'doctor ratio (architecture §7 + M7)',
    files: [DOCS.architecture],
    re: /doctor:install` [^|\n]*?(\d+)\/(\d+)/g,
    expect: () => [V.doctorPass, V.doctorChecks],
  },
  {
    id: 'doctor ratio (E2E gate table G1)',
    files: [DOCS.e2e],
    re: /✅ \*\*已满足\*\*：实测 \*\*(\d+)\/(\d+)\*\*/g,
    expect: () => [V.doctorPass, V.doctorChecks],
  },
  {
    id: 'doctor ratio (E2E §6.2 row)',
    files: [DOCS.e2e],
    re: /doctor exit (\d+) \/ (\d+)-(\d+) 绿/g,
    expect: () => [V.doctorExit, V.doctorPass, V.doctorChecks],
  },
  {
    id: 'doctor ratio (E2E §2.2 "必须全绿")',
    files: [DOCS.e2e],
    re: /必须全绿（(\d+)\/(\d+)）/g,
    expect: () => [V.doctorPass, V.doctorChecks],
  },
  {
    // The runbook's copy-paste block carried a stale 8/8 while every table said
    // 8/8 — it only became wrong when doctor grew a ninth check, and no rule was
    // anchored on this shape. Same hole H6 found in the README status paragraph.
    id: 'doctor ratio (E2E runbook command)',
    files: [DOCS.e2e],
    re: /doctor:install\s+# 必须 (\d+)\/(\d+)/g,
    expect: () => [V.doctorPass, V.doctorChecks],
  },
  {
    id: 'doctor ratio (E2E runbook criterion)',
    files: [DOCS.e2e],
    re: /判定：doctor (\d+)\/(\d+)/g,
    expect: () => [V.doctorPass, V.doctorChecks],
  },
  {
    id: 'compatibility.json lines (architecture M7)',
    files: [DOCS.architecture],
    re: /`compatibility\.json`（(\d+) 行）/g,
    expect: () => [V.compatibilityLines],
  },

  // ---- domain registry counts --------------------------------------------
  {
    id: 'roles count (README)',
    files: [DOCS.readme, DOCS.readmeZh],
    re: /(\d+)-job role registry|\*\*(\d+) 个固定岗位\*\*/g,
    expect: () => [V.roles, V.roles],
  },
  {
    id: 'roles + pipelines + DoD (architecture M1)',
    files: [DOCS.architecture],
    re: /(\d+) 岗位 \/ (\d+) 模板 (\d+) 阶段 \/ (\d+) 条 DoD/g,
    expect: () => [V.roles, V.pipelines, V.stages, V.dod],
  },
  {
    id: 'roles + pipelines (README feature table)',
    files: [DOCS.readme, DOCS.readmeZh],
    re: /(\d+) fixed jobs|(\d+) 个固定岗位/g,
    expect: () => [V.roles, V.roles],
  },
  {
    id: 'roles count (spec header)',
    files: [DOCS.roles],
    re: /规范岗位 \*\*(\d+)\*\* 个/g,
    expect: () => [V.roles],
  },
  {
    id: 'pipeline count (spec header)',
    files: [DOCS.roles],
    re: /流水线模板 \*\*(\d+)\*\* 套/g,
    expect: () => [V.pipelines],
  },
  {
    id: 'stage total per pipeline (spec header)',
    files: [DOCS.roles],
    re: /阶段数 ([\d /]+)/g,
    expect: () => [D.PIPELINE_IDS.map((id) => D.getPipeline(id).length).join(' / ')],
  },
  {
    id: 'DoD count (spec header)',
    files: [DOCS.roles],
    re: /DoD \*\*(\d+)\*\* 条/g,
    expect: () => [V.dod],
  },
  {
    id: 'security trigger count (spec §4.2)',
    files: [DOCS.roles],
    re: /安全岗触发（(\d+) 个关键词）/g,
    expect: () => [V.triggers],
  },

  // ---- tool surface counts -----------------------------------------------
  {
    id: 'tool split (architecture M3 row)',
    files: [DOCS.architecture],
    re: /(\d+) 队长 \+ (\d+) 成员工具/g,
    expect: () => [TOOLS.captain, TOOLS.member],
  },
  {
    id: 'tool total (architecture §7)',
    files: [DOCS.architecture],
    re: /(\d+) 个 `factory_\*` 工具/g,
    expect: () => [TOOLS.total],
  },
  {
    id: 'tool split (README tree)',
    files: [DOCS.readme],
    re: /\(landed: (\d+) \+ (\d+) tools\)/g,
    expect: () => [TOOLS.captain, TOOLS.member],
  },
  {
    id: 'tool split (E2E G4 row)',
    files: [DOCS.e2e],
    re: /(\d+) 个 `defineTool`：(\d+) 队长 \+ (\d+) 成员/g,
    expect: () => [TOOLS.total, TOOLS.captain, TOOLS.member],
  },

  // ---- module inventory quoted in the READMEs (stable groups only; the
  //      actively-developed `src/runtime` count lives in architecture.md §3,
  //      where the §6.3 churn window applies) -----------------------------
  {
    id: 'README module lines (domain, store)',
    files: [DOCS.readme],
    group: (m) => m[1],
    re: /\(`src\/(domain|store)\/`, (\d+) modules \/ (\d+) lines\)/g,
    expect: (m) => [m[1] === 'domain' ? MODULES.domain.modules : MODULES.store.modules,
      m[1] === 'domain' ? MODULES.domain.lines : MODULES.store.lines],
  },
  {
    id: 'README module counts (client, prompt, web)',
    files: [DOCS.readme],
    group: (m) => m[1],
    re: /\(`src\/(client|prompt|web)\/`, (\d+) modules/g,
    expect: (m) => [MODULES[m[1]].modules],
  },
  {
    id: 'README_ZH module lines (domain, store)',
    files: [DOCS.readmeZh],
    group: (m) => m[1],
    re: /（`src\/(domain|store)\/`，(\d+) 模块 \/ (\d+) 行）/g,
    expect: (m) => [m[1] === 'domain' ? MODULES.domain.modules : MODULES.store.modules,
      m[1] === 'domain' ? MODULES.domain.lines : MODULES.store.lines],
  },
  {
    id: 'README_ZH module counts (client, prompt, web)',
    files: [DOCS.readmeZh],
    group: (m) => m[1],
    re: /（`src\/(client|prompt|web)\/`，(\d+) 模块/g,
    expect: (m) => [MODULES[m[1]].modules],
  },
]

let missingClaims = 0
for (const rule of CLAIMS) {
  let seen = 0
  // `d` gives every capture group a [start, end) span in the source text, which is
  // what turns "update the number" from a guess into an exact edit. Adding the
  // flag is safe: it only populates `match.indices`.
  const indexed = new RegExp(rule.re.source, rule.re.flags.includes('d') ? rule.re.flags : `${rule.re.flags}d`)
  for (const file of rule.files) {
    const doc = loaded.get(file)
    for (const match of doc.text.matchAll(indexed)) {
      seen += 1
      // Only the *numeric* capture groups are values; a pattern may carry a
      // leading label capture (e.g. which directory it matched) for branching.
      // Keep the original group index so `match.indices` stays addressable.
      const captured = []
      match.slice(1).forEach((group, at) => {
        if (group !== undefined && /^\d+$/.test(group)) captured.push({ value: group, at: at + 1 })
      })
      const expected = rule.expect(match)
      const group = typeof rule.group === 'function' ? rule.group(match) : rule.group
      captured.forEach(({ value, at }, i) => {
        const want = String(expected[i] ?? expected[0])
        if (value !== want) {
          if (group && withinChurnWindow(group)) {
            suppressed.push(`${rule.id} @ ${doc.path}:${doc.lineOf(match.index)}`)
            warnings.push(
              `  ⚠ ${rule.id} — ${doc.path}:${doc.lineOf(match.index)} 写着 ${value}，当前测量 ${want}；` +
                `${SRC_GROUPS[group][0]} 在观测窗口内有写入，按并发编辑瞬态放过（--concurrent 已显式开启）`,
            )
          } else {
            const span = match.indices?.[at]
            fail(
              rule.id,
              doc,
              match.index,
              `写着 ${value}，实际是 ${want}`,
              span ? { start: span[0], end: span[1], from: value, to: want } : undefined,
            )
          }
        }
      })
    }
  }
  if (seen === 0) {
    missingClaims += 1
    fail(rule.id, null, 0, '这条数字声明在任何被扫文档里都找不到（被删了？措辞改了？）→ 请同步本脚本的 CLAIMS 表')
  } else {
    pass(`${rule.id} — ${seen} 处一致`)
  }
}

/* ------------------------------------------- section 3: tables vs. domain */

const tableRows = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|') && !/^\|[\s:|-]+\|$/.test(line.trim()))
    .map((line) => line.trim().slice(1, -1).split('|').map((cell) => cell.trim()))
const unquote = (s) => s.replace(/`/g, '').trim()
const ticked = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1])

{
  const doc = loaded.get(DOCS.roles)
  const lines = doc.text.split(/\r?\n/)
  const slice = (from, to) => {
    const a = lines.findIndex((l) => l.includes(from))
    const b = to ? lines.findIndex((l, i) => i > a && l.includes(to)) : lines.length
    return lines.slice(a, b < 0 ? lines.length : b).join('\n')
  }

  const roleRows = tableRows(slice('## 1. 角色注册表', '### 1.1')).filter((c) => /^\d+$/.test(c[0]))
  if (roleRows.length !== D.ROLES.length) {
    fail('roles table', doc, 0, `${roleRows.length} 行，应为 ${D.ROLES.length}`)
  } else {
    D.ROLES.forEach((def, i) => {
      const row = roleRows[i]
      const fields = [
        ['id', unquote(row[1]), def.id],
        ['中文名', row[2], def.title],
        ['代号', row[3], def.codename],
        ['档位', row[4], def.tier],
        ['分类色', unquote(row[5]), def.color],
        ['职责', row[6], def.duties],
        ['工件白名单', ticked(row[7]).join(','), def.outputs.join(',')],
        ['铁律条数', row[8], String(def.ironRules.length)],
      ]
      for (const [field, got, want] of fields) {
        if (got !== want) fail(`role ${def.id}.${field}`, doc, 0, `写着 ${got}，实际是 ${want}`)
      }
    })
    pass(`roles table — ${roleRows.length} 行 × 8 字段与 roles.ts 一致`)
  }

  const protoRows = tableRows(slice('### 2.1 原型 id', '### 2.2')).filter((c) => c[0].startsWith('`'))
  const protoEntries = Object.entries(D.PROTOTYPE_ROLE_ID_ALIASES)
  if (protoRows.length !== protoEntries.length) {
    fail('prototype id table', doc, 0, `${protoRows.length} 行，应为 ${protoEntries.length}`)
  } else {
    protoEntries.forEach(([proto, canonical], i) => {
      if (unquote(protoRows[i][0]) !== proto) fail('prototype id table', doc, 0, `行 ${i + 1} 原型 id`)
      if (unquote(protoRows[i][1]) !== canonical) fail('prototype id table', doc, 0, `行 ${i + 1} 规范 id`)
    })
    pass(`prototype id table — ${protoRows.length} 行与 PROTOTYPE_ROLE_ID_ALIASES 一致`)
  }

  let stageRowsSeen = 0
  for (const id of D.PIPELINE_IDS) {
    const stages = D.getPipeline(id)
    const heading = lines.find((l) => new RegExp(`^### 5\\.\\d+ \`${id}\``).test(l))
    if (!heading) {
      fail(`pipeline ${id}`, doc, 0, '找不到该模板的小节标题')
      continue
    }
    const titleCount = /（(\d+) 阶段/.exec(heading)
    if (!titleCount || Number(titleCount[1]) !== stages.length) {
      fail(`pipeline ${id} heading`, doc, 0, `标题阶段数写着 ${titleCount?.[1]}，实际 ${stages.length}`)
    }
    const start = lines.indexOf(heading)
    const next = lines.findIndex((l, i) => i > start && /^### 5\.\d+ `/.test(l))
    const rows = tableRows(lines.slice(start, next < 0 ? lines.length : next).join('\n')).filter(
      (c) => /^\d+$/.test(c[0]) && c.length === 9,
    )
    stageRowsSeen += rows.length
    if (rows.length !== stages.length) {
      fail(`pipeline ${id} table`, doc, 0, `${rows.length} 行，应为 ${stages.length}`)
      continue
    }
    stages.forEach((stage, i) => {
      const row = rows[i]
      const checks = [
        ['stage id', unquote(row[1]), stage.id],
        ['名称', row[2], stage.name],
        ['角色', ticked(row[3]).join(','), stage.roles.join(',')],
        ['并行', row[4] === '✅', stage.roles.length > 1],
        ['人工审批', row[5] === '✅', stage.humanApproval === true],
        ['门禁类型', row[6], stage.gate.type],
        ['maxRounds', Number(row[7]), stage.maxRounds],
        ['failGoto', unquote(row[8]) === '—' ? undefined : unquote(row[8]), stage.failGoto],
      ]
      for (const [field, got, want] of checks) {
        if (got !== want) fail(`pipeline ${id}/${stage.id}.${field}`, doc, 0, `写着 ${got}，实际是 ${want}`)
      }
    })
    pass(`pipeline ${id} — ${rows.length} 阶段 × 8 字段与 pipeline.ts 一致`)
  }
  if (stageRowsSeen !== V.stages) {
    fail('stage total', doc, 0, `阶段行合计 ${stageRowsSeen}，应为 ${V.stages}`)
  }

  const dodRows = tableRows(slice('## 6. DoD 七条', '## 7. 与原型方案')).filter(
    (c) => /^\d+$/.test(c[0]) && c.length === 6,
  )
  if (dodRows.length !== D.DOD_ITEMS.length) {
    fail('DoD table', doc, 0, `${dodRows.length} 行，应为 ${D.DOD_ITEMS.length}`)
  } else {
    D.DOD_ITEMS.forEach((item, i) => {
      const row = dodRows[i]
      const checks = [
        ['label', unquote(row[1]), item.label],
        ['kind', unquote(row[2]), item.kind],
        ['artifact', unquote(row[3]) === '—' ? undefined : unquote(row[3]), item.artifact],
        ['securityOnly', row[5].includes('✅'), item.securityOnly === true],
      ]
      for (const [field, got, want] of checks) {
        if (got !== want) fail(`DoD #${item.id}.${field}`, doc, 0, `写着 ${got}，实际是 ${want}`)
      }
      if (item.kind !== 'file') {
        const needle = item.run ?? item.expect ?? ''
        if (!row[4].includes(needle)) fail(`DoD #${item.id}.判据`, doc, 0, `判据列应含 ${needle}`)
      }
    })
    pass(`DoD table — ${dodRows.length} 行与 dod.ts 一致`)
  }
}

/* --------------------------- section 3.6: limitation disclosure (text) ---- */

{
  const doc = loaded.get(DOCS.limitations)

  // (a) The takeover gap must LEAD the document: a reader who stops after the
  //     first heading still learns the thing that can destroy their work.
  if (/^##\s*1\..*(接手|brownfield)/m.test(doc.text)) {
    pass('limitations §1 — 首节即「接手半成品 / brownfield」缺口')
  } else {
    fail(
      'limitations §1 leads with brownfield',
      doc,
      0,
      '第一节标题必须直接点明「接手半成品 / brownfield」→ 否则读者会先读到次要限制，而这条是会覆盖别人成果的',
    )
  }

  // (b) Mechanism, not slogan: the four facts that make the gap real must be
  //     quoted with their source location (the captain's wording: 不要弱化).
  const REQUIRED_EVIDENCE = [
    ['成员简报不提工作区既有内容', 'src/prompt/member-brief.ts:194'],
    ['计划阶段不做工作区 inventory', 'src/tools/captain.ts:353'],
    ['流水线没有 recon / baseline 阶段', 'src/domain/pipeline.ts:76'],
    ['DoD 是状态判定（会命中成熟仓库）', 'src/domain/dod.ts:57-102'],
  ]
  for (const [label, needle] of REQUIRED_EVIDENCE) {
    if (doc.text.includes(needle)) pass(`limitations 证据 — ${label}（${needle}）`)
    else {
      fail(
        'limitations evidence',
        doc,
        0,
        `缺少机制证据 ${needle}（${label}）→ 这条限制会退化成口号，下一个人照样踩`,
      )
    }
  }

  // (c) Proposals must never read as current capability.
  if (/建议[^。\n]{0,8}未实现|未实现[^。\n]{0,8}建议/.test(doc.text)) {
    pass('limitations — 建议方向已显式标注「未实现」')
  } else {
    fail(
      'limitations proposals',
      doc,
      0,
      '「建议方向」必须显式标注为未实现/建议，否则读者会把它当成已经有的能力',
    )
  }

  // (d) Disclosure where the reader decides: both READMEs, first bullet, linked.
  for (const path of [DOCS.readme, DOCS.readmeZh]) {
    const readme = loaded.get(path)
    const sectionRe = /^##\s*(?:Known limitations|已知限制)\s*$/m
    const section = sectionRe.exec(readme.text)
    if (!section) {
      fail('README limitations section', readme, 0, '缺少 `## Known limitations` / `## 已知限制` 小节')
      continue
    }
    const after = readme.text.slice(section.index + section[0].length)
    const firstBullet = /^\s*[-*]\s+(.{0,400})/m.exec(after)
    if (firstBullet && /brownfield|接手/.test(firstBullet[1])) {
      pass(`${path} — 已知限制第一条即 brownfield/接手缺口`)
    } else {
      fail(
        'README limitations first bullet',
        readme,
        section.index,
        '已知限制的**第一条**必须是「接手已有项目 / brownfield」缺口（读者常在读第一条时就决定要不要用）',
      )
    }
    const end = /^##\s/m.exec(after)
    const body = after.slice(0, end ? end.index : undefined)
    if (body.includes('docs/limitations.md')) {
      pass(`${path} — 已知限制小节内链接 docs/limitations.md`)
    } else {
      fail(
        'README limitations link',
        readme,
        section.index,
        '已知限制小节内必须链接 docs/limitations.md（否则读者永远看不到 §§2–8 的其余边界）',
      )
    }
  }

  // (e) `docs/usage.md` is another member's unfinished business: existence-aware
  //     only. Never red — a doc that is not there is not a doc defect.
  const usagePath = OPTIONAL_DOCS.usage
  if (existsSync(join(repoRoot, usagePath))) {
    const mentioned = [DOCS.readme, DOCS.readmeZh].filter((p) =>
      loaded.get(p).text.includes('docs/usage.md'),
    )
    if (mentioned.length === 2) pass(`${usagePath} 存在，且两份 README 都提到它`)
    else {
      checks.ran += 1
      warnings.push(
        `  ⚠ ${usagePath} 已存在，但 ${mentioned.length === 0 ? '两份 README 都' : mentioned.length === 1 ? '其中一份 README' : ''}没提到它` +
          '（可选文档，不判失败；作者落地时应顺手更新 README 的文档索引）',
      )
    }
  } else {
    pass(`${usagePath} 尚未落地（可选文档，跳过相关断言）`)
  }
}

/* --------------------------------------- section 4: module inventory claims */

{
  const doc = loaded.get(DOCS.architecture)
  // Both the directory table rows and the milestone rows state "N 模块 M 行".
  // `[^\n]*?` keeps each match inside one line, so a rule can never pair a row's
  // anchor with a *later* row's numbers.
  const CLAIM_GROUPS = [
    ['shared', /`src\/shared\/`[^\n]*?(\d+) 模块 (\d+) 行/],
    ['domain', /`src\/domain\/`[^\n]*?(\d+) 模块 (\d+) 行/],
    ['store', /`src\/store\/`[^\n]*?(\d+) 模块 (\d+) 行/],
    ['runtime', /`src\/runtime\/`[^\n]*?(\d+) 模块 (\d+) 行/],
    ['tools', /`src\/tools\/`[^\n]*?(\d+) 模块 (\d+) 行/],
    ['client', /`src\/client\/`[^\n]*?(\d+) 模块 (\d+) 行/],
    ['prompt', /`src\/prompt\/`[^\n]*?(\d+) 模块 (\d+) 行/],
    ['web', /`src\/web\/`[^\n]*?(\d+) 模块 (\d+) 行/],
    ['index+command', /`src\/index\.ts` \+ `src\/command\.ts`[^\n]*?(\d+) 模块 (\d+) 行/],
  ]
  for (const [group, re] of CLAIM_GROUPS) {
    // `d` again: the two numbers in "N 模块 M 行" are adjacent on the same line, so
    // a positional guess would happily rewrite the wrong one.
    const matches = [...doc.text.matchAll(new RegExp(re.source, 'gd'))]
    if (matches.length === 0) {
      fail(`module inventory ${group}`, doc, 0, '找不到「N 模块 M 行」声明')
      continue
    }
    const measured = MODULES[group]
    let churned = false
    for (const match of matches) {
      const modulesSpan = match.indices?.[1]
      const linesSpan = match.indices?.[2]
      if (Number(match[1]) !== measured.modules) {
        if (withinChurnWindow(group)) churned = true
        else {
          fail(
            `module inventory ${group}.modules`,
            doc,
            match.index,
            `写着 ${match[1]}，实际 ${measured.modules}`,
            modulesSpan
              ? { start: modulesSpan[0], end: modulesSpan[1], from: match[1], to: String(measured.modules) }
              : undefined,
          )
        }
      }
      if (Number(match[2]) !== measured.lines) {
        if (withinChurnWindow(group)) churned = true
        else {
          fail(
            `module inventory ${group}.lines`,
            doc,
            match.index,
            `写着 ${match[2]}，实际 ${measured.lines}`,
            linesSpan
              ? { start: linesSpan[0], end: linesSpan[1], from: match[2], to: String(measured.lines) }
              : undefined,
          )
        }
      }
    }
    if (churned) {
      suppressed.push(`module inventory ${group}`)
      warnings.push(
        `  ⚠ module inventory ${group} — 该目录在观测窗口内有写入（${SRC_GROUPS[group][0] ?? 'src/index.ts+command.ts'}）：` +
          `文档与当前测量不一致，按并发编辑瞬态放过；等写入停止后重跑，若仍不一致就是真漂移`,
      )
      continue
    }
    pass(`module inventory ${group} — ${measured.modules} 模块 ${measured.lines} 行`)
  }
}

/** §6.3 observation window: a group whose newest file was just written is "in flight". */
function withinChurnWindow(group) {
  if (STRICT) return false
  const [dir] = SRC_GROUPS[group]
  const files =
    dir === null
      ? ['src/index.ts', 'src/command.ts'].filter((f) => existsSync(join(repoRoot, f)))
      : readdirSync(join(repoRoot, dir), { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => join(repoRoot, dir, e.name))
  const newest = Math.max(0, ...files.map((f) => statSync(f).mtimeMs))
  return Date.now() - newest < CHURN_WINDOW_MS
}

/* ------------------------------------------------- section 5: stale values */

/**
 * Values that used to be correct. Each entry names the quantity whose *current*
 * value is `now`, so a reappearance is always a drift regression, never a
 * legitimate historical reference (those live in docs/VERIFICATION.md, which is
 * deliberately outside the scan set).
 */
const STALE = [
  { id: 'verify checks 33', tokens: ['33/33', '33 项检查', '33 checks', '33-33'], now: `${V.verifyChecks}` },
  { id: 'verify.mjs lines 881', tokens: ['881 行'], now: `${V.verifyLines}` },
  // The split('\n')-based numbers that shipped in t24: banned so the second
  // convention cannot creep back into the docs (see LINE-COUNT CONVENTION above).
  // These ban the value that is *one line ahead* of the current one, so each one
  // graduates into an unsatisfiable deadlock the moment the file grows (B7).
  // `unless` states that condition explicitly instead of waiting for it.
  {
    id: 'verify.mjs lines 1382 (split 口径)',
    tokens: ['scripts/verify.mjs`（1382 行'],
    now: `${V.verifyLines}`,
    unless: () => V.verifyLines === 1382,
  },
  {
    id: 'doctor.mjs lines 328 (split 口径)',
    tokens: ['scripts/doctor.mjs`（328 行'],
    now: `${V.doctorLines}`,
    unless: () => V.doctorLines === 328,
  },
  {
    id: 'compatibility.json lines 141 (split 口径)',
    tokens: ['compatibility.json`（141 行'],
    now: `${V.compatibilityLines}`,
    unless: () => V.compatibilityLines === 141,
  },
  { id: 'doctor failing 7/8', tokens: ['7/8', '7-8'], now: `${V.doctorPass}/${V.doctorChecks}` },
  { id: 'compatibility.json lines 137', tokens: ['compatibility.json`（137 行）'], now: `${V.compatibilityLines}` },
  { id: 'runtime lines 3537', tokens: ['8 模块 3537 行'], now: `${MODULES.runtime.lines}` },
  { id: 'tools lines 4434', tokens: ['5 模块 4434 行'], now: `${MODULES.tools.lines}` },
  { id: 'store lines 2260', tokens: ['4 模块 2260 行'], now: `${MODULES.store.lines}` },
  { id: 'domain lines 2664', tokens: ['7 模块 2664 行'], now: `${MODULES.domain.lines}` },
  { id: 'verify sections A–E only', tokens: ['A 路由 / B 流水线 / C 门禁 / D DoD / E store）'], now: `A–${V.verifySectionList.at(-1)}` },
  {
    // Doctor went 8 → 9 checks when it learned to name the tree the runtime
    // loads. The old literal survived in four sentence shapes, and only three of
    // them had a CLAIMS rule anchored — the runbook's copy-paste block and its
    // pass criterion went stale in silence. Banned outright so the next shape
    // nobody thought to anchor is still caught by the scan.
    id: 'doctor checks 8',
    tokens: ['8/8', '8-8'],
    now: `${V.doctorPass}/${V.doctorChecks}`,
  },
]

/**
 * A `STALE` ban and a `CLAIMS` rule that mandates the same number cannot both
 * hold: the moment the banned literal *becomes* the current derived value,
 * `pnpm check:docs` can never exit 0 again, and there is no legal way to write
 * the document. That is B7's deadlock. Two guards keep it from coming back:
 *
 *   1. `unless()` — an entry may declare the condition under which its ban is
 *      void (used by the split-convention entries, whose banned literal is
 *      always exactly one line ahead of the current value).
 *   2. a derived safety net — if a banned token literally contains the entry's
 *      own `now` value, the ban is by construction unenforceable, so it
 *      graduates automatically instead of deadlocking. Reported, never silent.
 */
{
  const structural = STALE.filter((entry) => entry.id.includes('split 口径'))
  const unguarded = structural.filter((entry) => typeof entry.unless !== 'function')
  if (structural.length < 3) {
    fail('stale table shape', null, 0, `三分之一个「split 口径」禁令条目不见了（只剩 ${structural.length} 条）→ 有人删了墓碑`)
  } else if (unguarded.length > 0) {
    fail(
      'stale table shape',
      null,
      0,
      `${unguarded.map((e) => e.id).join('、')} 禁的是「当前值 +1」，却没有声明 unless() → ` +
        '文件再长一行就永久无法 exit 0（B7）',
    )
  } else {
    pass(`stale table shape — ${STALE.length} 条墓碑，${structural.length} 条「当前值 +1」禁令均已声明毕业条件`)
  }
}

for (const entry of STALE) {
  const nowText = String(entry.now)
  const graduated =
    typeof entry.unless === 'function' && entry.unless() === true
      ? 'unless()'
      : /\d/.test(nowText) && entry.tokens.some((token) => token.includes(nowText))
        ? 'token 内含当前值'
        : null
  if (graduated !== null) {
    warnings.push(
      `  ⚠ stale ${entry.id} — 禁令已毕业（${graduated}）：被禁字面量与当前派生值同为 ${nowText}，` +
        '此后只由 CLAIMS 约束；请删除该条目或在墓碑文档里记一笔',
    )
    continue
  }
  let hits = 0
  for (const file of SCANNED) {
    const doc = loaded.get(file)
    for (const token of entry.tokens) {
      let index = doc.text.indexOf(token)
      while (index >= 0) {
        hits += 1
        fail(`stale ${entry.id}`, doc, index, `出现过时值「${token}」；当前应为 ${entry.now}`)
        index = doc.text.indexOf(token, index + token.length)
      }
    }
  }
  if (hits === 0) pass(`stale scan ${entry.id} — 未复发`)
}

/* --------------------------------- section 6: every quantity is explained */

/**
 * Counters that are legitimately *not* derived from this repo's code (GUI facts,
 * profile inventory, harness probe counts, …). Each must carry a reason; an
 * unexplained counter means someone wrote a number nobody checks.
 */
const COUNTER_EXCEPTIONS = [
  { token: '17/17', reason: 'peerDependency 版本满足数（doctor 第 8 项输出，属安装环境）' },
  { token: '17 个 peer 包', reason: '同上，compatibility.json 声明的包数' },
  { token: '11 条', reason: 'desktop profile 的 dependencies 条数（用户环境快照）' },
  { token: '8 条', reason: 'desktop profile 的 dsh.profile.bundles 条数（用户环境快照）' },
  { token: '10 个目录', reason: '会话存储目录数（用户环境快照）' },
  { token: '79 项', reason: '离线 harness 的探针数（qa-dev 的 harness 自检输出，见 t19 记录）' },
  { token: '118', reason: 'systemPrompt section order（src/tools 注册处的事实值）' },
  { token: '1 秒', reason: '面板轮询节奏（src/client/api.ts 的 FACTORY_POLL_MS = 1000）' },
  { token: '3 对', reason: 'profile 里应用自留的 .bak 文件对数（用户环境快照）' },
  { token: '12 位', reason: '短哈希展示位数（文档的取证片段约定）' },
  { token: '2 个', reason: '会话 slug 示例等零散环境事实' },
  { token: '404', reason: 'HTTP 状态码（契约事实，非计数）' },
  { token: '8/8', reason: 'doctor 全绿口径；规范位置已由 CLAIMS 覆盖，其余为流程性表述' },
  { token: '10 分钟', reason: '最小验收路径的时间预算（人写的预算，不是代码事实）' },
]
{
  const COUNTER_RE = /\d+\s*(?:项检查|项自检|个分区|checks|sections)|(?<![\d.])\d+\/\d+(?![\d.])/g
  const explained = new Set(COUNTER_EXCEPTIONS.map((e) => e.token))
  const claimTexts = CLAIMS.map((c) => c.re.source).join(' ')
  let unexplained = 0
  for (const file of SCANNED) {
    const doc = loaded.get(file)
    for (const match of doc.text.matchAll(COUNTER_RE)) {
      const token = match[0]
      if (explained.has(token)) continue
      if (claimTexts.length > 0 && matchesAClaim(doc.text, match.index)) continue
      unexplained += 1
      fail(
        'unexplained number',
        doc,
        match.index,
        `「${token}」既不是 CLAIMS 里的数字，也不在 COUNTER_EXCEPTIONS 里 → ` +
          '要么让它由代码派生并加一条 claim，要么在 COUNTER_EXCEPTIONS 里写明理由',
      )
    }
  }
  if (unexplained === 0) pass(`number coverage — 所有计数型数字都有出处（${COUNTER_EXCEPTIONS.length} 条例外已注明理由）`)
}

/** True when `index` falls inside a match of one of the CLAIMS patterns. */
function matchesAClaim(text, index) {
  for (const rule of CLAIMS) {
    for (const match of text.matchAll(rule.re)) {
      if (index >= match.index && index < match.index + match[0].length) return true
    }
  }
  return false
}

/* ------------------------------------------------------------- --update */

/**
 * M20 — write the measured numbers back instead of asking a human to retype them
 * in three files.
 *
 * The contract is deliberately narrow, and the narrowness is the point:
 *
 *  - It repairs only what it can prove. A `repair` exists only where the script
 *    itself measured the true value and knows the exact character span of the
 *    wrong one. Structural findings (a deleted claim, a renamed heading, a table
 *    cell it cannot locate) carry no repair and simply stay red.
 *  - It never prints a verdict. `--update` evaluates nothing; it writes, then
 *    re-runs the whole script in a FRESH process so the exit code comes from a
 *    real read of the files on disk. If the write did not fix things, the second
 *    pass still fails — which is the honest outcome, and the reason this is safe
 *    to run in a loop.
 *  - It applies edits back-to-front per file, so an earlier offset is never
 *    invalidated by a later write, and it refuses an overlapping or mismatched
 *    span rather than corrupting the line.
 */
if (process.argv.includes('--update')) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--update')
  if (repairs.length === 0) {
    console.log('\ncheck-docs --update: 没有可自动回写的数字。')
  } else {
    const byFile = new Map()
    for (const repair of repairs) {
      if (!byFile.has(repair.path)) byFile.set(repair.path, [])
      byFile.get(repair.path).push(repair)
    }
    let written = 0
    for (const [path, list] of byFile) {
      const doc = loaded.get(path)
      let text = doc.text
      let ceiling = Number.POSITIVE_INFINITY
      for (const repair of [...list].sort((a, b) => b.start - a.start)) {
        const current = text.slice(repair.start, repair.end)
        if (repair.end > ceiling) {
          console.log(`  ! ${path}: 跳过重叠回写 [${repair.rule}] ${repair.from} → ${repair.to}`)
          continue
        }
        if (current !== repair.from) {
          console.log(`  ! ${path}: 跳过对不上的回写 [${repair.rule}] 期望「${repair.from}」，读到「${current}」`)
          continue
        }
        text = `${text.slice(0, repair.start)}${repair.to}${text.slice(repair.end)}`
        ceiling = repair.start
        written += 1
        console.log(`  · ${path}: ${repair.from} → ${repair.to}  [${repair.rule}]`)
      }
      writeFileSync(join(repoRoot, path), text, 'utf8')
    }
    console.log(`\ncheck-docs --update: 回写 ${written}/${repairs.length} 处数字，重新核对……\n`)
  }
  const again = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { stdio: 'inherit' })
  process.exit(again.status ?? 1)
}

/* ------------------------------------------------------------- reporting */

if (!QUIET && notes.length > 0) console.log(notes.join('\n'))
if (warnings.length > 0) {
  console.log('\nWARNINGS (不判失败，但必须有人看一眼):')
  console.log(warnings.join('\n'))
}
if (failures.length > 0) {
  console.log('\nFAILURES:')
  console.log(failures.join('\n'))
  console.log(
    `\ncheck-docs: ${checks.failed} 处文档与代码/工具不一致（已核对 ${checks.ran + checks.failed} 条规则）。\n` +
      '修法二选一：更新文档里的数字，或者（若数字本该不同）修代码后重跑本脚本。',
  )
  process.exit(1)
}
if (suppressed.length > 0) {
  // M18: "some rules were skipped" must not look like "all rules passed".
  console.log(
    `\ncheck-docs: ${suppressed.length} 条规则因 --concurrent 的观测窗口被放过，` +
      '本次结果**不等于**全绿：\n' +
      suppressed.map((item) => `  - ${item}`).join('\n') +
      '\n去掉 --concurrent（默认即严格）重跑，或等写入停止后再跑。',
  )
  process.exit(3)
}
console.log(
  `\nSUCCESS: ${checks.ran} rules green — 文档数字与实际一致\n` +
    `  verify ${V.verifyChecks}/${V.verifyTotal} (sections ${V.verifySectionList}) · ` +
    `doctor ${V.doctorPass}/${V.doctorChecks} · ` +
    `verify.mjs ${V.verifyLines} lines · doctor.mjs ${V.doctorLines} lines · ` +
    `${V.roles} roles / ${V.pipelines} pipelines / ${V.stages} stages / ${V.dod} DoD`,
)
