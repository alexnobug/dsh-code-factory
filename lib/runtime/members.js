/**
 * members.ts — the member lifecycle: spawn → deliver → interrupt → drain.
 *
 * A "member" is one durable **continuable** child agent of the captain
 * (实施方案 §2.1: 当前会话即队长，成员为 durable 子代理). Durable means the
 * member keeps its conversation across turns *and* across harness restarts: the
 * captain queues its next turn through the inbox, the member works through its
 * turn, reports through `factory_report`, and goes idle again — exactly the model
 * the reference plugin `@nanmicoder/dsh-agent-teams` established.
 *
 * API shape (verified, 0.2.2-rc.3):
 *
 * ```ts
 * const started = await ctx.subagents.startActivation({
 *   provider, label,               // provider NAME string, not the provider object
 *   parent,                        // flat SubagentStartRequest
 *   prompt: ContentBlock[],        // role persona merged into the initial prompt
 *   signal,
 *   delivery: 'parent',            // the captain model receives the settlement notice
 *   agentOptions,                  // optional model route
 * })
 * started.childId   // durable child session id → factory.json members[].sessionId
 * started.messageId // OPTIONAL — only a reserved-childId start guarantees one
 * ```
 * — live `Service.listService {service:'subagents'}`;
 *   `node_modules/@deepseek-ai/dsh-subagent/lib/types/index.d.ts` (service) and
 *   `lib/types/types.d.ts` (`SubagentActivationSpec` / `SubagentActivation`).
 *
 * `persona` / `toolFilter` are gone from the public start request; the persona is
 * merged into the initial prompt. Captain tools are hidden from delegated agents
 * with step-admission conditions in `tools/captain.ts`; delegation-shaped tools
 * from the host preset remain guarded by `installMemberDelegationGuard`.
 *
 * **`maxDepth` is deliberately not sent.** See
 * `compat.installMemberDelegationGuard` for the full argument: `maxDepth` caps the
 * depth of *this creation* (`childDepth = parent + 1`, then
 * `childDepth > maxDepth ⇒ SubagentDepthError`,
 * `lib/types/child-agent.js:32-38`), so `maxDepth: 0` rejects the member itself
 * rather than stopping the member from delegating. The depth-0 rule is enforced
 * by the member toolFilter (no delegation tool is visible) plus the parent-chain
 * guard.
 *
 * Failure policy: a spawn failure is a **recorded outcome**, not an exception.
 * `state.members[].spawnError` is what the captain sees in `factory_status`, and
 * the returned result carries the same reason plus the provider audit so the
 * caller can persist and report without re-deriving anything.
 *
 * @module dsh-code-factory/runtime/members
 */
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { canonicalRoleId } from '../domain/roles.js';
import { LESSON_PROMPT_LIMIT, renderMemberBrief, renderStageDispatch } from '../prompt/member-brief.js';
import { selectLessonsForRole } from '../store/evolution.js';
import { runDetachedFromFactoryLocks } from '../store/lock.js';
import { transitionMember } from '../store/state.js';
import { logLine } from '../tools/context.js';
import { asSessionId, deliverToMember, describeError, dispatchSource, drainMemberChildren, errorCodeOf, interruptMemberTurn, listMemberChildren, startWithLenientFilter, textContent, } from './compat.js';
import { describeProviderVerdict, inspectMemberProvider } from './provider-guard.js';
import { computeMemberToolFilter, probeToolSurface, validateMemberBaseTools } from './tool-surface.js';
/* ------------------------------------------------------- the start request */
/* ------------------------------------------------------------------ consts */
/** Default label prefix so a member is recognisable in the host's agent list. */
export const MEMBER_LABEL_SUFFIX_SEPARATOR = '@';
/** How long a dispatch message may be before it is trimmed for the label. */
const LABEL_MAX_CHARS = 80;
/* --------------------------------------------------------------- helpers */
/** Canonical role id of a member record / role definition. */
export function memberRoleId(role) {
    return canonicalRoleId(typeof role === 'string' ? role : role.id);
}
/** Finds one member record, canonicalising the role spelling. */
export function findMember(state, role) {
    const id = memberRoleId(role);
    return state.members.find((member) => canonicalRoleId(member.role) === id);
}
/** Member label used for `startActivation({ label })` and the agent list. */
export function memberLabel(role, state) {
    const raw = `${role.title}${MEMBER_LABEL_SUFFIX_SEPARATOR}${state.id}`;
    return raw.length > LABEL_MAX_CHARS ? raw.slice(0, LABEL_MAX_CHARS) : raw;
}
/** Resolves the LLM route options for one member (record snapshot or override). */
export function memberAgentOptions(member, override) {
    if (override !== undefined)
        return override;
    const options = {};
    if (typeof member.provider === 'string' && member.provider.length > 0)
        options.provider = member.provider;
    if (typeof member.model === 'string' && member.model.length > 0)
        options.model = member.model;
    if (typeof member.reasoningEffort === 'string' && member.reasoningEffort.length > 0) {
        options.reasoningEffort = ReasoningEffortId(member.reasoningEffort);
    }
    return Object.keys(options).length > 0 ? options : undefined;
}
/**
 * Reads one member's live activity.
 *
 * `ctx.agents.get(id)` is the registry lookup (`dsh-agent/lib/types/index.d.ts:343`)
 * and `Agent.status` is the live lifecycle state (`runtime-types.d.ts:147`).
 * `ready` means the session is durable but not resident — a cold resume on the
 * next delivery brings it back.
 *
 * @param ctx - the plugin context (injects `agents`).
 * @param sessionId - the member's durable child session id.
 * @returns the liveness triple.
 */
