/**
 * engine/dispatch.ts — factory_approve / factory_dispatch.
 *
 * The approval gate that moves a factory to `running` and the stage dispatch
 * that wakes exactly the members the scheduler says have work, plus the
 * dispatch-row projections both report back.
 *
 * Moved here verbatim from the former single-file `src/tools/engine.ts`
 * (engineering review finding M5). Only this header, the imports and the
 * `export` keywords on cross-module helpers are new — no body was edited.
 *
 * @module dsh-code-factory/tools/engine/dispatch
 */
import { randomUUID } from 'node:crypto';
import { getStage, stageIds } from '../../domain/pipeline.js';
import { canonicalRoleId, roleTitle } from '../../domain/roles.js';
import { applyStageDispatch, planStageDispatch, schedulerProbes } from '../../runtime/scheduler.js';
import { transitionPhase } from '../../store/state.js';
import { FactoryToolError, loadFactory, mutateFactory, readEvolutionLessons, requireCaptainOf, requireFactoryId } from '../context.js';
import { UPSTREAM_ARTIFACT_LIMIT, optional, ledgerFor, recordPlanAttempts, postMail, captainNote } from './plumbing.js';
import { nextActionFor } from './status.js';
/* --------------------------------------------------------------- dispatch */
/** Renders the reasoning rows of one dispatch plan. */
function decisionRows(plan) {
    return plan.decisions.map((decision) => ({
        role: canonicalRoleId(decision.role),
        title: decision.title,
        action: decision.action,
        reason: decision.reason,
        ok: decision.action !== 'escalate',
        ...(decision.sessionId === undefined ? {} : { sessionId: decision.sessionId }),
    }));
}
/** Renders the executed rows of one dispatch plan. */
function appliedRows(outcome) {
    return outcome.applied.map((item) => ({
        role: canonicalRoleId(item.role),
        title: roleTitle(item.role),
        action: item.action,
        reason: item.spawn === undefined ? '派发成功' : item.spawn.ok ? item.spawn.detail : item.spawn.error,
        ok: item.ok,
        ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
        ...(item.messageId === undefined ? {} : { messageId: item.messageId }),
        ...(item.mode === undefined ? {} : { mode: item.mode }),
    }));
}
/** Renders the failed rows of one dispatch plan. */
function failedRows(outcome) {
    return outcome.failed.map((item) => ({
        role: canonicalRoleId(item.role),
        title: roleTitle(item.role),
        action: item.action,
        reason: item.error ?? '派发失败',
        ok: false,
        ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
        ...(item.error === undefined ? {} : { error: item.error }),
    }));
}
/** Upstream artifacts of a stage, for the dispatch text. */
async function upstreamArtifacts(call, factoryId) {
    const artifacts = await call.store.listArtifacts(factoryId);
    return artifacts.slice(-UPSTREAM_ARTIFACT_LIMIT).map((artifact) => artifact.path);
}
/**
 * Writes the mailbox copies of one applied dispatch plan.
 *
 * The mailbox line *is* the durable notification (and the cockpit's feed source),
 * so nothing else has to be recorded for the UI to see a dispatch.
 */
async function mailAppliedDispatch(call, factoryId, stageId, round, outcome, kind) {
    for (const item of outcome.applied) {
        await postMail(call, factoryId, {
            id: randomUUID(),
            from: 'captain',
            to: canonicalRoleId(item.role),
            content: item.text ?? `派发 ${stageId}（第 ${round} 轮）`,
            kind,
            stage: stageId,
            round,
            ...(item.ok ? { deliveredAt: call.store.now() } : {}),
        });
    }
}
/**
 * Approve a staged plan: the ONLY transition that creates member sessions.
 *
 * Idempotent by construction: a factory already `running` returns its current
 * phase without dispatching again, and the dispatch itself is planned by the
 * scheduler's anti-duplicate rules (a `working` member or an unsettled attempt is
 * never dispatched twice).
 */
