#!/usr/bin/env node
/**
 * delivery-drill.mjs — the end-to-end proof that the pipeline really delivers.
 *
 * Every other drill stops short of the claim the plugin makes to its users: the
 * cockpit shows `已交付`, the tool descriptions promise `phase = delivered`. The
 * engine drill asserts only the *refusal* (`delivered.delivered === false` for an
 * unfinished pipeline) and `verify.mjs` proves each DoD item separately; nothing
 * walks a whole pipeline from `staged` to a persisted `phase === 'delivered'`.
 * This drill does, offline, against the real handlers.
 *
 * What it drives (all from `lib/`, never a mock):
 *   `planFactory` → `approveFactory` → per stage: `dispatchFactory` +
 *   `reportFromMember` + `gateFactory` → `checkDod` → `deliverFactory`,
 *   with the real `FactoryStore` on disk and the real gate runner executing the
 *   template commands (`python -m compileall -q .`, `python -m pytest -q`,
 *   `bash start.sh --check`) through the node fallback executor.
 *
 * What it asserts, beyond the return values: the artifacts are real files written
 * into the temp workspace, and after delivery the record is re-read from
 * `<workspace>/.agent-teams/<id>/factory.json` — `phase` must literally be
 * `'delivered'` on disk, every stage must be `passed`, and the captain's
 * read path (`readFactoryStatus`) must agree.
 *
 * Exit contract (same shape as scripts/engine-drill.mjs and scripts/gates-drill.mjs):
 *   - exit 0: the last line matches /^SUCCESS: delivery drill — (\d+)\/(\d+) stages passed$/;
 *   - exit 1: one `[FAIL] <stage id> (<stage name>): <expected vs actual>` line per
 *     failed assertion, then `FAILURE: <k>/<n> stages failed`;
 *   - exit 2: the compiled modules are missing, `lib/` is older than `src/`, or this
 *     host cannot really run the commands the DoD depends on (pytest / a real bash).
 *     This drill never builds and never grades a stale bundle.
 *
 * `--quiet` keeps the verdict lines and drops the progress chatter.
 * `DELIVERY_DRILL_KEEP=1` keeps the temp workspace and prints its path (debugging a
 * failure), instead of removing it.
 *
 * What this drill does NOT prove (written down so a green run is never oversold):
 *   - it calls the engine handlers directly with a hand-built ToolCallContext, so it
 *     never exercises the tool-registration layer (`runtime/tool-surface.js`), the
 *     captain/member tool whitelists, or the Cordis plugin wiring in `index.ts`;
 *   - its host is `createFakeMemberHost`, so member sessions are the fake `child-N`
 *     ids from `runtime/testing.js`: no real DSH session is spawned and no member
 *     model ever runs. It proves the engine's state machine, not agent behaviour;
 *   - only the `lightweight` pipeline is walked end to end (the `script_tool` route);
 *     the other four pipelines are validated on load, never delivered here;
 *   - the brief deliberately avoids the security triggers, so DoD item 4 is `skipped`
 *     and delivery is green with 6/7 items verified — the live branch of the security
 *     escalation path is never taken;
 *   - the drill plays the human at the `requirement` stage (`humanConfirm: true`), so
 *     the approval gate is exercised mechanically, not through a real approval flow;
 *   - `DELIVERY.md` is deliberately NOT written: the engine records a delivery path,
 *     nothing in the DoD requires that file, and this drill will not fabricate one;
 *   - it is offline but not host-free: it needs python+pytest, a real bash and git on
 *     PATH, and it exits 2 rather than faking a DoD check it cannot really run.
 *
 * Honesty rules this file obeys:
 *   - every path it names exists, every command it reports really ran;
 *   - the release tag `v1.0.0` is NOT pre-seeded — the drill asserts the repo has no
 *     tags until the `document` stage earns one;
 *   - no artifact is written to make a gate green: each one is the fixture the gate
 *     demands, and the DoD verdict is read back from the engine, not composed here.
 */
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/* ------------------------------------------------------------- paths / flags */
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const LIB_DIR = process.env.DELIVERY_DRILL_LIB ?? join(REPO_ROOT, 'lib')
const SRC_DIR = join(REPO_ROOT, 'src')
const QUIET = process.argv.includes('--quiet')
const KEEP = process.env.DELIVERY_DRILL_KEEP === '1'

const MODULES = {
  engine: join(LIB_DIR, 'tools', 'engine.js'),
  context: join(LIB_DIR, 'tools', 'context.js'),
  store: join(LIB_DIR, 'store', 'store.js'),
  state: join(LIB_DIR, 'store', 'state.js'),
  pipeline: join(LIB_DIR, 'domain', 'pipeline.js'),
  router: join(LIB_DIR, 'domain', 'router.js'),
  dod: join(LIB_DIR, 'domain', 'dod.js'),
  scheduler: join(LIB_DIR, 'runtime', 'scheduler.js'),
  commands: join(LIB_DIR, 'runtime', 'commands.js'),
  testing: join(LIB_DIR, 'runtime', 'testing.js'),
}
const COMPILED = Object.values(MODULES)
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'
const STALE_SLACK_MS = 1000

/** Tool name → the handler `lib/tools/engine.js` must export for it. */
const HANDLERS = {
  factory_plan: 'planFactory',
  factory_approve: 'approveFactory',
  factory_dispatch: 'dispatchFactory',
  factory_gate: 'gateFactory',
  factory_status: 'readFactoryStatus',
  factory_dod_check: 'checkDod',
  factory_deliver: 'deliverFactory',
  factory_report: 'reportFromMember',
}

const CONFIG = {
  memberProvider: 'fake',
  memberMaxDepth: 1,
  maxMembers: 8,
  feedLimit: 12,
  allowNodeFallback: true,
}

/**
 * The brief the drill plans with. It deliberately names no security mechanism, so
 * the factory takes the *ordinary* path: `securityTriggered: false`, DoD item 4
 * (`securityOnly`) is skipped, and the DoD therefore has 6 gradeable items plus 1
 * skipped. The drill asserts that premise instead of assuming it.
 */
const BRIEF = '做一个离线的 Markdown 批量排版小工具：扫描本地目录里的 .md 文件，统一标题层级与空行，生成一份排版报告。纯命令行，无网络。'

/** The routing the drill asserts in stage `02-plan` — hardcoded labels are tied to it. */
const EXPECTED_STAGES = ['requirement', 'implement', 'review', 'sec_audit', 'test', 'deliver', 'document']

/* ------------------------------------------------------------------ harness */
const STAGES = []
let assertions = 0
let currentStage = null
const handlerRuns = new Map()
const toolCalls = []

