/**
 * engine/plan.ts — factory_plan / factory_edit_plan.
 *
 * The staged half of the two-phase protocol: routing a brief to a task type,
 * deciding the roster under the cap and the team floor, projecting the
 * pipeline, and writing (or amending) a plan without waking any member.
 *
 * Moved here verbatim from the former single-file `src/tools/engine.ts`
 * (engineering review finding M5). Only this header, the imports and the
 * `export` keywords on cross-module helpers are new — no body was edited.
 *
 * @module dsh-code-factory/tools/engine/plan
 */

import type { StageDef, PipelineId, FactoryState, SecuritySignalSource } from '../../shared/types.js'
import { getPipeline } from '../../domain/pipeline.js'
import { DEFAULT_DEV_ROLE, normaliseRoster, sanitizeCap, teamFloor, trimToCap, assembleTeam, requiredRolesFor, securitySignal } from '../../domain/router.js'
import { EXTRA_ROLES, ROLE_IDS, canonicalRoleId, isRoleId, SECURITY_ROLE_ID, TRIAD_BASE_ROLES, isDevRoleId, roleTitle } from '../../domain/roles.js'
import { TASK_TYPE_IDS, getTaskType } from '../../domain/task-types.js'
import { FactoryToolError, loadFactory, readEvolutionLessons, requireCaptainOf, requireFactoryId } from '../context.js'
import type { ToolCallContext } from '../context.js'

import { evolutionStats } from '../../store/evolution.js'
import { reusePlanNote } from '../../domain/reuse.js'
import { searchReuse } from './reuse.js'
import { optional, required, roleRow, freshStageRecords, freshMemberRecords, planPath, captainNote } from './plumbing.js'
import type { PlanRoleRow } from './plumbing.js'

/** One pipeline row of a staged plan. */
export interface PlanStageRow {
  readonly id: string
  readonly name: string
  readonly roles: string[]
  readonly parallel: boolean
  readonly humanApproval: boolean
  readonly gateType: string
  readonly maxRounds: number
  readonly failGoto?: string
}
/** One plan row for a stage definition of a pipeline template. */
function stageRow(def: StageDef): PlanStageRow {
  const row: PlanStageRow = {
    id: def.id,
    name: def.name,
    roles: [...def.roles],
    parallel: def.parallel === true,
    humanApproval: def.humanApproval === true,
    gateType: def.gate.type,
    maxRounds: def.maxRounds,
  }
  return def.failGoto === undefined ? row : { ...row, failGoto: def.failGoto }
}
/** All plan rows of one template. */
function pipelineRows(pipeline: PipelineId): PlanStageRow[] {
  return getPipeline(pipeline).map(stageRow)
}
/* ------------------------------------------------------------- roster rules */

/** Why the roster looks the way it does. */
interface RosterDecision {
  readonly taskType: string
  readonly pipeline: PipelineId
  readonly team: string[]
  readonly securityTriggered: boolean
  /** The words that put this factory on the security path, and where they came from (H4). */
  readonly securityHits: readonly string[]
  readonly securitySource: SecuritySignalSource
  readonly trimmed: string[]
  /** Template-required roles the cap forced out; see {@link PlanFactoryResult.trimmedRequired}. */
  readonly trimmedRequired: string[]
  readonly overCap: boolean
  readonly reasons: string[]
}
/** Explicit roster input, validated against the role registry. */
function requireKnownRoles(roles: readonly string[]): string[] {
  const canonical: string[] = []
  const unknown: string[] = []
  for (const role of roles) {
    const id = canonicalRoleId(required(role, 'members[] 里的角色 id'))
    if (!isRoleId(id) || id === 'router') {
      unknown.push(String(role))
      continue
    }
    if (!canonical.includes(id)) canonical.push(id)
  }
  if (unknown.length > 0) {
    const extra = EXTRA_ROLES.map((def) => def.id).join('、')
    throw new FactoryToolError(
      `code-factory: 未注册的角色 ${unknown.join('、')}。可用角色: ${ROLE_IDS.filter((id) => id !== 'router').join('、')}`
        + `（按需附加岗位: ${extra}）；别名（如 sec_eng / fe_dev）会被规范化。`,
    )
  }
  return canonical
}
/**
 * Applies the product's roster invariants to any seed list: the iron triangle
 * (`pm` + `qa` + at least one `*_dev`), the security pin when the brief triggers
 * it, and the roster cap — all through the domain's own exported rules, so the
 * router and this function cannot drift apart.
 */
