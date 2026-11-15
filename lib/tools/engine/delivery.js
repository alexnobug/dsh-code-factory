/**
 * engine/delivery.ts — factory_dod_check / deliver / halt / resume / delete.
 *
 * The end of the pipeline: the machine DoD check, the delivery that re-runs
 * it, and the pause/resume/archive controls that keep the on-disk record as
 * the truth source.
 *
 * Moved here verbatim from the former single-file `src/tools/engine.ts`
 * (engineering review finding M5). Only this header, the imports and the
 * `export` keywords on cross-module helpers are new — no body was edited.
 *
 * @module dsh-code-factory/tools/engine/delivery
 */
import { canonicalRoleId } from '../../domain/roles.js';
import { interruptMember, drainMembers } from '../../runtime/members.js';
import { selectDispatchStage } from '../../runtime/scheduler.js';
import { transitionMember, transitionPhase } from '../../store/state.js';
import { FactoryToolError, loadFactory, mutateFactory, requireCaptainOf, requireFactoryId } from '../context.js';
import { optional, required, captainNote, gateRunnerFor, commandRows } from './plumbing.js';
import { DOD_LESSON_STAGE, dodStateStatus, dodRows, recordDodLessons, resolveDodLessons } from './dod.js';
/**
 * Runs the seven-item Definition-of-Done audit with real reads, real commands and
 * real git facts, then persists the verdicts into the factory record.
 */
