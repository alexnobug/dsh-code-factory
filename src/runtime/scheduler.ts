/**
 * scheduler.ts — stage dispatch: **who** gets woken for **which** stage, and why
 * nobody else does.
 *
 * The plan's criticism of the original skeleton (§5.3 缺失 4) was exact:
 * 「谁在什么时候唤醒哪个成员？」 —— `approve` 里一次性 spawn 全部成员，与
 * "按需唤醒、空闲复用" 背道而驰. The scheduler therefore has two halves:
 *
 *  - {@link planStageDispatch} — **pure**. It reads the factory record, the
 *    dispatch ledger and the live-agent probe, and returns a decision per role
 *    with a reason. No I/O, no side effects: the same inputs always produce the
 *    same plan, which is what makes the "don't re-dispatch" rules testable.
 *  - {@link applyStageDispatch} — **imperative**. It executes exactly the
 *    decisions the plan marked as dispatches (spawn / wake / rework), updating the
 *    in-memory member and stage records. Persistence stays with the caller
 *    (`store.mutate`).
 *
 * The anti-duplicate rules the brief calls out are all here:
 *  1. a member with a **live executor** is never dispatched twice: a resident
 *     agent that is `running` waits, and a resident agent that is idle-but-live
 *     also waits (its accepted turn is in its inbox);
 *  2. an **unsettled attempt** (dispatched, no `factory_report` yet) is never
 *     re-dispatched while that executor is alive;
 *  3. staffing comes from `resolveStageRoles`, never from `stage.roles`, so a
 *     roster trimmed by the cap still has an executor per stage and an
 *     unstaffable stage is reported as `missingRoles` → escalate;
 *  4. a member whose **executor is gone** is *stranded*, not busy: it is
 *     re-dispatched with a **fresh attempt** (so the factory cannot dead-lock),
 *     and its stale status is reconciled back to `idle` when nothing is being
 *     dispatched right now.
 *
 * ## Stranded attempts (the cold-restart hole, fixed here)
 *
 * `factory.json` is the durable truth, and it says `working` for a member whose
 * turn was open when the host restarted — but a restarted host has no executor
 * for that member. Before rule 4, every plan answered `wait` forever
 * (「成员已在本阶段工作中，不重复派发」) and the factory dead-locked. The state
 * that reproduces it is durable and re-creatable from `factory.json` alone:
 * `phase: 'running'`, a member at `status: 'working'` whose `sessionId` no
 * longer resolves in `ctx.agents`, and its stage still at `status: 'active'`.
 *
 * The criterion is **deterministic first, temporal last**:
 *
 * | probe result | meaning | action |
 * |---|---|---|
 * | `ctx.agents.get(sessionId)` is an Agent | a live executor exists | **wait** — never re-dispatch |
 * | `ctx.agents.get(sessionId)` is `undefined` | nothing is executing this member right now | **recovery** — re-dispatch a fresh attempt |
 * | probe not wired (`isLive` omitted) | cannot tell | **wait**, unless the open attempt is older than {@link DEFAULT_STALE_AFTER_MS} |
 *
 * Evidence for the middle row: `ctx.agents.get(id)` is documented as "Look up a
 * live agent … or undefined when no live agent has that id"
 * (`@deepseek-ai/dsh-agent/lib/types/index.d.ts:339-343`), and the reference
 * plugin's `memberActivity()` uses exactly that lookup to classify a member as
 * `running | idle | ready`, where `ready` means "durable session, not resident,
 * cold-resumes on the next delivery" — i.e. not currently executing. A delivery
 * to such a member either cold-resumes it (new turn) or fails loudly with
 * `NOT_RESUMABLE` (`dsh-subagent/lib/index.js:1911-1917`), which is why the
 * recovery is safe *and* why a failed recovery escalates to a fresh session
 * instead of hanging.
 *
 * Time is deliberately **not** the primary criterion: a slow member is still a
 * live member (rule 1), so a timeout-based trigger would re-wake a working
 * member and duplicate its work. The staleness window survives only as the
 * documented fallback for a composition that cannot answer the liveness probe.
 *
 * ## Decisions must match what actually happens
 *
 * `plan.decisions` is the human-facing decision table of `factory_dispatch`, and
 * `plan.dispatches` is what really runs. Those two must agree, or the reader has
 * to repair the output with prose. Two states suppress dispatch entirely, and in
 * both of them every dispatching decision is rewritten as `wait` with the
 * suppressed intent kept in `parkedFrom` (see {@link parkDecision}):
 *
 *  - **the stage is parked on its gate verdict** (`status === 'gate'`): its
 *    artifact is already submitted, nobody may be sent to work on it, and
 *    `factory_gate` is the only correct unblock. Before this rule a parked stage
 *    reported e.g. `be_dev→wake` while `planned` was 0 (t23 observation 2);
 *  - **the plan escalates** (unstaffable role / rounds exhausted / blocked
 *    member): handing out work would contradict the plan's own verdict.
 *
 * ## Writing offline tests for this module
 *
 * The liveness criterion above means a fake host **must model agent residency**:
 * a host whose `ctx.agents.get()` always answers `undefined` makes every member —
 * including one it just spawned — look `gone`, so the planner emits a recovery
 * where the test expected a wait. `runtime/testing.ts` ships the model
 * (`createFakeMemberHost`: spawn registers, drain unregisters, `killSession`
 * emulates a cold restart) together with the full explanation of that false
 * `gone` mechanism. Use it instead of hand-rolling a probe.
 *
 * @module dsh-code-factory/runtime/scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  DispatchAttempt,
  FactoryState,
  LessonRecord,
  MemberState,
  MemberStatus,
  RoleDef,
  StageDef,
  StageStateRec,
} from '../shared/types.js'
import { getPipeline, getStage, isFinalStage, resolveStageRoles } from '../domain/pipeline.js'
import type { StageStaffing } from '../domain/pipeline.js'
import { canonicalRoleId, getRole, roleTitle } from '../domain/roles.js'
import type { MemberDispatchFocus, MemberReworkInstruction } from '../prompt/member-brief.js'
import { LESSON_PROMPT_LIMIT, renderMemberBrief } from '../prompt/member-brief.js'
import { selectLessonsForRole } from '../store/evolution.js'
import { transitionMember, transitionStage } from '../store/state.js'
import { isUnresumableDeliveryError } from './compat.js'
import type { MemberSpawnOptions, MemberSpawnResult } from './members.js'
import { dispatchToMember, findMember, memberLiveness, spawnMember } from './members.js'

/* ------------------------------------------------------------------ types */