function shapeRoster(
  seed: readonly string[],
  securityTriggered: boolean,
  cap: number,
  required: readonly string[] = [],
): {
  readonly team: string[]
  readonly trimmed: string[]
  readonly trimmedRequired: string[]
  readonly overCap: boolean
  readonly notes: string[]
} {
  const notes: string[] = []
  const roster: string[] = []
  const add = (role: string): void => {
    const canonical = canonicalRoleId(role)
    if (canonical === 'router' || !isRoleId(canonical)) return
    if (!roster.includes(canonical)) roster.push(canonical)
  }
  add('pm')
  for (const role of seed) add(role)
  for (const role of TRIAD_BASE_ROLES) add(role)
  if (!roster.some((role) => isDevRoleId(role))) {
    add(DEFAULT_DEV_ROLE)
    notes.push(`铁三角补位: ${DEFAULT_DEV_ROLE}`)
  }
  if (securityTriggered && !roster.includes(SECURITY_ROLE_ID)) {
    add(SECURITY_ROLE_ID)
    notes.push(`安全触发补位: ${SECURITY_ROLE_ID}`)
  }

  const pinned = securityTriggered ? [...TRIAD_BASE_ROLES, SECURITY_ROLE_ID] : [...TRIAD_BASE_ROLES]
  const result = trimToCap(roster, cap, pinned, required)
  if (result.trimmed.length > 0) notes.push(`裁剪: ${result.trimmed.join('、')}`)
  if (result.trimmedRequired.length > 0) {
    notes.push(
      `需要 ${required.length} 人，当前上限 ${sanitizeCap(cap)}，已裁掉 ${result.trimmedRequired.join('、')}`
        + '，这些岗位的阶段将退回 ROLE_FALLBACKS，请提高 maxMembers',
    )
  }
  if (result.overCap) {
    notes.push(`编制上限 ${sanitizeCap(cap)} 低于地板 ${teamFloor(securityTriggered)}，已保留强制岗位`)
  }
  return {
    team: [...normaliseRoster(result.team)],
    trimmed: [...result.trimmed],
    trimmedRequired: [...result.trimmedRequired],
    overCap: result.overCap,
    notes,
  }
}
/**
 * Decides the task family, pipeline and roster.
 *
 * The brief is always routed through `domain/router.assembleTeam`; an explicit
 * `taskType` overrides the family (and therefore the pipeline) while the roster
 * becomes the union of the routed team and that family's default team; an
 * explicit `members` list replaces the seed entirely. Either way the invariants
 * above are re-applied, so a hand-picked roster cannot lose the iron triangle or
 * the security pin.
 */
