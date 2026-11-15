#!/usr/bin/env node
/**
 * gates-drill.mjs — standalone drill for the gate / DoD **execution** layer.
 *
 * Closes finding H14: `lib/runtime/gates-runner.js` is re-exported by
 * `lib/runtime/index.js` but no check ever calls it, and neither of its two
 * refusal paths has ever fired:
 *
 *   - `无可用命令执行器（探测 ctx.subprocess 失败：… | ctx.subprocess 不可用且未启用
 *     node 回退 | ctx.subprocess 存在但不可用：…），拒绝执行: …` — the parenthesised
 *     cause is quoted from the probe, never assumed (an earlier shape reported a
 *     failed lookup as "不可用", a cause it had not established)
 *   - `git 事实采集失败：…`
 *
 * The command executor behind it (`lib/runtime/commands.js`) had no execution
 * test either, and the DoD's git facts were only ever fed hardcoded fixtures.
 *
 * This drill is deliberately *not* a shape test: it builds a real temporary git
 * repository under `os.tmpdir()` and runs real child processes against it. It
 * fails outright when zero child processes were really started.
 *
 * Contract (the captain wires this into `scripts/verify.mjs`):
 *   - exit 0 → the last line matches /^SUCCESS: gates drill — (\d+)\/(\d+) stages passed/
 *   - exit 1 → one `[FAIL] <stage>: <expected vs actual>` line per failed
 *              assertion, then `FAILURE: <k>/<n> stages failed`
 *   - exit 2 → `lib/runtime/gates-runner.js` (or a sibling) is missing; this
 *              drill never builds, so it says so instead of guessing.
 *   - `--quiet` suppresses progress chatter; the verdict lines always print.
 *
 * Hard rules observed here: nothing outside `os.tmpdir()` is written, every
 * temp directory is removed on every path, `git` always runs with its own
 * identity and `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pinned to the null
 * device, and no mutating git command is ever aimed at the plugin repository.
 *
 * @module scripts/gates-drill
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/* ------------------------------------------------------------------ paths */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
/**
 * Where the compiled subject lives. `GATES_DRILL_LIB` overrides it so the drill
 * can be verified against a *candidate* build (e.g. a `tsc --outDir` emission
 * under `os.tmpdir()`) while the real `lib/` is owned by another writer. It never
 * defaults to anywhere but the repo's own `lib/`.
 */
const LIB_DIR = process.env.GATES_DRILL_LIB ?? join(REPO_ROOT, 'lib')

/** Every compiled module this drill loads; all must exist before it starts. */
const MODULES = {
  runner: join(LIB_DIR, 'runtime', 'gates-runner.js'),
  commands: join(LIB_DIR, 'runtime', 'commands.js'),
  gates: join(LIB_DIR, 'domain', 'gates.js'),
  dod: join(LIB_DIR, 'domain', 'dod.js'),
  pipeline: join(LIB_DIR, 'domain', 'pipeline.js'),
  // The shipped offline harness surface: `createFakeSubprocess` (stage I) replaces
  // the double this drill used to hand-roll, so the double under test is the one
  // the package actually ships.
  testing: join(LIB_DIR, 'runtime', 'testing.js'),
}

const QUIET = process.argv.includes('--quiet')

const missing = Object.values(MODULES).filter((path) => !existsSync(path))
if (missing.length > 0) {
  process.stderr.write('gates-drill: cannot run — compiled module(s) missing:\n')
  for (const path of missing) process.stderr.write(`  - ${path}\n`)
  process.stderr.write('gates-drill: build lib/ first (`pnpm build`). This drill never builds.\n')
  process.exit(2)
}

/* ---------------------------------------------------------------- harness */