export async function checkDod(call, input) {
    const factoryId = requireFactoryId(input.factoryId);
    const state = await loadFactory(call, factoryId);
    requireCaptainOf(call, state);
    const runner = gateRunnerFor(call, call.config.allowNodeFallback);
    const audit = await runner.runDod({
        securityTriggered: state.securityTriggered,
        pipeline: state.pipeline,
        ...(input.minCommits === undefined ? {} : { minCommits: input.minCommits }),
        signal: call.signal,
    });
    const rows = dodRows(audit.audit.results);
    const { value } = await mutateFactory(call, factoryId, (current) => {
        if (current.captainSessionId !== call.callerId) {
            throw new FactoryToolError(`code-factory: 只有队长能跑工厂 ${factoryId} 的 DoD 总验收。`);
        }
        current.dod = audit.audit.results.map((item) => ({
            id: item.id,
            label: item.label,
            ok: item.ok,
            status: item.status,
            evidence: item.evidence,
        }));
        return audit.audit.summary;
    });
    // Evolution ledger: the failing DoD items become durable, role-addressed
    // lessons so the missing README headings / tag / REVIEW conclusion come back
    // in future briefs instead of costing another full audit round. Recording is
    // best-effort by construction (`recordDodLessons` never throws).
    const recordedLessons = await recordDodLessons(call, state, audit.audit.results);
    // A green audit also proves the previously failing items were fixed: stamp
    // this factory's open DoD lessons resolved. Same best-effort policy.
    const resolvedLessons = value.ok ? await resolveDodLessons(call, state.id) : 0;
    await captainNote(call, factoryId, `[DoD 总验收] ${audit.detail}${value.missing.length > 0 ? `\n未达标: ${value.missing.join('；')}` : ''}`
        + (recordedLessons > 0 ? `\n[进化库] 已记录 ${recordedLessons} 条 DoD 教训` : '')
        + (resolvedLessons > 0 ? `\n[进化库] 已标记 ${resolvedLessons} 条 DoD 教训为已解决` : ''));
    const refused = rows.filter((item) => item.needsExecution).map((item) => `#${item.id} ${item.label}`);
    const notes = [];
    if (recordedLessons > 0) {
        notes.push(`已记录 ${recordedLessons} 条 DoD 教训到进化库——后续任务的成员简报会自动带上对应角色的历史教训。`);
    }
    if (resolvedLessons > 0) {
        notes.push(`已标记 ${resolvedLessons} 条 DoD 教训为已解决（工厂 ${state.id} / stage ${DOD_LESSON_STAGE} 全绿）。`);
    }
    if (audit.skipped.length > 0)
        notes.push(`跳过 securityOnly 条目 ${audit.skipped.join('、')}（本工厂未触发安全路径）。`);
    if (audit.git.error !== undefined)
        notes.push(`git 事实采集失败: ${audit.git.error}`);
    if (refused.length > 0)
        notes.push(`仍有待执行条目 ${refused.length} 条（无执行器 / 命令被白名单拒绝）：不算通过。`);
    return {
        summary: `${audit.detail}${value.ok ? ' —— 七条全绿，可以 factory_deliver。' : ' —— 未达标，不能交付。'}`,
        factoryId,
        ok: value.ok,
        passed: value.passed,
        total: value.total,
        failed: value.failed,
        pending: value.pending,
        skipped: value.skipped,
        securityTriggered: state.securityTriggered,
        items: rows,
        commands: commandRows(audit.items.flatMap((item) => item.outcomes)),
        commits: audit.git.facts?.commits?.length ?? 0,
        tags: [...(audit.git.facts?.tags ?? [])],
        ...(audit.git.error === undefined ? {} : { gitError: audit.git.error }),
        refusedCommands: refused,
        missing: [...value.missing],
        notes,
        nextAction: value.ok
            ? '调用 factory_deliver（它会重跑 DoD 再交付）。'
            : `把未达标条目（${value.missing.slice(0, 5).join('；')}）交给对应角色返工，再重跑 factory_dod_check。`,
    };
}
/** Stops the pipeline: interrupts every working member and parks the factory. */
export async function haltFactory(call, input) {
    const factoryId = requireFactoryId(input.factoryId);
    const head = await loadFactory(call, factoryId);
    requireCaptainOf(call, head);
    const reason = optional(input.reason) ?? '队长/用户要求暂停';
    if (head.phase === 'halted') {
        return {
            summary: `工厂 ${factoryId} 已经处于 halted（此前已暂停）——本次未重复中断成员（幂等）。`,
            factoryId,
            phase: head.phase,
            alreadyHalted: true,
            interrupted: [],
            failed: [],
            reason,
            nextAction: '需要继续时用 factory_resume（附原因）。',
        };
    }
    if (head.phase !== 'running' && head.phase !== 'staged') {
        throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 处于 ${head.phase}，无需暂停。`);
    }
    const { value, state } = await mutateFactory(call, factoryId, (current) => {
        if (current.captainSessionId !== call.callerId) {
            throw new FactoryToolError(`code-factory: 只有队长能暂停工厂 ${factoryId}。`);
        }
        const interrupted = [];
        const failed = [];
        for (const member of current.members) {
            const sessionId = member.sessionId;
            if (sessionId === undefined || sessionId === '')
                continue;
            if (member.status !== 'working' && member.status !== 'rework')
                continue;
            const result = interruptMember(call.plugin, call.caller, sessionId);
            if (result.ok) {
                interrupted.push(canonicalRoleId(member.role));
                transitionMember(member, 'idle', call.store.now());
            }
            else {
                failed.push(`${canonicalRoleId(member.role)}: ${result.error ?? '中断失败'}`);
            }
        }
        transitionPhase(current, 'halted', call.store.now());
        return { interrupted, failed };
    });
    await captainNote(call, factoryId, `[已暂停] ${reason}；中断成员: ${value.interrupted.join('、') || '（无工作成员）'}`);
    return {
        summary: `工厂 ${factoryId} 已暂停（halted）：中断 ${value.interrupted.length} 个成员`
            + (value.failed.length > 0 ? `，${value.failed.length} 个中断失败` : '')
            + '。磁盘状态保留，未回收任何成员会话。',
        factoryId,
        phase: state.phase,
        alreadyHalted: false,
        interrupted: value.interrupted,
        failed: value.failed,
        reason,
        nextAction: '说明暂停原因；恢复时用 factory_resume（必须写明原因），再 factory_dispatch 继续。',
    };
}
/** Resumes a halted factory. Never dispatches by itself. */
export async function resumeFactory(call, input) {
    const factoryId = requireFactoryId(input.factoryId);
    const reason = required(input.reason, 'reason（恢复原因：用户在哪一轮明确要求继续）');
    const head = await loadFactory(call, factoryId);
    requireCaptainOf(call, head);
    if (head.phase === 'running') {
        const running = selectDispatchStage(head);
        return {
            summary: `工厂 ${factoryId} 已经在 running（幂等，未重复变更）。`,
            factoryId,
            phase: head.phase,
            alreadyRunning: true,
            reason,
            ...(running === undefined ? {} : { currentStage: running.rec.id }),
            nextAction: '用 factory_dispatch 继续推进。',
        };
    }
    if (head.phase !== 'halted') {
        throw new FactoryToolError(`code-factory: 只有 halted 的工厂需要恢复，工厂 ${factoryId} 当前是 ${head.phase}`
            + (head.phase === 'staged' ? '（staged 要走用户批准 → factory_approve）。' : '。'));
    }
    const { state } = await mutateFactory(call, factoryId, (current) => {
        if (current.captainSessionId !== call.callerId) {
            throw new FactoryToolError(`code-factory: 只有队长能恢复工厂 ${factoryId}。`);
        }
        transitionPhase(current, 'running', call.store.now());
        return current.phase;
    });
    await captainNote(call, factoryId, `[已恢复] ${reason}`);
    const stage = selectDispatchStage(state);
    return {
        summary: `工厂 ${factoryId} 已恢复为 running（原因: ${reason}）。`,
        factoryId,
        phase: state.phase,
        alreadyRunning: false,
        reason,
        ...(stage === undefined ? {} : { currentStage: stage.rec.id }),
        nextAction: '用 factory_dispatch 重新派发当前阶段（被打断的成员需要新的派发/返工单）。',
    };
}
/**
 * The delivery gate: stages all passed **and** the DoD audit green — re-verified
 * here, never trusted from an earlier run, because a delivered factory is a
 * promise the plugin makes to the user.
 */
export async function deliverFactory(call, input) {
    const factoryId = requireFactoryId(input.factoryId);
    const state = await loadFactory(call, factoryId);
    requireCaptainOf(call, state);
    const deliveryPath = optional(input.deliveryPath) ?? state.deliveryPath ?? 'DELIVERY.md';
    if (state.phase === 'delivered') {
        return {
            summary: `工厂 ${factoryId} 已经交付过（phase=delivered，交付物 ${state.deliveryPath ?? deliveryPath}）——幂等，未重复执行。`,
            factoryId,
            delivered: true,
            alreadyDelivered: true,
            phase: state.phase,
            deliveryPath: state.deliveryPath ?? deliveryPath,
            dodPassed: state.dod.filter((item) => dodStateStatus(item, state.securityTriggered) === 'passed').length,
            dodTotal: state.dod.length,
            blocked: [],
            stagesPassed: true,
            items: [],
            nextAction: '如需清理用 factory_delete（默认归档到 archive/）。',
        };
    }
    if (state.phase === 'staged') {
        throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 还在 staged —— 先经用户批准（factory_approve）并跑完流水线。`);
    }
    if (state.phase === 'halted') {
        throw new FactoryToolError(`code-factory: 工厂 ${factoryId} 处于 halted —— 先 factory_resume 再交付。`);
    }
    const stagesNotPassed = state.stages.filter((stage) => stage.status !== 'passed');
    const runner = gateRunnerFor(call, call.config.allowNodeFallback);
    const audit = await runner.runDod({
        securityTriggered: state.securityTriggered,
        pipeline: state.pipeline,
        ...(input.minCommits === undefined ? {} : { minCommits: input.minCommits }),
        signal: call.signal,
    });
    const rows = dodRows(audit.audit.results);
    const blocked = [];
    if (stagesNotPassed.length > 0) {
        blocked.push(`阶段未全部通过: ${stagesNotPassed.map((stage) => `${stage.id}(${stage.status})`).join('、')}`);
    }
    if (!audit.audit.summary.ok) {
        blocked.push(`DoD 未全绿: ${audit.audit.summary.missing.join('；') || '存在未达标/待执行条目'}`);
    }
    const note = optional(input.note);
    const { state: saved } = await mutateFactory(call, factoryId, (current) => {
        if (current.captainSessionId !== call.callerId) {
            throw new FactoryToolError(`code-factory: 只有队长能交付工厂 ${factoryId}。`);
        }
        current.dod = audit.audit.results.map((item) => ({
            id: item.id,
            label: item.label,
            ok: item.ok,
            status: item.status,
            evidence: item.evidence,
        }));
        if (blocked.length === 0) {
            transitionPhase(current, 'delivered', call.store.now());
            current.deliveryPath = deliveryPath;
        }
        return current.phase;
    });
    await captainNote(call, factoryId, `[交付] ${blocked.length === 0 ? `成功，交付物 ${deliveryPath}` : `被拦下: ${blocked.join(' / ')}`}`
        + (note === undefined ? '' : `\n队长说明: ${note}`));
    return {
        summary: blocked.length === 0
            ? `工厂 ${factoryId} 已交付：DoD ${audit.audit.summary.passed}/${audit.audit.summary.total} 通过，交付物 ${deliveryPath}，phase=delivered。`
            : `工厂 ${factoryId} 不能交付：${blocked.join(' / ')}。`,
        factoryId,
        delivered: blocked.length === 0,
        alreadyDelivered: false,
        phase: saved.phase,
        ...(blocked.length === 0 ? { deliveryPath } : {}),
        dodPassed: audit.audit.summary.passed,
        dodTotal: audit.audit.summary.total,
        blocked,
        stagesPassed: stagesNotPassed.length === 0,
        items: rows,
        nextAction: blocked.length === 0
            ? '把交付结果与工件路径报给用户；如需清理用 factory_delete（默认归档）。'
            : '把 blocked 里的每一条交给对应角色返工（factory_message / factory_gate 的打回单），修好后重新 factory_dod_check。',
    };
}
/**
 * Ends a factory: interrupts and releases every member, marks the record
 * `discarded`, then archives (default) or destroys the directory.
 *
 * Archiving is the default because a hard delete loses the audit trail of a
 * pipeline that may have produced real artifacts; `mode: 'destroy'` requires an
 * explicit `confirm: true`.
 */