/** What the scheduler decided to do for one role of one stage. */
export type DispatchAction = 'spawn' | 'wake' | 'rework' | 'wait' | 'skip' | 'escalate'

/**
 * One recorded dispatch. Re-exported from the shared contract because it is now
 * part of the durable `FactoryState` (`dispatchAttempts`), so the store, the tool
 * layer and this planner must agree on exactly one definition.
 */
export type { DispatchAttempt } from '../shared/types.js'

/** Everything the pure planner reads. */
export interface SchedulerInputs {
  readonly state: FactoryState
  /** The caller's dispatch ledger (may be empty on a fresh factory). */
  readonly attempts?: readonly DispatchAttempt[]
  /** Clock. */
  readonly now: number
  /** Live-agent probe; defaults to "unknown" so the plan stays pure. */
  readonly isLive?: (sessionId: string) => boolean
  /** Live `Agent.status === 'running'` probe; defaults to "unknown". */
  readonly isRunning?: (sessionId: string) => boolean | undefined
  /** Target stage override; otherwise the first non-passed stage is planned. */
  readonly stageId?: string
  /** An attempt older than this without a live activation is "stranded" (default 30 min). */
  readonly staleAfterMs?: number
  /** Concrete rejection items for a rework dispatch (the captain's own words). */
  readonly reworkFindings?: readonly string[]
  /** Artifacts the upstream stages produced, for the dispatch text. */
  readonly upstreamArtifacts?: readonly string[]
}

/** One decision, with its reason (the reason is user-facing). */
export interface DispatchDecision {
  readonly stageId: string
  readonly role: string
  /** Chinese title of the role, for logs and the cockpit. */
  readonly title: string
  readonly action: DispatchAction
  readonly reason: string
  readonly sessionId?: string
  /** True when executing this decision consumes one stage attempt. */
  readonly consumesAttempt: boolean
  /** Set for `rework` decisions. */
  readonly rework?: MemberReworkInstruction
  /**
   * Set when this decision exists because the member's executor was gone
   * (stranded recovery, rule 4). Recovery is never silent: this flag plus
   * {@link DispatchDecision.strandedEvidence} are what `factory_dispatch` /
   * `factory_status` show, and the consumed attempt lands in
   * `factory.json → stages[].attempts`.
   */
  readonly recoveredFromStranded?: boolean
  /** The probe result and timing behind a stranded recovery. */
  readonly strandedEvidence?: string
  /**
   * When a dispatching decision (`spawn` / `wake` / `rework`) was rewritten as
   * `wait` because this plan cannot dispatch (stage parked on its gate verdict, or
   * the plan escalates), the action it *would* have taken is preserved here.
   *
   * This is what keeps the plan self-consistent without losing information: the
   * decision table says `wait` (which is what actually happens — `planned=0`), and
   * `parkedFrom` records the intent that the suppression replaced.
   */
  readonly parkedFrom?: DispatchAction
}

/** What the liveness probe can say about one member's current executor. */
export type MemberExecutorState = 'live' | 'gone' | 'unknown'

/** Verdict of the executor probe for one member session. */
export interface MemberExecutorVerdict {
  readonly state: MemberExecutorState
  /** True only when a live executor reported `running`. */
  readonly running: boolean
}

/**
 * One durable-state repair the planner wants applied: a member whose status
 * claims activity that no executor is performing.
 *
 * Kept in the *plan* (not applied inside the pure planner) so it is testable and
 * visible, and so `applyStageDispatch` can report it the same way it reports a
 * dispatch. `factory_status` reads the resulting `idle` straight from
 * `factory.json` on the next call.
 */
export interface ReconcileAction {
  readonly role: string
  readonly from: MemberStatus
  readonly to: 'idle'
  readonly sessionId: string
  /** Stage the member claimed to be working on, when it recorded one. */
  readonly stageId?: string
  readonly reason: string
}

/** The plan for one stage. */
export interface StageDispatchPlan {
  readonly stageId: string
  readonly stageName: string
  readonly round: number
  readonly parallel: boolean
  readonly humanApproval: boolean
  readonly maxRounds: number
  readonly decisions: readonly DispatchDecision[]
  /** Decisions that must actually run, in order. */
  readonly dispatches: readonly DispatchDecision[]
  readonly staffing: StageStaffing
  /** Stage roles with neither a member nor a fallback. */
  readonly missingRoles: readonly string[]
  /** True when a human is needed (unstaffable role / rounds exhausted / blocked member). */
  readonly escalate: boolean
  readonly notes: readonly string[]
  readonly summary: string
  /** True when there is nothing to plan because the pipeline has no such stage. */
  readonly known: boolean
  /** Stale member statuses to converge back to `idle` (stranded executors). */
  readonly reconcile: readonly ReconcileAction[]
}

/* ------------------------------------------------------------- selection */

/**
 * The stage the engine should be working on: the first one in template order that
 * has not passed.
 *
 * A stage sitting in `gate` is deliberately *not* selected — it is waiting for a
 * `factory_gate` verdict (or a human approval), and dispatching again would be
 * exactly the duplicate work this module exists to prevent.
 *
 * @param state - the factory record.
 * @param stageId - optional explicit stage.
 * @returns the stage record and definition, or `undefined` when everything passed.
 */
