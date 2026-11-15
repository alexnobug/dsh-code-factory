/**
 * engine/gate.ts — factory_gate.
 *
 * The stage gate: it runs the template gate through the gate runner, takes
 * the domain verdict, rolls a failure back to `failGoto` with the corrective
 * list, and registers the artifacts a passed stage produced.
 *
 * Moved here verbatim from the former single-file `src/tools/engine.ts`
 * (engineering review finding M5). Only this header, the imports and the
 * `export` keywords on cross-module helpers are new — no body was edited.
 *
 * @module dsh-code-factory/tools/engine/gate
 */

import { randomUUID } from 'node:crypto'
import type { FactoryState, SecuritySignalSource, StageDef, GateAction, LessonKind } from '../../shared/types.js'
import { getStage, resolveStageRoles, stageIndex, getPipeline, isFinalStage, stageIds } from '../../domain/pipeline.js'
import { securitySignalForDocuments } from '../../domain/router.js'
import { SECURITY_ROLE_ID, canonicalRoleId, getRole, roleTitle } from '../../domain/roles.js'
import type { MemberDispatchFocus } from '../../prompt/member-brief.js'
import { LESSON_PROMPT_LIMIT } from '../../prompt/member-brief.js'
import { createWorkspaceArtifactReader } from '../../runtime/gates-runner.js'
import { dispatchToMember, findMember } from '../../runtime/members.js'
import { schedulerProbes, selectDispatchStage } from '../../runtime/scheduler.js'
import { selectLessonsForRole } from '../../store/evolution.js'
import { transitionStage } from '../../store/state.js'
import { FactoryToolError, loadFactory, mutateFactory, readEvolutionLessons, requireCaptainOf, requireFactoryId, jsonText, logLine } from '../context.js'
import type { ToolCallContext } from '../context.js'

import { optional, recordAttempt, settleAttempts, postMail, captainNote, freshMemberRecords, gateRunnerFor, commandRows } from './plumbing.js'
import { summarizeDodStates, summarizeDodAudit, dodRows } from './dod.js'
import type { CommandRow, DodItemRow, DodSummaryRow } from './plumbing.js'

/* ------------------------------------------------------------------- gate */

/** How one gate failure is rolled back. */
interface RollbackReport {
  readonly target: string
  readonly roles: string[]
  readonly resetStages: string[]
}
/** Rolls the pipeline back for a failed gate and reports who owns the rework. */
function rollbackFor(state: FactoryState, def: StageDef, currentIndex: number): RollbackReport {
  const target = def.failGoto ?? def.id
  const targetIndex = stageIndex(state.pipeline, target)
  const from = targetIndex >= 0 ? targetIndex : currentIndex
  const resetStages: string[] = []
  for (let index = from; index < currentIndex; index += 1) {
    const rec = state.stages[index]
    if (rec === undefined) continue
    transitionStage(rec, 'pending')
    resetStages.push(rec.id)
  }
  const targetRec = targetIndex >= 0 ? state.stages[targetIndex] : undefined
  if (targetRec !== undefined && targetRec.id !== def.id) {
    transitionStage(targetRec, 'pending')
    targetRec.round += 1
    resetStages.push(targetRec.id)
  }
  const targetDef = getStage(state.pipeline, target) ?? def
  const staffing = resolveStageRoles(targetDef, state.members.map((member) => member.role))
  const roles = staffing.assigned.length > 0 ? staffing.assigned : [...targetDef.roles]
  return { target, roles: roles.map(canonicalRoleId), resetStages }
}
/**
 * The verdict one gate evaluation produced, before it is projected for the tool.
 *
 * The stage status itself is already written into the record inside the same lock
 * window, so the verdict only carries what the tool result needs.
 */