export function memberLiveness(ctx, sessionId) {
    const agent = lookupAgent(ctx, sessionId);
    if (agent === undefined)
        return { live: false, running: false, status: 'ready' };
    const running = agent.status === 'running';
    return { live: true, running, status: running ? 'running' : 'idle' };
}
function lookupAgent(ctx, sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0)
        return undefined;
    const agents = ctx.agents;
    if (agents === undefined || typeof agents.get !== 'function')
        return undefined;
    try {
        return agents.get.call(agents, sessionId);
    }
    catch (error) {
        // A registry that throws is not the same fact as "this session is gone".
        // `memberLiveness` maps `undefined` to `{ live: false, status: 'ready' }`, so
        // a silent swallow here would let the planner call a resident member cold (or
        // strand a live one) while claiming it knows. Report it, keep the documented
        // absent fallback: the caller must not gain a new failure mode.
        logLine(ctx, 'warn', `agent registry lookup failed for session ${sessionId}: ${describeError(error)}`);
        return undefined;
    }
}
function failure(role, code, error, availableProviders = [], droppedTools = []) {
    return { ok: false, reused: false, role: memberRoleId(role), code, error, availableProviders, droppedTools };
}
function recordSpawnError(member, reason) {
    if (member === undefined)
        return;
    member.spawnError = reason;
    transitionMember(member, 'error');
}
/**
 * Merges the role's historical lessons into a dispatch focus.
 *
 * Pure and idempotent: an explicit `focus.lessons` always wins (the caller may
 * have selected a narrower set), and a ledger with nothing for this role leaves
 * the focus untouched — no empty 「历史教训」 block is ever emitted.
 *
 * @param focus - the caller's focus, when it has one.
 * @param lessons - the whole evolution ledger, when the caller read it.
 * @param role - canonical role id to select lessons for.
 * @returns the focus to render, or the original (possibly `undefined`).
 */
