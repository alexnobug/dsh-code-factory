/**
 * engine/status.ts — factory_status.
 *
 * The read-only cockpit projection: the factory index, the stage/member/feed
 * rows, the DoD summary, the executor audit that explains stranded members,
 * and the single next action the caller should take.
 *
 * Moved here verbatim from the former single-file `src/tools/engine.ts`
 * (engineering review finding M5). Only this header, the imports and the
 * `export` keywords on cross-module helpers are new — no body was edited.
 *
 * @module dsh-code-factory/tools/engine/status
 */
import { UNKNOWN_GATE_TYPE } from '../../shared/types.js';
import { getStage } from '../../domain/pipeline.js';
import { deriveImprovements, improvementStats } from '../../domain/improvements.js';
import { canonicalRoleId, roleTitle } from '../../domain/roles.js';
import { selectDispatchStage, memberExecutorVerdict, reconcileStrandedMembers, schedulerProbes } from '../../runtime/scheduler.js';
import { evolutionStats } from '../../store/evolution.js';
import { mailboxStatus } from '../../store/store.js';
import { loadFactory, logLine, requireFactoryId } from '../context.js';
import { optional, clip, optionalCount, roleRow, planPath, ledgerFor, findMemberFactoryForCall, findCaptainFactoryForCall } from './plumbing.js';
import { summarizeDodStates, dodStateRows } from './dod.js';
/** One live member row. */
function memberRow(member) {
    const role = roleRow(member.role);
    return {
        role: role.role,
        title: role.title,
        codename: role.codename,
        tier: role.tier,
        duties: role.duties,
        status: member.status,
        tokens: Number.isFinite(member.tokens) ? member.tokens : 0,
        ...(member.currentStage === undefined ? {} : { stage: member.currentStage }),
        ...(member.sessionId === undefined ? {} : { sessionId: member.sessionId }),
        ...(member.spawnError === undefined ? {} : { spawnError: member.spawnError }),
        ...(member.provider === undefined ? {} : { provider: member.provider }),
        ...(member.model === undefined ? {} : { model: member.model }),
    };
}
/** One live stage row. */
function statusStageRow(state, rec) {
    const def = getStage(state.pipeline, rec.id);
    const row = {
        id: rec.id,
        name: def?.name ?? rec.id,
        status: rec.status,
        round: rec.round,
        attempts: rec.attempts,
        roles: def === undefined ? [] : [...def.roles],
        parallel: def?.parallel === true,
        humanApproval: def?.humanApproval === true,
        gateType: def?.gate.type ?? rec.lastGate?.type ?? UNKNOWN_GATE_TYPE,
        ...(rec.lastGate === undefined ? {} : { lastGateOk: rec.lastGate.ok, lastGateDetail: rec.lastGate.detail }),
        ...(def?.failGoto === undefined ? {} : { failGoto: def.failGoto }),
    };
    return row;
}
/**
 * Reads the durable truth for one factory (or the workspace index).
 *
 * With no `factoryId` the newest factory owned by the caller is used; a member
 * session resolves through its own roster row; an explicit `sessionId` is only
 * ever compared for equality (it never becomes a path).
 */