export async function approveFactory(call, input) {
    const factoryId = requireFactoryId(input.factoryId);
    const existing = await loadFactory(call, factoryId);
    requireCaptainOf(call, existing);
    if (existing.phase === 'running') {
        return {
            summary: `工厂 ${factoryId} 已经是 running（此前已批准，approvedAt=${existing.approvedAt ?? '未知'}）——本次调用未创建任何新成员（幂等）。`,
            factoryId,
            phase: existing.phase,
            alreadyApproved: true,
            ...(existing.approvedAt === undefined ? {} : { approvedAt: existing.approvedAt }),
            planned: 0,
            decisions: [],
            applied: [],
            failed: [],
            spawned: [],
            missingRoles: [],
            escalate: false,
            notes: ['重复 approve 不会重复 spawn：调度器只会派发当前阶段还缺的成员。'],
            nextAction: '用 factory_status 查看成员/阶段，或直接 factory_dispatch 推进当前阶段。',
        };
    }
    if (existing.phase === 'halted') {
        throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 已暂停（halted）。先 factory_resume（附原因）再继续。`);
    }
    if (existing.phase !== 'staged') {
        throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 处于 ${existing.phase}，无法批准（只有 staged 计划需要批准）。`);
    }
    const probes = schedulerProbes(call.plugin);
    // Read the workspace ledger ONCE per approve; `applyStageDispatch` selects the
    // per-role slice for every spawn/wake/rework it performs. A ledger read failure
    // degrades to "no history block", never to a failed approval.
    const lessons = await readEvolutionLessons(call);
    const outcome = await mutateFactory(call, factoryId, async (state) => {
        if (state.captainSessionId !== call.callerId) {
            throw new FactoryToolError(`code-factory: 只有队长能批准工厂 ${factoryId} 的计划。`);
        }
        if (state.phase !== 'staged') {
            return {
                approvedNow: false,
                plan: undefined,
                applied: undefined,
                approvedAt: state.approvedAt,
            };
        }
        transitionPhase(state, 'running', call.store.now());
        state.approvedAt = call.store.now();
        delete state.planReviewState;
        const upstream = await upstreamArtifacts(call, factoryId);
        const plan = planStageDispatch({
            state,
            attempts: ledgerFor(state),
            now: call.store.now(),
            isLive: probes.isLive,
            isRunning: probes.isRunning,
            upstreamArtifacts: upstream,
        });
        const applied = await applyStageDispatch(call.plugin, call.caller, state, plan, {
            provider: call.config.memberProvider,
            signal: call.signal,
            memberDepth: call.config.memberMaxDepth,
            now: () => call.store.now(),
            upstreamArtifacts: upstream,
            lessons,
        });
        recordPlanAttempts(state, plan, applied, call.store.now());
        return { approvedNow: true, plan, applied, approvedAt: state.approvedAt };
    });
    const { value, state } = outcome;
    if (!value.approvedNow || value.plan === undefined || value.applied === undefined) {
        return {
            summary: `工厂 ${factoryId} 已经在 ${state.phase}，本次 approve 未重复派发（幂等）。`,
            factoryId,
            phase: state.phase,
            alreadyApproved: true,
            planned: 0,
            decisions: [],
            applied: [],
            failed: [],
            spawned: [],
            missingRoles: [],
            escalate: false,
            notes: [],
            nextAction: '用 factory_status 查看当前阶段与成员状态。',
        };
    }
    const plan = value.plan;
    const applied = value.applied;
    await mailAppliedDispatch(call, factoryId, plan.stageId, plan.round, applied, 'dispatch');
    const notes = [...plan.notes];
    if (applied.failed.length > 0)
        notes.push('有派发失败：成员记录里的 spawnError 会说明原因，可再调用 factory_dispatch 重试。');
    if (plan.escalate)
        notes.push('调度器判定当前阶段需要人工介入（缺角色 / 轮次用尽 / 成员 BLOCKED）。');
    return {
        summary: `工厂 ${factoryId} 已批准并进入 running：${plan.stageName}（\`${plan.stageId}\`）第 ${plan.round} 轮，`
            + `派发 ${applied.applied.length} 项成功${applied.failed.length > 0 ? `、${applied.failed.length} 项失败` : ''}。`
            + (plan.escalate ? ' 需要人工介入。' : ' 等成员用 factory_report 回报后再 factory_gate 裁决。'),
        factoryId,
        phase: state.phase,
        alreadyApproved: false,
        approvedAt: value.approvedAt,
        stageId: plan.stageId,
        stageName: plan.stageName,
        round: plan.round,
        planned: plan.dispatches.length,
        decisions: decisionRows(plan),
        applied: appliedRows(applied),
        failed: failedRows(applied),
        spawned: applied.spawned.map(canonicalRoleId),
        missingRoles: plan.missingRoles.map(canonicalRoleId),
        escalate: plan.escalate,
        notes,
        nextAction: plan.escalate
            ? '向用户说明卡点（缺角色 / 轮次用尽 / 成员阻塞），等人工决定，不要自行绕过门禁。'
            : `等 ${plan.staffing.assigned.map(roleTitle).join('、')} 提交工件并 factory_report；随后 factory_gate 裁决 ${plan.stageId}。`,
    };
}
/**
 * Runs one dispatch cycle for the current (or an explicitly named) stage.
 *
 * This is the "wake the people who have work now" operation: the scheduler picks
 * the first non-passed stage, resolves its roles against the real roster with the
 * fallback ladder, and only the roles with actual work are spawned / woken /
 * reworked.
 */