function focusWithLessons(focus, lessons, role) {
    if (lessons === undefined || lessons.length === 0)
        return focus;
    if (focus?.lessons !== undefined)
        return focus;
    const selected = selectLessonsForRole(lessons, role, undefined, LESSON_PROMPT_LIMIT);
    if (selected.length === 0)
        return focus;
    return { ...(focus ?? {}), lessons: selected };
}
/* ------------------------------------------------------------ spawnMember */
/**
 * Spawns one member as a durable continuable child of the captain.
 *
 * Preflight order (every step fails loud, never degrades):
 *  1. the role exists and is on this factory's roster;
 *  2. the provider exists and implements `prepareContinuable`;
 *  3. the three member factory tools are registered;
 *  4. the legacy deny-list is computed from the live registry for audit and
 *     name-liveness; 0.2.2 does not send it on the flat start spec. Captain tools
 *     are hidden from members by `tools.register(..., { when })`.
 *
 * On success `state.members[].sessionId` is filled and the member becomes `idle`:
 * the initial prompt *is* its first dispatch, so the member starts working in the
 * very turn that prompt opens (the scheduler moves the record to `working` with
 * the stage it dispatched). On failure `state.members[].spawnError` carries the
 * reason.
 *
 * The caller owns persistence (`store.mutate` wraps this call); this function only
 * mutates the in-memory record it was handed.
 *
 * @param ctx - plugin context (injects `subagents`, `agents`, `tools`).
 * @param caller - the exact live captain agent (the member's direct parent).
 * @param role - the role definition to instantiate.
 * @param state - the factory record whose member slot is filled.
 * @param signal - caller cancellation, forwarded to the start.
 * @param options - provider name and spawn knobs.
 * @returns the outcome; a failure is returned, never thrown.
 */
export async function spawnMember(ctx, caller, role, state, signal, options) {
    const roleId = memberRoleId(role);
    const member = findMember(state, roleId);
    if (member === undefined) {
        return failure(roleId, 'not-in-roster', `code-factory: 角色 "${roleId}" 不在工厂 ${state.id} 的编制里 —— 先经 factory_plan / factory_edit_plan 入编。`);
    }
    if (typeof member.sessionId === 'string' && member.sessionId.length > 0 && member.status !== 'removed') {
        return {
            ok: true,
            reused: true,
            role: roleId,
            childId: member.sessionId,
            detail: `复用已有成员会话 ${member.sessionId}（状态 ${member.status}）`,
        };
    }
    if (signal.aborted) {
        const reason = 'code-factory: 创建成员前调用已被取消';
        recordSpawnError(member, reason);
        return failure(roleId, 'cancelled', reason);
    }
    const verdict = inspectMemberProvider(ctx, options.provider);
    if (!verdict.ok || verdict.provider === undefined) {
        const reason = describeProviderVerdict(verdict);
        recordSpawnError(member, reason);
        return failure(roleId, 'provider', reason, verdict.available);
    }
    const probe = probeToolSurface(ctx, caller);
    const baseTools = validateMemberBaseTools(probe);
    if (!baseTools.ok) {
        recordSpawnError(member, baseTools.reason);
        return failure(roleId, 'tool-surface', baseTools.reason, verdict.available);
    }
    const computed = computeMemberToolFilter(probe, {
        memberDepth: options.memberDepth ?? 0,
        extraDeny: options.extraDeny,
        keep: role.tools,
    });
    const prompt = options.initialPrompt ?? renderMemberBrief(role, state, focusWithLessons(options.focus, options.lessons, roleId));
    const label = options.label ?? memberLabel(role, state);
    const agentOptions = memberAgentOptions(member, options.agentOptions);
    const promptText = [role.systemPrompt, prompt].filter((part) => part.trim().length > 0).join('\n\n');
    try {
        const started = await runDetachedFromFactoryLocks(() => startWithLenientFilter((_toolFilter) => {
            // DSH 0.2.2-rc.3: SubagentActivationSpec 是扁平结构（SubagentStartRequest 字段
            // 直接在顶层：parent / prompt / signal / agentOptions），旧的 `request` 嵌套字段
            // 已不存在；prompt 也由 string 改为 ContentBlock[]。persona/toolFilter 已从公开
            // start 请求移除（宿主按 preset 组合），这里把 persona 合并进初始 prompt。
            const spec = {
                provider: verdict.name,
                label,
                parent: caller,
                prompt: textContent(promptText),
                signal,
                // Parent delivery: the captain's model receives the member's settlement
                // notice. `caller` would only resolve `activation.result`, and this
                // plugin never awaits it — the spawn returns before the member's first
                // turn ends — so that notice would have nowhere to go.
                delivery: 'parent',
                ...(agentOptions !== undefined ? { agentOptions } : {}),
            };
            return ctx.subagents.startActivation(spec);
        }, computed.filter));
        const childId = String(started.value.childId);
        member.sessionId = childId;
        transitionMember(member, 'idle', (options.now ?? Date.now)());
        member.startedAt = (options.now ?? Date.now)();
        delete member.spawnError;
        return {
            ok: true,
            reused: false,
            role: roleId,
            label,
            childId,
            ...(started.value.messageId !== undefined ? { messageId: String(started.value.messageId) } : {}),
            toolFilter: started.filter,
            droppedTools: [...computed.droppedUnknown, ...started.dropped],
            deniedTools: computed.denied,
            promptChars: prompt.length,
            detail: `已创建成员 ${role.title}（${childId}）；${computed.summary}`
                + (started.dropped.length > 0 ? `；旧 host 拒绝的过滤器名已从审计名单剔除: ${started.dropped.join(', ')}` : ''),
        };
    }
    catch (error) {
        const reason = `code-factory: 创建成员 ${role.title} 失败 —— ${describeError(error)}`;
        recordSpawnError(member, reason);
        return failure(roleId, 'start-failed', reason, verdict.available, computed.droppedUnknown);
    }
}
/**
 * Delivers one message to a member.
 *
 * `queue` is the dispatch path: the message becomes its own turn, so a rework
 * note never merges into a step the member is already running. The delivery also
 * **wakes** the member — an idle one starts a turn, an absent (cold) one resumes
 * from persistence — which is what makes "打回后唤醒责任人" work
 * (`dsh-subagent/lib/types/index.d.ts:143-156`).
 *
 * @param ctx - plugin context.
 * @param caller - the exact live captain agent.
 * @param member - the member record (updated with `working` / `rework` status).
 * @param text - the message body.
 * @param signal - caller cancellation.
 * @param options - delivery mode and source fields.
 * @returns the outcome; a failure is returned with `ok: false`.
 */