export function selectDispatchStage(
  state: FactoryState,
  stageId?: string,
): { readonly rec: StageStateRec; readonly def: StageDef } | undefined {
  const stages = getPipeline(state.pipeline)
  const pick = (id: string): { rec: StageStateRec; def: StageDef } | undefined => {
    const rec = state.stages.find((candidate) => candidate.id === id)
    const def = getStage(state.pipeline, id)
    return rec === undefined || def === undefined ? undefined : { rec, def }
  }
  if (stageId !== undefined) return pick(stageId)
  for (const def of stages) {
    const rec = state.stages.find((candidate) => candidate.id === def.id)
    if (rec === undefined || rec.status === 'passed') continue
    if (rec.status === 'gate') return { rec, def }
    return { rec, def }
  }
  return undefined
}

/** Builds the rework instruction from the stage's own last gate verdict. */
export function reworkInstructionFor(
  rec: StageStateRec,
  def: StageDef,
  findings?: readonly string[],
): MemberReworkInstruction {
  const items = (findings ?? []).map((item) => item.trim()).filter((item) => item.length > 0)
  const fallback = rec.lastGate?.detail !== undefined && rec.lastGate.detail.length > 0 ? [rec.lastGate.detail] : []
  return {
    round: Math.max(0, rec.round),
    findings: items.length > 0 ? items : fallback,
    ...(rec.lastGate?.detail !== undefined ? { gateDetail: rec.lastGate.detail } : {}),
    ...(def.failGoto !== undefined ? { failGoto: def.failGoto } : {}),
  }
}

/* ------------------------------------------------------- executor probing */

/**
 * Reads the executor verdict for one member session.
 *
 * See the module header for why `ctx.agents.get()` is the criterion: a missing
 * live agent means *no executor is running this member right now*, which is
 * exactly the state a cold restart leaves behind — and the only state in which
 * re-dispatching cannot duplicate work, because there is nothing to duplicate.
 *
 * @param inputs - planner inputs (carries the probes).
 * @param sessionId - the member's durable child session id.
 * @returns `live` (a resident agent answers), `gone` (the probe answered and no
 *   resident agent exists) or `unknown` (no probe wired in this composition).
 */
export function memberExecutorVerdict(inputs: SchedulerInputs, sessionId: string): MemberExecutorVerdict {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return { state: 'unknown', running: false }
  const live = inputs.isLive?.(sessionId)
  if (live === undefined) return { state: 'unknown', running: false }
  if (live !== true) return { state: 'gone', running: false }
  return { state: 'live', running: inputs.isRunning?.(sessionId) === true }
}

/** The most recent time the open work for (stage, role) was handed out. */
function lastHandoutAt(
  inputs: SchedulerInputs,
  rec: StageStateRec,
  member: MemberState,
  role: string,
): number | undefined {
  const roleId = canonicalRoleId(role)
  const latest = (inputs.attempts ?? [])
    .filter((attempt) => attempt.stageId === rec.id && canonicalRoleId(attempt.role) === roleId)
    .sort((left, right) => right.dispatchedAt - left.dispatchedAt)[0]
  return latest?.dispatchedAt ?? member.startedAt
}

/** `123s 前` / `无时间戳`, for decision reasons. */
function ageTextOf(now: number, at: number | undefined): string {
  if (at === undefined) return '时间戳未知'
  return `${Math.max(0, Math.round((now - at) / 1000))}s 前`
}

/** One-line probe evidence, quoted into the decision reason. */
function executorEvidence(verdict: MemberExecutorVerdict, sessionId: string, dispatchedAt: number | undefined, now: number): string {
  const probe =
    verdict.state === 'live'
      ? `运行时在场（${verdict.running ? 'running' : 'idle'}）`
      : verdict.state === 'gone'
        ? 'ctx.agents.get 未返回该会话（无在场执行者）'
        : '本 composition 未提供 liveness 探针'
  return `执行者: ${probe}；上次派发 ${ageTextOf(now, dispatchedAt)}；childId=${sessionId}`
}

/**
 * Builds the stranded-recovery decision: hand the pending work out **again**,
 * with a fresh attempt.
 *
 * A stage that was already rejected recovers as a `rework` (the member owes the
 * fix from `failGoto`), everything else as a `wake`. Both consume an attempt, so
 * the recovery is visible as `stages[].attempts` +1 in `factory.json` and in the
 * `factory_dispatch` decision table — never a silent retry.
 */
function recoveryDecision(
  rec: StageStateRec,
  def: StageDef,
  base: { readonly stageId: string; readonly role: string; readonly title: string },
  sessionId: string,
  inputs: SchedulerInputs,
  evidence: string,
  lead: string,
): DispatchDecision {
  const wantsRework = rec.round > 0
  return {
    ...base,
    action: wantsRework ? 'rework' : 'wake',
    sessionId,
    consumesAttempt: true,
    recoveredFromStranded: true,
    strandedEvidence: evidence,
    reason: `${lead}；stranded 恢复：用新 attempt 重派（attempts +1，可在 factory_status 看到）`,
    ...(wantsRework ? { rework: reworkInstructionFor(rec, def, inputs.reworkFindings) } : {}),
  }
}

/** True for the actions that hand work to a member when they run. */
export function isDispatchingDecision(decision: DispatchDecision): boolean {
  return decision.action === 'spawn' || decision.action === 'wake' || decision.action === 'rework'
}