export async function readFactoryStatus(call, input) {
    const requestedId = optional(input.factoryId);
    const requestedSession = optional(input.sessionId);
    const feedLimit = optionalCount(input.feedLimit) ?? call.config.feedLimit;
    const index = (await call.store.list()).map((summary) => ({
        id: summary.id,
        name: summary.name,
        phase: summary.phase,
        taskType: summary.taskType,
        pipeline: summary.pipeline,
        updatedAt: summary.updatedAt,
    }));
    const notes = [];
    let state;
    if (requestedId !== undefined) {
        state = await loadFactory(call, requireFactoryId(requestedId));
    }
    else if (requestedSession !== undefined) {
        for (const summary of await call.store.list()) {
            if (summary.captainSessionId !== requestedSession)
                continue;
            const loaded = await call.store.load(summary.id);
            if (loaded !== undefined) {
                state = loaded;
                break;
            }
        }
        if (state === undefined) {
            notes.push(`会话 ${requestedSession} 在本工作区不是任何工厂的队长；已回退到当前会话自己的工厂。`);
        }
    }
    if (state === undefined) {
        const member = await findMemberFactoryForCall(call);
        if (member !== undefined) {
            state = member.state;
            notes.push(`当前会话是工厂 ${state.id} 的成员（角色 ${canonicalRoleId(member.member.role)}）。`);
        }
    }
    if (state === undefined)
        state = await findCaptainFactoryForCall(call);
    if (state === undefined) {
        return {
            summary: index.length === 0
                ? `工作区 ${call.workspace} 下还没有任何 code-factory 工厂 —— 用 factory_plan 建立 staged 规划。`
                : `当前会话还没有自己的工厂；本工作区共有 ${index.length} 个工厂。选一个 id 再调用 factory_status。`,
            scope: 'index',
            workspace: call.workspace,
            stateDir: call.config.stateDir,
            factories: index,
            notes,
            nextAction: index.length === 0
                ? 'factory_plan 建立 staged 规划（不会创建任何子会话）。'
                : '把要看的工厂 id 传给 factory_status。',
        };
    }
    const [artifacts, feed, inboxKeys] = await Promise.all([
        call.store.listArtifacts(state.id),
        call.store.readAllMessages(state.id, { limit: feedLimit }),
        call.store.inboxKeys(state.id),
    ]);
    const unread = [];
    for (const key of inboxKeys) {
        const messages = await call.store.listUnread(state.id, key);
        if (messages.length > 0)
            unread.push({ key, unread: messages.length });
    }
    const dispatchable = selectDispatchStage(state);
    const dodRow = state.dod.length === 0 ? undefined : summarizeDodStates(state.dod, state.securityTriggered);
    const dodItemRows = state.dod.length === 0 ? undefined : dodStateRows(state.dod, state.securityTriggered);
    // Read-only executor audit: it only projects the durable record plus the liveness
    // probe (see `explainStaleMembers`), and it is computed before `nextAction` so the
    // advice can mention a stale roster instead of dismissing it as "a busy member".
    const executorAudit = explainStaleMembers(call, state);
    const evolution = await summarizeEvolution(call);
    if (executorAudit.stale.length > 0) {
        notes.push(`成员状态已过期（执行者不在场）：${executorAudit.stale.map((row) => `${roleTitle(row.role)} ${row.status}`).join('、')}`
            + ' —— factory_dispatch 会收敛为 idle 并按 stranded 恢复重新派发；本次 factory_status 只读，未改任何状态。');
    }
    if (executorAudit.uncertain.length > 0) {
        notes.push(`成员执行者待确认：${executorAudit.uncertain.map((row) => roleTitle(row.role)).join('、')}`
            + ' —— 无法判定执行者是否在场，不要据此判定工厂卡死。');
    }
    // Read-only evolution clauses. The lesson clause is byte-identical to the old
    // summary; the improvement clause is only appended when a recurring lesson
    // actually produced a proposal (N = 0 stays silent, and a missing/failed
    // derivation leaves the improvement clause out instead of inventing a count).
    const evolutionSummary = evolution === undefined || evolution.total === 0
        ? ''
        : `；进化库 ${evolution.total} 条教训（${evolution.recurring} 反复 / ${evolution.resolved} 已解决）`;
    const improvementSummary = evolution?.improvements === undefined || evolution.improvements.total === 0
        ? ''
        : `；插件改进建议 ${evolution.improvements.total} 条（待改进 ${evolution.improvements.open} / 已验证 ${evolution.improvements.validated}）`;
    return {
        summary: `工厂 ${state.id}（${state.name}）phase=${state.phase} 任务类型=${state.taskType} 流水线=${state.pipeline}；`
            + `阶段 ${state.stages.filter((stage) => stage.status === 'passed').length}/${state.stages.length} passed`
            + `（当前 ${dispatchable?.rec.id ?? '无'}）；成员 ${state.members.length}；DoD ${dodRow === undefined ? '未跑' : `${dodRow.passed}/${dodRow.total}`}`
            + evolutionSummary
            + improvementSummary
            + '。',
        scope: 'factory',
        workspace: call.workspace,
        stateDir: call.config.stateDir,
        // A bare `factory_status` (no factoryId, no sessionId) is documented as "list
        // the workspace index, falling back to this session's own factory". The
        // fallback must not swallow the index: without it the caller cannot discover
        // any factory other than its own, and `factories` being optional meant the
        // omission was silent.
        ...(requestedId === undefined && requestedSession === undefined ? { factories: index } : {}),
        factoryId: state.id,
        name: state.name,
        phase: state.phase,
        taskType: state.taskType,
        pipeline: state.pipeline,
        ...(state.planReviewState === undefined ? {} : { planReviewState: state.planReviewState }),
        securityTriggered: state.securityTriggered,
        brief: state.brief,
        captainSessionId: state.captainSessionId,
        factoryFile: planPath(call, state.id),
        ...(state.deliveryPath === undefined ? {} : { deliveryPath: state.deliveryPath }),
        members: state.members.map(memberRow),
        stages: state.stages.map((stage) => statusStageRow(state, stage)),
        ...(dispatchable === undefined ? {} : { currentStage: dispatchable.rec.id }),
        ...(dodRow === undefined ? {} : { dod: dodRow }),
        ...(dodItemRows === undefined ? {} : { dodItems: dodItemRows }),
        artifacts,
        unread,
        feed: feed.map((message) => ({
            id: message.id,
            from: message.from,
            to: message.to,
            content: clip(message.content, 400),
            ts: message.ts,
            status: mailboxStatus(message),
            ...(message.kind === undefined ? {} : { kind: message.kind }),
            ...(message.stage === undefined ? {} : { stage: message.stage }),
        })),
        executorAudit,
        ...(evolution === undefined ? {} : { evolution }),
        notes,
        nextAction: nextActionFor(state, executorAudit.stale),
    };
}
/* ---------------------------------------------------- evolution projection */
/** One recent-lesson row (text clipped: a status row is not a transcript). */
function statusLessonRow(lesson) {
    return {
        id: lesson.id,
        role: lesson.role,
        stage: lesson.stage,
        gateType: lesson.gateType,
        kind: lesson.kind,
        text: clip(lesson.text, 240),
        count: lesson.count,
        lastAt: lesson.lastAt,
        ...(lesson.resolvedAt === undefined ? {} : { resolvedAt: lesson.resolvedAt }),
    };
}
/**
 * One derived improvement-proposal row.
 *
 * Only the status-facing subset is projected: the full proposal also carries
 * `gateType` / `lessonIds`, which stay out of the row because it exists to say
 * *what to change where* — the evidence is already listed in `lessons`.
 */