export async function sendToMember(ctx, caller, member, text, signal, options = {}) {
    const role = canonicalRoleId(member.role);
    const mode = options.mode ?? 'queue';
    const sessionId = member.sessionId ?? '';
    if (sessionId.length === 0) {
        return { ok: false, role, sessionId, mode, text, error: `成员 ${role} 还没有会话 id（spawnError: ${member.spawnError ?? '未创建'}）` };
    }
    try {
        const receipt = await runDetachedFromFactoryLocks(() => deliverToMember(ctx.subagents, caller, sessionId, text, signal, mode, dispatchSource({ stage: options.stage, role })));
        return { ok: true, role, sessionId, mode, via: receipt.via, messageId: receipt.messageId, text };
    }
    catch (error) {
        const code = errorCodeOf(error);
        return {
            ok: false,
            role,
            sessionId,
            mode,
            text,
            error: describeError(error),
            ...(code === undefined ? {} : { errorCode: code }),
        };
    }
}
/**
 * Renders and delivers one stage dispatch (or rework note) to a member, writing
 * the member status the scheduler relies on.
 *
 * @param ctx - plugin context.
 * @param caller - the exact live captain agent.
 * @param role - the role definition (for the brief body).
 * @param state - the factory record.
 * @param signal - caller cancellation.
 * @param options - focus, mode and optional text override.
 * @returns the send outcome plus the rendered text.
 */