/** The nine stages, in order. Each is named so a failure line is self-locating. */
const STAGES = [
  'A a real command returns its true exit code',
  'B a real non-zero exit code cannot pass',
  'C missing executor refuses loudly',
  'D node fallback is opt-in and honest',
  'E git facts come from a real repository',
  'F git facts fail loudly without a repository',
  'G a DoD item that shells out really shells out',
  'H the runner never invents a verdict',
  'I the production subprocess executor path is driven',
]
const TOTAL_STAGES = STAGES.length

const stats = { assertions: 0, attempted: 0, confirmed: 0, doubled: 0, mainStartShRuns: 0 }
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
 * Records one assertion. A failure is printed immediately (so a run is
 * debuggable in place) and its stage is remembered for the `<k>/<n>` rollup.
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

function expectFalse(label, value) {
  return record(value === false, label, 'false', String(value))
}

function expectAtLeast(label, actual, minimum) {
  return record(
    typeof actual === 'number' && actual >= minimum,
    label,
    `>= ${minimum}`,
    JSON.stringify(actual),
  )
}

function expectArray(label, value) {
  return record(Array.isArray(value), label, 'an array', typeof value)
}

function expectMatch(label, actual, pattern) {
  const text = typeof actual === 'string' ? actual : String(actual)
  return record(pattern.test(text), label, `text matching ${pattern}`, JSON.stringify(text.slice(0, 220)))
}

function expectIncludes(label, haystack, needle) {
  const text = typeof haystack === 'string' ? haystack : String(haystack)
  return record(text.includes(needle), label, `text containing ${JSON.stringify(needle)}`, JSON.stringify(text.slice(0, 220)))
}

function expectDeepEqual(label, actual, expected) {
  return expectEqual(label, JSON.stringify(actual), JSON.stringify(expected))
}

/* ------------------------------------------------------------ git plumbing */

/** Null device, so git never reads the machine's real config. */
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'

/**
 * A git environment that cannot touch the user's configuration or identity.
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` point at the null device and both the
 * author and committer identities are supplied here, so `git commit` never needs
 * `git config` and the machine's `~/.gitconfig` is never opened.
 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: NULL_DEVICE,
  GIT_CONFIG_SYSTEM: NULL_DEVICE,
  GIT_AUTHOR_NAME: 'gates-drill',
  GIT_AUTHOR_EMAIL: 'gates-drill@example.invalid',
  GIT_COMMITTER_NAME: 'gates-drill',
  GIT_COMMITTER_EMAIL: 'gates-drill@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
}

/** Runs one git command inside `cwd`. Only ever aimed at a temp repository. */
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error,
  }
}

/* ---------------------------------------------------------- temp workspace */

/**
 * Writes `start.sh`. Content is built with `\n` only — a CRLF shell script is
 * the classic way a Windows drill passes for the wrong reason.
 */
function writeStartSh(workspace, { exitCode, stdout = '', stderr = '' }) {
  const lines = ['#!/usr/bin/env bash', 'set -u']
  if (stdout.length > 0) lines.push(`printf '%s\\n' '${stdout}'`)
  if (stderr.length > 0) lines.push(`printf '%s\\n' '${stderr}' >&2`)
  lines.push("printf 'ran\\n' >> runs.log", `exit ${exitCode}`, '')
  writeFileSync(join(workspace, 'start.sh'), lines.join('\n'), 'utf8')
}

/** Creates a temp directory holding a real git repository. */
function makeRepo(commitCount) {
  const root = mkdtempSync(join(tmpdir(), 'gates-drill-'))
  const init = git(['init', '-b', 'main'], root)
  if (init.status !== 0) throw new Error(`git init failed in ${root}: ${init.stderr || String(init.error)}`)
  for (let index = 1; index <= commitCount; index += 1) {
    writeFileSync(join(root, `file-${index}.txt`), `content ${index}\n`, 'utf8')
    git(['add', '.'], root)
    const commit = git(['commit', '-m', `drill commit ${index}`], root)
    if (commit.status !== 0) throw new Error(`git commit ${index} failed: ${commit.stderr}`)
  }
  const tag = git(['tag', 'v1.0.0'], root)
  if (tag.status !== 0) throw new Error(`git tag failed: ${tag.stderr}`)
  return root
}