/**
 * Rewrites a decision that this plan will **not** execute as a `wait`.
 *
 * Why this exists (t23 observation 2): `factory_dispatch` renders the decision
 * table next to `planned`, so a plan that dispatches nothing must not contain a
 * decision claiming it will wake somebody — `wake` + `planned=0` reads as a
 * contradiction and sends the reader looking for a bug instead of calling
 * `factory_gate`. Two things suppress dispatch, and both go through here:
 *
 *  - `awaitingVerdict`: the stage is parked on its gate verdict. Its artifact is
 *    already submitted, so nobody may be sent to work on it; `factory_gate` is
 *    the only correct unblock. (Reported by tools-dev in t23: a parked stage
 *    still showed `be_dev→wake` while `planned` was 0.)
 *  - `escalate`: the plan needs a human (unstaffable role / rounds exhausted /
 *    blocked member), so handing out work would contradict its own verdict.
 *
 * The original action and reason are preserved (`parkedFrom` + the quoted reason)
 * so the suppressed intent stays diagnosable.
 *
 * @param decision - the decision the planner computed in isolation.
 * @param def - the stage it belongs to.
 * @param awaitingVerdict - true when the stage sits in `gate`.
 * @param escalate - true when the plan escalates.
 * @returns a `wait` decision (or the original when it was already non-dispatching).
 */
export function parkDecision(
  decision: DispatchDecision,
  def: StageDef,
  awaitingVerdict: boolean,
  escalate: boolean,
): DispatchDecision {
  const dispatching = isDispatchingDecision(decision)
  // A decision is suppressed when the plan will not do what it says:
  //  - a dispatching action, while the plan dispatches nothing at all;
  //  - an `escalate` action, while the plan itself reports `escalate: false`
  //    (that happens when a parked stage outranks the member-level escalation —
  //    the artifact is already submitted, so `factory_gate` comes first).
  const suppressed = dispatching ? awaitingVerdict || escalate : decision.action === 'escalate' && !escalate
  if (!suppressed) return decision
  const lead = awaitingVerdict
    ? `阶段 ${def.name}（\`${def.id}\`）停在门禁裁决：本阶段不会派发任何成员，唯一正确的解封动作是 factory_gate 出裁决`
    : `本轮不派发（计划判定需要人工介入）：先处理人工卡点，再重新 factory_dispatch`
  return {
    stageId: decision.stageId,
    role: decision.role,
    title: decision.title,
    action: 'wait',
    consumesAttempt: false,
    parkedFrom: decision.action,
    ...(decision.sessionId === undefined ? {} : { sessionId: decision.sessionId }),
    reason: `${lead}；被抑制的原判定「${decision.action}」: ${decision.reason}`,
  }
}

/* ---------------------------------------------------------------- planner */

function decideForRole(
  inputs: SchedulerInputs,
  rec: StageStateRec,
  def: StageDef,
  role: string,
  member: MemberState,
): DispatchDecision {
  const stageId = def.id
  const title = roleTitle(role)
  const base = { stageId, role, title }
  const roleId = canonicalRoleId(role)
  const unsettled = (inputs.attempts ?? [])
    .filter((attempt) => attempt.stageId === stageId && canonicalRoleId(attempt.role) === roleId && attempt.settledAt === undefined)
    .sort((left, right) => right.dispatchedAt - left.dispatchedAt)[0]

  if (member.status === 'removed') {
    return { ...base, action: 'skip', reason: '成员已回收（removed），不再派发；如需继续请先重新入编', consumesAttempt: false }
  }

  const sessionId = member.sessionId
  if (sessionId === undefined || sessionId.length === 0) {
    if (member.status === 'error' && member.spawnError !== undefined) {
      return {
        ...base,
        action: 'escalate',
        reason: `成员会话创建失败：${member.spawnError}`,
        consumesAttempt: false,
      }
    }
    return {
      ...base,
      action: 'spawn',
      reason: '成员尚未创建会话；本次派发同时完成创建（初始简报即第一张派工单）',
      consumesAttempt: true,
    }
  }

  const verdict = memberExecutorVerdict(inputs, sessionId)
  const handedOutAt = lastHandoutAt(inputs, rec, member, role)
  const evidence = executorEvidence(verdict, sessionId, handedOutAt, inputs.now)
  const staleAfter = inputs.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const age = handedOutAt === undefined ? 0 : inputs.now - handedOutAt
  const onThisStage = member.currentStage === stageId

  // — an open dispatch recorded for this very stage/role
  if (unsettled !== undefined) {
    if (verdict.state === 'live') {
      return {
        ...base,
        action: 'wait',
        sessionId,
        consumesAttempt: false,
        reason: verdict.running
          ? `已有未完成派发（第 ${unsettled.round} 轮，${ageTextOf(inputs.now, unsettled.dispatchedAt)}）且成员正在运行，不重复派发`
          : `已有未完成派发（第 ${unsettled.round} 轮）且成员在场（空闲）——等它用 factory_report 回报，不重复派发`,
      }
    }
    if (verdict.state === 'gone') {
      return recoveryDecision(
        rec,
        def,
        base,
        sessionId,
        inputs,
        evidence,
        `未完成派发（第 ${unsettled.round} 轮，${ageTextOf(inputs.now, unsettled.dispatchedAt)}）但执行者已不在场`,
      )
    }
    if (age > staleAfter) {
      return recoveryDecision(
        rec,
        def,
        base,
        sessionId,
        inputs,
        evidence,
        `未完成派发（第 ${unsettled.round} 轮，${ageTextOf(inputs.now, unsettled.dispatchedAt)}）无法判定执行者且已超过 ${Math.round(staleAfter / 1000)}s 停滞阈值`,
      )
    }
    return {
      ...base,
      action: 'wait',
      sessionId,
      consumesAttempt: false,
      reason: `已有未完成派发（第 ${unsettled.round} 轮），执行者不可判定且未超时（${ageTextOf(inputs.now, unsettled.dispatchedAt)}）`,
    }
  }

  if (member.status === 'blocked') {
    return {
      ...base,
      action: 'escalate',
      sessionId,
      reason: '成员上报 BLOCKED，需要队长/人工介入后才能继续',
      consumesAttempt: false,
    }
  }

  // — no open ledger entry (typically: the host restarted and the process-local
  //   ledger was lost), so the durable member record is the only signal left.
  if (onThisStage && (member.status === 'working' || member.status === 'rework')) {
    if (verdict.state === 'live') {
      return {
        ...base,
        action: 'wait',
        sessionId,
        consumesAttempt: false,
        reason: verdict.running
          ? `成员已在本阶段工作中且执行者正在运行，不重复派发`
          : `成员已在本阶段工作中，执行者在场（空闲，已受理的回合在它的收件箱里），不重复派发`,
      }
    }
    if (verdict.state === 'gone') {
      return recoveryDecision(
        rec,
        def,
        base,
        sessionId,
        inputs,
        evidence,
        `成员记录为 ${member.status}（阶段 ${stageId}）但执行者已不在场`,
      )
    }
    if (handedOutAt !== undefined && age > staleAfter) {
      return recoveryDecision(
        rec,
        def,
        base,
        sessionId,
        inputs,
        evidence,
        `成员记录为 ${member.status}（阶段 ${stageId}）且无法判定执行者，已超过 ${Math.round(staleAfter / 1000)}s 停滞阈值`,
      )
    }
    return {
      ...base,
      action: 'wait',
      sessionId,
      consumesAttempt: false,
      reason:
        `成员已在本阶段工作中（记录 ${member.status}，阶段 ${stageId}），`
        + `执行者不可判定且未超时（${ageTextOf(inputs.now, handedOutAt)}），不重复派发`,
    }
  }

  if (onThisStage && member.status === 'done') {
    if (rec.round > 0) {
      return {
        ...base,
        action: 'rework',
        sessionId,
        consumesAttempt: true,
        rework: reworkInstructionFor(rec, def, inputs.reworkFindings),
        reason: `成员已上报但本阶段已被门禁打回 ${rec.round} 轮，需要按打回单返工`,
      }
    }
    return {
      ...base,
      action: 'wait',
      sessionId,
      consumesAttempt: false,
      reason: '成员已完成本阶段并上报，等 factory_gate 裁决（不重复派发同一份工作）',
    }
  }

  if (rec.round > 0) {
    const rework = reworkInstructionFor(rec, def, inputs.reworkFindings)
    return {
      ...base,
      action: 'rework',
      sessionId,
      reason: `本阶段已被门禁打回 ${rec.round} 轮，需要按打回单返工`,
      consumesAttempt: true,
      rework,
    }
  }
  return {
    ...base,
    action: 'wake',
    sessionId,
    reason: '成员已就绪，唤醒它开始本阶段',
    consumesAttempt: true,
  }
}