export async function dispatchToMember(ctx, caller, role, state, signal, options) {
    const member = findMember(state, role);
    if (member === undefined) {
        return {
            ok: false,
            role: memberRoleId(role),
            sessionId: '',
            mode: options.mode ?? 'queue',
            text: '',
            error: `角色 ${role.id} 不在编制里`,
        };
    }
    const focus = focusWithLessons(options.focus, options.lessons, memberRoleId(role)) ?? options.focus;
    const text = options.text ?? renderStageDispatch(role, state, focus);
    const mode = options.mode ?? (options.rework === true ? 'steer' : 'queue');
    const result = await sendToMember(ctx, caller, member, text, signal, { ...options, mode });
    if (result.ok) {
        transitionMember(member, options.rework === true ? 'rework' : 'working', (options.now ?? Date.now)());
        member.currentStage = options.focus.stageId;
        member.startedAt = member.startedAt ?? (options.now ?? Date.now)();
    }
    return result;
}
/* ------------------------------------------------------------- interrupt */
/**
 * Interrupts one member's current turn.
 *
 * Never throws: an interrupt is best-effort cancellation, and a member that is
 * already idle is an accepted no-op. The reason is returned for the feed.
 *
 * @param ctx - plugin context.
 * @param caller - the exact live captain agent.
 * @param sessionId - the member's durable child session id.
 * @returns whether the authority was accepted.
 */
export function interruptMember(ctx, caller, sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { ok: false, error: '成员没有会话 id，无需中断' };
    }
    // `interrupt` is a fire-and-return host call: the cancellation it schedules (and
    // anything the cancelled turn does while winding down) is an async descendant of
    // THIS call, so it must not inherit the caller's held-lock set either.
    return runDetachedFromFactoryLocks(() => interruptMemberTurn(ctx.subagents, caller, sessionId));
}
/* ----------------------------------------------------------------- drain */
/**
 * Releases several members at once (halt / delete / archive).
 *
 * @param ctx - plugin context.
 * @param caller - the exact live captain agent.
 * @param sessionIds - durable child session ids.
 * @param state - optional factory record whose members are marked `removed`.
 * @returns the drain outcome.
 */
export async function drainMembers(ctx, caller, sessionIds, state) {
    const result = await runDetachedFromFactoryLocks(() => drainMemberChildren(ctx.subagents, caller, sessionIds));
    if (result.ok && state !== undefined) {
        for (const member of state.members) {
            if (member.sessionId !== undefined && sessionIds.includes(member.sessionId)) {
                transitionMember(member, 'removed');
            }
        }
    }
    return result;
}
/**
 * Reconciles `factory.json` member sessions against the durable child catalog.
 *
 * After a harness restart the member ids survive on disk while the catalog is the
 * only authoritative list of what the captain actually owns. A recorded id with no
 * catalog row is reported as `missingFromCatalog` instead of being woken blindly.
 *
 * @param ctx - plugin context.
 * @param parentSessionId - the captain's session id.
 * @param state - the factory record.
 * @param signal - optional cancellation.
 * @returns the reconciliation report.
 */
export async function reconcileMembers(ctx, parentSessionId, state, signal) {
    const rows = await listMemberChildren(ctx.subagents, parentSessionId, signal, (detail) => {
        logLine(ctx, 'warn', detail);
    });
    const recorded = state.members
        .map((member) => member.sessionId)
        .filter((id) => typeof id === 'string' && id.length > 0);
    if (rows === undefined) {
        return { catalogReadable: false, known: recorded, missingFromCatalog: [], orphanRows: [] };
    }
    const catalogIds = new Set(rows.map((row) => row.id));
    const recordedSet = new Set(recorded);
    return {
        catalogReadable: true,
        known: recorded.filter((id) => catalogIds.has(id)),
        missingFromCatalog: recorded.filter((id) => !catalogIds.has(id)),
        orphanRows: rows.filter((row) => !recordedSet.has(row.id)).map((row) => row.id),
    };
}
/* ----------------------------------------------------------------- misc */
/** Exported for tests: the exact durable-id cast boundary. */
export { asSessionId };
//# sourceMappingURL=members.js.map