function statusImprovementRow(proposal) {
    return {
        id: proposal.id,
        title: proposal.title,
        target: proposal.target,
        ...(proposal.targetFile === undefined ? {} : { targetFile: proposal.targetFile }),
        suggestion: proposal.suggestion,
        rationale: proposal.rationale,
        ...(proposal.role === undefined ? {} : { role: proposal.role }),
        ...(proposal.stage === undefined ? {} : { stage: proposal.stage }),
        evidenceCount: proposal.evidenceCount,
        status: proposal.status,
        lastAt: proposal.lastAt,
    };
}
/** Proposals listed by one status row; the roll-up still counts the whole backlog. */
const IMPROVEMENTS_SHOWN = 5;
/**
 * Derives the plugin-improvement backlog from the ledger, best-effort.
 *
 * `deriveImprovements` is pure and already sorted (evidence desc → `lastAt` desc
 * → id asc), so the slice is deterministic. A throw omits `improvements` rather
 * than fabricating an empty object, exactly like the ledger read: the advice
 * layer must never break a status call.
 */
function summarizeImprovements(call, lessons) {
    try {
        const proposals = deriveImprovements(lessons);
        const stats = improvementStats(proposals);
        return {
            total: stats.total,
            open: stats.open,
            validated: stats.validated,
            proposals: proposals.slice(0, IMPROVEMENTS_SHOWN).map(statusImprovementRow),
        };
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logLine(call.plugin, 'warn', `派生插件改进建议失败（factory_status 省略 improvements 摘要）: ${detail}`);
        return undefined;
    }
}
/**
 * Reads the workspace evolution ledger for the status projection.
 *
 * Two independent best-effort steps:
 *
 *  - ledger read + roll-up: an unreadable ledger omits the whole `evolution`
 *    field instead of failing a status call (the caller only asked what the
 *    factory is doing);
 *  - improvement derivation: a failure there keeps the stats/lessons and only
 *    omits `improvements`.
 *
 * The 5 newest lessons are ordered by `lastAt` desc, `id` asc — deterministic
 * even at equal stamps. Proposals come from `deriveImprovements`, which filters
 * to `count >= 2` and applies its own deterministic order.
 */