/* ------------------------------------------------------- state reconcile */

/**
 * Finds members whose durable status claims activity that no executor is
 * performing, and converges them back to `idle`.
 *
 * Pure, and exported on purpose: `scheduler.ts` applies these actions through
 * {@link applyStageDispatch}, while `factory_status` (engine side) may call the
 * same predicate later to *explain* a stale roster without mutating anything.
 *
 * A member that is the target of a dispatch in this same call is excluded — that
 * dispatch sets the correct status itself, and flipping it first would hide the
 * recovery.
 *
 * @param inputs - planner inputs (probes + state).
 * @param excludeRoles - roles this plan is about to dispatch.
 * @returns the repairs to apply, in roster order.
 */
export function reconcileStrandedMembers(
  inputs: SchedulerInputs,
  excludeRoles: readonly string[] = [],
): readonly ReconcileAction[] {
  if (inputs.state.phase !== 'running') return []
  const excluded = new Set(excludeRoles.map(canonicalRoleId))
  const actions: ReconcileAction[] = []
  for (const member of inputs.state.members) {
    if (member.status !== 'working' && member.status !== 'rework') continue
    const sessionId = member.sessionId
    if (sessionId === undefined || sessionId.length === 0) continue
    const roleId = canonicalRoleId(member.role)
    if (excluded.has(roleId)) continue
    const verdict = memberExecutorVerdict(inputs, sessionId)
    if (verdict.state !== 'gone') continue
    actions.push({
      role: roleId,
      from: member.status,
      to: 'idle',
      sessionId,
      ...(member.currentStage === undefined ? {} : { stageId: member.currentStage }),
      reason:
        `执行者不在场（ctx.agents.get 未返回 ${sessionId}）⇒ 状态 ${member.status} 已过期，收敛为 idle，`
        + '下一次 factory_dispatch 会按 stranded 恢复重新派发',
    })
  }
  return actions
}

/** Default staleness window, used only when the liveness probe is unavailable. */
export const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000

/**
 * Plans one stage's dispatch. Pure.
 *
 * @param inputs - state, ledger, live probes and clock.
 * @returns the plan; `known: false` when the requested stage does not exist.
 */