function emit(text) {
  process.stdout.write(text)
}
function say(text) {
  if (!QUIET) emit(text)
}
function oneLine(value, limit = 240) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}
function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : oneLine(error)
}
function fail(label, expected, actual) {
  if (currentStage !== null) currentStage.failed = true
  emit(`[FAIL] ${currentStage === null ? 'drill' : `${currentStage.id} (${currentStage.name})`}: ${label} — expected ${expected}, actual ${actual}\n`)
}
function record(ok, label, expected, actual) {
  assertions += 1
  if (currentStage !== null) currentStage.assertions += 1
  if (!ok) fail(label, expected, actual)
  return ok
}
const check = {
  equal(actual, expected, label) {
    return record(Object.is(actual, expected), label, JSON.stringify(expected), JSON.stringify(actual))
  },
  notEqual(actual, expected, label) {
    return record(!Object.is(actual, expected), label, `!= ${JSON.stringify(expected)}`, JSON.stringify(actual))
  },
  ok(value, label) {
    return record(value === true || Boolean(value), label, 'truthy', JSON.stringify(value))
  },
  notOk(value, label) {
    return record(!value, label, 'falsy', JSON.stringify(value))
  },
  includes(list, needle, label) {
    const hit = Array.isArray(list) && list.includes(needle)
    return record(hit, label, `list including ${JSON.stringify(needle)}`, oneLine(list))
  },
  excludes(list, needle, label) {
    const hit = Array.isArray(list) && list.includes(needle)
    return record(!hit, label, `list without ${JSON.stringify(needle)}`, oneLine(list))
  },
  atLeast(actual, floor, label) {
    return record(typeof actual === 'number' && actual >= floor, label, `>= ${floor}`, String(actual))
  },
  match(value, pattern, label) {
    return record(typeof value === 'string' && pattern.test(value), label, `matching ${pattern}`, JSON.stringify(value))
  },
  deepEqual(actual, expected, label) {
    return record(JSON.stringify(actual) === JSON.stringify(expected), label, oneLine(expected), oneLine(actual))
  },
  async rejects(label, body) {
    let threw = null
    try {
      await body()
    } catch (error) {
      threw = error
    }
    return record(threw !== null, label, 'a thrown FactoryToolError', threw === null ? 'the call resolved' : errorText(threw))
  },
}
function stage(id, name, body) {
  STAGES.push({ id, name, body, ok: false, failed: false, assertions: 0, error: '' })
}
function beginStage(row) {
  currentStage = row
  say(`\n${row.id}  ${row.name}\n`)
}
function note(text) {
  say(`      ${text}\n`)
}

/* ------------------------------------------------------------- module load */
/**
 * A path as the drill should print it: repo-relative when it lives in the repo (the
 * normal case), absolute otherwise — `DELIVERY_DRILL_LIB` may point at a copy outside
 * the tree, and slicing such a path at `REPO_ROOT.length` would print a path that no
 * longer exists anywhere.
 */
const rel = (path) => (path.startsWith(REPO_ROOT) ? path.slice(REPO_ROOT.length + 1).replace(/\\/g, '/') : path)
const sourceOf = (compiled) => join(SRC_DIR, compiled.slice(LIB_DIR.length + 1).replace(/\.js$/, '.ts'))

/**
 * engine-drill's staleness guard, applied to each module this drill grades: a
 * compiled module its own source has outrun must never be graded. Comparing the
 * whole tree instead would make the drill refuse because of a file it never loads
 * (`src/client/*.tsx`, or another agent's half-finished edit), which is not what
 * "never grade a stale bundle" means.
 */
async function staleModules() {
  const stale = []
  for (const compiled of COMPILED) {
    const source = sourceOf(compiled)
    if (!existsSync(source)) continue
    const [libStat, srcStat] = [await stat(compiled), await stat(source)]
    if (libStat.mtimeMs + STALE_SLACK_MS < srcStat.mtimeMs) stale.push({ compiled, source })
  }
  return stale
}

/**
 * Modules outside the graded set whose source is newer. Not a refusal — this drill
 * makes no claim about them — but a mid-edit tree is reported rather than hidden.
 */
async function outrunModules() {
  const graded = new Set(COMPILED)
  const outrun = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.name.endsWith('.js') || graded.has(full)) continue
      const source = sourceOf(full)
      if (!existsSync(source)) continue
      const [libStat, srcStat] = [await stat(full), await stat(source)]
      if (libStat.mtimeMs + STALE_SLACK_MS < srcStat.mtimeMs) outrun.push(rel(full))
    }
  }
  await walk(LIB_DIR)
  return outrun
}
/**
 * Loads the compiled modules the drill grades, refusing to run against a bundle
 * that a `src/` edit has already outrun (the guard engine-drill / gates-drill use),
 * and refusing to run where the template commands cannot really execute — a drill
 * that cannot run `python -m pytest -q` or `bash start.sh --check` would "pass" the
 * DoD on stub evidence, which is exactly what this file exists to prevent.
 */
async function loadModules() {
  const missing = COMPILED.filter((path) => !existsSync(path))
  if (missing.length > 0) {
    process.stderr.write(
      `delivery drill cannot run: missing build output ${missing.map((path) => rel(path)).join(', ')}\n`
        + '  build it in a session where no other agent is editing src/ (`pnpm build`). This drill never builds.\n',
    )
    return false
  }
  const stale = await staleModules()
  if (stale.length > 0) {
    process.stderr.write(
      `delivery drill cannot run: ${rel(stale[0].compiled)} is older than ${rel(stale[0].source)}`
        + ' — this drill grades the compiled bundle and never builds; rebuild instead of grading a stale one.\n',
    )
    return false
  }
  const outrun = await outrunModules()
  world.outrun = outrun
  if (outrun.length > 0) {
    process.stderr.write(
      `delivery drill warning: ${outrun.length} compiled module(s) this drill does not grade are older than their source`
        + ` (${outrun.slice(0, 6).join(', ')}${outrun.length > 6 ? ', …' : ''}) — another agent may be mid-edit.`
        + ' Every module the drill grades is current.\n',
    )
  }
  const load = async (path) => await import(pathToFileURL(path).href)
  world.engine = await load(MODULES.engine)
  world.context = await load(MODULES.context)
  world.StoreClass = (await load(MODULES.store)).FactoryStore
  world.state = await load(MODULES.state)
  world.pipeline = await load(MODULES.pipeline)
  world.router = await load(MODULES.router)
  world.dod = await load(MODULES.dod)
  world.scheduler = await load(MODULES.scheduler)
  world.commands = await load(MODULES.commands)
  world.testing = await load(MODULES.testing)

  for (const [tool, name] of Object.entries(HANDLERS)) {
    if (typeof world.engine[name] !== 'function') {
      process.stderr.write(`delivery drill cannot run: lib/tools/engine.js does not export ${name}() (needed for ${tool}).\n`)
      return false
    }
  }
  if (typeof world.StoreClass !== 'function') {
    process.stderr.write('delivery drill cannot run: lib/store/store.js does not export FactoryStore.\n')
    return false
  }
  for (const fn of ['planStageDispatch', 'schedulerProbes']) {
    if (typeof world.scheduler[fn] !== 'function') {
      process.stderr.write(`delivery drill cannot run: lib/runtime/scheduler.js does not export ${fn}().\n`)
      return false
    }
  }
  for (const fn of ['createNodeCommandRunner', 'resolveShellCommandLine']) {
    if (typeof world.commands[fn] !== 'function') {
      process.stderr.write(`delivery drill cannot run: lib/runtime/commands.js does not export ${fn}().\n`)
      return false
    }
  }
  if (typeof world.testing.createFakeMemberHost !== 'function') {
    process.stderr.write('delivery drill cannot run: lib/runtime/testing.js does not export createFakeMemberHost().\n')
    return false
  }

  world.nodeRunner = world.commands.createNodeCommandRunner()
  // The DoD runs template commands for real; prove the host can run them *before*
  // building a workspace, so "cannot run here" never looks like "the pipeline failed".
  const pytest = await world.nodeRunner.run('python -m pytest --version', {
    cwd: tmpdir(),
    timeoutMs: 60_000,
    maxOutputBytes: 65_536,
  })
  world.preflight = { pytest }
  if (pytest.ok !== true) {
    process.stderr.write(
      'delivery drill cannot run: `python -m pytest --version` failed on this host'
        + ` (${oneLine(pytest.detail)}) — DoD item 2 needs a real pytest run, and this drill will not fake one.\n`,
    )
    return false
  }
  const bashLine = world.commands.resolveShellCommandLine('bash start.sh --check')
  world.preflight.bashLine = bashLine
  if (!/^(\/|[A-Za-z]:[\\/])/.test(bashLine.trim())) {
    process.stderr.write(
      `delivery drill cannot run: \`bash start.sh --check\` still resolves to a bare interpreter (${oneLine(bashLine)})`
        + ' — on Windows that is the WSL launcher, so DoD item 5 could not pass here for the right reason.\n',
    )
    return false
  }
  return true
}

