/**
 * engine/plumbing.ts — shared plumbing for every factory tool.
 *
 * Cross-cutting helpers the tool handlers share: the ledger/attempt
 * bookkeeping that feeds the cockpit, mailbox writes, the gate-runner and
 * command-row adapters, the shared row shapes, and the factory lookup used
 * when a call does not name its factory explicitly.
 *
 * Moved here verbatim from the former single-file `src/tools/engine.ts`
 * (engineering review finding M5). Only this header, the imports and the
 * `export` keywords on cross-module helpers are new — no body was edited.
 *
 * @module dsh-code-factory/tools/engine/plumbing
 */
import { randomUUID } from 'node:crypto';
import { MESSAGE_KINDS } from '../../shared/types.js';
import { stageIds } from '../../domain/pipeline.js';
import { canonicalRoleId, getRole } from '../../domain/roles.js';
import { createGateRunner } from '../../runtime/gates-runner.js';
import { activeStage, pendingStages, transitionStage } from '../../store/state.js';
import { FactoryToolError, logLine, loadFactory, requireFactoryId } from '../context.js';
/* ------------------------------------------------------------------ limits */
/** Mailbox copies are clipped so one long dispatch cannot bloat the feed. */
const MAIL_CLIP_CHARS = 8_000;
/** Largest number of upstream artifacts rendered into one dispatch. */
export const UPSTREAM_ARTIFACT_LIMIT = 12;
/** Per-factory attempt-ledger bound (the ledger is a process-local accelerator). */
const LEDGER_LIMIT = 400;
/**
 * Narrows a model-supplied string to the closed `MessageKind` union.
 *
 * The list itself lives in `src/shared/types.ts` beside the union (review finding
 * H8 follow-up): the browser half validates the same field while parsing the
 * snapshot, and two hand-kept copies would let one side accept a kind the other
 * rejects, with no build error either way.
 */
export function isMessageKind(value) {
    return MESSAGE_KINDS.some((kind) => kind === value);
}
/* ---------------------------------------------------------------- helpers */
/** Trims a model-supplied optional string; blank means absent. */
export function optional(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}
/** Trims a required string or refuses the call. */
export function required(value, what) {
    const trimmed = optional(value);
    if (trimmed === undefined)
        throw new FactoryToolError(`code-factory: ${what} 不能为空。`);
    return trimmed;
}
/** Truncates a string for a mailbox line / a tool result. */
export function clip(text, max = MAIL_CLIP_CHARS) {
    return text.length <= max ? text : `${text.slice(0, max)}\n…（截断，共 ${text.length} 字符）`;
}
/** A finite non-negative integer, or `undefined`. */
export function optionalCount(value, minimum = 0) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return undefined;
    return Math.max(minimum, Math.trunc(value));
}
/** One roster row for a role id. */
export function roleRow(role) {
    const canonical = canonicalRoleId(role);
    const def = getRole(canonical);
    return {
        role: canonical,
        title: def?.title ?? canonical,
        codename: def?.codename ?? canonical.toUpperCase(),
        tier: def?.tier ?? 'chat',
        duties: def?.duties ?? '',
    };
}
/** New pipeline stage records for a factory being (re)staged. */
export function freshStageRecords(pipeline) {
    return stageIds(pipeline).map((id) => ({ id, status: 'pending', round: 0, attempts: 0 }));
}
/** New member records for a roster that has not been spawned yet. */
export function freshMemberRecords(team) {
    return team.map((role) => ({ role, status: 'staged', tokens: 0 }));
}
/** True when `id` names a stage of this factory's own pipeline. */
function hasStage(state, id) {
    return state.stages.some((rec) => rec.id === id);
}
/** The stage ids of this factory, for error text. */
function stageIdList(state) {
    return state.stages.map((rec) => rec.id).join(' / ');
}
/**
 * Resolves a stage **the caller named itself** (a tool argument).
 *
 * An unknown value is an error, not a fallback: `member.currentStage` and
 * `artifacts.json` both record this string, so accepting a typo invents a
 * phantom stage that no gate ever reads while the member's real stage silently
 * stays active. The message lists the ids that would have been accepted.
 */
export function resolveReportedStage(state, requested) {
    const trimmed = requested.trim();
    if (!hasStage(state, trimmed)) {
        throw new FactoryToolError(`code-factory: 阶段 ${JSON.stringify(trimmed)} 不在工厂 ${state.id} 的流水线里。`
            + `本工厂的阶段是：${stageIdList(state)}。`
            + '请用其中之一，或省略 stage 让系统按你当前所在阶段归属。');
    }
    return trimmed;
}
/**
 * The stage a member's artifact belongs to when neither the member nor its roster
 * row names one: the stage it is working, else the first stage that has not passed.
 *
 * `preferred` here is a **derived hint** (the member's own `currentStage`), not a
 * tool argument, so it is only used when it names a real stage of this pipeline —
 * a stale value left by a re-planned factory must not throw, or that record could
 * never report again. Caller-supplied values go through {@link resolveReportedStage}.
 */