export function planStageDispatch(inputs: SchedulerInputs): StageDispatchPlan {
  const found = selectDispatchStage(inputs.state, inputs.stageId)
  const notes: string[] = []
  if (found === undefined) {
    const stageId = inputs.stageId ?? ''
    const reconcile = reconcileStrandedMembers(inputs)
    return {
      stageId,
      stageName: stageId,
      round: 0,
      parallel: false,
      humanApproval: false,
      maxRounds: 0,
      decisions: [],
      dispatches: [],
      staffing: { stageId, assigned: [], direct: [], substituted: [], missing: [], fallbackUsed: false },
      missingRoles: [],
      escalate: false,
      notes: ['流水线没有更多未通过阶段：可以进入 DoD 总验收 / 交付'],
      summary: '没有待派发的阶段',
      known: false,
      reconcile,
    }
  }

  const { rec, def } = found
  const team = inputs.state.members.map((member) => member.role)
  const staffing = resolveStageRoles(def, team)
  const decisionsAll: DispatchDecision[] = []

  for (const role of staffing.assigned) {
    const member = findMember(inputs.state, role)
    if (member === undefined) {
      decisionsAll.push({
        stageId: def.id,
        role,
        title: roleTitle(role),
        action: 'escalate',
        reason: '编制里找不到该角色的成员记录（状态与编制不一致）',
        consumesAttempt: false,
      })
      continue
    }
    decisionsAll.push(decideForRole(inputs, rec, def, role, member))
  }

  if (staffing.fallbackUsed) {
    notes.push(
      `编制被上限裁剪，替补阶梯顶上：${staffing.substituted.map((item) => `${roleTitle(item.required)}→${roleTitle(item.assigned)}`).join('、')}`,
    )
  }
  if (staffing.missing.length > 0) {
    notes.push(`无法落实的阶段角色: ${staffing.missing.map(roleTitle).join('、')}（替补表也找不到人）`)
  }
  const awaitingVerdict = rec.status === 'gate'
  if (awaitingVerdict) {
    notes.push('当前阶段停在门禁裁决：应先 factory_gate 出裁决，而不是重新派发')
  }
  if (def.maxRounds > 0 && rec.round >= def.maxRounds) {
    notes.push(`打回轮次已用尽（${rec.round}/${def.maxRounds}）：必须升级人工，不能再自动返工`)
  }
  if (isFinalStage(inputs.state.pipeline, def.id)) {
    notes.push('这是最后一个阶段：门禁通过后走 DoD 总验收与交付')
  }

  const roundsExhausted = def.maxRounds > 0 && rec.round >= def.maxRounds
  const escalate =
    !awaitingVerdict
    && (staffing.missing.length > 0
      || roundsExhausted
      || decisionsAll.some((decision) => decision.action === 'escalate'))

  // A plan that dispatches nothing must say so per role: `wake` + `planned=0` is a
  // contradiction the caller had to paper over with prose (t23 observation 2), so
  // every suppressed dispatching decision is rewritten as `wait` here.
  const parked = awaitingVerdict || escalate
  const decisions = parked
    ? decisionsAll.map((decision) => parkDecision(decision, def, awaitingVerdict, escalate))
    : decisionsAll
  const downgraded = decisions.filter((decision) => decision.parkedFrom !== undefined)
  if (downgraded.length > 0) {
    notes.push(
      `decision 语义已对齐（${awaitingVerdict ? '阶段停在门禁裁决' : '本轮需要人工介入'}）：`
        + `${downgraded.map((decision) => `${roleTitle(decision.role)} ${String(decision.parkedFrom)}→wait`).join('、')}`
        + `；本次 planned=0，${awaitingVerdict ? '唯一正确的解封动作是 factory_gate' : '先处理人工卡点再重新 factory_dispatch'}`,
    )
  }

  const dispatches = parked ? [] : decisions.filter(isDispatchingDecision)

  // Status repair for members nobody is executing. Roles this plan dispatches are
  // excluded: their fresh dispatch sets the status itself.
  const reconcile = reconcileStrandedMembers(
    inputs,
    dispatches.map((decision) => decision.role),
  )
  if (reconcile.length > 0) {
    notes.push(
      `成员状态收敛（stranded）：${reconcile
        .map((action) => `${roleTitle(action.role)} ${action.from}→${action.to}`)
        .join('、')} —— 执行者不在场，状态已过期`,
    )
  }
  // Only count recoveries that will actually run: a parked plan dispatches nothing.
  const recovered = decisions.filter((decision) => decision.recoveredFromStranded === true)
  if (recovered.length > 0) {
    notes.push(
      `stranded 恢复：${recovered.map((decision) => roleTitle(decision.role)).join('、')} 的执行者已消失，`
        + '本次用新 attempt 重派（attempts +1），而不是无限等待',
    )
  }

  const summary =
    `${def.name}（\`${def.id}\`）第 ${rec.round} 轮：`
    + (awaitingVerdict ? '等待门禁裁决' : `${dispatches.length} 项派发`)
    + (decisions.some((decision) => decision.action === 'wait')
      ? `，${decisions.filter((decision) => decision.action === 'wait').length} 项等待`
      : '')
    + (downgraded.length > 0 ? `（${downgraded.length} 项原派发意图降级为 wait）` : '')
    + (recovered.length > 0 ? `，${recovered.length} 项 stranded 恢复` : '')
    + (reconcile.length > 0 ? `，${reconcile.length} 项状态收敛` : '')
    + (escalate ? '，需要升级人工' : '')

  return {
    stageId: def.id,
    stageName: def.name,
    round: rec.round,
    parallel: def.parallel === true,
    humanApproval: def.humanApproval === true,
    maxRounds: def.maxRounds,
    decisions,
    dispatches,
    staffing,
    missingRoles: staffing.missing,
    escalate,
    notes,
    summary,
    known: true,
    reconcile,
  }
}

/* ----------------------------------------------------------------- apply */

/** Options for {@link applyStageDispatch}. */
export interface ApplyDispatchOptions {
  /** Registered subagent provider name. */
  readonly provider: string
  /** Cancellation for every spawn/delivery. */
  readonly signal: AbortSignal
  /** Member-relative delegation budget (default 0). */
  readonly memberDepth?: number
  /** Extra tool names to deny for spawned members. */
  readonly extraDeny?: readonly string[]
  /** Clock override. */
  readonly now?: () => number
  /** Per-role label override. */
  readonly label?: (role: RoleDef, state: FactoryState) => string
  /** Builds the spawn options for one role (merged over the defaults). */
  readonly spawnOptions?: (role: RoleDef, state: FactoryState) => Partial<MemberSpawnOptions>
  /** Artifacts upstream stages produced (rendered into the dispatch). */
  readonly upstreamArtifacts?: readonly string[]
  /**
   * The workspace evolution ledger, read **once** by the engine before dispatch.
   *
   * Each dispatched role gets its own selected slice
   * (`selectLessonsForRole`, default 6) rendered as the 「历史教训」 block into
   * both the spawn brief and every later dispatch/steer text. Optional so an
   * offline planner test never has to touch the ledger.
   */
  readonly lessons?: readonly LessonRecord[]
  /**
   * Replace a member's session when a delivery proves it unresumable
   * (`NOT_RESUMABLE`). Default `true`: a dead child session is the one case where
   * retrying can never work, so the recovery creates a fresh one and records the
   * replacement. Set `false` to observe the raw failure instead.
   */
  readonly replaceUnresumableSession?: boolean
}
/** One executed decision. */
export interface AppliedDispatch {
  readonly role: string
  readonly stageId: string
  readonly action: DispatchAction
  readonly ok: boolean
  readonly sessionId?: string
  readonly messageId?: string
  readonly mode?: string
  /** The exact text delivered (or baked into the initial prompt) — mailbox copy. */
  readonly text?: string
  readonly error?: string
  /** Full spawn result when the decision spawned a member. */
  readonly spawn?: MemberSpawnResult
  /** Set when this dispatch recovered from a stranded attempt (fresh attempt). */
  readonly recoveredFromStranded?: boolean
  /**
   * The dead session id this dispatch replaced. Set when delivery proved the old
   * child unresumable (`NOT_RESUMABLE`) and the member was re-created on a fresh
   * session instead of retrying a session that can never answer.
   */
  readonly sessionReplaced?: string
}