function decideRoster(
  brief: string,
  input: { readonly taskType?: string; readonly members?: readonly string[]; readonly maxMembers?: number },
  fallbackCap: number,
): RosterDecision {
  const cap = sanitizeCap(input.maxMembers ?? fallbackCap)
  const routed = assembleTeam(brief, cap)
  const reasons: string[] = [`路由: ${routed.reasoning}`]

  let taskType = routed.taskType
  let pipeline = routed.pipeline
  let seed: readonly string[] = routed.team

  const requestedType = optional(input.taskType)
  if (requestedType !== undefined) {
    const def = getTaskType(requestedType)
    if (def === undefined) {
      throw new FactoryToolError(
        `code-factory: 未知任务类型 ${JSON.stringify(requestedType)}。可用类型: ${TASK_TYPE_IDS.join('、')}（省略则由 brief 自动路由）。`,
      )
    }
    taskType = def.id
    pipeline = def.pipeline
    seed = [...routed.team, ...def.team]
    reasons.push(`任务类型覆盖: ${def.id}（${def.label}）→ 流水线 ${def.pipeline}`)
  }

  if (input.members !== undefined && input.members.length > 0) {
    seed = requireKnownRoles(input.members)
    reasons.push(`编制覆盖: 由队长指定 ${seed.join('、')}`)
  }

  const signal = securitySignal(brief)
  const securityTriggered = routed.securityTriggered || signal.triggered
  const shaped = shapeRoster(seed, securityTriggered, cap, requiredRolesFor(taskType, securityTriggered))
  reasons.push(...shaped.notes)
  reasons.push(`最终编制 ${shaped.team.length} 人 / 上限 ${cap} → 流水线 ${pipeline}`)

  return {
    taskType,
    pipeline,
    team: shaped.team,
    securityTriggered,
    // The words and their origin travel with the decision so the record can
    // explain *why* it is on the security path — and so a later document can be
    // recognised as adding to them rather than replacing them (H4).
    securityHits: [...signal.hits],
    securitySource: signal.source,
    trimmed: shaped.trimmed,
    trimmedRequired: shaped.trimmedRequired,
    overCap: shaped.overCap,
    reasons,
  }
}
/* ------------------------------------------------------------------- plan */

/** Arguments of {@link planFactory}. */
export interface PlanFactoryInput {
  readonly brief: string
  readonly name?: string
  readonly taskType?: string
  readonly members?: string[]
  readonly maxMembers?: number
}
/** Result of {@link planFactory} / {@link editFactoryPlan}. */
export interface PlanFactoryResult {
  readonly summary: string
  readonly factoryId: string
  readonly name: string
  readonly brief: string
  readonly taskType: string
  readonly pipeline: string
  readonly phase: string
  readonly planReviewState: string
  readonly securityTriggered: boolean
  readonly maxMembers: number
  readonly team: PlanRoleRow[]
  readonly stages: PlanStageRow[]
  readonly reasoning: string[]
  readonly trimmed: string[]
  /**
   * Roles this task type's template requires that the cap forced out.
   *
   * Separate from {@link trimmed} on purpose: for a template whose every role is
   * required (all of `web_fullstack`), the cap drops required roles and nothing
   * else, so `trimmed` stays empty while the roster is genuinely short — and the
   * stages those roles staff will silently fall back through `ROLE_FALLBACKS`
   * unless somebody raises `maxMembers`.
   */
  readonly trimmedRequired: string[]
  readonly overCap: boolean
  readonly factoryFile: string
  readonly reusedPlan: boolean
  readonly spawnedMembers: number
  readonly childSessions: number
  readonly notes: string[]
  readonly nextAction: string
}
/** Projects one staged record into the plan result the tools return. */
function projectPlan(
  call: ToolCallContext,
  state: FactoryState,
  decision: {
    readonly maxMembers: number
    readonly reasons: readonly string[]
    readonly trimmed: readonly string[]
    readonly trimmedRequired?: readonly string[]
    readonly overCap: boolean
  },
  extra: { readonly reusedPlan: boolean; readonly notes: readonly string[] },
): PlanFactoryResult {
  const childSessions = state.members.filter(
    (member) => typeof member.sessionId === 'string' && member.sessionId !== '',
  ).length
  const trimmedRequired = [...(decision.trimmedRequired ?? [])]
  const notes = [...extra.notes]
  if (trimmedRequired.length > 0) {
    notes.push(
      `编制上限 ${decision.maxMembers} 装不下 ${state.taskType} 模板需要的全部岗位，已裁掉 `
        + `${trimmedRequired.map(roleTitle).join('、')}；这些岗位的阶段会退回 ROLE_FALLBACKS，`
        + '请让用户提高 maxMembers 或接受替补。',
    )
  }
  return {
    summary:
      `工厂 ${state.id}（${state.name}）已 staged：任务类型 ${state.taskType}，编制 ${state.members.length} 人，`
      + `流水线 ${state.pipeline} 共 ${state.stages.length} 阶段。未创建任何子会话（childSessions=${childSessions}）。`
      + ' 把计划完整呈现给用户，本轮结束并等待批准；批准后调用 factory_approve。',
    factoryId: state.id,
    name: state.name,
    brief: state.brief,
    taskType: state.taskType,
    pipeline: state.pipeline,
    phase: state.phase,
    planReviewState: state.planReviewState ?? 'awaiting_review',
    securityTriggered: state.securityTriggered,
    maxMembers: decision.maxMembers,
    team: state.members.map((member) => roleRow(member.role)),
    stages: pipelineRows(state.pipeline),
    reasoning: [...decision.reasons],
    trimmed: [...decision.trimmed],
    trimmedRequired,
    overCap: decision.overCap,
    factoryFile: planPath(call, state.id),
    reusedPlan: extra.reusedPlan,
    spawnedMembers: 0,
    childSessions,
    notes,
    nextAction:
      '把任务类型、每个角色的职责与工件边界、阶段顺序与门禁（含 failGoto / maxRounds）呈现给用户，然后结束本轮等批准。',
  }
}
/**
 * One planning note about the workspace's accumulated lessons.
 *
 * The plan is where the user decides whether to spend the effort; telling them
 * "this workspace already recorded N mistakes of this kind" at that point is the
 * cheapest possible moment to avoid repeating them. The ledger is only read —
 * planning must never write lessons.
 */