/* ------------------------------------------------------------- world / ctx */
const world = {
  engine: null,
  context: null,
  StoreClass: null,
  state: null,
  pipeline: null,
  router: null,
  dod: null,
  scheduler: null,
  commands: null,
  testing: null,
  nodeRunner: null,
  preflight: {},
  host: null,
  captain: null,
  store: null,
  root: '',
  workspace: '',
  factoryId: '',
  plan: null,
  realCommands: [],
  gateCommands: [],
  gateActions: [],
  outrun: [],
  tempRoots: [],
  updatedAtBeforeDeliver: 0,
  rawBeforeDeliver: '',
  finalFacts: null,
}
const stateDirOf = (workspace) => join(workspace, '.agent-teams')
const captainAgent = () => ({
  id: `delivery-drill-captain-${process.pid}`,
  session: { header: { name: 'captain', cwd: world.workspace } },
  isResident: false,
})
const memberAgent = (sessionId, name) => ({
  id: sessionId,
  session: { header: { name, cwd: world.workspace } },
  isResident: true,
  isRunning: () => true,
})
function makeCtx(agent, callId) {
  return {
    plugin: world.host.ctx,
    caller: agent,
    callerId: agent.id,
    store: world.store,
    workspace: world.workspace,
    now: Date.now(),
    callId,
    signal: new AbortController().signal,
    config: { ...CONFIG, ctx: world.host.ctx, stateDir: stateDirOf(world.workspace) },
  }
}
let callSeq = 0
const captainCtx = () => makeCtx(world.captain, `captain-call-${++callSeq}`)
const memberCtx = (sessionId, name) => makeCtx(memberAgent(sessionId, name), `member-call-${++callSeq}`)
async function callTool(tool, ctx, input) {
  const name = HANDLERS[tool]
  const handler = world.engine[name]
  handlerRuns.set(name, (handlerRuns.get(name) ?? 0) + 1)
  toolCalls.push({ tool, handler: name, input })
  return await handler(ctx, input)
}

/* ----------------------------------------------------------- disk / git IO */
const recordPath = (factoryId) => join(stateDirOf(world.workspace), factoryId, 'factory.json')
async function readRecord(factoryId = world.factoryId) {
  return JSON.parse(await readFile(recordPath(factoryId), 'utf8'))
}
const stageOf = (record, stageId) => record.stages.find((row) => row.id === stageId)
const memberOf = (record, role) => record.members.find((row) => row.role === role)
/** A role's live session id, or `''` when the role has none yet. */
const sessionOf = (record, role) => memberOf(record, role)?.sessionId ?? ''
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: NULL_DEVICE,
  GIT_CONFIG_SYSTEM: NULL_DEVICE,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'delivery-drill',
  GIT_AUTHOR_EMAIL: 'delivery-drill@example.invalid',
  GIT_COMMITTER_NAME: 'delivery-drill',
  GIT_COMMITTER_EMAIL: 'delivery-drill@example.invalid',
}
function git(args) {
  try {
    return {
      ok: true,
      out: execFileSync('git', args, { cwd: world.workspace, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
    }
  } catch (error) {
    const stderr = error !== null && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : ''
    return { ok: false, out: (stderr || errorText(error)).trim() }
  }
}
const commitCount = () => {
  const log = git(['rev-list', '--count', 'HEAD'])
  return log.ok ? Number.parseInt(log.out, 10) : -1
}
const tagList = () => {
  const tags = git(['tag', '--list'])
  return tags.ok ? tags.out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '') : []
}
async function writeReal(relative, body) {
  await writeFile(join(world.workspace, relative), body, 'utf8')
  return relative
}
async function runReal(command, label) {
  const outcome = await world.nodeRunner.run(command, {
    cwd: world.workspace,
    timeoutMs: 120_000,
    maxOutputBytes: 65_536,
  })
  world.realCommands.push({ command, label, ok: outcome.ok === true, exitCode: outcome.exitCode ?? null })
  return outcome
}
async function forceRemoveTree(target) {
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    return true
  } catch {
    /* Windows keeps read-only git objects around; clear the bits and retry once. */
    try {
      const entries = await readdir(target, { recursive: true })
      for (const entry of entries) {
        try {
          await chmod(join(target, entry), 0o666)
        } catch {
          /* best effort */
        }
      }
      await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      return true
    } catch {
      return false
    }
  }
}

/* --------------------------------------------------------------- staffing */
/**
 * Resolves which roles actually own a stage — through the engine's own
 * `planStageDispatch`, never by reading `stage.roles` directly, because the roster
 * cap substitutes via `ROLE_FALLBACKS` (with no security trigger the `sec_audit`
 * stage is handed to the retained `reviewer`).
 */
function staffingOf(record, stageId) {
  const probes = world.scheduler.schedulerProbes(world.host.ctx)
  const plan = world.scheduler.planStageDispatch({
    state: record,
    attempts: world.engine.ledgerFor(record),
    now: world.store.now(),
    isLive: probes.isLive,
    isRunning: probes.isRunning,
    stageId,
    upstreamArtifacts: [],
  })
  const staffing = plan.staffing ?? { assigned: [], direct: [], substituted: [], missing: [] }
  const assigned = staffing.assigned.length > 0 ? [...staffing.assigned] : [...staffing.direct]
  const substituted = (staffing.substituted ?? []).map((row) => `${row.from}→${row.to ?? row.resolved ?? '?'}`)
  return { assigned, substituted, missing: [...(staffing.missing ?? [])], fallbackUsed: staffing.fallbackUsed === true }
}