export function artifactStageId(state, preferred) {
    const hint = preferred?.trim() ?? '';
    if (hint !== '' && hasStage(state, hint))
        return hint;
    const active = activeStage(state);
    if (active !== undefined)
        return active.id;
    const next = pendingStages(state)[0];
    if (next !== undefined)
        return next.id;
    return state.stages[state.stages.length - 1]?.id ?? state.pipeline;
}
/** `<stateDir>/<id>/factory.json`, as the human sees it. */
export function planPath(call, factoryId) {
    return `${call.config.stateDir}/${factoryId}/factory.json`;
}
/* ----------------------------------------------------------- attempt ledger */
/**
 * The dispatch ledger, **carried by the durable record** (`state.dispatchAttempts`).
 *
 * It used to be a process-local `Map` keyed by store root + factory id, on the
 * theory that it was only an accelerator. It was not: after a host restart the
 * ledger was empty, so `planStageDispatch` saw `member.status === 'working'` with
 * an executor it could not judge (`isLive` undefined) and answered `wait` until
 * the 30-minute stale threshold elapsed — a factory could sit still for half an
 * hour with nothing actually running (review finding M13).
 *
 * Storing it in `factory.json` costs one array rewrite per state save (capped by
 * `LEDGER_LIMIT`) and buys three things:
 *  - the recovery decision is available **immediately** after a cold start, from
 *    the same read that produced the state;
 *  - the ledger is covered by the same atomic write, the same cross-process lock
 *    and the same backup/restore drill as everything else in the record;
 *  - there is exactly one source of truth, so a stale in-memory copy cannot
 *    contradict what is on disk.
 */
/** The attempt list the scheduler should plan against. Never `undefined`. */
export function ledgerFor(state) {
    return state.dispatchAttempts ?? [];
}
/** Records one applied dispatch so the scheduler will not repeat it. */
export function recordAttempt(state, attempt, now) {
    const ledger = state.dispatchAttempts ?? (state.dispatchAttempts = []);
    ledger.push({ ...attempt, dispatchedAt: attempt.dispatchedAt ?? now });
    // Oldest first: the scheduler only ever looks at the newest entry per
    // (stage, role), so trimming from the front cannot change a decision, and it
    // bounds the rewrite cost of every subsequent save.
    if (ledger.length > LEDGER_LIMIT)
        ledger.splice(0, ledger.length - LEDGER_LIMIT);
}
/** Marks the attempts of one role (optionally one stage) as settled by a report. */
export function settleAttempts(state, role, stageId, now) {
    const ledger = state.dispatchAttempts;
    if (ledger === undefined)
        return 0;
    let settled = 0;
    for (let index = ledger.length - 1; index >= 0; index -= 1) {
        const attempt = ledger[index];
        if (attempt === undefined || attempt.settledAt !== undefined)
            continue;
        if (canonicalRoleId(attempt.role) !== canonicalRoleId(role))
            continue;
        if (stageId !== undefined && attempt.stageId !== stageId)
            continue;
        ledger[index] = { ...attempt, settledAt: now };
        settled += 1;
    }
    return settled;
}
/** Records every dispatch one applied plan actually delivered. */
export function recordPlanAttempts(state, plan, outcome, now) {
    for (const decision of plan.dispatches) {
        if (!decision.consumesAttempt)
            continue;
        const applied = outcome.applied.find((item) => canonicalRoleId(item.role) === canonicalRoleId(decision.role));
        // A failed dispatch never reached the member, so it is NOT an attempt: the
        // next dispatch must be free to retry it.
        if (applied === undefined)
            continue;
        recordAttempt(state, {
            stageId: decision.stageId,
            round: plan.round,
            role: canonicalRoleId(decision.role),
            kind: decision.action === 'rework' ? 'rework' : 'initial',
            ...(applied.sessionId === undefined ? {} : { sessionId: applied.sessionId }),
        }, now);
    }
}
/**
 * Parks a stage at its gate once its owner has reported `done`.
 *
 * `gate` is the state the whole design assumes between "the member finished" and
 * "the captain adjudicated": `scheduler.selectDispatchStage` refuses to re-dispatch
 * a stage that is parked, `scheduler`'s `awaitingVerdict` and the "阶段等待裁决"
 * alert both key off `status === 'gate'`, and `STAGE_STATUS_TRANSITIONS` allows
 * `active -> gate`. Until this ran, the only writer was the humanApproval branch of
 * `gateFactory`, so every ordinary stage went `active -> passed` and those three
 * readers were unreachable.
 *
 * Only `active` is moved: `pending` has no work to adjudicate yet and the state
 * machine forbids `pending -> gate`, while `passed`/`rejected` are already decided
 * verdicts that a late report must not reopen. A second `done` report is a no-op.
 */