export async function deleteFactory(call, input) {
    const factoryId = requireFactoryId(input.factoryId);
    const state = await loadFactory(call, factoryId);
    requireCaptainOf(call, state);
    const modeRaw = optional(input.mode) ?? 'archive';
    if (modeRaw !== 'archive' && modeRaw !== 'destroy') {
        throw new FactoryToolError('code-factory: mode 只能是 archive（默认，移到 archive/）或 destroy（真删除，需要 confirm=true）。');
    }
    if (modeRaw === 'destroy' && input.confirm !== true) {
        throw new FactoryToolError(`code-factory: 真删除工厂 ${factoryId} 需要显式确认 —— 请传 confirm=true。`
            + ' 默认的 archive 保留完整记录（factory.json + inbox + artifacts），推荐用它。');
    }
    const { value } = await mutateFactory(call, factoryId, async (current) => {
        if (current.captainSessionId !== call.callerId) {
            throw new FactoryToolError(`code-factory: 只有队长能结束工厂 ${factoryId}。`);
        }
        transitionPhase(current, 'discarded', call.store.now());
        const errors = [];
        const sessionIds = [];
        for (const member of current.members) {
            const sessionId = member.sessionId;
            if (sessionId === undefined || sessionId === '')
                continue;
            sessionIds.push(sessionId);
            const result = interruptMember(call.plugin, call.caller, sessionId);
            if (!result.ok)
                errors.push(`${canonicalRoleId(member.role)}: ${result.error ?? '中断失败'}`);
        }
        let drained = [];
        if (sessionIds.length > 0) {
            const drain = await drainMembers(call.plugin, call.caller, sessionIds);
            if (drain.ok) {
                drained = sessionIds;
                for (const member of current.members) {
                    if (member.sessionId !== undefined && sessionIds.includes(member.sessionId)) {
                        transitionMember(member, 'removed', call.store.now());
                    }
                }
            }
            else {
                errors.push(drain.error ?? '回收成员失败');
            }
        }
        return { drained, errors };
    });
    let archived = false;
    let removed = false;
    let where;
    if (modeRaw === 'archive') {
        const result = await call.store.archive(factoryId);
        archived = true;
        where = result.to;
    }
    else {
        removed = await call.store.remove(factoryId);
    }
    return {
        summary: `工厂 ${factoryId} 已结束（phase=discarded，mode=${modeRaw}）：回收成员 ${value.drained.length} 个`
            + (value.errors.length > 0 ? `，${value.errors.length} 个失败` : '')
            + (archived ? `，已归档到 ${where}` : removed ? '，目录已删除' : '，目录不存在')
            + '。',
        factoryId,
        mode: modeRaw,
        archived,
        removed,
        drained: value.drained,
        drainErrors: value.errors,
        ...(where === undefined ? {} : { path: where }),
        nextAction: '需要新任务时重新 factory_plan（会得到新的 factoryId）。',
    };
}
//# sourceMappingURL=delivery.js.map