/* ------------------------------------------------------------ fixture text */
async function writePrd() {
  return await writeReal('PRD.md', [
    '# Markdown 批量排版工具 PRD',
    '',
    '## 功能清单',
    '- F1 扫描指定目录下的 .md 文件',
    '- F2 把超过指定深度的标题压平',
    '- F3 把连续空行合并为一行',
    '- F4 结束时打印处理文件数',
    '',
    '## 验收标准',
    '- AC-1 传入目录时列出该目录下全部 .md 文件的相对路径',
    '- AC-2 超过指定深度的标题被压平到指定深度',
    '- AC-3 连续空行被合并为一行',
    '- AC-4 结束时打印处理文件数',
    '',
    '## 非目标',
    '- 不做网络请求',
    '- 不做富文本渲染',
    '- 不做 Markdown 语法校验',
    '',
  ].join('\n'))
}
async function writeReview() {
  return await writeReal('REVIEW.md', [
    '# 代码评审报告',
    '',
    '## 评审范围',
    'md_tidy.py 与其单元测试（逐行读完，未做抽查）。',
    '',
    '## 发现',
    '- 无阻断问题；函数边界清晰，未发现资源泄漏。',
    '',
    '## 结论',
    '结论: APPROVED',
    '',
  ].join('\n'))
}
async function writeSecurityAudit() {
  return await writeReal('SECURITY_AUDIT.md', [
    '# 安全审计',
    '',
    '## 审计范围',
    '本工厂走的是普通路径（计划期未命中安全触发词）。本阶段的执行人由编制替补接手，',
    '仅按门禁要求对本阶段的产出做一次安全复核。',
    '',
    '## 检查项',
    '- 工具只读本地目录，不发起网络请求：通过',
    '- 不解析外部输入，不读写凭据文件：通过',
    '- 无子进程调用，无动态求值：通过',
    '',
    '## 结论',
    '结论: SEC_PASS',
    '',
  ].join('\n'))
}
async function writeTestReport() {
  return await writeReal('TEST_REPORT.md', [
    '# 测试报告',
    '',
    '## 用例映射',
    '- AC-1 → test_lists_markdown_files PASS',
    '- AC-2 → test_flattens_heading_depth PASS',
    '- AC-3 → test_collapses_blank_lines PASS',
    '- AC-4 → test_lists_markdown_files 覆盖处理计数 PASS',
    '',
    '## 执行命令',
    '`python -m pytest -q` —— 退出码 0（见下）',
    '',
    '## 结论',
    '结论: PASS',
    '',
  ].join('\n'))
}
async function writeStartSh() {
  return await writeReal('start.sh', [
    '#!/usr/bin/env bash',
    '# 构建交付阶段的自检入口：bash start.sh --check 必须退出 0。',
    'set -euo pipefail',
    'if [ "${1:-}" = "--check" ]; then',
    '  test -f md_tidy.py || { echo "md_tidy.py missing" >&2; exit 1; }',
    '  python -m compileall -q . >/dev/null',
    '  echo "start.sh --check OK"',
    '  exit 0',
    'fi',
    'python md_tidy.py "$@"',
    '',
  ].join('\n'))
}
async function writeReadme() {
  return await writeReal('README.md', [
    '# Markdown 批量排版工具',
    '',
    '## 简介',
    '离线命令行小工具：把目录里的 Markdown 统一标题层级与空行。',
    '',
    '## 安装',
    '无需安装，仓库自带源码与测试。',
    '',
    '## 启动',
    '`python md_tidy.py <目录>`；自检用 `bash start.sh --check`。',
    '',
    '## 接口一览',
    '| 函数 | 说明 |',
    '| --- | --- |',
    '| markdown_files | 列出目录下的 Markdown 文件 |',
    '| collapse_blank_lines | 把连续空行合并为一行 |',
    '| flatten_headings | 把标题压平到指定深度 |',
    '',
  ].join('\n'))
}

/** One row per pipeline stage: the artifact the gate reads, and who may write it. */
const PIPELINE_ROWS = [
  {
    id: 'requirement',
    stageId: '04-requirement',
    name: '需求分析 → PRD.md 章节清单（人工审批点）',
    humanApproval: true,
    artifacts: ['PRD.md'],
    write: writePrd,
  },
  {
    id: 'implement',
    stageId: '05-implement',
    name: '实现 → python -m compileall -q . 退出码',
    humanApproval: false,
    artifacts: ['md_tidy_cli.py'],
    write: async () => {
      // The implement stage has to leave a real diff: the fixture ships the library
      // and the tests, and the command line entry point is this stage's own code.
      await writeReal('md_tidy_cli.py', [
        '"""Command line entry point for the offline Markdown tidier."""',
        'import argparse',
        '',
        'import md_tidy',
        '',
        '',
        'def build_parser():',
        '    parser = argparse.ArgumentParser(prog="md-tidy", description="offline Markdown tidier")',
        '    parser.add_argument("root", help="directory to scan")',
        '    parser.add_argument("--depth", type=int, default=3, help="maximum heading depth")',
        '    return parser',
        '',
        '',
        'def run(argv=None):',
        '    args = build_parser().parse_args(argv)',
        '    files = md_tidy.markdown_files(args.root)',
        '    for path in files:',
        '        original = path.read_text(encoding="utf-8")',
        '        tidied = md_tidy.flatten_headings(md_tidy.collapse_blank_lines(original), args.depth)',
        '        if tidied != original:',
        '            path.write_text(tidied, encoding="utf-8")',
        '    print(f"tidied {len(files)} file(s)")',
        '    return 0',
        '',
        '',
        'if __name__ == "__main__":',
        '    raise SystemExit(run())',
        '',
      ].join('\n'))
      const outcome = await runReal('python -m compileall -q .', 'implement gate command')
      check.equal(outcome.ok, true, 'the implement-stage command really exits 0')
      return ['md_tidy_cli.py']
    },
  },
  {
    id: 'review',
    stageId: '06-review',
    name: '代码评审 → REVIEW.md 结论行 APPROVED',
    humanApproval: false,
    artifacts: ['REVIEW.md'],
    write: writeReview,
  },
  {
    id: 'sec_audit',
    stageId: '07-sec-audit',
    name: '安全审计 → SECURITY_AUDIT.md 结论行 SEC_PASS',
    humanApproval: false,
    artifacts: ['SECURITY_AUDIT.md'],
    write: writeSecurityAudit,
  },
  {
    id: 'test',
    stageId: '08-test',
    name: '测试验证 → 组合门禁（结论行 + pytest 退出码）',
    humanApproval: false,
    artifacts: ['TEST_REPORT.md'],
    write: async () => {
      const outcome = await runReal('python -m pytest -q', 'test gate command')
      check.equal(outcome.ok, true, 'the test-stage command really exits 0')
      await writeTestReport()
      return ['TEST_REPORT.md']
    },
  },
  {
    id: 'deliver',
    stageId: '09-deliver',
    name: '构建交付 → bash start.sh --check 退出码',
    humanApproval: false,
    artifacts: ['start.sh'],
    write: async () => {
      await writeStartSh()
      const outcome = await runReal('bash start.sh --check', 'deliver gate command')
      check.equal(outcome.ok, true, 'the deliver-stage command really exits 0')
      return ['start.sh']
    },
  },
  {
    id: 'document',
    stageId: '10-document',
    name: '文档与总验收 → 七条 DoD 机器校验',
    humanApproval: false,
    artifacts: ['README.md'],
    write: async () => {
      check.deepEqual(tagList(), [], 'the release tag does not exist yet — the pipeline has to earn it')
      const tag = git(['tag', 'v1.0.0'])
      check.equal(tag.ok, true, `git tag v1.0.0 succeeds at the document stage: ${oneLine(tag.out)}`)
      await writeReadme()
      return ['README.md']
    },
  },
]

/* --------------------------------------------------------------- pipeline */
/**
 * Drives exactly one stage: dispatch → write the real artifact → every assigned
 * member reports `done` → gate. Every assertion here is about the engine's own
 * verdict and the record on disk, never about what the drill "meant" to happen.
 */
