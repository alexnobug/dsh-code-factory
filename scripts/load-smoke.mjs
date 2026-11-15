#!/usr/bin/env node
/**
 * load-smoke.mjs — 端到端「装载」冒烟：在真实 dsh profile 里把本插件挂起来。
 *
 * Closes finding H15: “端到端全靠人工：613 行验收规程、10 个场景，无任何自动化装载测试”.
 * `scripts/verify.mjs` only ever loads `lib/domain`, `lib/store` and `lib/runtime`
 * **in-process**; nothing in this repository has ever exercised the DSH host's real
 * load path — `lib/index.js` (the Cordis entry), `lib/command.js` and
 * `lib/tools/*` — so “does the plugin actually mount and register its 16 tools in
 * a real profile” was discoverable only by a human following `docs/E2E-ACCEPTANCE.md`
 * §2.0 by hand. This drill automates exactly that, and automates it *safely*.
 *
 * It is not a shape test. It really does:
 *
 *   A. create a throwaway `DSH_HOME` and a throwaway factory workspace under
 *      `os.tmpdir()`; the real `~/.dsh` is never read for a profile and never written
 *   B. materialize a scratch profile from the shipped `headless` template with the
 *      real CLI (`dsh --profile <scratch> --from-default-profile headless`), then boot
 *      it once to prove the tool observation *discriminates*: with no plugin there
 *      are zero `factory_*` tools
 *   C. install **this** repository into that profile through the real plugin manager
 *      (`dsh plugin --profile <scratch> add <repoRoot>`), and assert the protocol pnpm
 *      actually used ("link:"/"file:" — a link install needs no registry)
 *   D. assert the composed profile tree really carries the plugin
 *      (`dsh --profile <scratch> --dump-config`): the plugin's own bundle section, its
 *      entry id/name, its declared config, and no `disabled:` flag
 *   E. boot the composed profile through the real Cordis loader and read the **live
 *      tool registry** out of the mounted context, then compare it to
 *      `FACTORY_TOOL_NAMES` imported from `lib/runtime/tool-surface.js`.
 *   F. pack the real release artifact (`npm pack --ignore-scripts`) and install **that
 *      tarball** into a second throwaway profile, then assert it is a materialised
 *      copy rather than a `link:` back into this checkout. Stages A-E install the
 *      repository by path, so a green A-E says nothing about what a user receives:
 *      the tarball carries only `files[]`, has no `src/`, and cannot resolve a
 *      relative import back into the checkout.
 *
 * How E observes the registry (this is the part that makes the count a fact rather
 * than a claim): the CLI has no tool-enumeration flag (`dsh --help` exposes only
 * `--dump-config`, `--dump-config-schema`, `--dump-default-config`), and
 * `--dump-config` is composition, not registration. So the drill boots the profile
 * with an extra `--patch <probe.yml>` overlay that (1) disables the `headless-runner`
 * entry — otherwise the runner exits the process immediately demanding a task — and
 * (2) inserts a tiny read-only observer plugin that calls `ctx.tools.schemas()` once
 * the registry has settled, writes the names to `$LOAD_SMOKE_OUT`, and exits. The
 * observer never mutates the registry and is injected *after* every other entry, so
 * it observes the same mounted context the host would hand a session.
 *
 * Contract (the captain wires this into `scripts/verify.mjs`):
 *   - exit 0 → the last line matches /^SUCCESS: load smoke — (\d+)\/(\d+) stages passed/
 *   - exit 1 → one `[FAIL] <stage>: <expected vs actual>` line per failed assertion,
 *              then `FAILURE: <k>/<n> stages failed`
 *   - exit 2 → no `dsh` launcher on PATH, or `lib/` is missing; this drill never
 *              builds and never installs anything for the user, it says so instead
 *   - `--quiet` suppresses progress chatter; the verdict lines always print
 *
 * Hard rules observed here: everything is written under `os.tmpdir()`; the real
 * `~/.dsh` is only ever *stat*-ed as a tripwire; the plugin is installed by path
 * (`link:`), so the run is offline-capable; no git command is run at all; and the
 * temp tree is removed on every exit path, retried, and reported rather than thrown
 * if Windows still holds a handle.
 *
 * @module scripts/load-smoke
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/* ------------------------------------------------------------------ paths */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const LIB_DIR = join(REPO_ROOT, 'lib')

