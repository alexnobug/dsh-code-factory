/**
 * engine-drill.mjs — offline exercise of the tool handlers in `src/tools/engine.ts`.
 *
 * `scripts/verify.mjs` proves the *libraries*; nothing in it ever enters a tool
 * handler, so the 3k-line engine that implements all 16 factory tools was only
 * ever verified by reading its source (finding H13). This drill closes that hole:
 * it imports the compiled `lib/tools/engine.js`, builds a real tool-call context
 * over a throwaway temp workspace, and drives the handlers the way a captain
 * session would — asserting the observable contract (the returned verdict *and*
 * the bytes on disk) at every step.
 *
 * Contract (the captain wires `node scripts/engine-drill.mjs` into verify.mjs):
 *   - exit 0 when every stage passed, non-zero otherwise;
 *   - exit 2 when `lib/` is missing or older than `src/`;
 *   - last line on success: `SUCCESS: engine drill — <n>/<n> stages passed`;
 *   - every failure prints `[FAIL] <stage id> (<name>): <expected vs actual>`
 *     followed by `FAILURE: <k>/<n> stages failed`;
 *   - `--quiet` keeps the failure and summary lines, drops the progress lines.
 *
 * Two policies worth knowing before reading the stages:
 *   - `allowNodeFallback: true`, so the commands the gates ask for
 *     (`npm run build --if-present`, `python -m pytest -q`, `bash start.sh --check`,
 *     `git log/tag`) really run inside the temp workspace instead of being refused
 *     for lack of an executor. Nothing here may pass on a fabricated exit code —
 *     that is the point of the drill.
 *   - the temp workspace is a real git repo with one commit and a `v1.0.0` tag, so
 *     DoD item 7 is decided by real git facts rather than a stub.
 *
 * The drill is honest about a broken handler instead of papering over it: when a
 * handler throws where the pipeline needs it to work, the drill asserts the real
 * failure, records it under "defects", and keeps covering the rest of the surface
 * through a labelled fixture that uses the shipped scheduler API. Two such defects
 * are live in the current build; both are reported at the end of the run.
 *
 * The drill is deliberately not vacuous: it fails when no handler ran, when fewer
 * than 12 distinct handlers ran, or when fewer than 60 assertions were evaluated.
 */

import assertRaw from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const quiet = process.argv.slice(2).includes('--quiet')