async function driveStage(row, index) {
  const stageId = row.id
  const isFirst = index === 0
  const isLast = index === PIPELINE_ROWS.length - 1
  const before = await readRecord()
  // approveFactory already dispatched the first stage to its owners — that is the
  // documented behaviour, so the drill must not pretend the stage was untouched.
  // Every later stage is still pending until the captain dispatches it.
  check.equal(stageOf(before, stageId).status, isFirst ? 'active' : 'pending', `${stageId} is ${isFirst ? 'active (approval already dispatched it)' : 'pending'} when the drill reaches it`)

  const staffing = staffingOf(before, stageId)
  check.atLeast(staffing.assigned.length, 1, `${stageId} resolves at least one owning role through the scheduler`)
  check.equal(staffing.missing.length, 0, `${stageId} has no unstaffed role`)
  note(`assigned: ${staffing.assigned.join(', ')}${staffing.substituted.length > 0 ? ` (substituted: ${staffing.substituted.join(', ')})` : ''}`)

  const dispatch = await callTool('factory_dispatch', captainCtx(), { factoryId: world.factoryId, stageId })
  check.equal(dispatch.known, true, `${stageId} is a known, dispatchable stage`)
  check.equal(dispatch.failed.length, 0, `${stageId} dispatch has no failed row`)
  check.equal(dispatch.missingRoles.length, 0, `${stageId} dispatch reports no missing role`)
  check.equal(dispatch.stageId, stageId, 'dispatch answers for the requested stage')
  if (isFirst) {
    // factory_approve already dispatched this stage to its owners; dispatching it a
    // second time must therefore start nobody, which is what makes approve idempotent.
    check.equal(dispatch.spawned.length, 0, 're-dispatching the stage approval already sent starts no further session')
  }
  const dispatched = await readRecord()
  check.equal(stageOf(dispatched, stageId).status, 'active', `${stageId} is active once the captain has dispatched it`)
  for (const [role, sessionId] of before.members.map((member) => [member.role, member.sessionId ?? ''])) {
    if (sessionId === '') continue
    check.equal(sessionOf(dispatched, role), sessionId, `${role} keeps its session id while ${stageId} is dispatched`)
  }
  // Members are spawned per stage, so the only roles that may gain a session here are
  // this stage's own owners — and a role that already had one never gets a second.
  const gained = dispatched.members
    .filter((member) => sessionOf(before, member.role) === '' && sessionOf(dispatched, member.role) !== '')
    .map((member) => member.role)
  const expectedGained = staffing.assigned.filter((role) => sessionOf(before, role) === '' && !isFirst)
  check.deepEqual([...gained].sort(), [...expectedGained].sort(), `${stageId} starts sessions for exactly the owners that had none`)
  check.equal(new Set(dispatched.members.map((member) => member.sessionId).filter((id) => id !== undefined && id !== '')).size, dispatched.members.filter((member) => member.sessionId !== undefined && member.sessionId !== '').length, 'no two members ever share one session id')

  const written = await row.write()
  const artifacts = Array.isArray(written) ? [...written] : [written]
  for (const path of artifacts) {
    check.ok(existsSync(join(world.workspace, path)), `${path} really exists on disk before the gate reads it`)
  }

  const record = await readRecord()
  const rolesRun = []
  for (const role of staffing.assigned) {
    const member = memberOf(record, role)
    if (member === undefined || member.sessionId === undefined || member.sessionId === '') {
      record(false, `${role} owns ${stageId} and must have a live session to report`, 'a spawned session', oneLine(member))
      continue
    }
    const report = await callTool('factory_report', memberCtx(member.sessionId, role), {
      factoryId: world.factoryId,
      status: 'done',
      summary: `${stageId} 阶段工件已完成（真实文件已写入工作区），请队长裁决门禁。`,
      stage: stageId,
      artifacts,
      commands: world.realCommands.filter((entry) => entry.label.startsWith(stageId)).map((entry) => entry.command),
    })
    rolesRun.push(role)
    check.equal(report.status, 'done', `${role} reports done on ${stageId}`)
    check.equal(report.artifactRejected.length, 0, `${role} has no artifact path rejected`)
    check.equal(report.artifactsRegistered.length, artifacts.length, `${role} registered every ${stageId} artifact`)
  }
  check.deepEqual(rolesRun, staffing.assigned, `every role the scheduler assigned to ${stageId} reported done`)

  const parked = await readRecord()
  check.equal(stageOf(parked, stageId).status, 'gate', `${stageId} parks at the gate after the reports`)

  // The human-approval stage must really block: unconfirmed it may only park, and
  // the engine has to say so instead of advancing on the drill's behalf.
  if (row.humanApproval) {
    const probe = await callTool('factory_gate', captainCtx(), { factoryId: world.factoryId, stageId })
    check.equal(probe.action, 'await_approval', `${stageId} is an approval point: without humanConfirm it must not advance`)
    check.equal(probe.needsHumanConfirm, true, `${stageId} asks for the human confirmation`)
    check.equal(probe.ok, true, `${stageId} evidence itself passed — only the confirmation is missing`)
    check.equal(stageOf(await readRecord(), stageId).status, 'gate', `${stageId} stays parked while the user has not answered`)
  }

  const gate = await callTool('factory_gate', captainCtx(), {
    factoryId: world.factoryId,
    stageId,
    ...(row.humanApproval ? { humanConfirm: true } : {}),
  })
  world.gateActions.push({ stageId, action: gate.action, gateType: gate.gateType })
  world.gateCommands.push(...(gate.commands ?? []))
  check.equal(gate.ok, true, `${stageId} gate evidence is green`)
  check.equal(gate.refusedCommands.length, 0, `${stageId} ran every command the gate planned (nothing refused)`)
  check.equal(gate.action, isLast ? 'delivered' : 'advance', `${stageId} gate verdict`)
  check.equal(gate.needsHumanConfirm, false, `${stageId} is settled, not waiting for a human`)
  if (!isLast) {
    check.equal(gate.nextStage, EXPECTED_STAGES[EXPECTED_STAGES.indexOf(stageId) + 1], `${stageId} names the next stage`)
  }
  if (stageId === 'document') {
    check.equal(gate.dod?.total, world.dod.DOD_TOTAL, 'the last gate really ran the seven-item audit')
    check.equal(gate.dod?.failed, 0, 'the last gate saw no failing DoD item')
    check.equal(gate.dod?.pending, 0, 'the last gate saw no unexecuted DoD item')
    check.equal(gate.dod?.skipped, 1, 'the last gate acknowledged the one skipped securityOnly item')
  }

  const after = await readRecord()
  check.equal(stageOf(after, stageId).status, 'passed', `${stageId} is persisted as passed`)
  check.equal(after.securityTriggered, false, `no ${stageId} artifact flipped the security path (DoD item 4 stays inapplicable)`)
  check.equal(after.phase, 'running', 'the factory is still running until delivery')

  const commit = git(['add', '-A'])
  check.equal(commit.ok, true, `git add succeeds after ${stageId}`)
  const staged = git(['commit', '-q', '-m', `stage: ${stageId}`])
  check.equal(staged.ok, true, `the ${stageId} stage is committed (one commit per stage)`)
  note(`commit ${commitCount()} · ${stageId} passed`)
}

/* ------------------------------------------------------------------ stages */
stage('00-preflight', 'compiled modules + real executors on this host', async () => {
  check.equal(Object.keys(HANDLERS).length, 8, 'the drill drives all eight captain/member handlers it needs')
  check.equal(world.dod.DOD_TOTAL, 7, 'the DoD really has seven items')
  check.equal(world.dod.README_REQUIRED_SECTIONS.length, 4, 'README has four required headings')
  check.equal(world.dod.DOD_RELEASE_TAG, 'v1.0.0', 'the release tag the DoD looks for')
  check.equal(world.preflight.pytest.ok, true, 'python -m pytest really ran here (the exit code the DoD will grade)')
  check.match(world.preflight.bashLine, /bash/i, 'bash start.sh --check resolves to a real interpreter, not a bare name')
  check.atLeast(world.dod.DOD_ITEMS.filter((item) => item.securityOnly === true).length, 1, 'one DoD item is securityOnly')
  const signal = world.router.securitySignal(BRIEF)
  check.equal(signal.triggered, false, 'the drill brief itself hits no security trigger (otherwise item 4 could not be skipped)')
  check.equal(world.pipeline.getPipeline('lightweight').length, EXPECTED_STAGES.length, 'the lightweight template has the seven stages the drill drives')
  check.deepEqual([...world.pipeline.stageIds('lightweight')], EXPECTED_STAGES, 'the template stage ids match the drill’s expectation')
  check.ok(world.router.SECURITY_TRIGGERS.length >= 20, 'the security trigger table is the real one')
})