interface StageVerdict {
  readonly action: GateAction
  readonly round: number
  readonly rollback: RollbackReport | undefined
  readonly woken: string[]
  readonly dodSummary: DodSummaryRow | undefined
  readonly dodItems: DodItemRow[] | undefined
}
/** Arguments of {@link gateFactory}. */
export interface GateFactoryInput {
  readonly factoryId: string
  readonly stageId?: string
  readonly findings?: string[]
  readonly humanConfirm?: boolean
  readonly minCommits?: number
}
/** Result of {@link gateFactory}. */
export interface GateFactoryResult {
  readonly summary: string
  readonly factoryId: string
  readonly action: string
  readonly phase: string
  readonly stageId: string
  readonly stageName: string
  readonly gateType: string
  readonly ok: boolean
  readonly detail: string
  readonly round: number
  readonly maxRounds: number
  readonly humanApproval: boolean
  readonly needsHumanConfirm: boolean
  readonly rejectedTo?: string
  readonly resetStages: string[]
  readonly findings: string[]
  readonly notifiedRoles: string[]
  readonly wokenRoles: string[]
  readonly refusedCommands: string[]
  readonly commands: CommandRow[]
  readonly dod?: DodSummaryRow
  readonly dodItems?: DodItemRow[]
  readonly nextStage?: string
  readonly nextStageName?: string
  readonly notes: string[]
  readonly nextAction: string
}
/**
 * Adjudicates one stage's gate with real evidence and applies the verdict.
 *
 * `advance` marks the stage passed; `reject` rolls back to `failGoto`, increments
 * the round and writes the corrective list (plus a rework turn) to the responsible
 * roles; `escalate` is the same rollback with the human in the loop because
 * `round >= maxRounds`; `await_approval` parks a `humanApproval` stage until the
 * user confirms; `delivered` means the last stage passed and only the DoD audit
 * and `factory_deliver` remain.
 */
