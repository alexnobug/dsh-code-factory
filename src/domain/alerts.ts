/**
 * Pure derivation of "what needs a human" from the durable factory record.
 *
 * Why this module exists
 * ----------------------
 * Before it, an `escalate` verdict and an `await_approval` gate had **no
 * consumer**: the only thing that ever read them was the model turn that asked
 * for them, so a factory could sit parked for as long as the user never looked
 * at the panel, and a member that never acquired a session was visible only as
 * a `spawnError` field nobody rendered. The host exposes no notification API
 * (`docs/limitations.md` §10), so the honest fix is a channel that is derived
 * from disk on every read, cannot be dismissed, and is impossible to miss in
 * the panel.
 *
 * Contract
 * --------
 *  - **Pure.** No I/O, no clock, no randomness. The whole list is a function of
 *    `FactoryState` plus the pipeline template, which is why it can be asserted
 *    against fixtures and why it survives a reload and a cold restart.
 *  - **Derived, never stored.** There is no `alerts.json` to fall out of sync
 *    with `factory.json`; the list is recomputed on every snapshot.
 *  - **Total.** A stage id whose template disappeared from the registry still
 *    produces an alert — it degrades to the raw id instead of being dropped.
 *  - **Ordered.** `action` before `attention`, then pipeline order, then roster
 *    order. A renderer may take `[0]` and be right about the most urgent item.
 *
 * @module dsh-code-factory/domain/alerts
 */

import type { FactoryState, SnapshotAlert, StageStateRec } from '../shared/types.js'
import { getStage } from './pipeline.js'

/**
 * Every reason this factory is not green, most urgent first.
 *
 * @param state - the durable record read from `factory.json`.
 * @returns the alert list; empty means nothing is blocked on anyone.
 */
export function deriveAlerts(state: FactoryState): SnapshotAlert[] {
  const alerts: SnapshotAlert[] = []

  // A terminal factory has nothing left to act on. Reporting one would train the
  // reader to ignore the banner, which is worse than reporting nothing.
  if (state.phase === 'delivered' || state.phase === 'discarded') return alerts

  if (state.phase === 'halted') {
    alerts.push({
      id: 'halted',
      kind: 'halted',
      severity: 'action',
      title: '工厂已暂停',
      detail: 'halt 期间没有任何阶段会推进，成员也已停止。',
      next: '确认后调用 factory_resume（写明恢复原因）再 factory_dispatch。',
    })
  }

  if (state.phase === 'staged') {
    const awaitingReview = state.planReviewState === 'awaiting_review'
    alerts.push({
      id: `awaiting-plan-review:${state.planReviewState ?? 'staged'}`,
      kind: 'awaiting-plan-review',
      severity: 'action',
      title: awaitingReview ? '计划待你批准' : `计划处于 ${state.planReviewState ?? 'staged'} 状态`,
      detail: `工厂 ${state.id} 停在 staged：${state.members.length} 名成员已在编制内，但尚未创建任何子会话。`,
      next: '看过计划后调用 factory_approve 才会唤醒成员。',
    })
  }

  for (const stage of state.stages) {
    const template = getStage(state.pipeline, stage.id)
    const name = template?.name ?? stage.id
    const maxRounds = template?.maxRounds

    // Rounds exhausted is the escalation condition: the engine has no legal
    // move left, so this is always the loudest thing on the board.
    if (maxRounds !== undefined && stage.round >= maxRounds && stage.status !== 'passed') {
      alerts.push({
        id: `rounds-exhausted:${stage.id}`,
        kind: 'rounds-exhausted',
        severity: 'action',
        title: `轮次用尽：${name}`,
        detail: `阶段 ${stage.id} 已用掉 ${stage.round}/${maxRounds} 轮，状态 ${stage.status}。`,
        next: '门禁已无法自行通过：人工判断是放宽契约还是改需求，再决定 continue / amend / halt。',
        stage: stage.id,
      })
    }

    pushStageAlert(alerts, stage, name, template?.humanApproval === true)
  }

  for (const member of state.members) {
    const spawnError = member.spawnError
    if (spawnError !== undefined && spawnError !== '') {
      alerts.push({
        id: `member-error:${member.role}`,
        kind: 'member-error',
        severity: 'action',
        title: `成员未能启动：${member.role}`,
        detail: spawnError,
        next: '修掉启动错误后重新 factory_dispatch（或 factory_reassign_task 给别的成员）。',
        role: member.role,
      })
      continue
    }
    if (member.status === 'blocked') {
      alerts.push({
        id: `member-blocked:${member.role}`,
        kind: 'member-blocked',
        severity: 'action',
        title: `成员上报 BLOCKED：${member.role}`,
        detail: member.currentStage === undefined
          ? '该成员已停止，调度器不会再给它派活。'
          : `停在阶段 ${member.currentStage}，调度器不会再给它派活。`,
        next: '读它的 factory_block 说明，补齐缺失输入后用 factory_message 继续同一次尝试。',
        role: member.role,
      })
    }
  }

  return orderAlerts(alerts)
}

/**
 * The stage-level alerts, split out so the round/status rules stay readable.
 *
 * @param alerts - accumulator.
 * @param stage - the live stage record.
 * @param name - the human stage name (registry or raw id).
 * @param humanApproval - true when the template parks this stage on a person.
 */
function pushStageAlert(
  alerts: SnapshotAlert[],
  stage: StageStateRec,
  name: string,
  humanApproval: boolean,
): void {
  if (stage.status === 'rejected') {
    const detail = stage.lastGate === undefined
      ? `阶段 ${stage.id} 的门禁判定为打回。`
      : `门禁（${stage.lastGate.type}）打回：${stage.lastGate.detail}`
    alerts.push({
      id: `stage-rejected:${stage.id}`,
      kind: 'stage-rejected',
      severity: 'action',
      title: `门禁打回：${name}`,
      detail,
      next: '把打回条目写进 dispatch 的 findings 交回责任角色，不要自己判通过。',
      stage: stage.id,
    })
    return
  }

  if (stage.status !== 'gate') return

  // `gate` means the stage is parked waiting for a verdict. A humanApproval stage
  // waits for the USER; every other one waits for the captain agent to call
  // factory_gate, which is a much softer "attention".
  if (humanApproval) {
    alerts.push({
      id: `awaiting-approval:${stage.id}`,
      kind: 'awaiting-approval',
      severity: 'action',
      title: `人工审批点：${name}`,
      detail: `阶段 ${stage.id} 的产出已就绪，模板把它标成了 humanApproval，机器不会替你拍板。`,
      next: '看过产出后明确确认，再用 factory_gate --humanConfirm 推进。',
      stage: stage.id,
    })
    return
  }

  alerts.push({
    id: `gate-pending:${stage.id}`,
    kind: 'awaiting-approval',
    severity: 'attention',
    title: `门禁待裁决：${name}`,
    detail: `阶段 ${stage.id} 停在 gate，等一次 factory_gate 裁决（第 ${stage.round + 1} 轮）。`,
    next: '调用 factory_gate；证据不足就打回，不要凭说明放行。',
    stage: stage.id,
  })
}

/**
 * Severity first, then pipeline order, then insertion order (roster order).
 *
 * Pipeline order is read from the state record itself, which is stored in
 * pipeline order, so no template lookup is needed here.
 *
 * @param alerts - unordered alerts.
 * @returns a new, ordered array.
 */
function orderAlerts(alerts: readonly SnapshotAlert[]): SnapshotAlert[] {
  const rank = (alert: SnapshotAlert): number => (alert.severity === 'action' ? 0 : 1)
  return [...alerts].sort((left, right) => rank(left) - rank(right))
}