stage('01-fixture', 'temp workspace: pytest fixture + seeded git repo, no tag', async () => {
  world.root = await mkdtemp(join(tmpdir(), 'delivery-drill-'))
  world.tempRoots.push(world.root)
  world.workspace = join(world.root, 'ws')
  await mkdir(world.workspace, { recursive: true })
  note(`workspace: ${world.workspace}`)

  await writeReal('.gitignore', 'node_modules/\n__pycache__/\n.pytest_cache/\n.agent-teams/\n')
  await writeReal('md_tidy.py', [
    '"""Offline Markdown tidying helper (delivery-drill fixture)."""',
    'from pathlib import Path',
    '',
    'def markdown_files(root):',
    '    return sorted(Path(root).rglob("*.md"))',
    '',
    'def collapse_blank_lines(text):',
    '    kept = []',
    '    for line in text.splitlines():',
    '        if line.strip() == "" and kept and kept[-1] == "":',
    '            continue',
    '        kept.append(line)',
    '    return "\\n".join(kept)',
    '',
    'def flatten_headings(text, depth=3):',
    '    out = []',
    '    for line in text.splitlines():',
    '        if line.startswith("#"):',
    '            level = len(line) - len(line.lstrip("#"))',
    '            out.append("#" * min(level, depth) + line[level:])',
    '        else:',
    '            out.append(line)',
    '    return "\\n".join(out)',
    '',
  ].join('\n'))
  await writeReal('test_md_tidy.py', [
    'import md_tidy',
    '',
    '',
    'def test_collapses_blank_lines():',
    '    assert md_tidy.collapse_blank_lines("a\\n\\n\\nb") == "a\\n\\nb"',
    '',
    '',
    'def test_flattens_heading_depth():',
    '    assert md_tidy.flatten_headings("#### deep", 3) == "### deep"',
    '',
    '',
    'def test_lists_markdown_files(tmp_path):',
    '    (tmp_path / "a.md").write_text("# a", encoding="utf-8")',
    '    assert [p.name for p in md_tidy.markdown_files(tmp_path)] == ["a.md"]',
    '',
  ].join('\n'))

  check.equal(git(['init', '-q', '-b', 'main']).ok, true, 'git init succeeds in the temp workspace')
  check.equal(git(['config', 'core.autocrlf', 'false']).ok, true, 'line endings stay as written (start.sh must stay LF)')
  check.equal(git(['add', '-A']).ok, true, 'the fixture files stage cleanly')
  const seed = git(['commit', '-q', '-m', 'chore: drill fixture'])
  check.equal(seed.ok, true, 'the seeded commit exists')
  check.equal(commitCount(), 1, 'the workspace starts with exactly one commit')
  check.deepEqual(tagList(), [], 'the workspace starts with no tag — v1.0.0 is earned by the pipeline, not pre-seeded')

  const baseline = await runReal('python -m pytest -q', 'fixture baseline')
  check.equal(baseline.ok, true, 'the fixture test suite is green before the pipeline touches it (the drill is not grading its own broken fixture)')

  world.host = world.testing.createFakeMemberHost({ provider: CONFIG.memberProvider })
  world.captain = captainAgent()
  world.store = new world.StoreClass({ workspace: world.workspace, stateDir: stateDirOf(world.workspace) })
  check.ok(world.store !== undefined, 'the real FactoryStore opens the temp workspace')
})

stage('02-plan', 'planFactory: no security trigger, nothing spawned', async () => {
  const spawnsBefore = world.host.calls.startActivation.length
  world.plan = await callTool('factory_plan', captainCtx(), { brief: BRIEF })
  world.factoryId = world.plan.factoryId
  const plan = world.plan

  check.match(plan.factoryId, /^[0-9a-f]{8}$/, 'factory_plan answers with an 8-hex factory id')
  check.equal(plan.phase, 'staged', 'a plan is staged, not running')
  check.equal(plan.planReviewState, 'awaiting_review', 'the plan waits for the user')
  check.equal(plan.taskType, 'script_tool', 'the brief routes to the script_tool family')
  check.equal(plan.pipeline, 'lightweight', 'the script_tool family uses the lightweight pipeline')
  check.equal(plan.securityTriggered, false, 'SecurityTriggered=false: this factory takes the ordinary path')
  check.deepEqual([...plan.stages.map((row) => row.id)], EXPECTED_STAGES, 'the planned stages are the seven the drill drives')
  check.equal(plan.childSessions, 0, 'planning creates no member session')
  check.equal(plan.spawnedMembers, 0, 'planning spawns nobody')
  check.equal(world.host.calls.startActivation.length, spawnsBefore, 'planning never calls the host to start a child')
  check.equal(plan.overCap, false, 'the roster fits the cap')
  check.equal(plan.reusedPlan, false, 'this is a fresh plan, not a replayed one')
  check.includes(plan.team.map((row) => row.role), 'pm', 'the iron triangle is on the roster (pm)')
  check.includes(plan.team.map((row) => row.role), 'qa', 'the iron triangle is on the roster (qa)')
  check.includes(plan.team.map((row) => row.role), 'be_dev', 'the iron triangle is on the roster (be_dev)')
  check.excludes(plan.team.map((row) => row.role), 'security_eng', 'no security role is pinned when nothing triggered the security path')
  check.match(plan.factoryFile, /[\\/]\.agent-teams[\\/]/, 'the record lives under the workspace state dir')
  check.ok(plan.factoryFile.endsWith(`${plan.factoryId}/factory.json`) || plan.factoryFile.endsWith(`${plan.factoryId}\\factory.json`), 'the plan names its own factory.json')

  const record = await readRecord()
  check.equal(record.phase, 'staged', 'the record on disk is staged')
  check.equal(record.captainSessionId, world.captain.id, 'the captain owns the record')
  check.deepEqual([...record.stages.map((row) => row.status)], EXPECTED_STAGES.map(() => 'pending'), 'no stage is active before approval')
  check.equal(record.members.filter((row) => row.sessionId !== undefined).length, 0, 'no roster member has a session before approval')
  check.equal(existsSync(recordPath(plan.factoryId)), true, 'factory.json really exists on disk')
})

stage('03-approve', 'approveFactory: only the first stage’s owners get sessions', async () => {
  const before = await readRecord()
  const required = staffingOf(before, 'requirement')
  check.atLeast(required.assigned.length, 1, 'the first stage resolves an owning role before approval')
  check.atLeast(before.members.length, 3, 'the roster carries the whole team up front, not just the first stage')

  const approve = await callTool('factory_approve', captainCtx(), { factoryId: world.factoryId })
  check.equal(approve.phase, 'running', 'approval moves the factory to running')
  check.equal(approve.alreadyApproved, false, 'this approval is not an idempotent replay')
  check.equal(approve.stageId, 'requirement', 'approval dispatches the first stage')
  check.deepEqual([...approve.spawned].sort(), [...required.assigned].sort(), 'approval wakes exactly the roles the first stage needs')
  check.equal(approve.failed.length, 0, 'no dispatch row failed')
  check.equal(approve.missingRoles.length, 0, 'no role is missing from the roster')
  check.atLeast(approve.decisions.length, 1, 'approval decided something')

  const record = await readRecord()
  const roles = record.members.map((row) => row.role)
  check.includes(roles, 'pm', 'the iron triangle is on the roster (pm)')
  check.includes(roles, 'qa', 'the iron triangle is on the roster (qa)')
  check.includes(roles, 'be_dev', 'the iron triangle is on the roster (be_dev)')
  const staffed = record.members.filter((row) => typeof row.sessionId === 'string' && row.sessionId !== '')
  // Approval must NOT wake the whole roster: members are started per stage, which is
  // the behaviour the captain protocol promises the user.
  check.deepEqual([...staffed.map((row) => row.role)].sort(), [...required.assigned].sort(), 'only the first stage’s owners have live sessions')
  check.equal(new Set(staffed.map((row) => row.sessionId)).size, staffed.length, 'member session ids are unique')
  check.equal(stageOf(record, 'requirement').status, 'active', 'the first stage is active')
  check.equal(record.phase, 'running', 'the record on disk is running')
})