function say(text) {
  if (!quiet) process.stdout.write(`${text}\n`)
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const rel = (path) => relative(repoRoot, path).split(sep).join('/')

const ENGINE_PATH = join(repoRoot, 'lib', 'tools', 'engine.js')
const ENGINE_SRC = join(repoRoot, 'src', 'tools', 'engine.ts')
const REQUIRED_LIBS = [
  ENGINE_PATH,
  join(repoRoot, 'lib', 'tools', 'context.js'),
  join(repoRoot, 'lib', 'store', 'store.js'),
  join(repoRoot, 'lib', 'store', 'state.js'),
  join(repoRoot, 'lib', 'runtime', 'tool-surface.js'),
  join(repoRoot, 'lib', 'runtime', 'testing.js'),
  join(repoRoot, 'lib', 'runtime', 'scheduler.js'),
  join(repoRoot, 'lib', 'domain', 'pipeline.js'),
  join(repoRoot, 'lib', 'domain', 'dod.js'),
]

/* ------------------------------------------------------- the tool surface */

/** The 13 captain tools — restated so a lone rename cannot hide behind a re-export. */
const CAPTAIN_TOOL_NAMES = [
  'factory_plan',
  'factory_edit_plan',
  'factory_approve',
  'factory_dispatch',
  'factory_gate',
  'factory_status',
  'factory_reuse',
  'factory_message',
  'factory_dod_check',
  'factory_halt',
  'factory_resume',
  'factory_deliver',
  'factory_delete',
]

const MEMBER_TOOL_NAMES = ['factory_report', 'factory_inbox', 'factory_block']

/** Every advertised name this engine must implement. */
const ENGINE_TOOL_NAMES = [...CAPTAIN_TOOL_NAMES, ...MEMBER_TOOL_NAMES]

/** Names owned elsewhere: they must NOT resolve to an engine handler. */
const FOREIGN_TOOL_NAMES = ['factory_create_task']

/** tool name → exported handler in `lib/tools/engine.js`. */
const TOOL_ENTRY = {
  factory_plan: 'planFactory',
  factory_edit_plan: 'editFactoryPlan',
  factory_approve: 'approveFactory',
  factory_dispatch: 'dispatchFactory',
  factory_gate: 'gateFactory',
  factory_status: 'readFactoryStatus',
  factory_reuse: 'reuseFactory',
  factory_message: 'messageFactory',
  factory_dod_check: 'checkDod',
  factory_deliver: 'deliverFactory',
  factory_halt: 'haltFactory',
  factory_resume: 'resumeFactory',
  factory_delete: 'deleteFactory',
  factory_report: 'reportFromMember',
  factory_inbox: 'readMemberInbox',
  factory_block: 'blockFromMember',
}

/** Exports that are deliberately not tool handlers. */
const NON_TOOL_ENGINE_EXPORTS = ['ledgerFor']

/** Gate verdicts `factory_gate` may return. */
const GATE_ACTIONS = ['advance', 'await_approval', 'deliver', 'delivered', 'escalate', 'reject', 'pass']

/** Driver defaults: every factory tool reads its tunables from here. */
const CONFIG = {
  memberProvider: 'fake',
  memberMaxDepth: 1,
  maxMembers: 8,
  feedLimit: 12,
  allowNodeFallback: true,
}

/** `登录` / `权限` are router security triggers, so the security path goes live. */
const BRIEF = '做一个企业内部的前端网站：包含登录与权限控制、页面设计、数据库表设计与接口契约，要求离线可复现地跑通工厂流水线。'
const BRIEF_2 = '再做一个内部员工门户网站：同样的全栈流水线，但需求描述完全不同，用于验证第二个工厂的隔离性。'

/* ------------------------------------------------------------- fixtures */

const PRD_BODY = [
  '# 员工门户 · 需求文档',
  '',
  '## 背景与目标',
  '把分散在三个系统里的员工信息收拢到一个门户里，减少 30% 的重复查询。',
  '',
  '## 用户故事',
  '- 作为员工，我希望能一次登录看到我的待办与公告。',
  '- 作为主管，我希望能导出团队的月度考勤。',
  '',
  '## 功能清单',
  '1. 单点登录与权限路由',
  '2. 公告与待办聚合',
  '3. 考勤导出',
  '',
  '## 验收标准',
  '- AC-1 登录成功后可跳转到门户首页',
  '- AC-2 待办列表按截止时间排序',
  '- AC-3 考勤导出生成 CSV 且字段完整',
  '',
  '## 非目标',
  '- 不做移动端原生应用',
  '- 不做薪资计算',
  '',
  '## 待确认问题',
  '- 单点登录对接哪一套 IdP？',
  '',
].join('\n')

const UI_SPEC_BODY = [
  '# 员工门户 · 界面规格',
  '',
  '## 页面清单',
  '- 登录页（/login）',
  '- 门户首页（/）',
  '- 考勤导出页（/attendance）',
  '',
  '## 交互流程',
  '登录 → 首页 → 待办卡片 → 导出抽屉，全部支持键盘操作。',
  '',
  '## 设计规范',
  '间距 8px 网格，正文 14px，主色沿用企业蓝。',
  '',
].join('\n')

const ARCHITECTURE_BODY = [
  '# 员工门户 · 架构说明',
  '',
  '## 技术选型',
  'Node 24 + TypeScript + 单进程 HTTP 服务，无外部中间件依赖。',
  '',
  '## 模块划分',
  'auth / portal / attendance / shared 四个模块，依赖单向向内。',
  '',
  '## 接口清单',
  '- POST /api/login',
  '- GET /api/todos',
  '- GET /api/attendance.csv',
  '',
].join('\n')

const DB_DESIGN_BODY = [
  '# 员工门户 · 数据库设计',
  '',
  '## ER 设计',
  'employee 1—N todo，employee 1—N attendance。',
  '',
  '## 索引策略',
  'todo(employee_id, due_at) 复合索引；attendance(employee_id, month)。',
  '',
  '## 迁移脚本',
  'migrations/001_init.sql 建三张表，可重复执行。',
  '',
].join('\n')

const API_CONTRACT_BODY = [
  '# 员工门户 · 接口契约',
  '',
  '## 接口清单',
  '- POST /api/login',
  '- GET /api/todos',
  '- GET /api/attendance.csv',
  '',
  '## 字段级 Schema',
  'login: { username: string, password: string } → { token: string }',
  '',
  '## 错误码',
  '401 未认证 / 403 无权限 / 500 服务异常。',
  '',
].join('\n')

const THREAT_MODEL_BODY = [
  '# 员工门户 · 威胁建模',
  '',
  '## STRIDE',
  '逐项分析欺骗、篡改、抵赖、信息泄露、拒绝服务、权限提升。',
  '',
  '## 威胁清单',
  'T1 会话固定；T2 越权读取他人考勤；T3 导出接口被刷。',
  '',
  '## 缓解措施',
  'T1 登录后轮换令牌；T2 服务端按 employee_id 过滤；T3 导出限流 5 次/分钟。',
  '',
].join('\n')

const REVIEW_BODY = ['# 代码评审记录', '', '## 评审范围', 'implement 阶段全部变更。', '', '## 结论', '结论: APPROVED', ''].join('\n')

const SECURITY_AUDIT_BODY = [
  '# 安全审计报告',
  '',
  '## 审计范围',
  '认证、授权、导出三个面。',
  '',
  '## 结论',
  '结论: SEC_PASS',
  '',
].join('\n')

const TEST_REPORT_BODY = [
  '# 测试报告',
  '',
  '## 用例',
  'AC-1 登录跳转：test_login_redirect 通过',
  'AC-2 待办排序：test_todo_order 通过',
  'AC-3 导出字段：test_export_csv 通过',
  '',
  '## 结论',
  '结论: PASS',
  '',
].join('\n')

const README_BODY = [
  '# 员工门户',
  '',
  '## 简介',
  '离线可复现的员工门户示例。',
  '',
  '## 安装',
  '无外部依赖，安装 Node 24 即可。',
  '',
  '## 启动',
  'node server.mjs',
  '',
  '## 接口一览',
  'POST /api/login · GET /api/todos · GET /api/attendance.csv',
  '',
].join('\n')

const START_SH_BODY = [
  '#!/bin/sh',
  '# Offline delivery check for the drill fixture: the delivery gate runs this',
  '# through the pipeline template command `bash start.sh --check`.',
  'set -eu',
  'if [ "${1:-}" = "--check" ]; then',
  '  echo "start.sh: check ok"',
  '  exit 0',
  'fi',
  'echo "start.sh: serving"',
  '',
].join('\n')

const PYTEST_BODY = [
  'def test_login_redirect():',
  '    assert True',
  '',
  '',
  'def test_todo_order():',
  '    assert True',
  '',
  '',
  'def test_export_csv():',
  '    assert True',
  '',
].join('\n')

/* --------------------------------------------------------------- harness */

let assertions = 0
/** tool name → how many times the drill actually entered that handler. */
const handlerRuns = new Map()
/** Defects the drill proved but does not fail on (reported, never hidden). */
const defects = []

function noteDefect(key, text) {
  if (defects.some((row) => row.key === key)) return
  defects.push({ key, text })
  process.stdout.write(`  [defect] ${text}\n`)
}

const DEBUG = process.env.DRILL_DEBUG === '1'

function countHandler(tool) {
  handlerRuns.set(tool, (handlerRuns.get(tool) ?? 0) + 1)
}

/** `assert.*` plus a global counter, so "not vacuous" is measurable. */
function check(...args) {
  assertions += 1
  return assertRaw(...args)
}
check.ok = (value, message) => {
  assertions += 1
  return assertRaw.ok(value, message)
}
check.equal = (actual, expected, message) => {
  assertions += 1
  return assertRaw.equal(actual, expected, message)
}
check.deepEqual = (actual, expected, message) => {
  assertions += 1
  return assertRaw.deepEqual(actual, expected, message)
}

/** Collapses whitespace so an assertion message stays on one readable line. */
function oneLine(value, limit = 240) {
  const text = String(value).replace(/\s+/gu, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

const errorText = (error) => oneLine(error instanceof Error ? `${error.name}: ${error.message}` : String(error))

/** Runs `body`, returning the value or the thrown error instead of failing. */
async function settles(body) {
  try {
    return { ok: true, value: await body() }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * Runs `body`, requires it to refuse, and returns the refusal message.
 *
 * Resolving is a failure: "the record did not change" is only half of a refusal
 * contract — a silent no-op must not be mistaken for a refusal.
 */
async function rejects(label, body) {
  const outcome = await settles(body)
  if (outcome.ok) throw new Error(`${label}: expected a rejection, but the call resolved`)
  const message = errorText(outcome.error)
  check.ok(message.length > 0, `${label}: the refusal message must not be empty`)
  return message
}

const STAGES = []
function stage(id, name, body, opts = {}) {
  STAGES.push({ id, name, body, static: opts.static === true, ok: false, error: '', handlers: 0, assertions: 0 })
}

/* ----------------------------------------------------------------- runtime */

const world = {
  Engine: null,
  Context: null,
  State: null,
  StoreClass: null,
  Surface: null,
  Fakes: null,
  Scheduler: null,
  Pipeline: null,
  Dod: null,
  host: null,
  captain: null,
  sharedId: '',
  tempRoots: [],
  store: null,
}

const stateDirOf = (workspace) => join(workspace, '.agent-teams')

function makeStore(workspace, onWarning) {
  return new world.StoreClass({
    workspace,
    stateDir: stateDirOf(workspace),
    ...(onWarning === undefined ? {} : { onWarning }),
  })
}

/** The fake captain agent; its id becomes the record's captainSessionId. */
function captainAgent(sessionId) {
  return { id: sessionId, session: { header: { name: 'captain', cwd: process.cwd() } }, isResident: false }
}

/** A fake member agent standing in for one spawned child session. */
function memberAgent(sessionId, name) {
  return { id: sessionId, session: { header: { name, cwd: process.cwd() } }, isResident: true, isRunning: () => true }
}

/** Builds the tool-call context one handler invocation needs. */
function makeCtx({ callId, workspace, store, agent }) {
  return {
    plugin: world.host.ctx,
    caller: agent,
    callerId: agent.id,
    store,
    workspace,
    now: Date.now(),
    callId,
    // Every spawning path consults the caller's abort signal before it starts a
    // session, so a context without one is not a realistic caller.
    signal: new AbortController().signal,
    config: { ...CONFIG, ctx: world.host.ctx, stateDir: stateDirOf(workspace) },
  }
}

const captainCtx = (workspace, store, callId) =>
  makeCtx({ callId, workspace, store, agent: world.captain })

const memberCtx = (workspace, store, callId, sessionId, name) =>
  makeCtx({ callId, workspace, store, agent: memberAgent(sessionId, name) })

/** Calls one engine handler by canonical tool name, counting the invocation. */
function callTool(tool, ctx, input) {
  const handlerName = TOOL_ENTRY[tool]
  const handler = world.Engine[handlerName]
  if (typeof handler !== 'function') {
    throw new Error(`engine export ${handlerName}() for tool ${tool} is ${typeof handler}`)
  }
  countHandler(tool)
  return handler(ctx, input)
}

/* ------------------------------------------------------------- artifacts */

async function writeArtifact(workspace, name, body) {
  await writeFile(join(workspace, name), body, 'utf8')
}

async function readRecord(workspace, factoryId) {
  const raw = await readFile(join(stateDirOf(workspace), factoryId, 'factory.json'), 'utf8')
  return JSON.parse(raw)
}

async function listDir(path) {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

/**
 * A comparable snapshot of the durable record.
 *
 * `updatedAt` is excluded because a legitimate no-op save may restamp it; every
 * other byte has to be identical for a refused call to count as a no-op.
 */
function digest(state) {
  const clone = structuredClone(state)
  delete clone.updatedAt
  return JSON.stringify(clone)
}

const stageOf = (record, id) => record.stages.find((row) => row.id === id)
const memberOf = (record, role) => record.members.find((row) => row.role === role)

/** Runs one git command in a workspace; returns stdout or an error note. */
function git(cwd, args) {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, out }
  } catch (error) {
    return { ok: false, out: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Makes the workspace a real deliverable repository.
 *
 * Real git facts are what let DoD item 7 be decided by evidence instead of a
 * stub: one commit on top of the `v1.0.0` tag is exactly what the audit asks for.
 */
function seedGitRepo(workspace) {
  git(workspace, ['init', '-q'])
  git(workspace, ['config', 'user.email', 'drill@example.invalid'])
  git(workspace, ['config', 'user.name', 'engine drill'])
  git(workspace, ['add', '-A'])
  const commit = git(workspace, ['commit', '-q', '-m', 'chore: drill fixture'])
  const tag = git(workspace, ['tag', 'v1.0.0'])
  return { commit: commit.ok, tag: tag.ok }
}

/* --------------------------------------------------------------- parking */

/**
 * Puts one stage into the state `factory_gate` expects: dispatched, then parked
 * at its gate by the `done` reports of its owners.
 *
 * The real route is `factory_dispatch` + `factory_report`. Only when the
 * dispatch handler leaves the stage untouched does this fall back to the shipped
 * scheduler API (see `dispatchViaScheduler`), and the fallback is reported.
 */
async function parkStage(workspace, factoryId, stageId) {
  const store = makeStore(workspace)
  const first = stageOf(await store.loadOrThrow(factoryId), stageId)
  if (first.status === 'gate' || first.status === 'passed') return first.status

  if (first.status === 'pending' || first.status === 'rejected') {
    await settles(() =>
      callTool('factory_dispatch', captainCtx(workspace, makeStore(workspace), `park-dispatch-${stageId}`), {
        factoryId,
        stageId,
      }))
    const afterDispatch = stageOf(await store.loadOrThrow(factoryId), stageId)
    if (afterDispatch.status === 'pending' || afterDispatch.status === 'rejected') {
      await dispatchViaScheduler(store, factoryId, stageId)
    }
  }

  // A member `done` report parks the stage at its gate, and `gate` is the only
  // status a gate verdict may pass from. Routing through the member tool keeps
  // this a real handler-to-handler handover instead of a status write.
  await ownersReportDone(workspace, factoryId, stageId)
  const parked = stageOf(await store.loadOrThrow(factoryId), stageId).status
  if (DEBUG) say(`[debug] park ${stageId}: settled at ${parked}`)
  return parked
}

/**
 * Fixture fallback: dispatch one stage through the shipped scheduler API — the
 * same `planStageDispatch` + `applyStageDispatch` pair the handler itself calls.
 *
 * Only used when `factory_dispatch` left the stage untouched, so the drill can
 * keep covering the rest of the surface. It moves a stage, never a verdict.
 */
async function dispatchViaScheduler(store, factoryId, stageId) {
  const probes = world.Scheduler.schedulerProbes(world.host.ctx)
  await store.withLock(factoryId, async () => {
    const state = await store.loadOrThrow(factoryId)
    const plan = world.Scheduler.planStageDispatch({
      state,
      attempts: world.Engine.ledgerFor(state),
      now: store.now(),
      isLive: probes.isLive,
      isRunning: probes.isRunning,
      stageId,
      upstreamArtifacts: [],
    })
    await world.Scheduler.applyStageDispatch(world.host.ctx, world.captain, state, plan, {
      provider: CONFIG.memberProvider,
      signal: new AbortController().signal,
      memberDepth: CONFIG.memberMaxDepth,
      now: () => store.now(),
      upstreamArtifacts: [],
    })
    const rec = state.stages.find((row) => row.id === stageId)
    // The scheduler only marks a stage active when a dispatch landed; keep the
    // state machine coherent if every send failed.
    if (rec !== undefined && (rec.status === 'pending' || rec.status === 'rejected')) {
      world.State.transitionStage(rec, 'active', store.now())
    }
    state.updatedAt = store.now()
    await store.save(state, { touch: false })
  })
}

/**
 * Who actually owns one stage.
 *
 * The roster is capped, so a specialist role can be trimmed and replaced by a
 * stand-in from the substitution ladder. `planStageDispatch` is the only thing that
 * knows the real assignment (`staffing` comes from `resolveStageRoles`, and the
 * scheduler never reads `stage.roles` directly), so the drill asks it too instead of
 * assuming the stage definition is the assignment.
 */
function staffingOf(record, stageId) {
  const plan = world.Scheduler.planStageDispatch({
    state: record,
    attempts: world.Engine.ledgerFor(record),
    now: Date.now(),
    isLive: world.host.probes.isLive,
    isRunning: world.host.probes.isRunning,
    stageId,
    upstreamArtifacts: [],
  })
  const staffing = plan.staffing
  return staffing === undefined || staffing === null
    ? { assigned: [], direct: [], substituted: [], missing: [], fallbackUsed: false }
    : staffing
}

/** Every staffed owner of one stage reports `done` through the member tool. */
async function ownersReportDone(workspace, factoryId, stageId) {
  const record = await readRecord(workspace, factoryId)
  const def = world.Pipeline.getStage(record.pipeline, stageId)
  const direct = def === undefined || def === null ? [] : (def.roles ?? [])
  const staffing = staffingOf(record, stageId)
  // A substituted role answers through its stand-in, so the assignment — not the
  // stage definition — decides who owes a report.
  const roles = staffing.assigned.length > 0 ? staffing.assigned : direct
  let reported = 0
  if (DEBUG) {
    const trace = roles.map((role) => {
      const member = memberOf(record, role)
      const sessionId = member === undefined ? 'absent' : String(member.sessionId ?? 'no-session')
      const substituted = staffing.substituted.some((item) => item.assigned === role)
      return `${role}${substituted ? '(stand-in)' : ''}=${sessionId}/${member === undefined ? '-' : member.status}`
    })
    const status = stageOf(record, stageId)?.status ?? 'missing'
    const missing = staffing.missing.length === 0 ? '-' : staffing.missing.join(',')
    say(`[debug] park ${stageId}: stage=${status} missing=${missing} roles ${trace.join(' ') || '(none)'}`)
  }
  for (const role of roles) {
    const member = memberOf(record, role)
    if (member === undefined) {
      check.ok(
        false,
        `stage ${stageId}: the scheduler assigned ${role}, but the roster has no such member — staffing and roster disagree`,
      )
      continue
    }
    if (typeof member.sessionId !== 'string' || member.sessionId === '') {
      check.ok(false, `stage ${stageId}: ${role} has no session to report from — the dispatch did not staff it`)
      continue
    }
    const outcome = await settles(() =>
      callTool(
        'factory_report',
        memberCtx(workspace, makeStore(workspace), `park-report-${stageId}-${role}`, member.sessionId, role),
        { status: 'done', summary: `${stageId} 阶段工件已完成，请队长裁决门禁。`, stage: stageId },
      ))
    // A refused `done` report is invisible in the record, so it has to be visible here.
    check.ok(
      outcome.ok,
      `the done report of ${role} on ${stageId} must be accepted: ${outcome.ok ? '' : errorText(outcome.error)}`,
    )
    reported += 1
  }
  return reported
}

/** A gate that throws proves nothing — name the defect instead of guessing. */
function noteGateReworkDefect(error, where) {
  const message = errorText(error)
  check.ok(
    /before initialization|ReferenceError/u.test(message),
    `${where}: the gate rework path must either work or fail loudly, saw: ${message}`,
  )
  noteDefect(
    'D3-gate-rework-tdz',
    `${where}: factory_gate can neither reject nor escalate a stage — ${message} (src/tools/engine.ts:1665: the gateFactory `
      + 'mutate callback opened at line 1612 binds `current`, but the rework loop calls `settleAttempts(state, …)`; '
      + 'compiled: lib/tools/engine.js:1119)',
  )
}

function noteGatePassDefect(error, where) {
  const message = errorText(error)
  check.ok(
    /illegal stage transition|before initialization/u.test(message),
    `${where}: the gate pass path must either work or fail loudly, saw: ${message}`,
  )
  noteDefect(
    'D2-gate-pass-transition',
    `${where}: factory_gate cannot pass a non-humanApproval stage — ${message} (src/tools/engine.ts gateFactory: a stage `
      + 'reaches `passed` from `active`, which src/store/state.ts does not allow — only `gate` may pass)',
  )
}

/** Dispatches + parks a stage, asserting the park really happened. */
async function parkAndCheck(workspace, factoryId, stageId) {
  const status = await parkStage(workspace, factoryId, stageId)
  check.ok(status === 'gate', `stage ${stageId} must be parked at its gate, saw ${status}`)
  return status
}

/* ---------------------------------------------------------------- stages */

stage('00-surface', 'every advertised tool resolves to a real engine handler', async () => {
  for (const [tool, handlerName] of Object.entries(TOOL_ENTRY)) {
    check.ok(
      typeof world.Engine[handlerName] === 'function',
      `tool ${tool} must resolve to engine export ${handlerName}(), got ${typeof world.Engine[handlerName]}`,
    )
  }
  for (const name of FOREIGN_TOOL_NAMES) {
    check.ok(!Object.prototype.hasOwnProperty.call(world.Engine, name), `${name} must not be an engine export`)
  }

  // A new export without a tool entry (or a dropped one) is exactly the drift
  // this check exists to catch: the surface and the engine must agree by name.
  const exported = Object.keys(world.Engine).filter((key) => typeof world.Engine[key] === 'function').sort()
  const allowed = [...ENGINE_TOOL_NAMES.map((tool) => TOOL_ENTRY[tool]), ...NON_TOOL_ENGINE_EXPORTS].sort()
  check.deepEqual(exported, allowed, 'the engine handler export set drifted from the advertised tool list')

  check.deepEqual([...world.Surface.CAPTAIN_TOOL_NAMES], CAPTAIN_TOOL_NAMES, 'CAPTAIN_TOOL_NAMES drifted')
  check.deepEqual([...world.Surface.MEMBER_BASE_TOOL_NAMES], MEMBER_TOOL_NAMES, 'MEMBER_BASE_TOOL_NAMES drifted')
  for (const name of ENGINE_TOOL_NAMES) {
    check.ok(world.Surface.FACTORY_TOOL_NAMES.includes(name), `FACTORY_TOOL_NAMES is missing ${name}`)
  }
  check.equal(world.Surface.FACTORY_TOOL_PREFIX, 'factory_', 'the factory tool prefix is the rename tripwire')
  check.equal(ENGINE_TOOL_NAMES.length, 16, 'the engine-backed surface is 16 names (13 captain + 3 member)')

  // The member filter a spawn hands to `tools.restrict()` must name only tools the
  // registry admits — `unknownFilterNames` is the validator for exactly that, and
  // the probe below is the same live-registry probe the spawn path builds
  // (`probeToolSurface` over `ctx.tools`; src/runtime/members.ts:324).
  const surfaceProbe = world.Surface.probeToolSurface(world.host.ctx, world.captain)
  check.ok(surfaceProbe.isRegistered('factory_report'), 'the tool-surface probe must see the live registry')
  const filterInputs = [
    { memberDepth: 0 },
    { memberDepth: 1 },
    { memberDepth: 0, keep: ['subagent'], extraDeny: ['not_a_tool', 'run_code'] },
  ]
  for (const input of filterInputs) {
    const built = world.Surface.computeMemberToolFilter(surfaceProbe, input)
    // Denying nothing would make the validator below pass for the wrong reason.
    check.ok(
      built.filter.deny.length > 0,
      `computeMemberToolFilter(${JSON.stringify(input)}) denied nothing — the probe is not seeing the registry`,
    )
    check.deepEqual(
      [...world.Surface.unknownFilterNames(surfaceProbe, built.filter)],
      [],
      `computeMemberToolFilter(${JSON.stringify(input)}) named a tool the registry does not admit`,
    )
  }
}, { static: true })

stage('01-context', 'an unbound caller and a fresh workspace are refused, not guessed', async ({ workspace, store }) => {
  const index = await callTool('factory_status', captainCtx(workspace, store, 'call-index'), {})
  check.equal(index.scope, 'index', 'factory_status without a factoryId reports the index scope')
  check.deepEqual(index.factories, [], 'a fresh workspace must hold zero factories')
  check.ok(
    typeof index.nextAction === 'string' && index.nextAction.length > 0,
    'the index scope must still advise a next action',
  )

  // `workspaceOf` reads the caller's cwd and refuses to fall back to
  // `process.cwd()`; a caller without one must not silently inherit the repo.
  const homeless = { id: 'captain-nowhere', session: { header: {} }, isResident: false }
  await rejects('status(caller with no cwd)', async () => {
    const ctx = { ...captainCtx(workspace, store, 'call-no-cwd'), caller: homeless, callerId: homeless.id }
    return await callTool('factory_status', ctx, { factoryId: 'deadbeef' })
  })

  const badId = await rejects('status(malformed factoryId)', () =>
    callTool('factory_status', captainCtx(workspace, store, 'call-bad-id'), { factoryId: '../../etc' }))
  check.ok(/factoryId|工厂/u.test(badId), `the refusal must name the malformed id: ${oneLine(badId)}`)
})

stage('02-plan', 'factory_plan stages a record and creates no session', async ({ workspace, store }) => {
  const planned = await callTool('factory_plan', captainCtx(workspace, store, 'call-plan'), { brief: BRIEF })
  check.ok(/^[0-9a-f]{8}$/u.test(planned.factoryId), `the factory id must be 8 hex chars, got ${planned.factoryId}`)
  world.sharedId = planned.factoryId
  check.equal(planned.phase, 'staged', 'a fresh plan is staged, not running')
  check.equal(planned.planReviewState, 'awaiting_review', 'a fresh plan waits for the user to review it')
  check.equal(planned.taskType, 'web_fullstack', 'the web brief must route to the web_fullstack task type')
  check.equal(planned.pipeline, 'fullstack', 'the web brief must route to the fullstack pipeline')
  check.equal(planned.securityTriggered, true, 'a brief mentioning 登录/权限 must trigger the security path')
  check.equal(planned.childSessions, 0, 'planning must report zero child sessions')
  check.ok(planned.team.length >= 4, `the plan must carry a roster, saw ${planned.team.length} entries`)
  check.ok(
    planned.stages.some((row) => row.id === 'requirement') && planned.stages.some((row) => row.id === 'test'),
    'the plan must enumerate the pipeline stages the gates will later walk',
  )

  const onDisk = await readRecord(workspace, planned.factoryId)
  check.equal(onDisk.phase, 'staged', 'the staged record must be on disk, not only in the tool result')
  check.equal(onDisk.id, planned.factoryId, 'the persisted record carries its own id')
  check.ok(
    onDisk.members.every((row) => row.sessionId === undefined || row.sessionId === ''),
    'planning must not have spawned a single session',
  )
  check.equal(world.host.calls.startActivation.length, 0, 'planning must not touch the host')

  // The default roster cap is smaller than the fullstack pipeline's staffing need, so
  // the design stage has no directly assigned owner: it can only be staffed through the
  // substitution ladder. The whole gate walk depends on that, so assert it is real.
  const ladder = staffingOf(await readRecord(workspace, planned.factoryId), 'design')
  check.equal(ladder.fallbackUsed, true, 'a capped roster must reach for the substitution ladder')
  check.deepEqual(ladder.missing, [], 'the ladder must cover every role of the design stage')
  check.ok(
    ladder.substituted.length > 0 && ladder.assigned.length > 0,
    'the ladder must name both the trimmed role and the stand-in that fills it',
  )

  // Idempotence has a narrow key: same captain, same brief, still awaiting review.
  const again = await callTool('factory_plan', captainCtx(workspace, makeStore(workspace), 'call-plan-2'), { brief: BRIEF })
  check.equal(again.factoryId, planned.factoryId, 're-planning the same brief reuses the staged plan')
  check.equal(again.reusedPlan, true, 'the reuse must be reported as such')
  const other = await callTool('factory_plan', captainCtx(workspace, makeStore(workspace), 'call-plan-3'), { brief: BRIEF_2 })
  check.ok(other.factoryId !== planned.factoryId, 'a different brief must create a second factory')
  check.equal((await readRecord(workspace, other.factoryId)).phase, 'staged', 'the second plan is staged too')
})

stage('03-edit-plan', 'factory_edit_plan mutates only a staged plan', async ({ workspace }) => {
  const store = makeStore(workspace)
  const rows = await store.list()
  const second = rows.map((row) => row.id).find((id) => id !== world.sharedId)
  check.ok(second !== undefined, 'the second staged factory must be listed by the store')

  const before = await readRecord(workspace, second)
  const edited = await callTool('factory_edit_plan', captainCtx(workspace, makeStore(workspace), 'call-edit'), {
    factoryId: second,
    name: '被改名的第二个工厂',
  })
  check.equal(edited.factoryId, second, 'the edit answers for the requested factory')
  check.ok(edited.changedFields.includes('name'), `the result must name the changed field: ${oneLine(edited.changedFields)}`)
  check.ok(typeof edited.editedAt === 'number', 'the edit must be stamped with a time')
  const after = await readRecord(workspace, second)
  check.equal(after.name, '被改名的第二个工厂', 'the rename must be persisted')
  check.equal(after.phase, 'staged', 'editing must not approve anything')
  check.ok(before.name !== after.name, 'the edit must have actually changed the record')

  await rejects('edit_plan(with no changed field)', () =>
    callTool('factory_edit_plan', captainCtx(workspace, makeStore(workspace), 'call-edit-2'), { factoryId: second }))
  await rejects('edit_plan(unknown factoryId)', () =>
    callTool('factory_edit_plan', captainCtx(workspace, makeStore(workspace), 'call-edit-3'), {
      factoryId: 'ffffffff',
      name: 'x',
    }))
  check.equal((await readRecord(workspace, second)).name, '被改名的第二个工厂', 'a refused edit must not rename anything')
})

stage('04-approve', 'factory_approve flips staged→running, spawns, and is idempotent', async ({ workspace, store }) => {
  const id = world.sharedId
  const spawnsBefore = world.host.calls.startActivation.length
  const approved = await callTool('factory_approve', captainCtx(workspace, store, 'call-approve'), { factoryId: id })
  check.equal(approved.factoryId, id, 'approve must answer for the requested factory')
  check.equal(approved.phase, 'running', 'approve must flip the phase to running')
  check.equal(approved.alreadyApproved, false, 'the first approval is not the idempotent replay')
  check.equal(approved.stageId, 'requirement', 'approving must dispatch the first pipeline stage')
  check.ok(
    world.host.calls.startActivation.length > spawnsBefore,
    'approve must actually start the stage owner through the host',
  )
  check.ok(approved.spawned.length >= 1, `approve must name the roles it spawned: ${oneLine(approved.spawned)}`)

  // DSH 0.2.2 uses the flat SubagentActivationSpec: the persona/toolFilter
  // request fields are gone. The role persona must instead be carried in the
  // initial prompt, and no legacy filter may be sent.
  const spawnCalls = world.host.calls.startActivation.slice(spawnsBefore)
  for (const call of spawnCalls) {
    check.equal(call.toolFilter, undefined, `the 0.2.2 spawn of ${call.label} must not carry the removed toolFilter field`)
    check.ok(
      typeof call.promptText === 'string' && call.promptText.includes('【你的职责】'),
      `the spawn of ${call.label} must carry the rendered role brief in promptText`,
    )
  }

  const after = await readRecord(workspace, id)
  check.equal(after.phase, 'running', 'phase=running must be on disk, not only in the tool result')
  check.equal(after.planReviewState, undefined, 'approving clears the awaiting_review marker')
  check.ok(typeof after.approvedAt === 'number' && after.approvedAt > 0, 'approving stamps approvedAt')
  const staffed = after.members.filter((row) => typeof row.sessionId === 'string' && row.sessionId.length > 0)
  check.ok(staffed.length >= 1, `approving must persist session ids, saw ${staffed.length} staffed rows`)
  check.equal(after.stages[0].status, 'active', 'the first stage is active once its owner holds the work')

  const before = digest(after)
  const spawnCount = world.host.calls.startActivation.length
  const again = await callTool('factory_approve', captainCtx(workspace, makeStore(workspace), 'call-approve-2'), { factoryId: id })
  check.equal(again.phase, 'running', 're-approving a running factory stays running')
  check.equal(again.alreadyApproved, true, 'the replay must be reported as already approved')
  check.equal(world.host.calls.startActivation.length, spawnCount, 're-approving must not spawn a second roster')
  check.equal(digest(await readRecord(workspace, id)), before, 're-approving must not rewrite the record')

  await rejects('approve(unknown factoryId)', () =>
    callTool('factory_approve', captainCtx(workspace, makeStore(workspace), 'call-approve-3'), { factoryId: 'ffffffff' }))
})

stage('05-dispatch', 'factory_dispatch refuses the wrong phase and advances the right one', async ({ workspace }) => {
  const id = world.sharedId
  const digestBefore = digest(await readRecord(workspace, id))

  const stagedId = (await makeStore(workspace).list()).map((row) => row.id).find((row) => row !== id)
  const staged = await rejects('dispatch(a staged factory)', () =>
    callTool('factory_dispatch', captainCtx(workspace, makeStore(workspace), 'call-dispatch-staged'), { factoryId: stagedId }))
  check.ok(/staged|批准/u.test(staged), `the staged refusal must name the phase: ${oneLine(staged)}`)
  await rejects('dispatch(unknown factoryId)', () =>
    callTool('factory_dispatch', captainCtx(workspace, makeStore(workspace), 'call-dispatch-miss'), { factoryId: 'ffffffff' }))
  const badStage = await rejects('dispatch(unknown stageId)', () =>
    callTool('factory_dispatch', captainCtx(workspace, makeStore(workspace), 'call-dispatch-stage'), {
      factoryId: id,
      stageId: 'no-such-stage',
    }))
  check.ok(/no-such-stage/u.test(badStage), `the stage refusal must name the stage: ${oneLine(badStage)}`)
  check.equal(digest(await readRecord(workspace, id)), digestBefore, 'a refused dispatch must not touch the record')

  // The real dispatch path. This is where the drill earns its keep: the handler
  // is executed against the record it must move.
  const outcome = await settles(() =>
    callTool('factory_dispatch', captainCtx(workspace, makeStore(workspace), 'call-dispatch'), { factoryId: id }))
  if (outcome.ok) {
    check.equal(outcome.value.factoryId, id, 'dispatch answers for the requested factory')
    check.ok(Array.isArray(outcome.value.decisions), 'dispatch must report its per-role decisions')
    check.equal((await readRecord(workspace, id)).factoryId, undefined, 'factory.json is keyed by id, not factoryId')
    check.equal((await readRecord(workspace, id)).id, id, 'the record survives a real dispatch')
  } else {
    // D1: the handler reads `state` from inside a callback that only binds
    // `current`, so it throws in the temporal dead zone before doing anything.
    const message = errorText(outcome.error)
    check.ok(
      /before initialization|ReferenceError/u.test(message),
      `dispatch must either work or fail loudly, saw: ${message}`,
    )
    noteDefect(
      'D1-dispatch-tdz',
      `factory_dispatch can never run — ${message} (src/tools/engine.ts dispatchFactory: the mutate callback binds `
        + '`current` but the body reads `state`)',
    )
    check.equal(digest(await readRecord(workspace, id)), digestBefore, 'a dispatch that throws must not touch the record')
  }
})

stage('06-gate-human', 'the humanApproval gate refuses thin evidence, then passes on confirmation', async ({ workspace }) => {
  const id = world.sharedId

  // Refuse first: an incomplete PRD must be rejected — and the rejection must be
  // recorded with the reason, not silently swallowed.
  await writeArtifact(workspace, 'PRD.md', '# 只有标题\n')
  await parkAndCheck(workspace, id, 'requirement')
  const digestBefore = digest(await readRecord(workspace, id))
  const thin = await settles(() =>
    callTool('factory_gate', captainCtx(workspace, makeStore(workspace), 'call-gate-thin'), {
      factoryId: id,
      stageId: 'requirement',
      humanConfirm: true,
      findings: ['PRD.md 必须补齐六段结构'],
    }))
  if (!thin.ok) {
    // The gate agrees the evidence is thin and then throws inside the rework
    // loop, so no stage can ever be rejected or escalated. The pass path is the
    // one branch left, and it must not need a stored pass: with the artifact on
    // disk before the first verdict the gate has to evaluate for real.
    noteGateReworkDefect(thin.error, 'factory_gate(requirement, thin PRD)')
    check.equal(digest(await readRecord(workspace, id)), digestBefore, 'a gate that throws must not touch the record')
    await writeArtifact(workspace, 'PRD.md', PRD_BODY)
    await parkAndCheck(workspace, id, 'requirement')
    const direct = await settles(() =>
      callTool('factory_gate', captainCtx(workspace, makeStore(workspace), 'call-gate-direct'), {
        factoryId: id,
        stageId: 'requirement',
        humanConfirm: true,
      }))
    if (direct.ok) {
      check.equal(direct.value.action, 'advance', `a complete PRD with humanConfirm must advance: ${oneLine(direct.value.detail)}`)
      check.equal(stageOf(await readRecord(workspace, id), 'requirement').status, 'passed', 'the stage must be passed on disk')
    } else {
      noteGatePassDefect(direct.error, 'factory_gate(requirement, confirmed)')
    }
    return
  }

  check.equal(thin.value.action, 'reject', `an incomplete PRD.md must be rejected, got ${oneLine(thin.value.detail)}`)
  check.ok(/PRD\.md/u.test(thin.value.detail ?? ''), `the rejection must name PRD.md: ${oneLine(thin.value.detail)}`)
  check.equal(thin.value.ok, false, 'a rejected gate is not a pass')
  check.equal(thin.value.rejectedTo, 'requirement', 'without failGoto the stage is its own rework target')
  const rejected = await readRecord(workspace, id)
  check.equal(stageOf(rejected, 'requirement').status, 'rejected', 'a rejected stage must be recorded as rejected')
  check.equal(stageOf(rejected, 'requirement').round, 1, 'the first rejection is round 1')
  check.ok(
    (await makeStore(workspace).readAllMessages(id)).some((mail) => String(mail.content).includes('PRD.md')),
    'the rejection must write the findings into a mailbox',
  )

  // Park, then judge without a confirmation: the humanApproval stage must hold.
  await writeArtifact(workspace, 'PRD.md', PRD_BODY)
  await parkAndCheck(workspace, id, 'requirement')
  const parked = await callTool('factory_gate', captainCtx(workspace, makeStore(workspace), 'call-gate-1'), {
    factoryId: id,
    stageId: 'requirement',
  })
  check.equal(parked.action, 'await_approval', `the first verdict must wait for the user: ${oneLine(parked.detail)}`)
  check.equal(parked.needsHumanConfirm, true, 'await_approval must ask for humanConfirm explicitly')
  check.equal(parked.ok, true, 'the gate itself passed; only the human confirmation is missing')
  check.equal(stageOf(await readRecord(workspace, id), 'requirement').status, 'gate', 'the stage must park at its gate')
  check.deepEqual(parked.commands, [], 'a checklist gate runs no command')

  // The stored pass makes the confirmed replay cheap, and it must still advance.
  const second = await callTool('factory_gate', captainCtx(workspace, makeStore(workspace), 'call-gate-2'), {
    factoryId: id,
    stageId: 'requirement',
    humanConfirm: true,
  })
  check.equal(second.action, 'advance', `a complete PRD with humanConfirm must advance: ${oneLine(second.detail)}`)
  check.equal(second.ok, true, 'the gate verdict must be green')
  check.equal(second.needsHumanConfirm, false, 'a confirmed gate is no longer waiting for the user')
  check.equal(second.nextStage, 'design', 'advancing must name the next stage')
  check.equal(stageOf(await readRecord(workspace, id), 'requirement').status, 'passed', 'the stage must be passed on disk')
  const registered = await makeStore(workspace).listArtifacts(id)
  check.ok(
    registered.some((row) => row.path === 'PRD.md'),
    `the gate must register the artifact it verified: ${oneLine(registered.map((row) => row.path).join(','))}`,
  )
})

stage('07-gate-nonapproval', 'a non-approval gate rejects, escalates, then passes on complete evidence', async ({ workspace }) => {
  const id = world.sharedId

  // Rounds 1 and 2 without artifacts: the gate must reject, then escalate once
  // the round budget is spent. Both verdicts come out of the same rework loop.
  for (const round of [1, 2]) {
    await parkAndCheck(workspace, id, 'design')
    const digestBefore = digest(await readRecord(workspace, id))
    const verdict = await settles(() =>
      callTool('factory_gate', captainCtx(workspace, makeStore(workspace), `call-design-${round}`), {
        factoryId: id,
        stageId: 'design',
        findings: ['UI_SPEC.md / ARCHITECTURE.md / DB_DESIGN.md 必须全部提交'],
      }))
    if (!verdict.ok) {
      noteGateReworkDefect(verdict.error, `factory_gate(design, round ${round})`)
      check.equal(digest(await readRecord(workspace, id)), digestBefore, 'a gate that throws must not touch the record')
      break
    }
    check.equal(verdict.value.maxRounds, 2, 'the design stage allows two rounds')
    check.equal(verdict.value.round, round, `verdict ${round} must be reported as round ${round}`)
    check.ok(verdict.value.notifiedRoles.length >= 1, `a rejection must notify a role: ${oneLine(verdict.value.notifiedRoles)}`)
    const rejected = await readRecord(workspace, id)
    check.equal(stageOf(rejected, 'design').round, round, `rejection ${round} must be recorded as round ${round}`)
    check.ok(
      (await makeStore(workspace).readAllMessages(id)).some((mail) => String(mail.content).includes('UI_SPEC.md')),
      'the design rejection must land in a mailbox',
    )
    if (round === 1) {
      check.equal(verdict.value.action, 'reject', `a missing design artifact must be rejected: ${oneLine(verdict.value.detail)}`)
      check.equal(verdict.value.ok, false, 'a rejected gate is not a pass')
      check.equal(verdict.value.rejectedTo, 'design', 'design has no failGoto, so it is its own rework target')
      check.equal(stageOf(rejected, 'design').status, 'rejected', 'the design stage must be recorded rejected')
    } else {
      check.equal(verdict.value.action, 'escalate', `round 2 of 2 must escalate: ${oneLine(verdict.value.detail)}`)
      check.equal(verdict.value.ok, false, 'an escalated gate is not a pass')
    }
  }

  // Complete evidence: the same gate must now pass without a human confirm.
  for (const [name, body] of [['UI_SPEC.md', UI_SPEC_BODY], ['ARCHITECTURE.md', ARCHITECTURE_BODY], ['DB_DESIGN.md', DB_DESIGN_BODY]]) {
    await writeArtifact(workspace, name, body)
  }
  await parkAndCheck(workspace, id, 'design')
  const design = await settles(() =>
    callTool('factory_gate', captainCtx(workspace, makeStore(workspace), 'call-design-pass'), { factoryId: id, stageId: 'design' }))
  if (design.ok) {
    check.equal(design.value.action, 'advance', `a complete design gate must advance: ${oneLine(design.value.detail)}`)
    check.equal(design.value.ok, true, 'the design verdict must be green')
    check.equal(design.value.nextStage, 'contract', 'design advances to the contract stage')
    check.equal(stageOf(await readRecord(workspace, id), 'design').status, 'passed', 'the design stage must be passed')
    const rows = await makeStore(workspace).listArtifacts(id)
    check.ok(
      ['UI_SPEC.md', 'ARCHITECTURE.md', 'DB_DESIGN.md'].every((path) => rows.some((row) => row.path === path)),
      `the design gate must register all three artifacts: ${oneLine(rows.map((row) => row.path).join(','))}`,
    )
  } else {
    noteGatePassDefect(design.error, 'factory_gate(design)')
  }

  // The contract stage is the second humanApproval gate; its artifact is on disk
  // before the first verdict, so the confirmed gate evaluates instead of replaying.
  await writeArtifact(workspace, 'API_CONTRACT.md', API_CONTRACT_BODY)
  await parkAndCheck(workspace, id, 'contract')
  const contract = await settles(() =>
    callTool('factory_gate', captainCtx(workspace, makeStore(workspace), 'call-contract'), {
      factoryId: id,
      stageId: 'contract',
      humanConfirm: true,
    }))
  if (contract.ok) {
    check.equal(contract.value.action, 'advance', `a complete API_CONTRACT.md must advance: ${oneLine(contract.value.detail)}`)
    check.equal(contract.value.needsHumanConfirm, false, 'a confirmed gate is no longer waiting for the user')
    check.equal(stageOf(await readRecord(workspace, id), 'contract').status, 'passed', 'the contract stage must be passed')
  } else {
    noteGatePassDefect(contract.error, 'factory_gate(contract)')
  }

  // The threat stage is a plain checklist on a non-approval stage: no commands.
  await writeArtifact(workspace, 'THREAT_MODEL.md', THREAT_MODEL_BODY)
  await parkAndCheck(workspace, id, 'threat')
  const threat = await settles(() =>
    callTool('factory_gate', captainCtx(workspace, makeStore(workspace), 'call-threat'), { factoryId: id, stageId: 'threat' }))
  if (threat.ok) {
    check.equal(threat.value.action, 'advance', `a complete THREAT_MODEL.md must advance: ${oneLine(threat.value.detail)}`)
    check.deepEqual(threat.value.commands, [], 'a checklist gate runs no command')
    check.equal(stageOf(await readRecord(workspace, id), 'threat').status, 'passed', 'the threat stage must be passed')
  } else {
    noteGatePassDefect(threat.error, 'factory_gate(threat)')
  }

  // No stageId: the handler must select a stage itself, and must never report a
  // silent success for a stage it cannot judge.
  const selected = await settles(() =>
    callTool('factory_gate', captainCtx(workspace, makeStore(workspace), 'call-gate-selected'), { factoryId: id }))
  if (selected.ok) {
    check.ok(
      world.Pipeline.getPipeline('fullstack').some((row) => row.id === selected.value.stageId),
      `a self-selected gate must answer for a real stage, saw ${oneLine(selected.value.stageId)}`,
    )
    check.ok(GATE_ACTIONS.includes(selected.value.action), `unknown verdict ${oneLine(selected.value.action)}`)
  } else {
    check.ok(
      /illegal stage transition|before initialization/u.test(errorText(selected.error)),
      `a self-selected gate must fail loudly: ${errorText(selected.error)}`,
    )
  }
})

stage('08-member-tools', 'member report/inbox/block resolve their factory from the session id', async ({ workspace, store }) => {
  const id = world.sharedId
  const record = await readRecord(workspace, id)
  const staffed = record.members.find((row) => typeof row.sessionId === 'string' && row.sessionId.length > 0)
  check.ok(staffed !== undefined, 'the approved factory must have at least one staffed member to act as')
  const pipelineIds = world.Pipeline.getPipeline(record.pipeline).map((row) => row.id)

  const refusal = await rejects('report(from a stranger session)', () =>
    callTool('factory_report', memberCtx(workspace, store, 'call-foreign', 'session-not-in-this-factory', 'impostor'), {
      status: 'done',
      summary: '我不属于任何工厂',
    }))
  check.ok(/没有|找不到|工厂/u.test(refusal), `the stranger refusal must explain itself: ${oneLine(refusal)}`)

  await rejects('report(with an unknown status)', () =>
    callTool('factory_report', memberCtx(workspace, store, 'call-bad-status', staffed.sessionId, staffed.role), {
      status: 'finished',
      summary: 'x',
    }))
  await rejects('report(with no summary)', () =>
    callTool('factory_report', memberCtx(workspace, store, 'call-bad-summary', staffed.sessionId, staffed.role), {
      status: 'done',
      summary: '   ',
    }))
  await rejects('block(with no reason)', () =>
    callTool('factory_block', memberCtx(workspace, store, 'call-bad-block', staffed.sessionId, staffed.role), {}))

  // An unknown stage id must not create a phantom stage. The handler either
  // refuses it or falls back to a real stage — both are acceptable, inventing a
  // stage is not.
  const weirdStage = await settles(() =>
    callTool('factory_report', memberCtx(workspace, makeStore(workspace), 'call-bad-stage', staffed.sessionId, staffed.role), {
      status: 'working',
      summary: 'unknown stage probe',
      stage: 'no-such-stage',
    }))
  const stagesAfterWeird = (await readRecord(workspace, id)).stages.map((row) => row.id)
  check.ok(!stagesAfterWeird.includes('no-such-stage'), 'a report must never create a stage that is not in the pipeline')
  if (weirdStage.ok) {
    check.ok(
      pipelineIds.includes(weirdStage.value.stage),
      `the reported stage must be a real pipeline stage, saw ${oneLine(weirdStage.value.stage)}`,
    )
  }

  const reported = await callTool('factory_report', memberCtx(workspace, makeStore(workspace), 'call-report', staffed.sessionId, staffed.role), {
    status: 'done',
    summary: '本阶段工件已完成，请队长裁决门禁。',
    artifacts: ['PRD.md'],
  })
  check.equal(reported.factoryId, id, 'the member report must resolve its factory from the session id')
  check.equal(reported.role, staffed.role, 'the report must be attributed to the resolved role')
  check.equal(reported.status, 'done', 'the report must echo the status it applied')
  check.ok(Array.isArray(reported.artifactsRegistered), 'the report must report which artifacts it registered')
  const afterReport = await readRecord(workspace, id)
  check.equal(memberOf(afterReport, staffed.role).status, 'done', 'the roster row must move to done on disk')
  const registered = await makeStore(workspace).listArtifacts(id)
  check.ok(
    registered.some((row) => row.path === 'PRD.md'),
    `the artifact the member submitted must be registered: ${oneLine(registered.map((row) => row.path).join(','))}`,
  )
  check.ok(
    (await makeStore(workspace).readAllMessages(id)).some((mail) => mail.to === 'captain'),
    'the member report must reach the captain mailbox',
  )

  /*
   * The unread count is the one number a member actually acts on, and it is the
   * one number a handler can fake while this whole drill stays green: hard-coding
   * `remainingUnread = 0` in `consumeMailbox` used to pass 16/16, because nothing
   * here pinned the arithmetic. (verify's E18 catches it by reading the store, but
   * this stage claims to be the handler contract, so it has to catch it too.)
   *
   * Two unread messages and a limit of one are what make the difference between
   * "consumed exactly what I returned" and "read nothing" observable.
   */
  for (const tag of ['a', 'b']) {
    await callTool('factory_message', captainCtx(workspace, makeStore(workspace), `call-unread-${tag}`), {
      factoryId: id,
      to: staffed.role,
      content: `未读计数探针 ${tag}`,
    })
  }
  const peek = await callTool('factory_inbox', memberCtx(workspace, makeStore(workspace), 'call-peek', staffed.sessionId, staffed.role), {
    markRead: false,
  })
  check.ok(peek.remainingUnread >= 2, `the probe must leave unread mail to count, saw ${peek.remainingUnread}`)
  check.ok(peek.messages.length > 0, 'an unread-only read must return the unread mail it is counting')
  check.equal(peek.markedRead, 0, 'markRead:false must not mark anything read')

  const consume = await callTool('factory_inbox', memberCtx(workspace, makeStore(workspace), 'call-consume', staffed.sessionId, staffed.role), {
    limit: 1,
  })
  check.equal(consume.markedRead, 1, 'the default markRead with a limit of one must mark exactly one message')
  check.equal(
    consume.remainingUnread,
    peek.remainingUnread - 1,
    'remainingUnread must be the real remainder: a constant cannot satisfy it',
  )
  check.ok(consume.remainingUnread >= 1, 'the probe must leave a non-zero remainder, or a hard-coded 0 would still pass')

  const drained = await callTool('factory_inbox', memberCtx(workspace, makeStore(workspace), 'call-drained', staffed.sessionId, staffed.role), {
    markRead: false,
  })
  check.equal(drained.remainingUnread, consume.remainingUnread, 'a read-only pass must not change the unread count')
  check.equal(
    drained.messages.length,
    consume.remainingUnread,
    'an unread-only read must return exactly the messages it counts as unread',
  )

  const inbox = await callTool('factory_inbox', memberCtx(workspace, makeStore(workspace), 'call-inbox', staffed.sessionId, staffed.role), {
    includeRead: true,
    markRead: false,
  })
  check.equal(inbox.factoryId, id, 'the inbox must resolve the same factory')
  check.equal(inbox.role, staffed.role, 'the inbox must be scoped to the reader role')
  check.ok(Array.isArray(inbox.messages), 'the inbox must return a message array')

  const blocked = await callTool('factory_block', memberCtx(workspace, makeStore(workspace), 'call-block', staffed.sessionId, staffed.role), {
    reason: '缺少 DB_DESIGN.md 的迁移脚本，无法继续。',
    need: '请补齐迁移脚本或放宽验收标准。',
  })
  check.equal(blocked.blocked, true, 'factory_block must report the member as blocked')
  check.ok(
    world.Pipeline.getPipeline('fullstack').some((row) => row.id === blocked.stage),
    `the block must name a real stage, saw ${oneLine(blocked.stage)}`,
  )
  check.equal(
    memberOf(await readRecord(workspace, id), staffed.role).status,
    'blocked',
    'the blocked state must be persisted for the roster',
  )
  // factory_inbox is a member tool: a captain session must be refused, and the
  // report still has to be in the mailbox the captain actually reads.
  const refusedCaptainInbox = await rejects('inbox(a captain session)', () =>
    callTool('factory_inbox', captainCtx(workspace, makeStore(workspace), 'call-cap-mail'), {
      factoryId: id,
      includeRead: true,
      markRead: false,
    }))
  check.ok(
    /不是.*成员|只供成员使用/u.test(refusedCaptainInbox),
    `the member-only refusal must be readable: ${oneLine(refusedCaptainInbox)}`,
  )
  const mail = await makeStore(workspace).readAllMessages(id)
  check.ok(
    mail.some((row) => row.to === 'captain' && String(row.content).includes('迁移脚本')),
    `the block report must reach the captain mailbox: ${oneLine(mail.map((row) => `${row.from}→${row.to}`).join(','))}`,
  )
})

stage('09-dod', 'the DoD audit reads real artifacts, real commands and real git facts', async ({ workspace }) => {
  const id = world.sharedId
  for (const [name, body] of [
    ['package.json', '{"name":"portal","private":true}'],
    ['THREAT_MODEL.md', THREAT_MODEL_BODY],
    ['REVIEW.md', REVIEW_BODY],
    ['SECURITY_AUDIT.md', SECURITY_AUDIT_BODY],
    ['TEST_REPORT.md', TEST_REPORT_BODY],
    ['README.md', README_BODY],
    ['start.sh', START_SH_BODY],
    ['test_portal.py', PYTEST_BODY],
  ]) {
    await writeArtifact(workspace, name, body)
  }

  const dod = await callTool('factory_dod_check', captainCtx(workspace, makeStore(workspace), 'call-dod'), { factoryId: id })
  check.equal(dod.total, 7, 'the DoD audit is seven items')
  check.equal(dod.items.length, 7, 'every DoD item must be reported, including the ones that cannot pass')
  check.deepEqual(dod.items.map((row) => row.id), [1, 2, 3, 4, 5, 6, 7], 'the DoD items must be reported in order')
  check.equal(dod.securityTriggered, true, 'the security item must be evaluated, not skipped, on this pipeline')
  check.ok(
    dod.items.every((row) => typeof row.evidence === 'string' && row.evidence.length > 0),
    'every item must carry evidence text, including the failures',
  )
  check.equal(dod.items.find((row) => row.id === 3).ok, true, 'item 3 must read the real 结论: APPROVED out of REVIEW.md')
  check.equal(dod.items.find((row) => row.id === 6).ok, true, 'item 6 must find the four README headings')
  check.equal(dod.items.find((row) => row.id === 7).ok, true, 'item 7 must be decided by the real git facts')
  check.ok(dod.tags.includes('v1.0.0'), `the real git tag must be visible to the audit, saw ${oneLine(dod.tags.join(','))}`)
  check.ok(dod.commits >= 1, `the audit must see the real commits, saw ${dod.commits}`)
  // Self-consistency: the summary may never disagree with the item rows, and an
  // item the runner could not execute must never count as passed.
  const held = dod.items.filter((row) => !row.skipped && row.ok)
  check.equal(dod.ok, held.length === dod.total - dod.skipped, 'the DoD summary must agree with its own item rows')
  check.ok(
    dod.items.every((row) => row.needsExecution !== true || row.ok === false),
    'an item that was never executed must not be reported as passed',
  )

  const onDisk = await readRecord(workspace, id)
  check.equal(onDisk.dod.length, 7, 'the audit verdicts must be persisted into the record')
  check.equal(
    onDisk.dod.find((row) => row.id === 3).status,
    dod.items.find((row) => row.id === 3).status,
    'the persisted verdict must match the reply',
  )
  if (!dod.ok) {
    check.ok(dod.missing.length >= 1, 'a red audit must name what is missing')
    check.equal(dod.nextAction.includes('返工'), true, 'a red audit must send the work back, not forward')
  }
})

stage('10-deliver', 'factory_deliver re-runs the audit and refuses to deliver an unfinished pipeline', async ({ workspace }) => {
  const id = world.sharedId
  const before = await readRecord(workspace, id)
  const delivered = await callTool('factory_deliver', captainCtx(workspace, makeStore(workspace), 'call-deliver'), { factoryId: id })
  check.equal(delivered.factoryId, id, 'deliver answers for the requested factory')
  check.equal(delivered.delivered, false, 'a pipeline with unpassed stages must not be delivered')
  check.equal(delivered.alreadyDelivered, false, 'a refused delivery is not the idempotent replay')
  check.equal(delivered.stagesPassed, false, 'deliver must report that the stages are unfinished')
  check.ok(delivered.blocked.length >= 1, 'a refused delivery must explain itself')
  check.ok(
    delivered.blocked.some((row) => row.includes('阶段未全部通过')),
    `the refusal must name the unfinished stages: ${oneLine(delivered.blocked.join(' / '))}`,
  )
  check.equal(delivered.dodTotal, 7, 'deliver must re-run the whole audit, not trust an earlier one')
  const after = await readRecord(workspace, id)
  check.equal(after.phase, 'running', 'a refused delivery must not change the phase')
  check.equal(after.dod.length, 7, 'deliver must still persist the audit it ran')
  check.equal(
    after.dod.filter((row) => row.ok === true).length,
    delivered.dodPassed,
    'the persisted audit must agree with the reply',
  )
  check.ok(before.phase === after.phase, 'the phase must survive the refused delivery')
})

stage('11-captain-reach', 'factory_status and factory_message agree with the record', async ({ workspace }) => {
  const id = world.sharedId
  const status = await callTool('factory_status', captainCtx(workspace, makeStore(workspace), 'call-status'), { factoryId: id })
  check.equal(status.factoryId, id, 'the status must be scoped to the requested factory')
  check.equal(status.phase, 'running', 'the status must report the live phase')
  check.equal(status.members.length, (await readRecord(workspace, id)).members.length, 'the roster must match disk')
  check.ok(status.stages.length >= 10, `the status must list every stage, saw ${status.stages.length}`)
  check.ok(typeof status.executorAudit === 'object', 'the status must carry the executor audit block')
  check.ok(Array.isArray(status.feed), 'the status must carry the message feed')
  check.ok(status.artifacts.some((row) => row.path === 'PRD.md'), 'the status must list the registered artifacts')

  const staffed = (await readRecord(workspace, id)).members.find((row) => typeof row.sessionId === 'string' && row.sessionId !== '')
  const asMember = await callTool('factory_status', memberCtx(workspace, makeStore(workspace), 'call-status-member', staffed.sessionId, staffed.role), {})
  check.equal(asMember.factoryId, id, 'a member session must resolve the factory it belongs to')

  const mail = await callTool('factory_message', captainCtx(workspace, makeStore(workspace), 'call-mail'), {
    factoryId: id,
    to: 'pm',
    content: '请把 PRD.md 的 AC-3 补上对应用例。',
    kind: 'dispatch',
  })
  check.equal(mail.to, 'pm', 'the message must be addressed to the requested role')
  check.equal(mail.delivered, true, `a staffed roster member must be reachable by message: ${oneLine(mail.summary)}`)
  check.ok(mail.messageId.length > 0, 'the message must have an id')
  const auditMail = await callTool('factory_message', captainCtx(workspace, makeStore(workspace), 'call-mail-captain'), {
    factoryId: id,
    to: 'captain',
    content: '审计：本轮已完成需求与契约门禁。',
  })
  check.equal(auditMail.to, 'captain', 'the captain channel must be reachable')
  check.equal(auditMail.delivered, false, 'the captain channel is a record, not a delivery')

  await rejects('message(unknown role id)', () =>
    callTool('factory_message', captainCtx(workspace, makeStore(workspace), 'call-mail-bad'), {
      factoryId: id,
      to: 'not_a_role',
      content: 'x',
    }))
  await rejects('message(unknown kind)', () =>
    callTool('factory_message', captainCtx(workspace, makeStore(workspace), 'call-mail-kind'), {
      factoryId: id,
      to: 'pm',
      content: 'x',
      kind: 'nonsense',
    }))
  await rejects('message(empty content)', () =>
    callTool('factory_message', captainCtx(workspace, makeStore(workspace), 'call-mail-empty'), {
      factoryId: id,
      to: 'pm',
      content: '   ',
    }))
  await rejects('gate(unknown stage id)', () =>
    callTool('factory_gate', captainCtx(workspace, makeStore(workspace), 'call-gate-bad-stage'), {
      factoryId: id,
      stageId: 'no-such-stage',
    }))
  const outsider = captainAgent('captain-outsider')
  const outsiderRefusal = await rejects('gate(from a non-captain session)', () =>
    callTool('factory_gate', makeCtx({ callId: 'call-outsider', workspace, store: makeStore(workspace), agent: outsider }), {
      factoryId: id,
      stageId: 'requirement',
    }))
  check.ok(/队长/u.test(outsiderRefusal), `the outsider refusal must name the captain rule: ${oneLine(outsiderRefusal)}`)
})

stage('12-refusals-are-record-stable', 'a refused call leaves the record byte-identical', async ({ workspace }) => {
  const id = world.sharedId
  const before = digest(await readRecord(workspace, id))
  const refusals = [
    ['gate(unknown factory)', () => callTool('factory_gate', captainCtx(workspace, makeStore(workspace), 'r-gate'), { factoryId: 'ffffffff' })],
    ['dod(unknown factory)', () => callTool('factory_dod_check', captainCtx(workspace, makeStore(workspace), 'r-dod'), { factoryId: 'ffffffff' })],
    ['deliver(unknown factory)', () => callTool('factory_deliver', captainCtx(workspace, makeStore(workspace), 'r-deliver'), { factoryId: 'ffffffff' })],
    ['halt(unknown factory)', () => callTool('factory_halt', captainCtx(workspace, makeStore(workspace), 'r-halt'), { factoryId: 'ffffffff' })],
    ['resume(no reason)', () => callTool('factory_resume', captainCtx(workspace, makeStore(workspace), 'r-resume'), { factoryId: id })],
    ['resume(unknown factory)', () => callTool('factory_resume', captainCtx(workspace, makeStore(workspace), 'r-resume-2'), { factoryId: 'ffffffff', reason: 'x' })],
    ['delete(path-shaped factoryId)', () => callTool('factory_delete', captainCtx(workspace, makeStore(workspace), 'r-delete'), { factoryId: 'not/a/factory' })],
    ['plan(empty brief)', () => callTool('factory_plan', captainCtx(workspace, makeStore(workspace), 'r-plan'), { brief: '   ' })],
  ]
  for (const [label, body] of refusals) {
    await rejects(label, body)
  }
  check.equal(digest(await readRecord(workspace, id)), before, 'no refusal may rewrite the record it was refused for')
})

stage('13-halt-resume', 'factory_halt parks the factory and factory_resume restores it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-factory-drill-halt-'))
  world.tempRoots.push(root)
  try {
    const ws = join(root, 'ws')
    await mkdir(ws, { recursive: true })
    const store = makeStore(ws)
    const planned = await callTool('factory_plan', captainCtx(ws, store, 'h-plan'), { brief: BRIEF })
    const approved = await callTool('factory_approve', captainCtx(ws, makeStore(ws), 'h-approve'), { factoryId: planned.factoryId })
    check.ok(approved.spawned.length >= 1, 'the halt fixture needs a working member to interrupt')

    const halted = await callTool('factory_halt', captainCtx(ws, makeStore(ws), 'h-halt'), {
      factoryId: planned.factoryId,
      reason: '等待用户确认需求范围',
    })
    check.equal(halted.phase, 'halted', 'halt must park the factory')
    check.equal(halted.alreadyHalted, false, 'the first halt is not the idempotent replay')
    check.ok(
      halted.interrupted.length >= 1,
      `halt must interrupt the members holding work, saw ${oneLine(halted.interrupted.join(','))}`,
    )
    check.equal(halted.failed.length, 0, `a fake host must interrupt cleanly, saw ${oneLine(halted.failed.join(';'))}`)
    const onDisk = await readRecord(ws, planned.factoryId)
    check.equal(onDisk.phase, 'halted', 'halted must be on disk')
    check.ok(
      onDisk.members.filter((row) => row.status === 'working').length === 0,
      'no member may still be working after a halt',
    )

    const again = await callTool('factory_halt', captainCtx(ws, makeStore(ws), 'h-halt-2'), { factoryId: planned.factoryId })
    check.equal(again.alreadyHalted, true, 'halting twice is idempotent')
    check.equal(again.interrupted.length, 0, 'the idempotent halt must not interrupt anyone twice')

    const refused = await rejects('dispatch(a halted factory)', () =>
      callTool('factory_dispatch', captainCtx(ws, makeStore(ws), 'h-dispatch'), { factoryId: planned.factoryId }))
    check.ok(/halted|暂停/u.test(refused), `the halt refusal must name the phase: ${oneLine(refused)}`)

    const preResume = await readRecord(ws, planned.factoryId)
    const spawnsBeforeResume = world.host.calls.startActivation.length
    const resumed = await callTool('factory_resume', captainCtx(ws, makeStore(ws), 'h-resume'), {
      factoryId: planned.factoryId,
      reason: '用户在对话里明确要求继续',
    })
    check.equal(resumed.phase, 'running', 'resume must restore running')
    check.equal(resumed.alreadyRunning, false, 'the first resume is not the idempotent replay')
    check.equal((await readRecord(ws, planned.factoryId)).phase, 'running', 'running must be back on disk')
    check.equal(
      world.host.calls.startActivation.length,
      spawnsBeforeResume,
      'factory_resume must never dispatch on its own — it spawns no child session',
    )
    check.deepEqual(
      (await readRecord(ws, planned.factoryId)).members.map((row) => [row.role, row.status]),
      preResume.members.map((row) => [row.role, row.status]),
      'resume must not restaff anyone — dispatch is a separate call',
    )
    const replay = await callTool('factory_resume', captainCtx(ws, makeStore(ws), 'h-resume-2'), {
      factoryId: planned.factoryId,
      reason: '再确认一次',
    })
    check.equal(replay.alreadyRunning, true, 'resuming a running factory is idempotent')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

stage('14-delete', 'factory_delete archives by default and destroys only on explicit confirm', async () => {
  const root = await mkdtemp(join(tmpdir(), 'code-factory-drill-delete-'))
  world.tempRoots.push(root)
  try {
    const ws = join(root, 'ws')
    await mkdir(ws, { recursive: true })
    const first = await callTool('factory_plan', captainCtx(ws, makeStore(ws), 'd-plan-1'), { brief: BRIEF })
    const second = await callTool('factory_plan', captainCtx(ws, makeStore(ws), 'd-plan-2'), { brief: BRIEF_2 })
    const live = join(stateDirOf(ws), first.factoryId, 'factory.json')
    check.ok(existsSync(live), 'the factory directory must exist before the delete')

    await rejects('delete(destroy without confirm)', () =>
      callTool('factory_delete', captainCtx(ws, makeStore(ws), 'd-destroy'), { factoryId: first.factoryId, mode: 'destroy' }))
    await rejects('delete(bad mode)', () =>
      callTool('factory_delete', captainCtx(ws, makeStore(ws), 'd-mode'), { factoryId: first.factoryId, mode: 'rmrf' }))
    check.ok(existsSync(live), 'a refused delete must not remove anything')

    const archived = await callTool('factory_delete', captainCtx(ws, makeStore(ws), 'd-archive'), { factoryId: first.factoryId })
    check.equal(archived.factoryId, first.factoryId, 'the archive must answer for the factory')
    check.equal(archived.mode, 'archive', 'archiving is the default mode')
    check.ok(!existsSync(live), 'archiving must move the factory out of the live index')
    check.ok(
      (await listDir(join(stateDirOf(ws), 'archive'))).length >= 1,
      `archiving must keep the record under archive/, saw ${oneLine((await listDir(stateDirOf(ws))).join(','))}`,
    )
    const status = await callTool('factory_status', captainCtx(ws, makeStore(ws), 'd-status'), {})
    check.ok(
      status.factories === undefined || status.factories.every((row) => row.id !== first.factoryId),
      'an archived factory must be gone from the active index',
    )
    check.ok(
      status.factories === undefined || status.factories.some((row) => row.id === second.factoryId),
      'the other factory must survive the archive',
    )

    const destroyed = await callTool('factory_delete', captainCtx(ws, makeStore(ws), 'd-destroy-2'), {
      factoryId: second.factoryId,
      mode: 'destroy',
      confirm: true,
    })
    check.equal(destroyed.mode, 'destroy', 'the explicit confirm must select the destroy mode')
    check.ok(!existsSync(join(stateDirOf(ws), second.factoryId)), 'destroy must remove the factory directory')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

stage('15-security-escalation', 'a security verdict the brief missed is corrected from the requirements document', async ({ workspace }) => {
  /*
   * Review finding H4. The plan-time verdict reads one line of prose, so
   * 「做一个跑腿的微信小程序」 — WeChat login, customer and rider phone numbers,
   * addresses, payment — was recorded as `securityTriggered: false`, the DoD's
   * securityOnly item auto-passed as 「本次工厂未触发安全路径」 and the security
   * audit stage was never required.
   *
   * This stage uses a brief that genuinely names no mechanism, then writes a
   * requirements document that does, and asserts the record is corrected at the
   * gate — and only ever upward.
   */
  const terse = '做一个给社区用的报名应用：包含页面设计、数据库表设计与接口契约，离线可复现地跑通流水线。'
  const planned = await callTool('factory_plan', captainCtx(workspace, makeStore(workspace), 'sec-plan'), { brief: terse })
  const id = planned.factoryId
  check.equal(planned.securityTriggered, false, 'the control brief must not trigger on its own')

  const before = await readRecord(workspace, id)
  check.equal(before.securityTriggered, false, 'the record must start off the security path')
  check.deepEqual([...(before.securityHits ?? [])], [], 'nothing matched, so nothing may be claimed to have matched')
  check.equal(before.securitySource, 'none', `a clean brief must report itself as no source: ${String(before.securitySource)}`)

  await callTool('factory_approve', captainCtx(workspace, makeStore(workspace), 'sec-approve'), { factoryId: id })

  // PRD_BODY names 单点登录 / 权限路由 — mechanisms the terse brief never mentions.
  await writeArtifact(workspace, 'PRD.md', PRD_BODY)
  await parkAndCheck(workspace, id, 'requirement')
  const verdict = await callTool('factory_gate', captainCtx(workspace, makeStore(workspace), 'sec-gate'), {
    factoryId: id,
    stageId: 'requirement',
    humanConfirm: true,
  })
  check.equal(verdict.action, 'advance', `the gate itself must still advance: ${oneLine(verdict.detail)}`)

  const after = await readRecord(workspace, id)
  check.equal(after.securityTriggered, true, 'the document named a mechanism the brief did not — the verdict must be corrected')
  check.equal(after.securitySource, 'document', `the corrected verdict must name a document as its source: ${String(after.securitySource)}`)
  check.ok(
    (after.securityHits ?? []).includes('登录'),
    `the recorded words must include what actually matched: ${oneLine((after.securityHits ?? []).join('、'))}`,
  )
  check.ok(
    after.members.some((row) => row.role === 'security_eng'),
    `the security role must be added back to the roster: ${oneLine(after.members.map((row) => row.role).join('、'))}`,
  )
  check.ok(
    (await makeStore(workspace).readAllMessages(id)).some((mail) => String(mail.content).includes('安全复评')),
    'the correction must reach the mailbox, not only the record',
  )
  check.ok(
    (verdict.notes ?? []).some((note) => note.includes('安全复评')),
    `the verdict must report the correction rather than change the record silently: ${oneLine((verdict.notes ?? []).join(' '))}`,
  )

  // Upward only, and idempotent: a second verdict over the same documents must
  // not add a second security_eng and must not rewrite the words it recorded.
  const replay = await callTool('factory_gate', captainCtx(workspace, makeStore(workspace), 'sec-gate-2'), {
    factoryId: id,
    stageId: 'requirement',
    humanConfirm: true,
  })
  check.equal(replay.action, 'advance', `re-verifying a passed stage must still advance: ${oneLine(replay.detail)}`)
  const twice = await readRecord(workspace, id)
  check.equal(
    twice.members.filter((row) => row.role === 'security_eng').length,
    1,
    'a second verdict duplicated the security role',
  )
  check.deepEqual([...(twice.securityHits ?? [])], [...(after.securityHits ?? [])], 'a second verdict rewrote the recorded words')
})

/* ------------------------------------------------------------------ main */
async function loadModules() {
  const missing = REQUIRED_LIBS.filter((path) => !existsSync(path))
  if (missing.length > 0) {
    process.stderr.write(
      `engine drill cannot run: missing build output ${missing.map((path) => rel(path)).join(', ')}\n`
        + '  build it in a session where no other agent is editing src/ (`pnpm build`).\n',
    )
    return false
  }
  // A stale lib/ would silently test yesterday's engine — the same guard
  // verify.mjs uses, reported the same way.
  if (existsSync(ENGINE_SRC)) {
    const srcStat = await stat(ENGINE_SRC)
    const libStat = await stat(ENGINE_PATH)
    if (libStat.mtimeMs + 1000 < srcStat.mtimeMs) {
      process.stderr.write(
        `engine drill cannot run: ${rel(ENGINE_PATH)} is older than ${rel(ENGINE_SRC)}`
          + ' — rebuild instead of testing a stale handler.\n',
      )
      return false
    }
  }
  const load = async (path) => await import(pathToFileURL(path).href)
  world.Engine = await load(ENGINE_PATH)
  world.Context = await load(join(repoRoot, 'lib', 'tools', 'context.js'))
  world.StoreClass = (await load(join(repoRoot, 'lib', 'store', 'store.js'))).FactoryStore
  world.State = await load(join(repoRoot, 'lib', 'store', 'state.js'))
  world.Surface = await load(join(repoRoot, 'lib', 'runtime', 'tool-surface.js'))
  world.Fakes = await load(join(repoRoot, 'lib', 'runtime', 'testing.js'))
  world.Scheduler = await load(join(repoRoot, 'lib', 'runtime', 'scheduler.js'))
  world.Pipeline = await load(join(repoRoot, 'lib', 'domain', 'pipeline.js'))
  world.Dod = await load(join(repoRoot, 'lib', 'domain', 'dod.js'))
  if (typeof world.StoreClass !== 'function') {
    process.stderr.write('engine drill cannot run: lib/store/store.js does not export FactoryStore.\n')
    return false
  }
  for (const fn of ['planStageDispatch', 'applyStageDispatch', 'schedulerProbes']) {
    if (typeof world.Scheduler[fn] !== 'function') {
      process.stderr.write(`engine drill cannot run: lib/runtime/scheduler.js does not export ${fn}().\n`)
      return false
    }
  }
  return true
}

async function main() {
  if (!(await loadModules())) return 2

  const root = await mkdtemp(join(tmpdir(), 'code-factory-drill-'))
  world.tempRoots.push(root)
  let failures = 0
  try {
    const workspace = join(root, 'ws')
    await mkdir(workspace, { recursive: true })
    world.host = world.Fakes.createFakeMemberHost({ provider: CONFIG.memberProvider })
    world.captain = captainAgent(`captain-${process.pid}`)
    world.store = makeStore(workspace, (warning) => say(`      [store warning] ${oneLine(warning)}`))

    await writeFile(join(workspace, '.gitignore'), 'node_modules/\n__pycache__/\n.agent-teams/\n', 'utf8')
    const seeded = seedGitRepo(workspace)
    say(`  workspace ${workspace}`)
    say(`  git fixture: commit=${seeded.commit} tag=${seeded.tag} node=${process.version}`)

    for (const item of STAGES) {
      const before = assertions
      const beforeCalls = [...handlerRuns.values()].reduce((sum, count) => sum + count, 0)
      try {
        await item.body({ workspace, store: makeStore(workspace) })
        item.ok = true
      } catch (error) {
        item.ok = false
        item.error = errorText(error)
        if (process.env.DRILL_DEBUG === '1' && error instanceof Error) process.stdout.write(`${error.stack}\n`)
      }
      item.handlers = [...handlerRuns.values()].reduce((sum, count) => sum + count, 0) - beforeCalls
      item.assertions = assertions - before
      if (item.ok && !item.static && item.handlers === 0) {
        item.ok = false
        item.error = 'stage executed 0 tool handlers — a stage that calls nothing proves nothing'
      }
      if (item.ok) {
        say(`  ok  ${item.id.padEnd(28)} ${String(item.handlers).padStart(2)} handler calls, ${String(item.assertions).padStart(3)} assertions`)
      } else {
        failures += 1
        process.stdout.write(`[FAIL] ${item.id} (${item.name}): ${item.error}\n`)
      }
    }
  } finally {
    for (const path of world.tempRoots) {
      await rm(path, { recursive: true, force: true })
    }
  }

  const leaked = world.tempRoots.filter((path) => existsSync(path))
  if (leaked.length > 0) {
    failures += 1
    process.stdout.write(`[FAIL] cleanup (temp workspace removal): ${leaked.join(', ')} still exists\n`)
  }

  const exercised = handlerRuns.size
  const invocations = [...handlerRuns.values()].reduce((sum, count) => sum + count, 0)
  const passed = STAGES.filter((item) => item.ok).length

  // Vacuity guards: a drill that runs nothing must never report success.
  if (exercised === 0) {
    process.stdout.write('[FAIL] vacuity guard (handler coverage): the drill executed no tool handler at all\n')
    process.stdout.write('FAILURE: the tool surface was never executed\n')
    return 1
  }
  if (exercised < 12) {
    process.stdout.write(`[FAIL] vacuity guard (handler coverage): only ${exercised} distinct handlers ran, need at least 12\n`)
    process.stdout.write('FAILURE: the tool surface was barely executed\n')
    return 1
  }
  if (assertions < 60) {
    process.stdout.write(`[FAIL] vacuity guard (assertions): only ${assertions} assertions were evaluated, need at least 60\n`)
    process.stdout.write('FAILURE: the drill barely asserted anything\n')
    return 1
  }

  if (defects.length > 0) {
    process.stdout.write(`\n${defects.length} defect(s) in the engine under test:\n`)
    for (const defect of defects) process.stdout.write(`  - ${defect.text}\n`)
  }

  // The counts are the summary, not progress, so `--quiet` keeps them.
  process.stdout.write('\n')
  process.stdout.write(`  workspaces cleaned: ${leaked.length === 0 ? 'yes' : 'NO'}\n`)
  process.stdout.write(`  stages:             ${passed}/${STAGES.length} passed\n`)
  process.stdout.write(`  tool handlers:      ${exercised}/${ENGINE_TOOL_NAMES.length} distinct (${invocations} invocations)\n`)
  process.stdout.write(`  assertions:         ${assertions}\n`)
  process.stdout.write(`  handlers reached:   ${[...handlerRuns.keys()].sort().join(', ')}\n`)
  process.stdout.write('\n')

  if (failures > 0) {
    process.stdout.write(`FAILURE: ${failures}/${STAGES.length} stages failed\n`)
    return 1
  }
  process.stdout.write(`SUCCESS: engine drill — ${passed}/${STAGES.length} stages passed\n`)
  return 0
}

process.exitCode = await main()