/** Result of applying one plan. */
export interface StageDispatchOutcome {
  readonly stageId: string
  readonly applied: readonly AppliedDispatch[]
  readonly failed: readonly AppliedDispatch[]
  readonly spawned: readonly string[]
  readonly stageMarkedActive: boolean
  readonly escalate: boolean
  readonly notes: readonly string[]
  readonly summary: string
  /** Stale member statuses that were converged back to `idle`. */
  readonly reconciled: readonly ReconcileAction[]
}

/**
 * Executes one plan against the live runtime and the in-memory factory record.
 *
 * A `spawn` decision bakes the stage dispatch into the member's **initial prompt**
 * (`renderMemberBrief(role, state, focus)`) instead of sending a second turn: the
 * brief already carries the stage's gate requirements, and one turn means the
 * member starts working immediately rather than after a round-trip.
 *
 * Two recovery behaviours live here:
 *  - **status reconciliation** — `plan.reconcile` converges members whose claimed
 *    activity has no executor back to `idle`, so `factory_status` stops showing a
 *    working member that nothing is running;
 *  - **dead-session replacement** — when a recovery delivery fails with a
 *    `NOT_RESUMABLE`-class error, the member's child session can never answer, so
 *    the session is dropped and a fresh one is created (recorded as
 *    `sessionReplaced`) instead of retrying a corpse.
 *
 * @param ctx - plugin context.
 * @param caller - the exact live captain agent.
 * @param state - the factory record (mutated in place; the caller persists it).
 * @param plan - a plan from {@link planStageDispatch}.
 * @param options - provider, signal and rendering knobs.
 * @returns what was applied, what failed, and whether the stage became active.
 */