async function evolutionPlanNotes(call: ToolCallContext): Promise<string[]> {
  const lessons = await readEvolutionLessons(call)
  if (lessons.length === 0) return []
  const stats = evolutionStats(lessons)
  return [
    `进化库: 本工作区已有 ${stats.total} 条历史教训（其中 ${stats.recurring} 条反复出现、`
      + `${stats.resolved} 条已解决）；批准后成员简报与返工单会自动带上本角色的历史教训。`,
  ]
}

/**
 * One planning note about cross-project assets the reuse library already holds.
 *
 * The library is global (not tied to this workspace), and the search is
 * read-only: planning may suggest, but never copy or claim an asset. Every
 * failure is silent-by-design (`searchReuse` returns `[]`), because a missing
 * library must not block the plan the user is waiting for.
 *
 * @param call - the resolved tool call (workspace/config).
 * @param brief - the user's original brief (search query).
 * @param taskType - routed task family (exact match bonus).
 * @returns zero or one note, already user-facing.
 */
async function reusePlanNotes(call: ToolCallContext, brief: string, taskType: string): Promise<string[]> {
  const matches = await searchReuse(call, { query: brief, taskType, limit: 3 })
  const note = reusePlanNote(matches)
  return note === undefined ? [] : [note]
}
/** Finds an identical staged plan already owned by this captain (idempotency). */
async function findIdenticalStagedPlan(
  call: ToolCallContext,
  brief: string,
  decision: RosterDecision,
): Promise<FactoryState | undefined> {
  for (const summary of await call.store.list()) {
    if (summary.captainSessionId !== call.callerId) continue
    if (summary.phase !== 'staged') continue
    if (summary.taskType !== decision.taskType) continue
    if (summary.pipeline !== decision.pipeline) continue
    const state = await call.store.load(summary.id)
    if (state === undefined) continue
    if (state.brief !== brief) continue
    if (state.planReviewState !== 'awaiting_review') continue
    if (state.members.map((member) => canonicalRoleId(member.role)).join(',') !== decision.team.join(',')) continue
    return state
  }
  return undefined
}
/**
 * Stage one plan. Creates the factory record (phase `staged`, review state
 * `awaiting_review`) and **nothing else** — no `startActivation`, no delivery.
 */