export async function dispatchFactory(call, input) {
    const factoryId = requireFactoryId(input.factoryId);
    const head = await loadFactory(call, factoryId);
    requireCaptainOf(call, head);
    if (head.phase === 'staged') {
        throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 还在 staged —— 必须先拿到用户明确批准，再 factory_approve；本轮不要派发。`);
    }
    if (head.phase === 'halted') {
        throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 已暂停（halted）—— 先 factory_resume 再派发。`);
    }
    if (head.phase !== 'running') {
        throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 处于 ${head.phase}，不再有可派发的阶段。`);
    }
    const stageId = optional(input.stageId);
    if (stageId !== undefined && getStage(head.pipeline, stageId) === undefined) {
        throw new FactoryToolError(`code-factory: 流水线 ${head.pipeline} 没有阶段 ${JSON.stringify(stageId)}。可用阶段: ${stageIds(head.pipeline).join('、')}。`);
    }
    const findings = (input.findings ?? []).map((item) => String(item).trim()).filter((item) => item !== '');
    const note = optional(input.note);
    const probes = schedulerProbes(call.plugin);
    // One ledger read per dispatch cycle; the per-role selection happens inside
    // `applyStageDispatch` for every spawn / wake / rework text.
    const lessons = await readEvolutionLessons(call);
    const { value, state } = await mutateFactory(call, factoryId, async (current) => {
        if (current.captainSessionId !== call.callerId) {
            throw new FactoryToolError(`code-factory: 只有队长能派发工厂 ${factoryId} 的阶段。`);
        }
        if (current.phase !== 'running') {
            throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 处于 ${current.phase}，不能派发。`);
        }
        const upstream = await upstreamArtifacts(call, factoryId);
        // Inside this callback the live record is `current`; the outer `state` from
        // `const { value, state } = await mutateFactory(...)` is still in its temporal
        // dead zone here, so reaching for it is a ReferenceError, not a state read.
        const plan = planStageDispatch({
            state: current,
            attempts: ledgerFor(current),
            now: call.store.now(),
            isLive: probes.isLive,
            isRunning: probes.isRunning,
            ...(stageId === undefined ? {} : { stageId }),
            ...(findings.length === 0 ? {} : { reworkFindings: findings }),
            upstreamArtifacts: upstream,
        });
        const applied = await applyStageDispatch(call.plugin, call.caller, current, plan, {
            provider: call.config.memberProvider,
            signal: call.signal,
            memberDepth: call.config.memberMaxDepth,
            now: () => call.store.now(),
            upstreamArtifacts: upstream,
            lessons,
        });
        recordPlanAttempts(current, plan, applied, call.store.now());
        return { plan, applied };
    });
    const { plan, applied } = value;
    if (plan.known && applied.applied.length > 0) {
        await mailAppliedDispatch(call, factoryId, plan.stageId, plan.round, applied, 'dispatch');
    }
    if (note !== undefined) {
        await captainNote(call, factoryId, `[派发备注] ${note}`, 'system', { stage: plan.stageId, round: plan.round });
    }
    const decisions = decisionRows(plan);
    return {
        summary: plan.known
            ? `${plan.summary}${applied.applied.length > 0 ? `；${applied.summary}` : ''}`
            : `工厂 ${factoryId} 没有待派发的阶段（全部 passed 或停在门禁裁决）——可以 factory_dod_check / factory_deliver。`,
        factoryId,
        phase: state.phase,
        known: plan.known,
        stageId: plan.stageId,
        stageName: plan.stageName,
        round: plan.round,
        parallel: plan.parallel,
        humanApproval: plan.humanApproval,
        planned: plan.dispatches.length,
        decisions,
        applied: appliedRows(applied),
        failed: failedRows(applied),
        waiting: decisions.filter((row) => row.action === 'wait'),
        skipped: decisions.filter((row) => row.action === 'skip'),
        spawned: applied.spawned.map(canonicalRoleId),
        missingRoles: plan.missingRoles.map(canonicalRoleId),
        escalate: plan.escalate,
        notes: [...plan.notes],
        nextAction: plan.escalate
            ? '向用户说明卡点，等人工决定；不要自己替成员完成工作。'
            : plan.dispatches.length > 0
                ? `等 ${plan.staffing.assigned.map(roleTitle).join('、')} 用 factory_report 回报，再 factory_gate 裁决 ${plan.stageId}。`
                : applied.failed.length > 0
                    ? '有派发失败：factory_status 的成员行里有 spawnError，修好后重试 factory_dispatch。'
                    // No dispatch was needed because nothing is dispatchable *right now*.
                    // That is exactly the case a bare "don't re-dispatch" hint gets wrong: a
                    // stage parked at its gate needs `factory_gate`, not another dispatch.
                    : nextActionFor(state),
    };
}
//# sourceMappingURL=dispatch.js.map