/** Every compiled module this drill needs; all must exist before it starts. */
const MODULES = {
  entry: join(LIB_DIR, 'index.js'),
  toolSurface: join(LIB_DIR, 'runtime', 'tool-surface.js'),
}

const QUIET = process.argv.includes('--quiet')

const missingModules = Object.values(MODULES).filter((path) => !existsSync(path))
if (missingModules.length > 0) {
  process.stderr.write('load-smoke: cannot run — compiled module(s) missing:\n')
  for (const path of missingModules) process.stderr.write(`  - ${path}\n`)
  process.stderr.write('load-smoke: build lib/ first (`pnpm build`). This drill never builds.\n')
  process.exit(2)
}

/* --------------------------------------------------------------- launcher */

/**
 * Resolves the real `dsh` launcher. The launcher is a `.cmd` shim on Windows, so it
 * cannot be spawned without a shell (Node raises EINVAL for `.cmd` with `shell: false`),
 * and the absolute path usually contains a space, so it is always quoted.
 */
function resolveLauncher() {
  const probe = process.platform === 'win32'
    ? spawnSync('where dsh', { shell: true, encoding: 'utf8' })
    : spawnSync('which', ['dsh'], { encoding: 'utf8' })
  const lines = String(probe.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return probe.status === 0 && lines.length > 0 ? lines[0] : null
}

const LAUNCHER = resolveLauncher()
if (LAUNCHER === null) {
  process.stderr.write('load-smoke: cannot run — no `dsh` launcher on PATH.\n')
  process.stderr.write('load-smoke: install the DSH CLI (or put it on PATH) first. This drill never installs it for you.\n')
  process.exit(2)
}

/** Quotes one token for `cmd.exe`; only the launcher and paths can contain spaces. */
function quoteCmd(value) {
  return /[\s\t"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/* ---------------------------------------------------------------- harness */

/** The six stages, in order. Each is named so a failure line is self-locating. */
const STAGES = [
  'A a throwaway DSH_HOME and factory workspace are created',
  'B the shipped template alone exposes no factory tool',
  'C this repository installs into the scratch profile',
  'D the composed profile tree really carries the plugin',
  'E the live composition registers all fifteen factory tools',
  'F the packed release artifact installs and composes',
]
const TOTAL_STAGES = STAGES.length

const stats = { assertions: 0, dshRuns: 0, registryTotal: 0, offlineInstall: true }
const failedStages = new Set()
const invariants = []
let currentStage = STAGES[0]

function emit(text) {
  process.stdout.write(`${text}\n`)
}

function note(text) {
  if (!QUIET) emit(text)
}

function beginStage(name) {
  currentStage = name
  note(`\n── ${name}`)
}

/**
 * Records one assertion. A failure is printed immediately (so a run is debuggable
 * in place) and its stage is remembered for the `<k>/<n>` rollup.
 */
function record(ok, label, expected, actual) {
  stats.assertions += 1
  if (ok) {
    note(`   ok   ${label}`)
    return true
  }
  const detail = `${label} — expected ${expected}, actual ${actual}`
  emit(`[FAIL] ${currentStage}: ${detail}`)
  failedStages.add(currentStage)
  return false
}

function expectEqual(label, actual, expected) {
  return record(Object.is(actual, expected), label, JSON.stringify(expected), JSON.stringify(actual))
}

function expectTrue(label, value, expectedText = 'true') {
  return record(value === true, label, expectedText, String(value))
}

function expectAtLeast(label, actual, minimum) {
  return record(typeof actual === 'number' && actual >= minimum, label, `>= ${minimum}`, JSON.stringify(actual))
}

function expectIncludes(label, haystack, needle) {
  const text = typeof haystack === 'string' ? haystack : String(haystack)
  return record(text.includes(needle), label, `text containing ${JSON.stringify(needle)}`, JSON.stringify(text.slice(0, 220)))
}

function expectMatch(label, actual, pattern) {
  const text = typeof actual === 'string' ? actual : String(actual)
  return record(pattern.test(text), label, `text matching ${pattern}`, JSON.stringify(text.slice(0, 220)))
}

function expectDeepEqual(label, actual, expected) {
  return record(
    JSON.stringify(actual) === JSON.stringify(expected),
    label,
    JSON.stringify(expected),
    JSON.stringify(actual),
  )
}

/* ------------------------------------------------------------ dsh plumbing */

/** A synchronous sleep, so a retried cleanup does not need async plumbing. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Runs the real CLI. On Windows the launcher is a `.cmd` shim, so the whole command
 * line is handed to `shell: true` as one already-quoted string — passing an args
 * array alongside `shell: true` lets Node escape the quotes and mangles a launcher
 * path containing a space (verified: `'D:\DeepSeek' is not recognized`).
 */
function runDsh(args, { cwd, env } = {}) {
  stats.dshRuns += 1
  const options = { cwd, env: env ?? CHILD_ENV, encoding: 'utf8', timeout: 120_000 }
  const result = process.platform === 'win32'
    ? spawnSync([quoteCmd(LAUNCHER), ...args.map(quoteCmd)].join(' '), { ...options, shell: true })
    : spawnSync(LAUNCHER, args, options)
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error,
  }
}

/**
 * Runs any other host tool (only `npm pack` uses this). It shares `runDsh`'s
 * Windows quoting because `npm` is also a `.cmd` shim there.
 */
function runTool(program, args, { cwd, env, timeout = 180_000 } = {}) {
  const options = { cwd, env: env ?? CHILD_ENV, encoding: 'utf8', timeout }
  const result = process.platform === 'win32'
    ? spawnSync([quoteCmd(program), ...args.map(quoteCmd)].join(' '), { ...options, shell: true })
    : spawnSync(program, args, options)
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error,
  }
}

/**
 * Packs the release artifact exactly as `npm pack` would.
 *
 * `--ignore-scripts` is deliberate. `prepack` is `pnpm run build`, and
 * `check-pack` — which runs earlier in `release:publish` — already packs WITH the
 * build and proves the tarball equals this checkout byte for byte. Rebuilding
 * here would double the cost and give the drill a second way to fail for a build
 * reason it is not testing. What this stage adds is the thing nothing else
 * proves: that the artifact INSTALLS and COMPOSES, rather than the working tree
 * being linked into the profile and standing in for it.
 */
function packRepo() {
  const dest = join(ROOT, 'pack')
  mkdirSync(dest, { recursive: true })
  const result = runTool('npm', ['pack', '--ignore-scripts', '--pack-destination', dest], {
    cwd: REPO_ROOT,
    env: { ...process.env, NO_COLOR: '1' },
  })
  const tarballs = readdirSync(dest)
    .filter((name) => name.endsWith('.tgz'))
    .map((name) => join(dest, name))
  return { ...result, tarballs }
}

/** Second line of a failed child, which is where the CLI puts the real reason. */
function reason(result) {
  const text = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  const line = text.find((item) => item.startsWith('Error:') || item.startsWith('dsh:')) ?? text[0] ?? String(result.error ?? 'no output')
  return line.slice(0, 200)
}

/* ---------------------------------------------------------- temp workspace */

/**
 * Removes a tree even when a pnpm/CLI child left read-only files or a live handle
 * behind (Windows EPERM/EBUSY). Returns whether the directory is really gone.
 */
function forceRemoveTree(target) {
  const clearReadOnly = (dir) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) clearReadOnly(child)
      else {
        try {
          chmodSync(child, 0o666)
        } catch {
          /* best effort: rmSync below reports the real outcome */
        }
      }
    }
    try {
      chmodSync(dir, 0o777)
    } catch {
      /* best effort */
    }
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      clearReadOnly(target)
    } catch {
      /* best effort */
    }
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 })
    } catch {
      /* the caller reads the result through existsSync */
    }
    if (!existsSync(target)) return true
    sleepSync(250)
  }
  return !existsSync(target)
}