for (const [index, row] of PIPELINE_ROWS.entries()) {
  stage(row.stageId, row.name, async () => {
    await driveStage(row, index)
  })
}

stage('11-dod', 'checkDod: seven items, six gradeable, one skipped', async () => {
  const minCommits = EXPECTED_STAGES.length + 1
  const dod = await callTool('factory_dod_check', captainCtx(), { factoryId: world.factoryId, minCommits })
  check.equal(dod.ok, true, 'the DoD audit is all green')
  check.equal(dod.total, world.dod.DOD_TOTAL, 'the audit covered every DoD item')
  check.equal(dod.passed, 6, 'six items passed')
  check.equal(dod.skipped, 1, 'exactly one item (the securityOnly one) is skipped')
  check.equal(dod.failed, 0, 'nothing failed')
  check.equal(dod.pending, 0, 'nothing was left unexecuted')
  check.equal(dod.securityTriggered, false, 'the audit agrees the security path was never taken')
  check.equal(dod.refusedCommands.length, 0, 'every DoD command really ran')
  check.atLeast(dod.commits, minCommits, `git history has at least one commit per pipeline stage (${minCommits})`)
  check.includes(dod.tags, world.dod.DOD_RELEASE_TAG, 'the release tag exists')
  const statusOf = (id) => dod.items.find((item) => item.id === id)?.status
  check.equal(statusOf(1), 'passed', 'DoD #1 PRD ↔ 用例映射 passed')
  check.equal(statusOf(2), 'passed', 'DoD #2 pytest 实跑 passed')
  check.equal(statusOf(3), 'passed', 'DoD #3 REVIEW APPROVED passed')
  check.equal(statusOf(4), 'skipped', 'DoD #4 is skipped, not passed: this factory has no security path')
  check.equal(statusOf(5), 'passed', 'DoD #5 start.sh --check passed')
  check.equal(statusOf(6), 'passed', 'DoD #6 README 四标题 passed')
  check.equal(statusOf(7), 'passed', 'DoD #7 逐阶段 commit + tag passed')
  const skippedEvidence = dod.items.find((item) => item.id === 4)?.evidence ?? ''
  check.match(skippedEvidence, /未触发/, 'DoD #4 explains why it was skipped')
  check.ok(skippedEvidence.length > 0, 'the skipped item still carries a machine-readable reason')
})

stage('12-deliver', 'deliverFactory: the real delivery gate', async () => {
  const minCommits = EXPECTED_STAGES.length + 1
  world.rawBeforeDeliver = await readFile(recordPath(world.factoryId), 'utf8')
  world.updatedAtBeforeDeliver = JSON.parse(world.rawBeforeDeliver).updatedAt
  const delivered = await callTool('factory_deliver', captainCtx(), { factoryId: world.factoryId, minCommits, note: 'delivery drill: end-to-end offline delivery' })
  check.equal(delivered.delivered, true, 'deliverFactory returns delivered: true')
  check.equal(delivered.alreadyDelivered, false, 'this is the first, real delivery')
  check.equal(delivered.phase, 'delivered', 'the delivery answer already reports the delivered phase')
  check.deepEqual([...delivered.blocked], [], 'nothing blocked the delivery')
  check.equal(delivered.stagesPassed, true, 'every stage passed')
  check.equal(delivered.dodPassed, 6, 'delivery re-ran the audit: six passed')
  check.equal(delivered.dodTotal, world.dod.DOD_TOTAL, 'delivery re-ran all seven items')
  check.equal(delivered.deliveryPath, 'DELIVERY.md', 'the delivery path is recorded')
  check.equal(delivered.items.length, world.dod.DOD_TOTAL, 'the delivery answer carries the seven verdicts')
})

stage('13-disk', 'the persisted record really says phase = delivered', async () => {
  const raw = await readFile(recordPath(world.factoryId), 'utf8')
  const record = JSON.parse(raw)
  check.equal(record.phase, 'delivered', 'factory.json on disk: phase === "delivered"')
  // `FactoryState` carries no `deliveredAt`; the phase transition is what stamps the
  // record, so the persisted proof of "the delivery really wrote this" is an
  // `updatedAt` that moved forward across the deliverFactory call.
  check.ok(typeof record.updatedAt === 'number', 'the delivered record carries a numeric updatedAt')
  check.atLeast(record.updatedAt, world.updatedAtBeforeDeliver, 'the delivery write is what stamped updatedAt')
  check.ok(typeof record.approvedAt === 'number', 'the approval timestamp from the earlier phase survives on disk')
  check.equal(record.deliveryPath, 'DELIVERY.md', 'the delivery path is persisted on disk')
  check.equal(record.securityTriggered, false, 'the persisted security verdict is unchanged')
  const statuses = record.stages.map((row) => row.status)
  check.deepEqual([...statuses], EXPECTED_STAGES.map(() => 'passed'), 'every stage on disk is passed')
  // `StageStatus` is 'pending' | 'active' | 'gate' | 'passed' | 'rejected' — there is no
  // 'skipped' stage state; only DoD items can be skipped. So "passed or skipped"
  // collapses to "passed" here, and the skip is asserted on the DoD row instead.
  check.equal(statuses.filter((value) => value !== 'passed').length, 0, 'no stage is left pending/active/gate/rejected')
  check.equal(record.dod.length, world.dod.DOD_TOTAL, 'the seven DoD verdicts are persisted')
  check.equal(record.dod.filter((item) => item.status === 'skipped').length, 1, 'the persisted skip is the securityOnly item')
  check.equal(record.dod.filter((item) => item.status === 'passed').length, 6, 'six persisted verdicts are passes')

  const status = await callTool('factory_status', captainCtx(), { factoryId: world.factoryId })
  check.equal(status.scope, 'factory', 'factory_status answers for one factory')
  check.equal(status.phase, 'delivered', 'the captain’s own read path sees phase = delivered')
  check.deepEqual([...(status.stages ?? []).map((row) => row.status)], EXPECTED_STAGES.map(() => 'passed'), 'the read path sees every stage passed')
  check.equal(status.securityTriggered, false, 'the read path agrees on the security verdict')
  check.ok(typeof status.nextAction === 'string' && status.nextAction.length > 0, 'the read path explains what to do next')
})

stage('14-terminal', 'delivered is terminal and the delivery is idempotent', async () => {
  const before = await readFile(recordPath(world.factoryId), 'utf8')
  const again = await callTool('factory_deliver', captainCtx(), { factoryId: world.factoryId })
  check.equal(again.delivered, true, 'a repeated delivery still reports delivered')
  check.equal(again.alreadyDelivered, true, 'a repeated delivery is recognised as the idempotent replay')
  check.equal(again.blocked.length, 0, 'the replay is not blocked')
  check.equal(again.phase, 'delivered', 'the replay keeps the delivered phase')
  check.equal(again.dodTotal, world.dod.DOD_TOTAL, 'the replay reports the persisted seven DoD verdicts')
  const after = await readFile(recordPath(world.factoryId), 'utf8')
  check.equal(after, before, 'the replay rewrote nothing on disk (no second audit, no phase churn)')

  let refusal = null
  try {
    await callTool('factory_dispatch', captainCtx(), { factoryId: world.factoryId })
  } catch (error) {
    refusal = error
  }
  check.ok(refusal !== null, 'a delivered factory can no longer be dispatched')
  check.match(String(refusal?.message ?? ''), /delivered/, 'the refusal names the delivered phase')
  const still = await readRecord()
  check.equal(still.phase, 'delivered', 'the refused dispatch left the delivered record untouched')
})