export async function gateFactory(call: ToolCallContext, input: GateFactoryInput): Promise<GateFactoryResult> {
  const factoryId = requireFactoryId(input.factoryId)
  const head = await loadFactory(call, factoryId)
  requireCaptainOf(call, head)
  if (head.phase === 'staged') {
    throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 还在 staged —— 门禁裁决只对已批准（running）的工厂有意义。`)
  }
  if (head.phase === 'halted') {
    throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 已暂停（halted）—— 先 factory_resume 再裁决。`)
  }
  if (head.phase !== 'running') {
    throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 处于 ${head.phase}，没有待裁决阶段。`)
  }

  const requestedStage = optional(input.stageId)
  const selected = requestedStage === undefined ? selectDispatchStage(head) : undefined
  const stageIdResolved = requestedStage ?? selected?.rec.id
  if (stageIdResolved === undefined) {
    const dod = head.dod.length === 0 ? undefined : summarizeDodStates(head.dod, head.securityTriggered)
    return {
      summary: `工厂 ${factoryId} 的流水线所有阶段都已 passed —— 没有可裁决的门禁。下一步是 factory_dod_check（DoD 七条）后 factory_deliver。`,
      factoryId,
      action: 'delivered',
      phase: head.phase,
      stageId: '',
      stageName: '',
      gateType: 'dod',
      ok: true,
      detail: '所有阶段已通过',
      round: 0,
      maxRounds: 0,
      humanApproval: false,
      needsHumanConfirm: false,
      resetStages: [],
      findings: [],
      notifiedRoles: [],
      wokenRoles: [],
      refusedCommands: [],
      commands: [],
      ...(dod === undefined ? {} : { dod }),
      notes: ['流水线已全部通过；交付前必须跑 DoD 总验收。'],
      nextAction: '调用 factory_dod_check；七条全绿后 factory_deliver。',
    }
  }
  const def = getStage(head.pipeline, stageIdResolved)
  const rec = head.stages.find((stage) => stage.id === stageIdResolved)
  if (def === undefined || rec === undefined) {
    throw new FactoryToolError(
      `code-factory: 工厂 ${factoryId} 的流水线 ${head.pipeline} 里没有阶段 ${JSON.stringify(stageIdResolved)}。可用阶段: ${stageIds(head.pipeline).join('、')}。`,
    )
  }

  const confirm = input.humanConfirm === true
  const findings = (input.findings ?? []).map((item) => String(item).trim()).filter((item) => item !== '')
  const runner = gateRunnerFor(call, call.config.allowNodeFallback)

  // Human-approval short circuit: the stored verdict is durable evidence, so a
  // confirmed approval does not re-run the stage's commands (no double side
  // effects on the deliver stage).
  const storedPass = rec.status === 'gate' && rec.lastGate?.ok === true
  const runnerOutput = confirm && storedPass
    ? undefined
    : await runner.runGateDetailed(def.gate, {
        pipeline: head.pipeline,
        stageId: def.id,
        round: rec.round,
        securityTriggered: head.securityTriggered,
        ...(input.minCommits === undefined ? {} : { minCommits: input.minCommits }),
        signal: call.signal,
      })

  const evaluation = runnerOutput?.evaluation
  const gateOk = runnerOutput === undefined ? true : evaluation?.ok === true
  const detail = runnerOutput === undefined
    ? `用户已确认 humanApproval 阶段「${def.name}」的产出（沿用上一轮门禁证据）`
    : (evaluation?.detail ?? '门禁未给出结论')
  const pendingEvidence = evaluation?.needsExecution === true
  const dodSummary = runnerOutput?.dod === undefined
    ? undefined
    : summarizeDodAudit(runnerOutput.dod.audit.summary)
  const dodItemRows = runnerOutput?.dod === undefined ? undefined : dodRows(runnerOutput.dod.audit.results)

  // Artifact reads that failed for a reason other than "missing". The domain only
  // ever sees `undefined` from the reader (`domain.gates.readArtifactFor`), so a
  // locked, permission-denied or oversized document reaches the verdict as
  // `工件不存在`. Carrying the real reason into the corrective list is what keeps
  // the captain from hunting a phantom missing file and rewriting a document that
  // is sitting right there.
  const readErrors = runnerOutput?.readErrors ?? []
  const readErrorFindings = readErrors.map(
    (item) =>
      `工件读取被拒绝: \`${item.path}\` — ${item.reason}`
      + '（文件可能存在但读不到：先关掉占用它的进程或修权限，不要当成"缺失"重写一遍）',
  )
  const corrective = [...findings, ...readErrorFindings]

  const probes = schedulerProbes(call.plugin)
  // Read the workspace ledger once, BEFORE the locked mutation. The reject path
  // needs it for the rework turn (the members being woken must see the history),
  // and the pass path needs it for the resolution stamp. The record of THIS
  // rejection happens after the verdict so a ledger failure cannot affect it.
  const lessonLedger = await readEvolutionLessons(call)
  const { value, state } = await mutateFactory(call, factoryId, async (current): Promise<StageVerdict> => {
    if (current.captainSessionId !== call.callerId) {
      throw new FactoryToolError(`code-factory: 只有队长能裁决工厂 ${factoryId} 的门禁。`)
    }
    if (current.phase !== 'running') {
      throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 处于 ${current.phase}，不能裁决门禁。`)
    }
    const stageRec = current.stages.find((stage) => stage.id === def.id)
    if (stageRec === undefined) throw new FactoryToolError(`code-factory: 状态记录缺少阶段 ${def.id}。`)
    const now = call.store.now()
    stageRec.lastGate = {
      type: evaluation?.type ?? def.gate.type,
      ok: gateOk,
      detail,
      at: evaluation?.at ?? now,
      ...(evaluation?.exitCode === undefined ? {} : { exitCode: evaluation.exitCode }),
      ...(def.gate.artifact === undefined ? {} : { artifact: def.gate.artifact }),
    }
    if (runnerOutput?.dod !== undefined) {
      // `status` rides along with `ok`: the two answer different questions, and
      // a row persisted without it would read back as "passed or failed" with a
      // skipped audit looking like a pass. See `H5` / `dodStatusOf`.
      current.dod = runnerOutput.dod.audit.results.map((item) => ({
        id: item.id,
        label: item.label,
        ok: item.ok,
        status: item.status,
        evidence: item.evidence,
      }))
    }

    // 1. humanApproval that has not been confirmed parks the stage.
    if (gateOk && def.humanApproval === true && !confirm) {
      transitionStage(stageRec, 'gate', now)
      return { action: 'await_approval', round: stageRec.round, rollback: undefined, woken: [], dodSummary, dodItems: dodItemRows }
    }

    // 2. pass.
    if (gateOk) {
      transitionStage(stageRec, 'passed', now)
      return {
        action: isFinalStage(current.pipeline, def.id) ? 'delivered' : 'advance',
        round: stageRec.round,
        rollback: undefined,
        woken: [],
        dodSummary,
        dodItems: dodItemRows,
      }
    }

    // 3. failure: record the round, roll back, then rework or escalate.
    stageRec.round += 1
    stageRec.endedAt = now
    const exhausted = def.maxRounds > 0 && stageRec.round >= def.maxRounds
    const currentIndex = stageIndex(current.pipeline, def.id)
    transitionStage(stageRec, 'rejected', now)
    const rollback = rollbackFor(current, def, currentIndex >= 0 ? currentIndex : 0)
    // `current`, not the outer `state`: this runs INSIDE the mutateFactory
    // callback, where the outer destructuring target is still in its temporal
    // dead zone. Reading it threw `ReferenceError: Cannot access 'state' before
    // initialization`, so a missing-evidence gate crashed instead of rejecting —
    // and because the throw happened before the save, the record was left
    // byte-identical, which made the whole rework loop unreachable.
    for (const role of def.roles) settleAttempts(current, role, def.id, call.store.now())

    if (exhausted) {
      return { action: 'escalate', round: stageRec.round, rollback, woken: [], dodSummary, dodItems: dodItemRows }
    }

    // Wake the responsible role with a rework turn and an attempt entry, so a
    // following factory_dispatch will not hand out the same work twice.
    const baseFocus = {
      stageId: rollback.target,
      round: stageRec.round,
      rework: {
        round: stageRec.round,
        findings: corrective.length > 0 ? corrective : [detail],
        gateDetail: detail,
        ...(def.failGoto === undefined ? {} : { failGoto: def.failGoto }),
      },
    } as const
    const woken: string[] = []
    for (const role of rollback.roles) {
      const roleDef = getRole(role)
      const member = findMember(current, role)
      if (roleDef === undefined || member?.sessionId === undefined || member.sessionId === '') continue
      // Historical lessons of THIS role: the rework order must repeat the past
      // mistakes the ledger remembers, not just this round's gate detail.
      const roleLessons = selectLessonsForRole(lessonLedger, role, undefined, LESSON_PROMPT_LIMIT)
      const focus: MemberDispatchFocus = {
        ...baseFocus,
        ...(roleLessons.length === 0 ? {} : { lessons: roleLessons }),
      }
      const send = await dispatchToMember(call.plugin, call.caller, roleDef, current, call.signal, {
        focus,
        rework: true,
        mode: 'steer',
        now: () => call.store.now(),
        lessons: lessonLedger,
      })
      if (!send.ok) continue
      woken.push(role)
      recordAttempt(
        current,
        {
          stageId: rollback.target,
          round: stageRec.round,
          role,
          kind: 'rework',
          sessionId: member.sessionId,
        },
        call.store.now(),
      )
    }
    return { action: 'reject', round: stageRec.round, rollback, woken, dodSummary, dodItems: dodItemRows }
  })

  const action = value.action
  const round = value.round
  const rollback = value.rollback
  const wokenRoles = value.woken
  const nextStageDef = action === 'advance' ? getPipeline(state.pipeline)[stageIndex(state.pipeline, def.id) + 1] : undefined

  // Evolution ledger: a rejected gate becomes durable lessons for the responsible
  // roles; a passed gate resolves this factory/stage's open lessons. Every failure
  // here is reported and swallowed — the verdict above must never be affected.
  const evolution = await recordGateEvolution(call, state, def, action, rollback, corrective, detail, gateOk)
  const evolutionNote =
    evolution.warning !== undefined
      ? `[进化库] 写入失败（不影响裁决）: ${evolution.warning}`
      : `[进化库] 已记录 ${evolution.recorded} 条教训 / 已标记 ${evolution.resolved} 条已解决`

  // Mailbox: the corrective list goes to every responsible role of the target
  // stage; the captain's own inbox gets the audit line.
  const notified: string[] = []
  if (rollback !== undefined) {
    const text = [
      `【门禁打回 · ${def.name}（${def.id}）第 ${round} 轮】`,
      `门禁类型: ${def.gate.type}；判定: ${detail}`,
      action === 'escalate'
        ? `打回轮次已用尽（${round}/${def.maxRounds}）：已升级人工，不要自行返工后宣称通过。`
        : `回退到阶段: ${rollback.target}（failGoto）；按下述清单修正后重新提交。`,
      corrective.length > 0 ? `整改清单:\n${corrective.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : '',
      `重置的阶段: ${rollback.resetStages.join('、') || '（无）'}`,
    ]
      .filter((line) => line !== '')
      .join('\n')
    for (const role of rollback.roles) {
      await postMail(call, factoryId, {
        id: randomUUID(),
        from: 'captain',
        to: role,
        content: text,
        kind: action === 'escalate' ? 'system' : 'reject',
        stage: rollback.target,
        round,
        ...(wokenRoles.includes(role) ? { deliveredAt: call.store.now() } : {}),
      })
      notified.push(role)
    }
  }
  await captainNote(
    call,
    factoryId,
    `[门禁裁决] ${def.name}(${def.id}) → ${action}；第 ${round}/${def.maxRounds} 轮；${detail}\n${evolutionNote}`,
    action === 'reject' ? 'reject' : 'system',
    { stage: def.id, round },
  )

  // Register the stage's own artifacts (only the ones that really exist).
  const registered = await registerGateArtifacts(call, state, def, rollback?.roles[0] ?? def.roles[0] ?? 'captain')

  const notes: string[] = []
  if (evolution.recorded > 0) {
    notes.push(
      `已记录 ${evolution.recorded} 条教训到进化库（工厂 ${factoryId}）`
        + '—— 返工单与后续任务的成员简报会自动带上这些历史教训。',
    )
  }
  if (evolution.resolved > 0) {
    notes.push(`已标记 ${evolution.resolved} 条历史教训为已解决（工厂 ${factoryId} / 阶段 ${def.id}）。`)
  }
  if (evolution.warning !== undefined) {
    notes.push(`教训库写入失败（已忽略，不影响门禁裁决）: ${evolution.warning}`)
  }
  if (rec.status === 'passed' && runnerOutput !== undefined) {
    notes.push('该阶段此前已 passed：本次按当前工件重新核验，结论覆盖上一次。')
  }
  if (pendingEvidence) {
    notes.push('门禁仍有未能执行的检查（无可用命令执行器，或命令被模板白名单拒绝）：这不是通过，按未达标处理。')
  }
  if (runnerOutput !== undefined && runnerOutput.refused.length > 0) {
    notes.push(`被拒绝执行的命令 ${runnerOutput.refused.length} 条 —— 命令只能来自流水线模板，不接受自由指定。`)
  }
  if (readErrors.length > 0) {
    notes.push(
      `工件读取失败 ${readErrors.length} 处（不是"文件不存在"）: `
        + readErrors.map((item) => `${item.path}（${item.reason}）`).join('；')
        + ' —— 已写进整改清单。',
    )
  }
  if (registered.length > 0) notes.push(`已登记工件: ${registered.join('、')}`)

  const escalation = await escalateSecurityFromDocuments(call, state)
  if (escalation !== undefined) {
    notes.push(
      `安全复评: 阶段 ${def.name}(${def.id}) 的工件里出现了 brief 没提到的安全机制（${escalation.hits.join('、')}）——` +
        `securityTriggered 已判为「触发」，securitySource=${escalation.source}，DoD 第 4 条不再按「未触发」跳过。这是只升不降的结论，后续门禁不会把它改回去。`,
    )
    for (const role of [SECURITY_ROLE_ID]) {
      await postMail(call, factoryId, {
        id: randomUUID(),
        from: 'captain',
        to: role,
        content:
          `安全复评：本工厂的工件里出现了 brief 未提及的安全机制（${escalation.hits.join('、')}），` +
          (escalation.addedRoles.length > 0 ? '你因此被加回编制。' : '') +
          '触发判定已改为「已触发安全路径」。请按 THREAT_MODEL.md 与 SECURITY_AUDIT.md 的要求工作。',
        kind: 'system',
        stage: def.id,
        round,
      })
    }
  }

  const summary =
    action === 'advance'
      ? `阶段 ${def.name}(${def.id}) 门禁通过 → advance${nextStageDef === undefined ? '' : `；下一阶段 ${nextStageDef.name}(${nextStageDef.id})，用 factory_dispatch 派发。`}`
      : action === 'delivered'
        ? `阶段 ${def.name}(${def.id}) 是最后一个阶段且门禁通过 → delivered：接下来 factory_dod_check，然后 factory_deliver。`
        : action === 'await_approval'
          ? `阶段 ${def.name}(${def.id}) 门禁已通过，但这是人工审批点（humanApproval）→ await_approval：把产出呈现给用户，拿到明确确认后再调用 factory_gate（humanConfirm=true）。`
          : action === 'reject'
            ? `阶段 ${def.name}(${def.id}) 门禁未通过（第 ${round} 轮）→ reject：已回退到 ${rollback?.target ?? def.id}，整改清单已发往 ${notified.map(roleTitle).join('、') || '责任角色'}。`
            : `阶段 ${def.name}(${def.id}) 门禁未通过且轮次已用尽（${round}/${def.maxRounds}）→ escalate：升级人工，禁止自行判通过。`

  return {
    summary,
    factoryId,
    action,
    phase: state.phase,
    stageId: def.id,
    stageName: def.name,
    gateType: def.gate.type,
    ok: gateOk,
    detail,
    round,
    maxRounds: def.maxRounds,
    humanApproval: def.humanApproval === true,
    needsHumanConfirm: action === 'await_approval',
    ...(rollback === undefined ? {} : { rejectedTo: rollback.target }),
    resetStages: rollback?.resetStages ?? [],
    findings,
    notifiedRoles: notified,
    wokenRoles,
    refusedCommands: [...(runnerOutput?.refused ?? [])],
    commands: commandRows(runnerOutput?.outcomes ?? []),
    ...(value.dodSummary === undefined ? {} : { dod: value.dodSummary }),
    ...(value.dodItems === undefined ? {} : { dodItems: value.dodItems }),
    ...(nextStageDef === undefined ? {} : { nextStage: nextStageDef.id, nextStageName: nextStageDef.name }),
    notes,
    nextAction:
      action === 'advance'
        ? `factory_dispatch 派发 ${nextStageDef?.id ?? '下一阶段'}（若它是 humanApproval，裁决前先问用户）。`
        : action === 'delivered'
          ? 'factory_dod_check → factory_deliver。'
          : action === 'await_approval'
            ? '把阶段产出与门禁证据呈现给用户，等明确确认；不要替用户拍板。'
            : action === 'reject'
              ? `等 ${notified.map(roleTitle).join('、') || '责任角色'} 按整改清单返工并 factory_report，然后重新 factory_gate。`
              : '把门禁原话、整改清单与轮次用尽的事实报给用户，等人工决定（放宽范围 / 手工修复 / 终止）。',
  }
}
/* ------------------------------------------- evolution ledger (lessons) */
/**
 * What one gate adjudication wrote to the workspace evolution ledger.
 *
 * `warning` is only set when the ledger itself failed. That is deliberately a
 * *note*, not an error: the gate verdict was already persisted and delivered, so
 * a broken lesson ledger must not turn a correct rejection into a crash.
 */
interface GateEvolutionReport {
  readonly recorded: number
  readonly resolved: number
  readonly warning?: string
}
/**
 * Turns one gate verdict into durable lessons (reject) or resolution stamps (pass).
 *
 * - **reject / escalate**: the corrective list (or, when there is none, the gate's
 *   own verdict line) is recorded once per responsible role — `rollback.roles`
 *   when the rollback resolved staffing, else the stage's declared roles. Each
 *   record carries the stage, `stageName`, `gateType`, `factoryId` and
 *   `taskType`; a `dod`-typed gate is recorded as `kind: 'dod'`.
 * - **pass** (including the humanApproval `await_approval` verdict): every open
 *   lesson of the SAME factory + stage (+ that stage's responsible roles) is
 *   stamped `resolvedAt`. Scoped on purpose — see `EvolutionStore.resolve`.
 *
 * Never throws: any ledger failure is logged and reported in `warning`.
 */
async function recordGateEvolution(
  call: ToolCallContext,
  state: FactoryState,
  def: StageDef,
  action: GateAction,
  rollback: RollbackReport | undefined,
  corrective: readonly string[],
  detail: string,
  gateOk: boolean,
): Promise<GateEvolutionReport> {
  try {
    if (gateOk) {
      const stageDef = getStage(state.pipeline, def.id) ?? def
      const staffing = resolveStageRoles(stageDef, state.members.map((member) => member.role))
      const roles = [...new Set((staffing.assigned.length > 0 ? staffing.assigned : stageDef.roles).map(canonicalRoleId))]
      if (roles.length === 0) return { recorded: 0, resolved: 0 }
      const resolved = await call.store.evolution.resolve({
        factoryId: state.id,
        stage: def.id,
        roles,
        at: call.store.now(),
      })
      return { recorded: 0, resolved }
    }
    if (action !== 'reject' && action !== 'escalate') return { recorded: 0, resolved: 0 }

    const target = rollback?.target ?? def.id
    const targetDef = getStage(state.pipeline, target) ?? def
    const roleSource = rollback !== undefined && rollback.roles.length > 0 ? rollback.roles : [...def.roles]
    const roles = [...new Set(roleSource.map(canonicalRoleId))]
    if (roles.length === 0) return { recorded: 0, resolved: 0 }
    const gateType = def.gate.type
    const kind: LessonKind = gateType === 'dod' ? 'dod' : 'gate'
    const texts = (corrective.length > 0 ? corrective : [detail])
      .map((text) => String(text).trim())
      .filter((text) => text !== '')
    if (texts.length === 0) return { recorded: 0, resolved: 0 }

    const report = await call.store.evolution.record(
      roles.flatMap((role) =>
        texts.map((text) => ({
          role,
          stage: target,
          stageName: targetDef.name,
          gateType,
          kind,
          text,
          detail,
          factoryId: state.id,
          taskType: state.taskType,
        })),
      ),
    )
    return { recorded: report.added + report.updated, resolved: 0 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logLine(call.plugin, 'warn', `进化教训库记录失败（已忽略，不影响门禁裁决）: ${message}`)
    return { recorded: 0, resolved: 0, warning: message }
  }
}
/* ------------------------------------------- security re-evaluation (H4) */
/**
 * Review finding H4: the plan-time security verdict reads one line of prose, so
 * 「做一个跑腿的微信小程序」 — WeChat login, customer and rider phone numbers,
 * addresses, payment — was recorded as `securityTriggered: false`, the DoD's
 * securityOnly item auto-passed as 「本次工厂未触发安全路径」 and the security
 * audit stage was never required.
 *
 * This runs after every gate and re-reads every artifact the pipeline declares,
 * so the requirements stage — the `humanApproval` point the finding named — is
 * where a missed verdict is caught.
 *
 * The only direction the verdict may move is **up**. A document that mentions
 * nothing can never talk a factory back off the security path, and a factory the
 * brief already triggered is never re-examined: 「只升不降」 is the whole
 * contract, and it is why a hand-edit cannot be laundered through a later gate.
 */
interface SecurityEscalation {
  readonly hits: readonly string[]
  readonly source: SecuritySignalSource
  readonly addedRoles: readonly string[]
}
/** Re-reads the artifacts the pipeline names and corrects a missed security verdict. */
async function escalateSecurityFromDocuments(
  call: ToolCallContext,
  state: FactoryState,
): Promise<SecurityEscalation | undefined> {
  const read = createWorkspaceArtifactReader(call.workspace)
  const texts: string[] = []
  for (const stageDef of getPipeline(state.pipeline)) {
    for (const relative of gateArtifacts(stageDef)) {
      const text = read(relative)
      if (text !== undefined) texts.push(text)
    }
  }
  if (texts.length === 0) return undefined

  const signal = securitySignalForDocuments(state.brief, texts)
  if (!signal.triggered) return undefined

  const addedRoles: string[] = []
  await call.store.mutate(state.id, (current) => {
    if (!current.securityTriggered) {
      current.securityTriggered = true
      current.securityHits = [...signal.hits]
      current.securitySource = signal.source
    }
    if (!current.members.some((row) => row.role === SECURITY_ROLE_ID)) {
      current.members.push(...freshMemberRecords([SECURITY_ROLE_ID]))
      addedRoles.push(SECURITY_ROLE_ID)
    }
  })

  return { hits: [...signal.hits], source: signal.source, addedRoles }
}
/** Every artifact path a gate tree references. */
function gateArtifacts(def: StageDef): string[] {
  const found: string[] = []
  const walk = (gate: StageDef['gate']): void => {
    if (gate.artifact !== undefined && !found.includes(gate.artifact)) found.push(gate.artifact)
    for (const child of gate.checks ?? []) walk(child)
  }
  walk(def.gate)
  return found
}
/** Registers the stage's artifacts that really exist on disk. */
async function registerGateArtifacts(
  call: ToolCallContext,
  state: FactoryState,
  def: StageDef,
  by: string,
): Promise<string[]> {
  const registered: string[] = []
  for (const relative of gateArtifacts(def)) {
    try {
      await call.store.primitives.stat(call.store.workspacePath(relative))
    } catch (error) {
      // A declared artifact that is not on disk yet is the normal case (ENOENT):
      // registering only what exists is the intent of this function. Every other
      // stat failure (EACCES, EBUSY, a directory that raced us) is NOT evidence of
      // absence — staying silent there would drop an artifact that is really
      // there. Same shape as the gate runner's artifact reader.
      const code = (error as { readonly code?: unknown } | null)?.code
      if (code !== 'ENOENT') {
        logLine(
          call.plugin,
          'warn',
          `工件 ${relative} 无法 stat（${typeof code === 'string' ? code : '未知错误'}）: ${jsonText(String(error))}`,
        )
      }
      continue
    }
    try {
      await call.store.registerArtifact(state.id, { path: relative, by: canonicalRoleId(by), stage: def.id }, { lock: true })
      registered.push(relative)
    } catch (error) {
      logLine(call.plugin, 'warn', `登记工件 ${relative} 失败: ${jsonText(String(error))}`)
    }
  }
  return registered
}