/* ------------------------------------------------------------- the probe */

/**
 * The observer plugin. It is inserted last (so every other entry has applied),
 * polls `ctx.tools.schemas()` until the registry stops changing, then writes the
 * names and exits. Read-only: it never registers, filters or removes a tool.
 */
const PROBE_SOURCE = `const fs = require('node:fs')

const out = process.env.LOAD_SMOKE_OUT
const deadline = Date.now() + Number(process.env.LOAD_SMOKE_WAIT_MS || 20000)

function finish(payload) {
  try {
    fs.writeFileSync(out, JSON.stringify(payload), 'utf8')
  } catch (err) {
    process.stderr.write('load-smoke probe: write failed: ' + String(err) + '\\n')
  }
  process.exit(0)
}

module.exports = {
  name: 'load-smoke-probe',
  inject: ['tools'],
  apply(ctx) {
    let previous = null
    let stable = 0
    const tick = () => {
      let snapshot
      try {
        const schemas = ctx.tools.schemas()
        snapshot = { ok: true, count: schemas.length, names: schemas.map((s) => s.name).sort() }
      } catch (err) {
        snapshot = { ok: false, error: String((err && err.stack) || err) }
      }
      const key = JSON.stringify(snapshot)
      stable = key === previous ? stable + 1 : 0
      previous = key
      if ((snapshot.ok && snapshot.count > 0 && stable >= 4) || Date.now() >= deadline) finish(snapshot)
      else setTimeout(tick, 250)
    }
    tick()
  },
}
`