export async function applyStageDispatch(
  ctx: Context,
  caller: Agent,
  state: FactoryState,
  plan: StageDispatchPlan,
  options: ApplyDispatchOptions,
): Promise<StageDispatchOutcome> {
  const now = options.now ?? Date.now
  const applied: AppliedDispatch[] = []
  const failed: AppliedDispatch[] = []
  const spawned: string[] = []

  // Reconciliation runs first and runs even when nothing is dispatched (a plan
  // parked on `factory_gate` still has to stop lying about its roster).
  const reconciled = applyReconcile(state, plan.reconcile, now)

  if (!plan.known || plan.dispatches.length === 0) {
    return {
      stageId: plan.stageId,
      applied,
      failed,
      spawned,
      stageMarkedActive: false,
      escalate: plan.escalate,
      notes: plan.notes,
      reconciled,
      summary:
        (plan.escalate ? `阶段 ${plan.stageId} 需要升级人工，未派发` : `阶段 ${plan.stageId} 无派发项`)
        + (reconciled.length > 0 ? `；收敛 ${reconciled.length} 个过期成员状态` : ''),
    }
  }

  for (const decision of plan.dispatches) {
    const role = getRole(decision.role)
    if (role === undefined) {
      failed.push({
        role: decision.role,
        stageId: decision.stageId,
        action: decision.action,
        ok: false,
        error: `角色注册表里没有 ${decision.role}`,
      })
      continue
    }
    const roleLessons =
      options.lessons === undefined
        ? []
        : selectLessonsForRole(options.lessons, decision.role, undefined, LESSON_PROMPT_LIMIT)
    const focus: MemberDispatchFocus = {
      stageId: decision.stageId,
      round: decision.action === 'rework' ? (decision.rework?.round ?? plan.round) : plan.round,
      ...(decision.rework !== undefined ? { rework: decision.rework } : {}),
      ...(options.upstreamArtifacts !== undefined ? { upstreamArtifacts: options.upstreamArtifacts } : {}),
      ...(roleLessons.length === 0 ? {} : { lessons: roleLessons }),
    }
    const spawnFor = (extra: Partial<MemberSpawnOptions> = {}): Promise<MemberSpawnResult> =>
      spawnMember(ctx, caller, role, state, options.signal, {
        provider: options.provider,
        memberDepth: options.memberDepth ?? 0,
        extraDeny: options.extraDeny,
        initialPrompt: renderMemberBrief(role, state, focus),
        now,
        ...(options.spawnOptions?.(role, state) ?? {}),
        ...(options.label !== undefined ? { label: options.label(role, state) } : {}),
        ...extra,
      })
    const noteSpawnSuccess = (spawnResult: MemberSpawnResult): void => {
      spawned.push(spawnResult.role)
      // A fresh member received its whole brief as the initial prompt — that
      // prompt *is* the stage dispatch, so the record moves straight to
      // `working` instead of showing an idle LED while the member runs.
      const spawnedMember = findMember(state, spawnResult.role)
      if (spawnedMember !== undefined && !spawnResult.reused) {
        transitionMember(spawnedMember, 'working', now())
        spawnedMember.currentStage = decision.stageId
        spawnedMember.startedAt = spawnedMember.startedAt ?? now()
      }
    }

    if (decision.action === 'spawn') {
      const spawnResult = await spawnFor()
      if (spawnResult.ok) {
        noteSpawnSuccess(spawnResult)
        applied.push({
          role: spawnResult.role,
          stageId: decision.stageId,
          action: decision.action,
          ok: true,
          sessionId: spawnResult.childId,
          messageId: spawnResult.reused ? undefined : spawnResult.messageId,
          text: renderMemberBrief(role, state, focus),
          spawn: spawnResult,
        })
      } else {
        failed.push({
          role: spawnResult.role,
          stageId: decision.stageId,
          action: decision.action,
          ok: false,
          error: spawnResult.error,
          spawn: spawnResult,
        })
      }
      continue
    }

    const sendResult = await dispatchToMember(ctx, caller, role, state, options.signal, {
      focus,
      rework: decision.action === 'rework',
      mode: decision.action === 'rework' ? 'steer' : 'queue',
      now,
    })
    if (sendResult.ok) {
      applied.push({
        role: sendResult.role,
        stageId: decision.stageId,
        action: decision.action,
        ok: true,
        sessionId: sendResult.sessionId,
        ...(sendResult.messageId !== undefined ? { messageId: sendResult.messageId } : {}),
        ...(sendResult.mode !== undefined ? { mode: sendResult.mode } : {}),
        text: sendResult.text,
        ...(decision.recoveredFromStranded === true ? { recoveredFromStranded: true } : {}),
      })
      continue
    }

    // Delivery failed. If the host says the child cannot be resumed, the session
    // is dead: replace it rather than re-delivering into a corpse forever.
    const dead = isUnresumableDeliveryError(sendResult.error ?? '', sendResult.errorCode)
    const member = findMember(state, role)
    if (dead && options.replaceUnresumableSession !== false && member !== undefined) {
      const deadSessionId = member.sessionId
      delete member.sessionId
      delete member.spawnError
      transitionMember(member, 'idle', now())
      const replacement = await spawnFor()
      if (replacement.ok) {
        noteSpawnSuccess(replacement)
        applied.push({
          role: replacement.role,
          stageId: decision.stageId,
          action: decision.action,
          ok: true,
          sessionId: replacement.childId,
          messageId: replacement.reused ? undefined : replacement.messageId,
          text: renderMemberBrief(role, state, focus),
          spawn: replacement,
          ...(deadSessionId === undefined ? {} : { sessionReplaced: deadSessionId }),
          ...(decision.recoveredFromStranded === true ? { recoveredFromStranded: true } : {}),
        })
        continue
      }
      failed.push({
        role: replacement.role,
        stageId: decision.stageId,
        action: decision.action,
        ok: false,
        error:
          `会话 ${deadSessionId ?? '(无)'} 不可恢复（${sendResult.error ?? 'NOT_RESUMABLE'}），`
          + `改用新会话重派也失败：${replacement.error}`,
        spawn: replacement,
      })
      continue
    }

    failed.push({
      role: sendResult.role,
      stageId: decision.stageId,
      action: decision.action,
      ok: false,
      sessionId: sendResult.sessionId,
      error: sendResult.error,
      text: sendResult.text,
      ...(decision.recoveredFromStranded === true ? { recoveredFromStranded: true } : {}),
    })
  }

  let stageMarkedActive = false
  const rec = state.stages.find((candidate) => candidate.id === plan.stageId)
  if (rec !== undefined && applied.some((item) => item.ok)) {
    const consumed = plan.dispatches.filter((decision) => decision.consumesAttempt).length
    if (consumed > 0) rec.attempts += consumed
    if (rec.status === 'pending' || rec.status === 'rejected') {
      transitionStage(rec, 'active', now())
      stageMarkedActive = true
    }
    rec.startedAt = rec.startedAt ?? now()
  }

  const recoveredCount = applied.filter((item) => item.recoveredFromStranded === true).length
  const replaced = applied.filter((item) => item.sessionReplaced !== undefined)

  return {
    stageId: plan.stageId,
    applied,
    failed,
    spawned,
    stageMarkedActive,
    escalate: plan.escalate,
    notes: plan.notes,
    reconciled,
    summary:
      `阶段 ${plan.stageName}：派发 ${applied.length} 项成功`
      + (failed.length > 0 ? `，${failed.length} 项失败` : '')
      + (spawned.length > 0 ? `，新创建成员 ${spawned.length} 个` : '')
      + (recoveredCount > 0 ? `，其中 ${recoveredCount} 项为 stranded 恢复（attempts +${recoveredCount}）` : '')
      + (replaced.length > 0 ? `，替换不可恢复会话 ${replaced.length} 个` : '')
      + (reconciled.length > 0 ? `，收敛过期成员状态 ${reconciled.length} 个` : ''),
  }
}

/**
 * Applies the planner's status repairs to the in-memory record.
 *
 * @param state - the factory record.
 * @param actions - repairs from {@link reconcileStrandedMembers}.
 * @param now - clock, so a repair is stamped with the caller's time (the same
 *   convention `factory_halt` uses when it retires a member back to `idle`).
 * @returns the repairs that actually changed something.
 */
function applyReconcile(
  state: FactoryState,
  actions: readonly ReconcileAction[],
  now: () => number,
): readonly ReconcileAction[] {
  const done: ReconcileAction[] = []
  for (const action of actions) {
    const member = findMember(state, action.role)
    if (member === undefined) continue
    if (member.status !== action.from) continue
    transitionMember(member, action.to, now())
    member.endedAt = member.endedAt ?? now()
    done.push(action)
  }
  return done
}

/* ------------------------------------------------------------------ probes */

/** Builds the live probes the planner needs from the plugin context. */
export function schedulerProbes(
  ctx: Context,
): { readonly isLive: (sessionId: string) => boolean; readonly isRunning: (sessionId: string) => boolean | undefined } {
  return {
    isLive: (sessionId: string) => memberLiveness(ctx, sessionId).live,
    isRunning: (sessionId: string) => {
      const liveness = memberLiveness(ctx, sessionId)
      return liveness.live ? liveness.running : undefined
    },
  }
}