/**
 * Removes a tree even when git left read-only objects behind (Windows EPERM).
 * Returns whether the directory is really gone.
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
  return !existsSync(target)
}

/* ------------------------------------------------------------- the modules */

const load = (path) => import(pathToFileURL(path).href)

const runnerModule = await load(MODULES.runner)
const commandsModule = await load(MODULES.commands)
const gatesModule = await load(MODULES.gates)
const dodModule = await load(MODULES.dod)
const pipelineModule = await load(MODULES.pipeline)
const testingModule = await load(MODULES.testing)

/**
 * The command text, taken from the compiled DoD template rather than retyped —
 * so the drill fails loudly if the template stops asking for this command.
 */
const SCRIPT_RUN = String(dodModule.DOD_ITEMS.find((item) => item.id === 5)?.run ?? '')
const GIT_COMMANDS = [...dodModule.DOD_GIT_COMMANDS]
const PIPELINE = pipelineModule.PIPELINE_IDS[0]
const SCRIPT_GATE = { type: 'script', run: SCRIPT_RUN }

/**
 * Counts every command handed to a real-process runner. `trackStartSh` is on
 * only for the main workspace, so the `runs.log` cross-check below stays an
 * equality rather than an accident.
 */
function makeCounter(trackStartSh) {
  return (outcome) => {
    stats.attempted += 1
    if (outcome.exitCode !== null) stats.confirmed += 1
    if (trackStartSh && outcome.command === SCRIPT_RUN) stats.mainStartShRuns += 1
  }
}
const onMainCommand = makeCounter(true)
const onOtherCommand = makeCounter(false)

/**
 * Stage I drives the **shipped** `ctx.subprocess` double from
 * `runtime/testing.js` (`createFakeSubprocess` / `createFakeMemberHost`) instead
 * of a copy hand-rolled here, so this drill is also the place where the
 * package's own double is driven through the real gate runner.
 *
 * The service contract it implements is the one copied from the module header of
 * `src/runtime/commands.ts` (which quotes the live host service):
 *   `resolveExecutable(command, env?, signal?): Promise<string>`
 *   `spawn(spec): SubprocessHandle` with `{ collected, done, terminate, waitForExit }`
 *
 * It never starts a process, and its outcomes stay counted separately so they
 * can never inflate the real child-process tally.
 *
 * Stages A–H are deliberately left on the real-process path and are NOT rewired:
 * their subject is "a real child process produced this exit code", which no fake
 * host can supply, and stage C's bare probes (`{ get: () => undefined }`,
 * `{ get: () => ({}) }`) are single-expression statements of *which* lookup
 * failure is being asserted — routing them through a host factory would hide the
 * thing under test behind a composed object.
 */

/* --------------------------------------------------------------------- run */

const controller = new AbortController()
const workspaces = []

for (const text of [
  'dsh-code-factory — gate / DoD execution drill',
  `repo: ${REPO_ROOT}`,
  `node: ${process.version}`,
  `platform: ${process.platform}`,
  `pipeline: ${PIPELINE}`,
]) {
  note(text)
}