/**
 * The overlay that makes the registry observable. Disabling `headless-runner` is what
 * keeps the process alive long enough to read the registry: with it enabled the runner
 * immediately demands a task and tears the tree down, and a read during teardown fails
 * with `cannot get required service "tools" in inactive context`.
 */
const PATCH_SOURCE = `# load-smoke: read-only tool-registry observer (see scripts/load-smoke.mjs)
- id: headless-runner
  disabled: true
- insert:
    - id: load-smoke-probe
      name: ./probe.cjs
`

/* -------------------------------------------------------------------- main */

const ROOT = mkdtempSync(join(tmpdir(), 'load-smoke-'))
const HOME_DIR = join(ROOT, 'home')
const WORKSPACE = join(ROOT, 'workspace')
const PROBE_PATH = join(ROOT, 'probe.cjs')
const PATCH_PATH = join(ROOT, 'probe.yml')
const PROBE_OUT = join(ROOT, 'probe-out.json')

/** The scratch profile is named after the temp root, so it cannot collide with a real one. */
const PROFILE = basename(ROOT)

/** Children get exactly one DSH variable: their own throwaway home. */
const CHILD_ENV = {
  ...process.env,
  DSH_HOME: HOME_DIR,
  NO_COLOR: '1',
  LOAD_SMOKE_OUT: PROBE_OUT,
}

/** Tripwire: a scratch profile must never appear under the user's real home. */
const REAL_HOME_PROFILE = join(homedir(), '.dsh', 'profiles', PROFILE)

let expectedToolNames = []

/** Creates the scratch profile from a shipped template with the real CLI. */
function createProfile() {
  return runDsh(['--profile', PROFILE, '--from-default-profile', 'headless', '--dump-config'], { cwd: WORKSPACE })
}

/** Boots the profile with the observer overlay and reads back what it saw. */
function observeTools() {
  try {
    rmSync(PROBE_OUT, { force: true })
  } catch {
    /* the run below reports the real outcome */
  }
  const boot = runDsh(['--profile', PROFILE, '--patch', PATCH_PATH], { cwd: WORKSPACE })
  let observation = null
  if (existsSync(PROBE_OUT)) {
    try {
      observation = JSON.parse(readFileSync(PROBE_OUT, 'utf8'))
    } catch (error) {
      observation = { ok: false, error: `probe output was not JSON: ${String(error)}` }
    }
  }
  return { boot, observation }
}

const factoryNames = (names) => (Array.isArray(names) ? names.filter((name) => String(name).startsWith('factory_')) : [])

