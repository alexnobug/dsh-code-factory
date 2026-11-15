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
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent';
import type { ToolRestriction } from '@deepseek-ai/dsh-tools';
import type { FactoryState, LessonRecord, MemberState, RoleDef } from '../shared/types.js';
import type { MemberDispatchFocus } from '../prompt/member-brief.js';
import { asSessionId } from './compat.js';
import type { MemberDeliveryMode, MemberDeliveryReceipt } from './compat.js';
/** Default label prefix so a member is recognisable in the host's agent list. */
export declare const MEMBER_LABEL_SUFFIX_SEPARATOR = "@";
/** Everything a spawn needs besides the roster record. */
export interface MemberSpawnOptions {
    /**
     * Registered `ctx.subagents` provider name (`Config.memberProvider`).
     * Validated by `provider-guard`, never assumed.
     */
    readonly provider: string;
    /**
     * Member-relative descendant budget. `0` (default) = members may not delegate;
     * enforced through captain-tool visibility and the parent-chain guard, never
     * `maxDepth`.
     */
    readonly memberDepth?: number;
    /** Explicit LLM route override; otherwise the member record's snapshot is used. */
    readonly agentOptions?: AgentOptions;
    /** Label override; defaults to `<角色名>@<factoryId>`. */
    readonly label?: string;
    /** Extra tool names to deny for this member (validated against the registry). */
    readonly extraDeny?: readonly string[];
    /** Full replacement for the initial prompt; defaults to `renderMemberBrief`. */
    readonly initialPrompt?: string;
    /** Stage/round context for the default initial prompt. */
    readonly focus?: MemberDispatchFocus;
    /**
     * The workspace evolution ledger. When the caller does not override
     * `initialPrompt`, the role's lessons are selected from it and rendered into
     * the default brief — the spawn turn must carry the history too.
     */
    readonly lessons?: readonly LessonRecord[];
    /** Clock override for deterministic tests. */
    readonly now?: () => number;
}
/** Successful first-time spawn. */
export interface MemberSpawnSuccess {
    readonly ok: true;
    readonly reused: false;
    readonly role: string;
    readonly label: string;
    /** Durable child session id, also written to `state.members[].sessionId`. */
    readonly childId: string;
    /**
     * Inbox id of the accepted initial prompt, when the host reports one.
     *
     * `startActivation` guarantees a message id only for a start that reserves its
     * own `childId` (`dsh-subagent/lib/types/index.d.ts:135-146`). The plugin lets
     * the host allocate the child id, so a host that does not publish an inbox id
     * for an allocated child returns none — `AppliedDispatch.messageId` is optional
     * for exactly that reason, and the spawn result stays honest by omitting it.
     */
    readonly messageId?: string;
    /** Intended deny-list audit; 0.2.2 does not send it on the start spec. */
    readonly toolFilter: ToolRestriction;
    /** Names removed from the legacy filter because an older host rejected them. */
    readonly droppedTools: readonly string[];
    /** Names the legacy deny-list would hide (member-surface audit). */
    readonly deniedTools: readonly string[];
    readonly promptChars: number;
    readonly detail: string;
}
/** Existing member reused instead of spawning a second one. */
export interface MemberSpawnReused {
    readonly ok: true;
    readonly reused: true;
    readonly role: string;
    readonly childId: string;
    readonly detail: string;
}
/** Failed spawn; the reason is also written to `state.members[].spawnError`. */
export interface MemberSpawnFailure {
    readonly ok: false;
    readonly reused: false;
    readonly role: string;
    /** Machine-ish code for the caller's own branching. */
    readonly code: 'unknown-role' | 'not-in-roster' | 'provider' | 'tool-surface' | 'start-failed' | 'cancelled';
    /** Human-readable reason (identical to what was stored on the member record). */
    readonly error: string;
    /** Provider names, so the failure is actionable without another query. */
    readonly availableProviders: readonly string[];
    /** Names dropped from the filter before the failed attempt. */
    readonly droppedTools: readonly string[];
}
/** Outcome of {@link spawnMember}. */
export type MemberSpawnResult = MemberSpawnSuccess | MemberSpawnReused | MemberSpawnFailure;
/** Outcome of {@link sendToMember}. */
export interface MemberSendResult {
    readonly ok: boolean;
    readonly role: string;
    readonly sessionId: string;
    readonly mode: MemberDeliveryMode;
    readonly via?: MemberDeliveryReceipt['via'];
    readonly messageId?: string;
    readonly error?: string;
    /**
     * Harness error code of a failed delivery (`NOT_RESUMABLE`, `ACTIVATION_CLOSING`, …).
     * Kept separate from the message so the scheduler can tell "this session is dead"
     * (`NOT_RESUMABLE`) from "this delivery is temporarily impossible", which is
     * what makes the session-replacement recovery safe.
     */
    readonly errorCode?: string;
    /** The exact text that was delivered (for the mailbox copy and the feed). */
    readonly text: string;
}
/** Canonical role id of a member record / role definition. */
export declare function memberRoleId(role: RoleDef | string): string;
/** Finds one member record, canonicalising the role spelling. */
export declare function findMember(state: FactoryState, role: RoleDef | string): MemberState | undefined;
/** Member label used for `startActivation({ label })` and the agent list. */
export declare function memberLabel(role: RoleDef, state: FactoryState): string;
/** Resolves the LLM route options for one member (record snapshot or override). */
export declare function memberAgentOptions(member: MemberState, override?: AgentOptions): AgentOptions | undefined;
/** Live facts about one member session, resolved from the agent registry. */
export interface MemberLiveness {
    readonly live: boolean;
    readonly running: boolean;
    readonly status: 'running' | 'idle' | 'ready';
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
export declare function memberLiveness(ctx: Context, sessionId: string): MemberLiveness;
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
export declare function spawnMember(ctx: Context, caller: Agent, role: RoleDef, state: FactoryState, signal: AbortSignal, options: MemberSpawnOptions): Promise<MemberSpawnResult>;
/** Options for {@link sendToMember}. */
export interface SendToMemberOptions {
    /** `queue` = a distinct turn (dispatch / rework); `steer` = nearest step (notice). */
    readonly mode?: MemberDeliveryMode;
    /** Stage id stamped into the message source. */
    readonly stage?: string;
    /** Clock override for deterministic tests. */
    readonly now?: () => number;
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
export declare function sendToMember(ctx: Context, caller: Agent, member: MemberState, text: string, signal: AbortSignal, options?: SendToMemberOptions): Promise<MemberSendResult>;
/** Options for {@link dispatchToMember}. */
export interface DispatchToMemberOptions extends SendToMemberOptions {
    /** Stage/round/rework context rendered into the dispatch text. */
    readonly focus: MemberDispatchFocus;
    /**
     * The workspace evolution ledger. Lessons are selected per role (default 6)
     * and merged into the focus unless the caller already supplied `focus.lessons`
     * — so both the spawn brief and every later steer carry the history.
     */
    readonly lessons?: readonly LessonRecord[];
    /** Send as a rework note (`steer`) instead of a fresh stage turn (`queue`). */
    readonly rework?: boolean;
    /** Override the rendered text. */
    readonly text?: string;
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
export declare function dispatchToMember(ctx: Context, caller: Agent, role: RoleDef, state: FactoryState, signal: AbortSignal, options: DispatchToMemberOptions): Promise<MemberSendResult>;
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
export declare function interruptMember(ctx: Context, caller: Agent, sessionId: string): {
    readonly ok: boolean;
    readonly error?: string;
};
/**
 * Releases several members at once (halt / delete / archive).
 *
 * @param ctx - plugin context.
 * @param caller - the exact live captain agent.
 * @param sessionIds - durable child session ids.
 * @param state - optional factory record whose members are marked `removed`.
 * @returns the drain outcome.
 */
export declare function drainMembers(ctx: Context, caller: Agent, sessionIds: readonly string[], state?: FactoryState): Promise<{
    readonly ok: boolean;
    readonly error?: string;
}>;
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
export declare function reconcileMembers(ctx: Context, parentSessionId: string, state: FactoryState, signal?: AbortSignal): Promise<{
    readonly catalogReadable: boolean;
    readonly known: readonly string[];
    readonly missingFromCatalog: readonly string[];
    readonly orphanRows: readonly string[];
}>;
/** Exported for tests: the exact durable-id cast boundary. */
export { asSessionId };