try {
  const workspace = makeRepo(3)
  workspaces.push(workspace)

  /**
   * A runner over the main workspace. Stages A–H pass `ctx: undefined` on
   * purpose — with no `ctx.subprocess` service the executor choice is explicit at
   * every call site. Stage I is the one stage that supplies a context, and it
   * supplies a fake host, because its subject *is* the `ctx.subprocess` path.
   */
  const newRunner = (options) =>
    runnerModule.createGateRunner({ workspace, timeoutMs: 60_000, ...options })

  /* -- A ---------------------------------------------------------------- */
  beginStage(STAGES[0])
  expectAtLeast('the DoD template still asks for start.sh --check', SCRIPT_RUN.length, 1)
  note(`   the template command is ${JSON.stringify(SCRIPT_RUN)}`)

  writeStartSh(workspace, { exitCode: 0, stdout: 'DRILL_STDOUT_OK', stderr: 'DRILL_STDERR_OK' })

  const allowList = newRunner({ ctx: undefined, allowNodeFallback: true }).templateCommands(PIPELINE)
  expectArray('the template allow-list is an array', allowList)
  expectTrue(
    'the command is in the template allow-list',
    allowList.includes(SCRIPT_RUN),
    `the list to contain ${JSON.stringify(SCRIPT_RUN)}`,
  )

  const runnerA = newRunner({ ctx: undefined, allowNodeFallback: true, onCommand: onMainCommand })
  expectEqual('opt-in fallback selects the node executor', runnerA.executor, 'node')

  const confirmedBeforeA = stats.confirmed
  const detailA = await runnerA.runGateDetailed(SCRIPT_GATE, { pipeline: PIPELINE, signal: controller.signal })
  expectEqual('exactly one command was executed', detailA.outcomes.length, 1)
  expectEqual('nothing was refused', detailA.refused.length, 0)
  expectArray('readErrors is an array', detailA.readErrors)

  const outcomeA = detailA.outcomes[0]
  expectEqual('command text is the template text, verbatim', outcomeA?.command, SCRIPT_RUN)
  expectEqual('the real exit code is 0', outcomeA?.exitCode, 0)
  expectTrue('the outcome is ok', outcomeA?.ok)
  expectIncludes('real stdout was captured', outcomeA?.stdout, 'DRILL_STDOUT_OK')
  expectIncludes('real stderr was captured', outcomeA?.stderr, 'DRILL_STDERR_OK')
  expectEqual('the outcome reports the node executor', outcomeA?.via, 'node')
  expectTrue('a real child process was started', stats.confirmed > confirmedBeforeA)
  expectEqual('the domain verdict is a pass', detailA.evaluation.ok, true)
  expectEqual('the exit code reached the verdict', detailA.evaluation.exitCode, 0)
  expectEqual('nothing is left pending', detailA.evaluation.needsExecution, false)

  /* -- B ---------------------------------------------------------------- */
  beginStage(STAGES[1])
  writeStartSh(workspace, { exitCode: 7, stdout: 'DRILL_FAIL_OUT', stderr: 'DRILL_FAIL_ERR' })

  const runnerB = newRunner({ ctx: undefined, allowNodeFallback: true, onCommand: onMainCommand })
  const detailB = await runnerB.runGateDetailed(SCRIPT_GATE, { pipeline: PIPELINE, signal: controller.signal })
  const outcomeB = detailB.outcomes[0]
  expectEqual('the real exit code is 7', outcomeB?.exitCode, 7)
  expectFalse('the outcome is not ok', outcomeB?.ok)
  expectIncludes('the failing stdout was captured', outcomeB?.stdout, 'DRILL_FAIL_OUT')
  expectIncludes('the failing stderr was captured', outcomeB?.stderr, 'DRILL_FAIL_ERR')
  expectEqual('the exit code reached the verdict', detailB.evaluation.exitCode, 7)
  expectFalse('the gate did not pass', detailB.evaluation.ok)
  expectMatch('the verdict quotes the real exit code', detailB.evaluation.detail, /退出码 7/)

  /* -- C ---------------------------------------------------------------- */
  beginStage(STAGES[2])
  /*
   * `ctx: undefined` makes the service LOOKUP itself throw. The refusal must say
   * that, not claim "this composition has no subprocess service" — asserting a
   * cause the probe never established is exactly the defect reported against
   * `subprocessRuntimeOf`'s `catch { return undefined }`.
   */
  const runnerC = newRunner({ ctx: undefined, allowNodeFallback: false, onCommand: onMainCommand })
  expectEqual('no executor means executor is undefined', runnerC.executor, undefined)

  const attemptedBeforeC = stats.attempted
  const detailC = await runnerC.runGateDetailed(SCRIPT_GATE, { pipeline: PIPELINE, signal: controller.signal })
  expectEqual('no command was executed', detailC.outcomes.length, 0)
  expectEqual('exactly one refusal was recorded', detailC.refused.length, 1)
  expectMatch(
    'the 无可用命令执行器 refusal path fires',
    detailC.refused[0],
    /^无可用命令执行器（探测 ctx\.subprocess 失败：/,
  )
  expectIncludes('the refusal quotes the command', detailC.refused[0], SCRIPT_RUN)
  expectFalse('the refusal reached the verdict as a failure', detailC.evaluation.ok)
  expectEqual('the verdict is a hard fail, not a deferral', detailC.evaluation.needsExecution, false)
  expectMatch('the verdict detail IS the refusal text', detailC.evaluation.detail, /^无可用命令执行器/)
  expectEqual('refusing means no child process was even attempted', stats.attempted, attemptedBeforeC)

  // A probe that answers "no such service" must NOT be reported as a throw...
  const runnerCAbsent = newRunner({ ctx: { get: () => undefined }, allowNodeFallback: false })
  const detailCAbsent = await runnerCAbsent.runGateDetailed(SCRIPT_GATE, { pipeline: PIPELINE, signal: controller.signal })
  expectMatch(
    'an absent service is reported as absent',
    detailCAbsent.refused[0],
    /^无可用命令执行器（ctx\.subprocess 不可用且未启用 node 回退），拒绝执行: /,
  )
  // ...and a service that exists but does not satisfy the contract is its own case.
  const runnerCUnusable = newRunner({ ctx: { get: () => ({}) }, allowNodeFallback: false })
  const detailCUnusable = await runnerCUnusable.runGateDetailed(SCRIPT_GATE, { pipeline: PIPELINE, signal: controller.signal })
  expectMatch(
    'a service that exists but is unusable says so',
    detailCUnusable.refused[0],
    /^无可用命令执行器（ctx\.subprocess 存在但不可用：/,
  )

  /* -- D ---------------------------------------------------------------- */
  beginStage(STAGES[3])
  const runnerD = newRunner({ ctx: undefined, allowNodeFallback: true, onCommand: onMainCommand })
  expectEqual('allowNodeFallback true selects node', runnerD.executor, 'node')

  writeStartSh(workspace, { exitCode: 0, stdout: 'DRILL_OPTIN_OK', stderr: '' })
  const confirmedBeforeD = stats.confirmed
  const detailD = await runnerD.runGateDetailed(SCRIPT_GATE, { pipeline: PIPELINE, signal: controller.signal })
  expectEqual('the opt-in fallback really ran the command', detailD.outcomes[0]?.exitCode, 0)
  expectIncludes('the opt-in fallback captured real stdout', detailD.outcomes[0]?.stdout, 'DRILL_OPTIN_OK')
  expectTrue('the opt-in fallback started a real process', stats.confirmed > confirmedBeforeD)

  const runnerDOff = newRunner({ ctx: undefined, allowNodeFallback: false, onCommand: onMainCommand })
  expectEqual('allowNodeFallback false keeps the executor undefined', runnerDOff.executor, undefined)

  const runnerDPrefer = newRunner({ ctx: undefined, preferNodeRunner: true, onCommand: onMainCommand })
  expectEqual('preferNodeRunner selects node without a ctx', runnerDPrefer.executor, 'node')

  /* -- E ---------------------------------------------------------------- */
  beginStage(STAGES[4])
  const runnerE = newRunner({ ctx: undefined, allowNodeFallback: true, onCommand: onMainCommand })
  const gitFacts = await runnerE.collectGitFacts(controller.signal)
  expectEqual('git fact collection ran both template commands', gitFacts.outcomes.length, GIT_COMMANDS.length)
  expectDeepEqual(
    'the template git commands were used, in order',
    gitFacts.outcomes.map((outcome) => outcome.command),
    GIT_COMMANDS,
  )
  expectTrue('every git command exited 0', gitFacts.outcomes.every((outcome) => outcome.exitCode === 0))
  expectEqual('no error was reported', gitFacts.error, undefined)
  expectEqual('three commits were parsed from the real repo', gitFacts.facts?.commits?.length, 3)
  expectDeepEqual('the tag was parsed from the real repo', gitFacts.facts?.tags, ['v1.0.0'])
  expectTrue(
    'the newest commit subject came from the repo',
    gitFacts.facts?.commits?.[0]?.includes('drill commit 3'),
    'the log to contain "drill commit 3"',
  )
  expectTrue(
    'every parsed commit line is real git output',
    gitFacts.facts?.commits?.every((entry) => entry.includes('drill commit ')),
  )

  const independent = git(['rev-list', '--count', 'HEAD'], workspace)
  expectEqual('the drill read the same repo git did', independent.status, 0)
  expectEqual('git itself agrees on the commit count', String(gitFacts.facts?.commits?.length ?? -1), independent.stdout.trim())

  /* -- F ---------------------------------------------------------------- */
  beginStage(STAGES[5])
  const vanished = makeRepo(2)
  workspaces.push(vanished)
  const runnerF = runnerModule.createGateRunner({
    ctx: undefined,
    workspace: vanished,
    timeoutMs: 60_000,
    allowNodeFallback: true,
    onCommand: onOtherCommand,
  })
  const factsBefore = await runnerF.collectGitFacts(controller.signal)
  expectEqual('the doomed repo starts out readable', factsBefore.facts?.commits?.length, 2)

  forceRemoveTree(join(vanished, '.git'))
  expectTrue('.git really was deleted', !existsSync(join(vanished, '.git')))

  const factsAfter = await runnerF.collectGitFacts(controller.signal)
  expectEqual('the vanished repo yields no facts', factsAfter.facts, undefined)
  expectMatch('the git 事实采集失败 refusal path fires', factsAfter.error, /^git 事实采集失败：/)
  expectAtLeast('the failing git command is reported', factsAfter.outcomes?.length, 1)
  expectEqual('the failing git command reports exit 128', factsAfter.outcomes?.[0]?.exitCode, 128)
  expectIncludes('the failure names the missing repository', factsAfter.error, 'not a git repository')

  const dodBroken = await runnerF.runDod({
    pipeline: PIPELINE,
    securityTriggered: false,
    signal: controller.signal,
  })
  expectMatch('runDod surfaces the git failure instead of swallowing it', dodBroken.git?.error, /^git 事实采集失败：/)
  expectFalse('without git facts DoD item 7 cannot pass', dodBroken.audit.results.find((item) => item.id === 7)?.ok)

  /* -- G ---------------------------------------------------------------- */
  beginStage(STAGES[6])
  writeStartSh(workspace, { exitCode: 0, stdout: 'DRILL_DOD_OK', stderr: '' })
  const runnerG = newRunner({ ctx: undefined, allowNodeFallback: true, onCommand: onMainCommand })
  const startShRunsBeforeG = stats.mainStartShRuns
  const dod = await runnerG.runDod({ pipeline: PIPELINE, securityTriggered: false, signal: controller.signal })

  expectEqual('all seven DoD items were evaluated', dod.audit.results.length, 7)
  expectTrue('item 4 is skipped without the security path', dod.skipped.includes(4))

  // `runDod` returns `items` as `{ result, outcomes }` rows in DoD order — the
  // item id lives on `result`, not on the row.
  const item5 = dod.items.find((item) => item.result.id === 5)
  expectEqual('item 5 really executed the shell command', item5?.outcomes?.length, 1)
  expectEqual('item 5 executed the template command', item5?.outcomes?.[0]?.command, SCRIPT_RUN)
  expectEqual('item 5 saw the real exit code', item5?.outcomes?.[0]?.exitCode, 0)
  expectIncludes('item 5 captured real stdout', item5?.outcomes?.[0]?.stdout, 'DRILL_DOD_OK')
  expectTrue('item 5 passed on that real evidence', item5?.result?.ok)
  expectTrue('start.sh really ran during the DoD pass', stats.mainStartShRuns > startShRunsBeforeG)
  expectEqual('start.sh recorded exactly one run for this stage', stats.mainStartShRuns - startShRunsBeforeG, 1)

  const item6 = dod.audit.results.find((item) => item.id === 6)
  expectFalse('item 6 fails on the missing README', item6?.ok)
  expectTrue('item 7 passes on the real repo facts', dod.audit.results.find((item) => item.id === 7)?.ok)

  const runsLogPath = join(workspace, 'runs.log')
  const runsSeen = readFileSync(runsLogPath, 'utf8')
    .split('\n')
    .filter((lineText) => lineText.length > 0).length
  expectEqual('the child process itself counted every real invocation', runsSeen, stats.mainStartShRuns)

  /* -- H ---------------------------------------------------------------- */
  beginStage(STAGES[7])
  const signature = gatesModule.gateCommandSignature(SCRIPT_GATE)
  expectEqual('the signature keys the script gate', signature, `script:${SCRIPT_RUN}`)

  const pureVerdict = gatesModule.evaluateGate(SCRIPT_GATE, {})
  expectFalse('the pure domain will not pass without evidence', pureVerdict.ok)
  expectTrue('the pure domain asks for execution instead', pureVerdict.needsExecution)
  expectDeepEqual('the pure domain names the command to run', pureVerdict.pendingCommands, [SCRIPT_RUN])

  const injected = {
    [signature]: {
      type: 'script',
      ok: outcomeA.ok,
      detail: outcomeA.detail,
      exitCode: outcomeA.exitCode,
      at: detailA.at,
    },
  }
  const injectedVerdict = gatesModule.evaluateGate(SCRIPT_GATE, { executed: injected })
  expectTrue('the domain passes once handed the real evidence', injectedVerdict.ok)
  expectEqual('the domain — not the runner — produced that pass', injectedVerdict.exitCode, 0)

  expectEqual('the runner returned the domain-shaped verdict type', detailA.evaluation.type, 'script')
  expectTrue(
    'the runner result carries evidence, not a verdict of its own',
    Array.isArray(detailA.outcomes) && typeof detailA.evaluation === 'object',
    'an evaluation plus an outcomes array',
  )

  expectFalse('a green command did not make the whole DoD pass', dod.audit.summary.ok)
  expectTrue('the green item is only one of seven', item5?.result?.ok)
  expectAtLeast('the audit still blocks delivery', dod.audit.summary.failed, 1)

  /* -- I ---------------------------------------------------------------- */
  beginStage(STAGES[8])
  /*
   * The double and the context that exposes it both come from the shipped
   * harness surface, so this stage drives the package's own fake host — the one
   * a fifth harness would reach for — not a copy of it that can drift.
   */
  const host = testingModule.createFakeMemberHost({
    subprocess: () => ({ exitCode: 0, stdout: 'SUB_STDOUT_OK', stderr: 'SUB_STDERR_OK' }),
  })
  const double = host.subprocess
  const runnerI = newRunner({
    ctx: host.ctx,
    onCommand: () => {
      stats.doubled += 1
    },
  })
  expectEqual('the sanctioned ctx.subprocess path is selected', runnerI.executor, 'subprocess')

  const detailI = await runnerI.runGateDetailed(SCRIPT_GATE, { pipeline: PIPELINE, signal: controller.signal })
  expectEqual('the subprocess executor spawned exactly once', double.specs.length, 1)
  const spec = double.specs[0]
  expectEqual('the spawn spec carries the workspace as cwd', spec?.cwd, workspace)
  expectEqual('the spawn spec passes the caller signal through', spec?.signal, controller.signal)
  expectEqual('the spawn spec requests the documented grace', spec?.graceMs, commandsModule.SPAWN_GRACE_MS)
  expectEqual('the spawn spec bounds stdout', spec?.stdio?.stdout?.maxBytes, commandsModule.DEFAULT_MAX_OUTPUT_BYTES)
  expectEqual('the spawn spec bounds stderr', spec?.stdio?.stderr?.maxBytes, commandsModule.DEFAULT_MAX_OUTPUT_BYTES)
  expectEqual('the spawn spec ignores stdin', spec?.stdio?.stdin, 'ignore')
  expectAtLeast('the resolved argv carries an executable and the arguments', spec?.argv?.length, 3)
  expectTrue(
    'the resolved executable is a non-empty string',
    typeof spec?.argv?.[0] === 'string' && spec.argv[0].length > 0,
    'a non-empty executable path',
  )
  expectEqual('the resolved argv kept the template arguments', spec?.argv?.slice(1).join(' '), 'start.sh --check')

  const outcomeI = detailI.outcomes[0]
  expectEqual('the service exit code reached the evidence', outcomeI?.exitCode, 0)
  expectEqual('the evidence names the subprocess executor', outcomeI?.via, 'subprocess')
  expectEqual('the collected stdout was read back', outcomeI?.stdout, 'SUB_STDOUT_OK')
  expectEqual('the collected stderr was read back', outcomeI?.stderr, 'SUB_STDERR_OK')
  expectTrue('the domain verdict is a pass', detailI.evaluation.ok)

  const failing = testingModule.createFakeMemberHost({
    subprocess: () => ({ exitCode: 3, stdout: '', stderr: 'SUB_FAIL' }),
  })
  const runnerIFail = newRunner({
    ctx: failing.ctx,
    onCommand: () => {
      stats.doubled += 1
    },
  })
  const detailIFail = await runnerIFail.runGateDetailed(SCRIPT_GATE, { pipeline: PIPELINE, signal: controller.signal })
  expectEqual('a non-zero service exit code reaches the verdict', detailIFail.evaluation.exitCode, 3)
  expectFalse('a non-zero service exit code cannot pass', detailIFail.evaluation.ok)

  expectEqual('the double was counted separately from real processes', stats.doubled, 2)
} catch (error) {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error)
  record(false, 'the stage completed without throwing', 'a completed stage', text.split('\n')[0])
  note(text)
} finally {
  controller.abort()
  for (const workspace of workspaces) {
    if (!forceRemoveTree(workspace)) {
      invariants.push(`[FAIL] cleanup: expected ${workspace} to be removed, actual it still exists`)
    }
  }
}

/* ----------------------------------------------------------------- rollup */

// Anti-vacuity gate: a drill that started no real process must never be green.
if (stats.confirmed === 0) {
  invariants.push(
    '[FAIL] real-execution guard: expected at least 1 real child process with a real exit code, actual 0',
  )
}
for (const lineText of invariants) emit(lineText)

const failedCount = failedStages.size > 0 ? failedStages.size : invariants.length > 0 ? 1 : 0

if (failedCount === 0) {
  const doubledNote = stats.doubled > 0 ? `, plus ${stats.doubled} driven through the ctx.subprocess double` : ''
  emit(
    `  ${TOTAL_STAGES}/${TOTAL_STAGES} stages · ${stats.assertions} assertions · `
      + `${stats.confirmed} real child processes started (of ${stats.attempted} commands executed${doubledNote})`,
  )
  emit(`SUCCESS: gates drill — ${TOTAL_STAGES}/${TOTAL_STAGES} stages passed`)
  process.exit(0)
}

emit(`  ${stats.assertions} assertions evaluated, ${stats.confirmed} real child processes started`)
emit(`FAILURE: ${failedCount}/${TOTAL_STAGES} stages failed`)
process.exit(1)