try {
  /* -- A ---------------------------------------------------------------- */
  beginStage(STAGES[0])
  mkdirSync(HOME_DIR, { recursive: true })
  mkdirSync(WORKSPACE, { recursive: true })
  writeFileSync(PROBE_PATH, PROBE_SOURCE, 'utf8')
  writeFileSync(PATCH_PATH, PATCH_SOURCE, 'utf8')
  expectTrue('the temp DSH_HOME lives under os.tmpdir()', HOME_DIR.startsWith(tmpdir()), `${tmpdir()}${process.platform === 'win32' ? '\\' : '/'}…`)
  expectTrue('the factory workspace lives under os.tmpdir()', WORKSPACE.startsWith(tmpdir()), `${tmpdir()}…`)
  expectTrue('the temp home is not the real dsh home', HOME_DIR !== join(homedir(), '.dsh'), 'a throwaway directory')
  expectTrue('the scratch profile does not exist in the real home yet', !existsSync(REAL_HOME_PROFILE), 'no such profile')

  const created = createProfile()
  expectEqual('creating the scratch profile exits 0', created.status, 0)
  if (created.status !== 0) throw new Error(`profile creation failed: ${reason(created)}`)
  expectTrue(
    'the shipped template materialized a profile package.json',
    existsSync(join(HOME_DIR, 'profiles', PROFILE, 'package.json')),
    join(HOME_DIR, 'profiles', PROFILE, 'package.json'),
  )
  expectDeepEqual('the profile record names the shipped template', JSON.parse(readFileSync(join(HOME_DIR, 'profiles', PROFILE, 'package.json'), 'utf8')).dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])

  /* -- B ---------------------------------------------------------------- */
  beginStage(STAGES[1])
  const before = observeTools()
  expectEqual('booting the unmodified profile exits 0', before.boot.status, 0)
  record(
    before.observation !== null,
    'the observer plugin really ran in the unmodified profile',
    'a probe-out.json written by the inserted observer',
    reason(before.boot),
  )
  const beforeFactory = factoryNames(before.observation?.names)
  expectDeepEqual('the shipped template alone registers no factory tool', beforeFactory, [])
  expectAtLeast('the unmodified profile still mounted a real registry', before.observation?.count ?? 0, 1)
  stats.registryTotal = before.observation?.count ?? 0

  /* -- C ---------------------------------------------------------------- */
  beginStage(STAGES[2])
  // `--offline` first: a path install is a `link:`, so it must not need the registry.
  // If pnpm does reach for the network the retry below says so instead of failing.
  let installed = runDsh(['plugin', '--profile', PROFILE, 'add', REPO_ROOT, '--offline'], { cwd: WORKSPACE })
  if (installed.status !== 0) {
    stats.offlineInstall = false
    note('   note the --offline install was refused; retrying against the registry')
    installed = runDsh(['plugin', '--profile', PROFILE, 'add', REPO_ROOT], { cwd: WORKSPACE })
  }
  expectEqual('installing this repository into the scratch profile exits 0', installed.status, 0)
  // Deliberately NOT asserted here: how pnpm prints the add summary. That text is
  // a human-facing progress line, not a contract — it changed from
  // `+ dsh-code-factory link:<path>` to `+ dsh-code-factory 0.2.1 <- <path>` between
  // two pnpm releases, and asserting on it makes this gate fail for a formatting
  // change while the install it describes is perfectly correct. The same fact is
  // proven structurally two lines below, off the profile manifest pnpm actually
  // wrote. What pnpm's output IS still allowed to prove is that the host satisfies
  // the ranges this plugin declares — that is a real compatibility fact, and a
  // stale declaration is a defect we want to see here, not discover later.
  expectTrue(
    'the host satisfies every peer range this plugin declares (no unmet-peer warning)',
    // pnpm 11 prints a generic "peerDependencies specified ... linked dependency"
    // warning for every `link:` install; that is not an unmet range. Only an
    // explicit unmet-peer report fails this stage.
    !/unmet peer dependenc/i.test(`${installed.stdout}\n${installed.stderr}`),
    'no peer warning',
    JSON.stringify(`${installed.stdout}\n${installed.stderr}`.trim().slice(0, 400)),
  )
  expectTrue('the profile now links this repository', existsSync(join(HOME_DIR, 'profiles', PROFILE, 'node_modules', 'dsh-code-factory')), 'node_modules/dsh-code-factory')
  const installedProfile = JSON.parse(readFileSync(join(HOME_DIR, 'profiles', PROFILE, 'package.json'), 'utf8'))
  const dependencySpec = String(installedProfile.dependencies?.['dsh-code-factory'] ?? '')
  expectMatch('the profile depends on this repository by a path spec', dependencySpec, /^(link|file):/i)
  expectEqual(
    'the dependency spec points at this repository',
    dependencySpec.slice(dependencySpec.indexOf(':') + 1).replace(/\\/g, '/').toLowerCase(),
    REPO_ROOT.replace(/\\/g, '/').toLowerCase(),
  )
  expectTrue(
    'the plugin was added to the profile bundle list',
    Array.isArray(installedProfile.dsh?.profile?.bundles)
      && installedProfile.dsh.profile.bundles.includes('dsh-code-factory'),
    'dsh.profile.bundles to contain dsh-code-factory',
  )

  /* -- D ---------------------------------------------------------------- */
  beginStage(STAGES[3])
  const composed = runDsh(['--profile', PROFILE, '--dump-config'], { cwd: WORKSPACE })
  expectEqual('composing the profile exits 0', composed.status, 0)
  if (composed.status !== 0) throw new Error(`--dump-config failed: ${reason(composed)}`)
  expectIncludes('the composed tree has the plugin\'s own bundle section', composed.stdout, '# == dsh-code-factory')
  // Everything after the plugin's own section header, so a failure message quotes the
  // entry instead of the head of a 380-line tree.
  const sectionStart = composed.stdout.indexOf('# == dsh-code-factory')
  const pluginSection = sectionStart === -1 ? composed.stdout : composed.stdout.slice(sectionStart)
  expectIncludes('the composed tree mounts the plugin entry', pluginSection, '- id: code-factory')
  expectMatch('the mounted entry resolves to this package, not a lookalike', pluginSection, /^ {2}name: dsh-code-factory$/m)
  expectIncludes('the mounted entry carries the plugin\'s declared config', pluginSection, 'stateDir: .code-factory')
  expectIncludes('the mounted entry carries the slash-command switch', pluginSection, 'slashCommand: true')

  const blockStart = pluginSection.indexOf('- id: code-factory')
  const blockRest = pluginSection.slice(blockStart)
  const blockEnd = blockRest.slice(1).search(/^\S/m)
  const block = blockEnd === -1 ? blockRest : blockRest.slice(0, blockEnd + 1)
  expectTrue('the mounted entry is not disabled', !/^\s*disabled:\s*true\s*$/m.test(block), 'no `disabled: true` in the code-factory entry')

  /* -- E ---------------------------------------------------------------- */
  beginStage(STAGES[4])
  const surfaceModule = await import(pathToFileURL(MODULES.toolSurface).href)
  expectedToolNames = [...surfaceModule.FACTORY_TOOL_NAMES]
  const captainNames = [...surfaceModule.CAPTAIN_TOOL_NAMES]
  const memberNames = [...surfaceModule.MEMBER_BASE_TOOL_NAMES]
  expectEqual('the tool surface declares sixteen tools', expectedToolNames.length, 16)
  expectEqual('the tool surface declares thirteen captain tools', captainNames.length, 13)
  expectEqual('the tool surface declares three member tools', memberNames.length, 3)

  const after = observeTools()
  expectEqual('booting the composed profile exits 0', after.boot.status, 0)
  record(
    after.observation !== null,
    'the observer plugin ran in the composed profile',
    'a probe-out.json written by the inserted observer',
    reason(after.boot),
  )
  expectTrue('the live tool registry answered', after.observation?.ok === true, 'ok: true', JSON.stringify(after.observation?.error ?? after.observation))
  if (after.observation?.ok !== true) throw new Error(`the registry probe failed: ${JSON.stringify(after.observation)}`)

  const liveNames = after.observation.names
  stats.registryTotal = after.observation.count
  const liveFactory = factoryNames(liveNames)
  const missing = expectedToolNames.filter((name) => !liveFactory.includes(name)).sort()
  const unexpected = liveFactory.filter((name) => !expectedToolNames.includes(name)).sort()

  expectDeepEqual('no documented factory tool is missing from the live registry', missing, [])
  expectDeepEqual('no undocumented factory_* tool appeared in the live registry', unexpected, [])
  expectEqual('the live registry exposes exactly the documented tool count', liveFactory.length, expectedToolNames.length)
  expectAtLeast(
    'the observation read the whole global registry, not just this plugin',
    after.observation.count,
    expectedToolNames.length + 1,
  )
  expectIncludes('the registry also carries a non-factory tool', liveNames.join(' '), ' read ')
  expectTrue(
    'the plugin mounted without waiting for a missing service',
    !/did not activate|pending \(waiting for service/i.test(`${after.boot.stdout}\n${after.boot.stderr}`),
    'no unactivated entry',
    JSON.stringify(`${after.boot.stdout}\n${after.boot.stderr}`.trim().slice(0, 200)),
  )
  /* -- F ---------------------------------------------------------------- */
  beginStage(STAGES[5])
  // Stages A-E install this REPOSITORY, which pnpm resolves as a `link:` — so a
  // green run there says nothing about the artifact that actually ships: a
  // published tarball carries only `files[]`, has no `src/`, and cannot resolve a
  // relative import back into the checkout. This stage installs the real tarball.
  const packed = packRepo()
  expectEqual('packing the release artifact exits 0', packed.status, 0)
  record(packed.tarballs.length === 1, 'npm pack produced exactly one tarball', '1 tarball', JSON.stringify(packed.tarballs.map((path) => basename(path))))
  if (packed.status !== 0 || packed.tarballs.length !== 1) {
    throw new Error(`npm pack failed: ${reason(packed)}`)
  }
  const tarball = packed.tarballs[0]
  expectMatch('the artifact is named after the package and its version', basename(tarball), /^dsh-code-factory-\d+\.\d+\.\d+\.tgz$/)

  const PACKED_HOME = join(ROOT, 'packed-home')
  mkdirSync(PACKED_HOME, { recursive: true })
  // A second profile name, so neither side can silently read the other's state.
  const PACKED_PROFILE = `${PROFILE}-packed`
  const packedEnv = { ...process.env, DSH_HOME: PACKED_HOME, NO_COLOR: '1' }
  const runPacked = (args) => runDsh(args, { cwd: WORKSPACE, env: packedEnv })

  const materialised = runPacked(['--profile', PACKED_PROFILE, '--from-default-profile', 'headless', '--dump-config'])
  expectEqual('materialising the second scratch profile exits 0', materialised.status, 0)

  const added = runPacked(['plugin', '--profile', PACKED_PROFILE, 'add', tarball, '--offline'])
  expectEqual('installing the packed artifact exits 0', added.status, 0)
  // Same reason as stage C: pnpm's add summary is progress text, not a contract.
  // The `file:` / `link:` fact is read off the profile manifest the install wrote.
  expectTrue(
    'the host satisfies every peer range this plugin declares (no unmet-peer warning)',
    !/peerDependencies specifi|unmet peer dependenc/i.test(`${added.stdout}\n${added.stderr}`),
    'no peer warning',
    JSON.stringify(`${added.stdout}\n${added.stderr}`.trim().slice(0, 400)),
  )

  const packedModule = join(PACKED_HOME, 'profiles', PACKED_PROFILE, 'node_modules', 'dsh-code-factory')
  expectTrue('the artifact materialised inside the profile', existsSync(packedModule), packedModule)
  if (!existsSync(packedModule)) throw new Error('the packed artifact did not materialise')
  // The whole point: a `link:` would make every assertion below pass while
  // proving nothing, because it would be reading the checkout it came from.
  expectEqual('the install is a real copy, not a link back into this checkout', lstatSync(packedModule).isSymbolicLink(), false)

  expectTrue('the packed artifact ships the host entry', existsSync(join(packedModule, 'lib', 'index.js')), 'lib/index.js')
  expectTrue('the packed artifact ships the client bundle', existsSync(join(packedModule, 'lib', 'client.js')), 'lib/client.js')
  expectTrue('the packed artifact ships its type declarations', existsSync(join(packedModule, 'lib', 'index.d.ts')), 'lib/index.d.ts')
  expectTrue('the packed artifact does not ship the sources', !existsSync(join(packedModule, 'src')), 'no src/')
  expectTrue('the packed artifact does not ship the tsc intermediate', !existsSync(join(packedModule, 'lib', 'client')), 'no lib/client/')
  expectTrue('the packed artifact ships its rollback runbook', existsSync(join(packedModule, 'ROLLBACK.md')), 'ROLLBACK.md')

  const shippedMaps = readdirSync(join(packedModule, 'lib')).filter((name) => name.endsWith('.map'))
  expectAtLeast('the shipped artifact carries its source maps too', shippedMaps.length, 1)

  const packedManifest = JSON.parse(readFileSync(join(packedModule, 'package.json'), 'utf8'))
  const repoManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  expectEqual('the installed artifact reports this checkout\'s version', packedManifest.version, repoManifest.version)
  expectEqual('the installed artifact keeps the host entry point', packedManifest.main, repoManifest.main)

  const packedProfileFile = JSON.parse(readFileSync(join(PACKED_HOME, 'profiles', PACKED_PROFILE, 'package.json'), 'utf8'))
  // The structural half of "installed as `file:`, not `link:`": read the specifier
  // pnpm wrote into the profile, which is the durable fact, instead of matching the
  // sentence it printed to a terminal.
  const packedSpec = String(packedProfileFile.dependencies?.['dsh-code-factory'] ?? '')
  expectMatch(
    'the profile records the artifact as a file: dependency, not a link into this checkout',
    packedSpec,
    /^file:/i,
  )
  expectTrue(
    'the packed artifact was added to the profile bundle list',
    Array.isArray(packedProfileFile.dsh?.profile?.bundles)
      && packedProfileFile.dsh.profile.bundles.includes('dsh-code-factory'),
    'dsh.profile.bundles to contain dsh-code-factory',
  )

  const packedComposed = runPacked(['--profile', PACKED_PROFILE, '--dump-config'])
  expectEqual('composing the profile around the installed artifact exits 0', packedComposed.status, 0)
  expectIncludes('the installed artifact really composes into the profile tree', packedComposed.stdout, '# == dsh-code-factory')
  expectIncludes('the composed tree mounts the artifact\'s own entry', packedComposed.stdout, '- id: code-factory')
} catch (error) {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
  record(false, 'the stage completed without throwing', 'a completed stage', text.split('\n')[0])
  note(text)
} finally {
  for (const target of [ROOT]) {
    if (!forceRemoveTree(target)) {
      invariants.push(`[FAIL] cleanup: expected ${target} to be removed, actual it still exists (remove it by hand)`)
    }
  }
  if (existsSync(REAL_HOME_PROFILE)) {
    invariants.push(`[FAIL] isolation: expected no profile under the real home, actual ${REAL_HOME_PROFILE} exists`)
  }
}