stage('15-invariants', 'anti-vacuity: the drill really drove the engine', async () => {
  check.atLeast(handlerRuns.size, 8, 'at least eight distinct handlers ran')
  for (const name of Object.values(HANDLERS)) {
    check.atLeast(handlerRuns.get(name) ?? 0, 1, `${name}() really ran`)
  }
  check.equal(handlerRuns.get('gateFactory'), EXPECTED_STAGES.length + 1, 'one gate per stage plus the unconfirmed human-approval probe')
  check.atLeast(handlerRuns.get('reportFromMember') ?? 0, EXPECTED_STAGES.length, 'at least one member report per stage')
  check.atLeast(handlerRuns.get('dispatchFactory') ?? 0, EXPECTED_STAGES.length + 1, 'one dispatch per stage plus the refused one')
  check.deepEqual(world.gateActions.map((row) => row.stageId), EXPECTED_STAGES, 'the gates were adjudicated in pipeline order')
  check.deepEqual(world.gateActions.map((row) => row.action), EXPECTED_STAGES.map((_, i) => (i === EXPECTED_STAGES.length - 1 ? 'delivered' : 'advance')), 'every gate advanced, the last one delivered')
  // The three script gates of this pipeline each really started a child process:
  // `python -m compileall -q .`, `python -m pytest -q` and `bash start.sh --check`.
  // The drill starts those same commands once itself (to prove the fixture is green
  // before the pipeline reads it) plus a baseline `pytest`, so the honest floor for
  // the drill's own child processes is four.
  check.atLeast(world.realCommands.length, 4, 'the drill really started child processes of its own')
  check.equal(world.realCommands.filter((row) => row.ok !== true).length, 0, 'every command the drill started exited 0')
  check.atLeast(world.gateCommands.length, 3, 'the gates themselves really executed the template commands')
  check.equal(world.gateCommands.filter((row) => row.exitCode !== 0).length, 0, 'every gate command carries a real exit code 0')
  const gateCommandText = world.gateCommands.map((row) => row.command).join(' | ')
  for (const fragment of ['compileall', 'pytest', 'start.sh --check']) {
    check.match(gateCommandText, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `the gates really ran the template command matching ${fragment}`)
  }
  const drillCommandText = world.realCommands.map((row) => row.command).join(' | ')
  check.match(drillCommandText, /python -m pytest -q/, 'the drill proved the pytest fixture green itself, before the pipeline read it')
  check.atLeast(commitCount(), EXPECTED_STAGES.length + 1, 'the history has a commit per stage plus the fixture commit')
  check.includes(tagList(), world.dod.DOD_RELEASE_TAG, 'the tag the DoD read is really in the repo')
  check.equal(existsSync(join(world.workspace, 'DELIVERY.md')), false, 'nothing fabricated the recorded deliveryPath file')
  check.atLeast(assertions, 60, 'the drill evaluated enough assertions to be non-vacuous')
})

/* ------------------------------------------------------------------- main */
async function main() {
  emit(`delivery drill — ${REPO_ROOT}\n`)
  emit(`  lib: ${LIB_DIR}${QUIET ? '  (quiet)' : ''}\n`)
  // Exit 2 is the "cannot grade anything honestly here" contract: missing/stale
  // build output, or a host that cannot really run the commands the DoD depends on.
  if (!(await loadModules())) process.exit(2)

  try {
    for (const row of STAGES) {
      beginStage(row)
      const before = assertions
      try {
        await row.body()
      } catch (error) {
        record(false, 'the stage threw instead of asserting', 'no throw', errorText(error))
      }
      row.assertions = assertions - before
      row.ok = row.failed !== true
      if (row.ok) say(`  ok  ${row.id.padEnd(16)} ${String(row.assertions).padStart(3)} assertions\n`)
    }
  } finally {
    // Snapshot the disk facts the rollup prints *before* the temp workspace goes
    // away — otherwise the summary would report `commits: -1` and a missing record
    // and read like a claim that was never checked.
    world.finalFacts = {
      phase: await (async () => {
        try {
          return JSON.parse(await readFile(recordPath(world.factoryId), 'utf8')).phase
        } catch {
          return '<no record on disk>'
        }
      })(),
      commits: commitCount(),
      tags: tagList(),
      stageStatuses: await (async () => {
        try {
          return (await readRecord()).stages.map((row) => `${row.id}:${row.status}`);
        } catch {
          return []
        }
      })(),
    }
    const kept = []
    for (const target of world.tempRoots) {
      if (KEEP) {
        kept.push(target)
        continue
      }
      if (!(await forceRemoveTree(target))) {
        STAGES.push({ id: 'cleanup', name: 'temp workspace removal', ok: false, failed: true, assertions: 0, error: '' })
        process.stdout.write(`[FAIL] cleanup (temp workspace removal): could not remove ${target}\n`)
      }
    }
    if (kept.length > 0) say(`\n  kept: ${kept.join(', ')} (DELIVERY_DRILL_KEEP=1)\n`)
  }

  const failed = STAGES.filter((row) => row.ok !== true)
  const passed = STAGES.length - failed.length
  const delivered = world.finalFacts?.phase ?? '<not read>'

  emit('\n')
  emit(`  factory:      ${world.factoryId || '<none>'} (${world.plan?.taskType ?? '?'} · ${world.plan?.pipeline ?? '?'} · security ${world.plan?.securityTriggered === true ? 'triggered' : 'not triggered'})\n`)
  emit(`  pipeline:     ${world.gateActions.filter((row) => row.action === 'advance' || row.action === 'delivered').length}/${EXPECTED_STAGES.length} gates advanced\n`)
  emit(`  handlers run: ${handlerRuns.size} distinct (${[...handlerRuns.keys()].sort().join(', ')})\n`)
  emit(`  real commands:${String(world.realCommands.length).padStart(3)} started by the drill, ${world.gateCommands.length} more by the gates\n`)
  emit(`  commits:      ${world.finalFacts?.commits ?? -1} · tags ${JSON.stringify(world.finalFacts?.tags ?? [])}\n`)
  emit(`  bundle:       ${COMPILED.length} graded modules current${world.outrun.length > 0 ? `; ${world.outrun.length} ungraded module(s) outrun by source` : ''}\n`)
  emit(`  phase on disk: ${delivered}\n`)
  emit(`  stages on disk: ${(world.finalFacts?.stageStatuses ?? []).join(' ')}\n`)
  emit(`  assertions:   ${assertions}\n`)
  emit(`  stages:       ${passed}/${STAGES.length} passed\n`)
  if (failed.length > 0) {
    emit(`FAILURE: ${failed.length}/${STAGES.length} stages failed\n`)
    process.exit(1)
  }
  emit('  note: the recorded deliveryPath (DELIVERY.md) is a path the engine stores; nothing in the DoD\n')
  emit('        requires that file to exist, and this drill deliberately does not fabricate one.\n')
  emit(`SUCCESS: delivery drill — ${passed}/${STAGES.length} stages passed\n`)
  process.exit(0)
}

await main()