export async function planFactory(call: ToolCallContext, input: PlanFactoryInput): Promise<PlanFactoryResult> {
  const brief = required(input.brief, 'brief（用户原始需求）')
  const cap = sanitizeCap(input.maxMembers ?? call.config.maxMembers)
  const decision = decideRoster(
    brief,
    {
      ...(optional(input.taskType) === undefined ? {} : { taskType: optional(input.taskType) }),
      ...(input.members === undefined ? {} : { members: input.members }),
      maxMembers: cap,
    },
    call.config.maxMembers,
  )

  const existing = await findIdenticalStagedPlan(call, brief, decision)
  const notes: string[] = []
  notes.push(...(await evolutionPlanNotes(call)))
  // Global reuse library: suggest already-delivered cross-project assets. This
  // is read-only and failure-tolerant — a missing/broken library never blocks
  // planning (and never copies a file into the workspace by itself).
  notes.push(...(await reusePlanNotes(call, brief, decision.taskType)))
  if (existing !== undefined) {
    notes.push(`检测到完全相同的 staged 计划 ${existing.id}，直接复用（幂等）；如需修改请用 factory_edit_plan。`)
    return projectPlan(
      call,
      existing,
      { maxMembers: cap, reasons: decision.reasons, trimmed: decision.trimmed, trimmedRequired: decision.trimmedRequired, overCap: decision.overCap },
      { reusedPlan: true, notes },
    )
  }

  const name = optional(input.name)
  const state = await call.store.create({
    brief,
    ...(name === undefined ? {} : { name }),
    taskType: decision.taskType,
    pipeline: decision.pipeline,
    captainSessionId: call.callerId,
    securityTriggered: decision.securityTriggered,
    ...(decision.securityHits === undefined ? {} : { securityHits: [...decision.securityHits] }),
    ...(decision.securitySource === undefined ? {} : { securitySource: decision.securitySource }),
    members: freshMemberRecords(decision.team),
    stages: freshStageRecords(decision.pipeline),
    phase: 'staged',
    planReviewState: 'awaiting_review',
  })

  notes.push(`工厂目录: ${planPath(call, state.id)}（factory.json + inbox/ + artifacts.json）`)
  if (decision.overCap) notes.push('上限低于地板，强制岗位被保留：请告知用户需要提高 maxMembers 或缩减目标。')

  await captainNote(
    call,
    state.id,
    `[staged 规划] ${state.name}\n任务类型: ${state.taskType}（${state.pipeline}）\n编制: ${decision.team.map(roleTitle).join('、')}\n`
      + `安全触发: ${decision.securityTriggered ? '是（security_eng 不可裁剪）' : '否'}\n${decision.reasons.join('\n')}`,
  )

  return projectPlan(
    call,
    state,
    { maxMembers: cap, reasons: decision.reasons, trimmed: decision.trimmed, trimmedRequired: decision.trimmedRequired, overCap: decision.overCap },
    { reusedPlan: false, notes },
  )
}
/* -------------------------------------------------------------- edit plan */

/** Arguments of {@link editFactoryPlan}. */
export interface EditPlanInput {
  readonly factoryId: string
  readonly brief?: string
  readonly name?: string
  readonly taskType?: string
  readonly members?: string[]
  readonly maxMembers?: number
  readonly note?: string
}
/** Result of {@link editFactoryPlan}. */
export interface EditPlanResult extends PlanFactoryResult {
  readonly changedFields: string[]
  readonly editedAt: number
}
/**
 * Revise a staged plan. Only legal while nothing has been spawned: once a member
 * has a session id the roster is frozen (its brief is already in its context), and
 * the refusal says so instead of silently diverging the plan from the running team.
 */