export function parkStageAtGate(state, stageId, now) {
    const rec = state.stages.find((stage) => stage.id === stageId);
    if (rec === undefined || rec.status !== 'active')
        return;
    transitionStage(rec, 'gate', now);
}
/* ------------------------------------------------------------- mail helpers */
/** Writes one mailbox line, clip-protected. */
export async function postMail(call, factoryId, input) {
    return await call.store.mail(factoryId, {
        id: input.id,
        from: input.from,
        to: input.to,
        content: clip(input.content),
        kind: input.kind,
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(input.round === undefined ? {} : { round: input.round }),
        ...(input.deliveredAt === undefined ? {} : { deliveredAt: input.deliveredAt }),
    });
}
/** One captain log line in the feed (the captain's own inbox is the audit trail). */
export async function captainNote(call, factoryId, content, kind = 'system', extra = {}) {
    return await postMail(call, factoryId, {
        id: randomUUID(),
        from: 'captain',
        to: 'captain',
        content,
        kind,
        ...(extra.stage === undefined ? {} : { stage: extra.stage }),
        ...(extra.round === undefined ? {} : { round: extra.round }),
    });
}
/* -------------------------------------------------------------- gate runner */
/** The gate executor for this call: real commands, real exit codes, template-only. */
export function gateRunnerFor(call, allowNodeFallback) {
    return createGateRunner({
        ctx: call.plugin,
        workspace: call.workspace,
        allowNodeFallback,
        onCommand: (outcome) => {
            logLine(call.plugin, outcome.ok ? 'info' : 'warn', `命令 ${outcome.command} → ${outcome.detail}`);
        },
    });
}
/** Projection of the commands one gate/DoD run started. */
export function commandRows(outcomes) {
    return outcomes.map((outcome) => ({
        command: outcome.command,
        ok: outcome.ok,
        detail: outcome.detail,
        timedOut: outcome.timedOut,
        via: outcome.via,
        ...(outcome.exitCode === null ? {} : { exitCode: outcome.exitCode }),
    }));
}
export async function findMemberFactoryForCall(call) {
    for (const summary of await call.store.list()) {
        const state = await call.store.load(summary.id);
        if (state === undefined)
            continue;
        const member = state.members.find((candidate) => candidate.sessionId === call.callerId);
        if (member !== undefined)
            return { state, member };
    }
    return undefined;
}
export async function findCaptainFactoryForCall(call) {
    for (const summary of await call.store.list()) {
        if (summary.captainSessionId !== call.callerId)
            continue;
        const state = await call.store.load(summary.id);
        if (state !== undefined)
            return state;
    }
    return undefined;
}
/** Resolves the member's own factory + roster row. */
export async function resolveMemberFactory(call, factoryIdInput) {
    const explicit = optional(factoryIdInput);
    if (explicit !== undefined) {
        const state = await loadFactory(call, requireFactoryId(explicit));
        const member = state.members.find((candidate) => candidate.sessionId === call.callerId);
        if (member === undefined) {
            throw new FactoryToolError(`code-factory: 当前会话 ${call.callerId} 不是工厂 ${state.id} 的成员 —— 成员工具只能操作自己所属的工厂。`);
        }
        return {
            state,
            role: canonicalRoleId(member.role),
            ...(member.currentStage === undefined ? {} : { stage: member.currentStage }),
        };
    }
    for (const summary of await call.store.list()) {
        const state = await call.store.load(summary.id);
        if (state === undefined)
            continue;
        const member = state.members.find((candidate) => candidate.sessionId === call.callerId);
        if (member === undefined)
            continue;
        return {
            state,
            role: canonicalRoleId(member.role),
            ...(member.currentStage === undefined ? {} : { stage: member.currentStage }),
        };
    }
    throw new FactoryToolError('code-factory: 当前会话不是任何工厂的成员 —— 成员工具（factory_report / factory_inbox / factory_block）只供成员使用；'
        + '队长请用 factory_status / factory_gate / factory_message。');
}
//# sourceMappingURL=plumbing.js.map