/* ----------------------------------------------------------------- rollup */

// Anti-vacuity gates: a drill that never ran the real CLI, never read a real
// registry, or never established a discriminating baseline must never be green.
// The floor is 8 because stages A-E need 5 real `dsh` runs before F can even
// start (create profile, baseline boot, path install, compose, composed boot),
// and F adds 3 more — a lower floor would let F's own runs alone satisfy it.
if (stats.dshRuns < 8) {
  invariants.push(`[FAIL] real-execution guard: expected at least 8 real dsh child processes, actual ${stats.dshRuns}`)
}
if (stats.registryTotal === 0) {
  invariants.push('[FAIL] real-registry guard: expected a mounted tool registry with at least 1 tool, actual 0')
}
for (const lineText of invariants) emit(lineText)

const failedCount = failedStages.size > 0 ? failedStages.size : invariants.length > 0 ? 1 : 0

if (failedCount === 0) {
  const installNote = stats.offlineInstall ? 'installed offline (pnpm --offline)' : 'installed with registry access'
  emit(
    `  ${TOTAL_STAGES}/${TOTAL_STAGES} stages · ${stats.assertions} assertions · `
      + `${stats.dshRuns} real dsh processes · ${stats.registryTotal}-tool registry · ${installNote}`,
  )
  emit(`SUCCESS: load smoke — ${TOTAL_STAGES}/${TOTAL_STAGES} stages passed`)
  process.exit(0)
}

emit(`  ${stats.assertions} assertions evaluated, ${stats.dshRuns} real dsh processes started`)
emit(`FAILURE: ${failedCount}/${TOTAL_STAGES} stages failed`)
process.exit(1)