export async function editFactoryPlan(call: ToolCallContext, input: EditPlanInput): Promise<EditPlanResult> {
  const factoryId = requireFactoryId(input.factoryId)
  const current = await loadFactory(call, factoryId)
  requireCaptainOf(call, current)
  if (current.phase !== 'staged') {
    throw new FactoryToolError(
      `code-factory: 工厂 ${factoryId} 处于 ${current.phase}，只有 staged 计划可编辑。`
        + ' 运行中的调整请用 factory_message / factory_gate 的打回单，而不是改编制。',
    )
  }
  const spawned = current.members.filter(
    (member) => typeof member.sessionId === 'string' && member.sessionId !== '',
  )
  if (spawned.length > 0) {
    throw new FactoryToolError(
      `code-factory: 工厂 ${factoryId} 已有成员会话（${spawned.map((member) => member.role).join('、')}），编制已冻结，不能再用 factory_edit_plan 修改。`,
    )
  }

  const changedFields: string[] = []
  const briefInput = optional(input.brief)
  const nameInput = optional(input.name)
  const typeInput = optional(input.taskType)
  const noteInput = optional(input.note)
  if (briefInput !== undefined) changedFields.push('brief')
  if (nameInput !== undefined) changedFields.push('name')
  if (typeInput !== undefined) changedFields.push('taskType')
  if (input.members !== undefined && input.members.length > 0) changedFields.push('members')
  if (input.maxMembers !== undefined) changedFields.push('maxMembers')
  if (noteInput !== undefined) changedFields.push('note')
  if (changedFields.length === 0) {
    throw new FactoryToolError(
      'code-factory: 没有给出任何要修改的内容（brief / name / taskType / members / maxMembers / note 至少给一项）。',
    )
  }

  const brief = briefInput ?? current.brief
  const cap = sanitizeCap(input.maxMembers ?? call.config.maxMembers)
  const decision = decideRoster(
    brief,
    {
      ...(typeInput === undefined ? {} : { taskType: typeInput }),
      ...(input.members === undefined ? {} : { members: input.members }),
      maxMembers: cap,
    },
    call.config.maxMembers,
  )

  // `brief` / `name` / `taskType` / `pipeline` / `securityTriggered` are readonly on
  // `FactoryState` by contract, so an edit rebuilds the record instead of writing
  // into it — and it must be saved here, because `store.mutate` would persist the
  // object it loaded (and undo the edit).
  const edited = await call.store.withLock(factoryId, async (): Promise<FactoryState> => {
    const fresh = await call.store.loadOrThrow(factoryId)
    if (fresh.captainSessionId !== call.callerId) {
      throw new FactoryToolError(`code-factory: 只有队长能修改工厂 ${factoryId} 的计划。`)
    }
    if (fresh.phase !== 'staged') {
      throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 已不在 staged（当前 ${fresh.phase}），计划已被批准，不能再改。`)
    }
    if (fresh.members.some((member) => typeof member.sessionId === 'string' && member.sessionId !== '')) {
      throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 已有成员会话，编制已冻结。`)
    }
    const next: FactoryState = {
      ...fresh,
      brief,
      ...(nameInput === undefined ? {} : { name: nameInput }),
      taskType: decision.taskType,
      pipeline: decision.pipeline,
      securityTriggered: decision.securityTriggered,
      ...(decision.securityHits === undefined ? {} : { securityHits: [...decision.securityHits] }),
      ...(decision.securitySource === undefined ? {} : { securitySource: decision.securitySource }),
      members: freshMemberRecords(decision.team),
      stages: freshStageRecords(decision.pipeline),
      planReviewState: 'awaiting_review',
      updatedAt: call.store.now(),
    }
    await call.store.save(next, { touch: false })
    return next
  })

  await captainNote(
    call,
    factoryId,
    `[staged 计划修订] ${edited.name}\n改动字段: ${changedFields.join('、')}`
      + `${noteInput === undefined ? '' : `\n用户/队长说明: ${noteInput}`}\n`
      + `编制: ${decision.team.map(roleTitle).join('、')}\n流水线: ${edited.pipeline}（${edited.stages.length} 阶段）\n${decision.reasons.join('\n')}`,
  )

  const evolutionNotes = await evolutionPlanNotes(call)
  return {
    ...projectPlan(
      call,
      edited,
      { maxMembers: cap, reasons: decision.reasons, trimmed: decision.trimmed, trimmedRequired: decision.trimmedRequired, overCap: decision.overCap },
      { reusedPlan: false, notes: ['修订后仍处于 awaiting_review：必须重新等待用户批准，再调用 factory_approve。', ...evolutionNotes] },
    ),
    changedFields,
    editedAt: edited.updatedAt,
  }
}