async function summarizeEvolution(call) {
    let lessons;
    let stats;
    try {
        lessons = await call.store.evolution.read();
        stats = evolutionStats(lessons);
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logLine(call.plugin, 'warn', `读取进化教训库失败（factory_status 省略 evolution 摘要）: ${detail}`);
        return undefined;
    }
    const recent = [...lessons]
        .sort((left, right) => right.lastAt - left.lastAt || left.id.localeCompare(right.id))
        .slice(0, 5);
    const improvements = summarizeImprovements(call, lessons);
    return {
        total: stats.total,
        recurring: stats.recurring,
        resolved: stats.resolved,
        ...(stats.lastAt === undefined ? {} : { lastAt: stats.lastAt }),
        lessons: recent.map(statusLessonRow),
        ...(improvements === undefined ? {} : { improvements }),
    };
}
/**
 * The next thing the captain should do, derived from the durable record.
 *
 * "Next" is `selectDispatchStage` — the first stage that has not passed — not
 * `activeStage`: after a rejection nothing is `active` any more, and the honest
 * answer is therefore "rework/redispatch that stage", never "all stages passed".
 *
 * The mapping is **status-first on purpose**. A stage sitting in `gate` has already
 * been evaluated: `factory_dispatch` has nothing to dispatch there (its own planner
 * answers `wait`), so pointing at it walks the reader into a dead end — in a real
 * rehearsal exactly that happened ("dispatch returned wait → the factory looks
 * stuck"). Every stage status therefore maps to the one tool that can actually move
 * it, and the gate status is split again by its own verdict because a passed gate
 * and a failed one need different calls (`advance` vs a rejection round).
 *
 * @param state - the durable factory record.
 * @param staleMembers - read-only audit rows (see {@link explainStaleMembers}) to
 *   mention, so a stale roster is never explained away as "a working member".
 * @returns one imperative sentence for the model.
 */
export function nextActionFor(state, staleMembers = []) {
    if (state.phase === 'staged') {
        return state.planReviewState === 'awaiting_feedback'
            ? '等用户说明要改什么，然后用 factory_edit_plan 一次改完；改完重新等用户批准，再 factory_approve。'
            : '把 staged 计划呈现给用户并结束本轮；用户明确批准后才 factory_approve（要先调整计划就用 factory_edit_plan）。';
    }
    if (state.phase === 'halted') {
        return '工厂已暂停（halted）：需要继续时调用 factory_resume（必须写明原因），然后 factory_dispatch 重新派发。';
    }
    if (state.phase === 'delivered') {
        return '工厂已交付：把交付结果与工件路径报给用户；如需清理用 factory_delete（默认归档到 archive/）。';
    }
    if (state.phase === 'discarded') {
        return '工厂已归档/删除：新任务请重新 factory_plan（会得到新的 factoryId）。';
    }
    const next = selectDispatchStage(state);
    if (next === undefined) {
        return '所有阶段都已 passed：调用 factory_dod_check 跑 DoD 七条机器校验，全绿后 factory_deliver。';
    }
    const { rec, def } = next;
    const stage = `阶段 ${rec.id}（${def.name}）`;
    const exhausted = def.maxRounds > 0 && rec.round >= def.maxRounds
        ? `打回轮次已用尽（${rec.round}/${def.maxRounds}）：需要人工决定（放宽范围 / 手工修复 / 终止），不要再自动返工。`
        : '';
    const staleNote = staleMembers.length === 0
        ? ''
        : `注意：${staleMembers.map((row) => `${row.role}(${row.status})`).join('、')} 的执行者不在场、状态已过期`
            + '—— factory_dispatch 会把它收敛为 idle 并按 stranded 恢复重新派发；这不等于工厂卡死。';
    const base = (() => {
        switch (rec.status) {
            case 'gate': {
                if (rec.lastGate?.ok === false) {
                    return `${stage} 的门禁记录是未通过、却停在 gate（人工或旧数据造成）：调用 factory_gate 重新裁决`
                        + '—— 它会按 failGoto 回退、轮次 +1，并把整改清单写进责任角色邮箱。';
                }
                if (rec.lastGate === undefined) {
                    return `${stage} 停在门禁但没有裁决记录：调用 factory_gate 用当前工件重新核验（不要在此时 factory_dispatch，门禁阶段没有派发项）。`;
                }
                if (def.humanApproval === true) {
                    return `${stage} 门禁已通过，且这是人工审批点（humanApproval）：把产出与门禁证据呈现给用户，`
                        + '拿到明确确认后再调用 factory_gate 并传 humanConfirm=true 让它 advance —— 不要替用户拍板，也不要用 factory_dispatch（门禁阶段没有派发项，只会返回 wait）。';
                }
                return `${stage} 门禁已通过、正等裁决：调用 factory_gate 让它 advance（最后一个阶段则是 delivered）`
                    + `—— 此刻不要用 factory_dispatch：门禁阶段没有派发项，它只会返回 wait，工厂并没有卡死。`;
            }
            case 'active': {
                return `${stage} 进行中：等成员用 factory_report 回报（或 factory_block 上报），然后 factory_gate 裁决。`
                    + '要确认派发状态就用 factory_status；成员已在工作或已有未完成派发时 factory_dispatch 返回 wait 属正常。';
            }
            case 'rejected': {
                return `${stage} 已打回（第 ${rec.round} 轮）：按整改清单让责任角色返工，用 factory_dispatch 重新派发`
                    + '（它会把回退目标的成员按 stranded/返工规则唤醒）；返工后重新 factory_gate。';
            }
            case 'pending': {
                return `${stage} 尚未派发：调用 factory_dispatch 派发它（首次派发会创建该阶段所需的成员）。`;
            }
            default: {
                return `${stage} 当前状态是 ${rec.status}：用 factory_status 复核，必要时 factory_dispatch 推进。`;
            }
        }
    })();
    return [base, exhausted, staleNote].filter((part) => part !== '').join(' ');
}
/**
 * Explains roster rows whose recorded status nobody is executing — **read-only**.
 *
 * This is the `factory_status` half of the stranded story: `factory_dispatch`
 * repairs those rows, but the captain should not have to *dispatch* (which wakes
 * people) just to learn that a roster row is out of date. Nothing here writes:
 * the planner's own predicates are called without applying anything, and the
 * returned rows are a projection of the durable record plus the liveness probe.
 *
 * @param call - the resolved call context (store + plugin context for the probe).
 * @param state - the factory record just loaded.
 * @returns the two buckets described on {@link ExecutorAudit}.
 */
function explainStaleMembers(call, state) {
    if (state.phase !== 'running') {
        return {
            stale: [],
            uncertain: [],
            note: `工厂处于 ${state.phase}：不做搁浅解释（只有 running 的工厂才有正在执行的成员）。`,
        };
    }
    const inputs = {
        state,
        attempts: ledgerFor(state),
        now: call.store.now(),
        ...schedulerProbes(call.plugin),
    };
    const stale = reconcileStrandedMembers(inputs).map((action) => ({
        role: action.role,
        status: action.from,
        sessionId: action.sessionId,
        ...(action.stageId === undefined ? {} : { stage: action.stageId }),
        reason: action.reason,
    }));
    const staleRoles = new Set(stale.map((row) => row.role));
    const uncertain = [];
    for (const member of state.members) {
        if (member.status !== 'working' && member.status !== 'rework')
            continue;
        const role = canonicalRoleId(member.role);
        if (staleRoles.has(role))
            continue;
        const sessionId = member.sessionId ?? '';
        const verdict = memberExecutorVerdict(inputs, sessionId);
        if (verdict.state !== 'unknown')
            continue;
        uncertain.push({
            role,
            status: member.status,
            sessionId,
            ...(member.currentStage === undefined ? {} : { stage: member.currentStage }),
            reason: sessionId === ''
                ? '成员没有会话 id，无法探测执行者：状态无法确认'
                : '本 composition 没有可用的 liveness 探针（探针无结果 ≠ 执行者不在场）：执行者是否在场无法确认',
        });
    }
    const note = stale.length === 0 && uncertain.length === 0
        ? '名册与执行者一致：没有状态过期的成员。'
        : `已过期 ${stale.length} 个（执行者不在场；factory_dispatch 会把状态收敛为 idle 并按 stranded 恢复重新派发）、`
            + `待确认 ${uncertain.length} 个。本字段是只读解释：factory_status 没有写盘、没有派发、没有唤醒任何人。`;
    return { stale, uncertain, note };
}
//# sourceMappingURL=status.js.map