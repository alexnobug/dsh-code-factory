/**
 * compat.ts — **the version-compatibility seam** for everything that talks to
 * `ctx.subagents`.
 *
 * Why one file (实施方案 §7「子代理继续唤醒跨版本语义漂移」, M4 risk #1):
 * The continuable-subagent surface is the youngest part of the harness. Method
 * names, delivery modes and the host-only delivery symbol have all moved between
 * 0.1.x releases, and the reference plugin keeps an audited seam
 * (`@nanmicoder/dsh-agent-teams/lib/harness-compat.js`) for exactly that reason.
 * Isolating every shape that could move here means a harness upgrade is a
 * one-file review instead of a hunt through the runtime.
 *
 * What is verified for **0.2.2-rc.3** (this project's pinned peer version):
 *
 * | surface | evidence |
 * |---|---|
 * | `runtime.startActivation(spec)` — flat `SubagentActivationSpec` | live `Service.listService {service:'subagents'}`; `dsh-subagent/lib/types/types.d.ts` |
 * | `runtime.sendMessage(sender, targetId, content, {signal})` (steer) | live service; `dsh-subagent/lib/types/index.d.ts` |
 * | `runtime.interrupt(targetId, authority)` | live service; `dsh-subagent/lib/types/index.d.ts` |
 * | `runtime.listDescendants(rootSessionId, signal?)` — recursive catalog read; depth=1 is direct children | live service; `dsh-subagent/lib/types/index.d.ts` |
 * | `runtime.drainDescendants(parents)` — close whole subagent trees | live service; `dsh-subagent/lib/types/index.d.ts` |
 * | `runtime.getProvider(name)` — provider lookup (no `list()` anymore) | live service; `dsh-subagent/lib/types/index.d.ts` |
 * | `Symbol.for('dsh.subagent.deliverPrompt')` — host-authored **queue vs steer** delivery | `dsh-subagent/lib/types/internal.d.ts` |
 * | `delegationDepthOf(agent)` | `dsh-subagent/lib/types/depth.d.ts` |
 *
 * The symbol-keyed deliverer is read through `Symbol.for(...)` instead of
 * `import { deliverSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'`:
 * the symbol is process-stable by construction, while a static value import of
 * that subpath hard-couples module *loading* to a harness generation that ships
 * it (the reference plugin warns about exactly this). The **type** is imported
 * (type-only imports are erased), so the shape stays compiler-checked.
 *
 * @module dsh-code-factory/runtime/compat
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent';
import type { ToolRestriction } from '@deepseek-ai/dsh-tools';
/**
 * Message-source vocabulary owned by this plugin.
 *
 * `MessageSourceMap` is merge-extensible by design ("each producer declares its
 * own `kind` in its own module"), so a member dispatch is never attributed to
 * the human user — the chat renders it as plugin-produced protocol text.
 * `command.ts` already adds `'code-factory-command'` for the same reason.
 */
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'code-factory': {
            readonly kind: 'code-factory';
            /** Factory the dispatch belongs to, when known. */
            readonly factoryId?: string;
            /** Stage the dispatch is about, when known. */
            readonly stage?: string;
            /** Role id being addressed, when known. */
            readonly role?: string;
        };
    }
}
/** Provenance for one member-facing dispatch message. */
export interface DispatchSourceFields {
    readonly factoryId?: string;
    readonly stage?: string;
    readonly role?: string;
}
/** Builds the message source for a member-facing dispatch. */
export declare function dispatchSource(fields?: DispatchSourceFields): MessageSource;
/** The single storage-boundary cast: durable ids are plain strings on disk. */
export declare function asSessionId(value: string): SessionId;
/** Compact one-line description of a thrown value. */
export declare function describeError(error: unknown): string;
/** `content` for one model-visible text message. */
export declare function textContent(text: string): ContentBlock[];
/** How a member message was delivered. */
export type MemberDeliveryMode = 'queue' | 'steer';
/** Which host path carried the delivery. */
export type MemberDeliveryVia = 'host-deliver' | 'sendMessage';
/** Result of one successful member delivery. */
export interface MemberDeliveryReceipt {
    readonly messageId: string;
    readonly mode: MemberDeliveryMode;
    readonly via: MemberDeliveryVia;
}
/**
 * Delivers one host-authored message to a durable direct child.
 *
 * `mode: 'queue'` is the dispatch path — the message becomes its own turn, so a
 * second stage or a rework note is never merged into a step the member is
 * already running. `mode: 'steer'` lands at the nearest step boundary, which is
 * what an urgent interrupt/notice wants.
 *
 * When the host-only deliverer is absent (an older or reshaped harness),
 * `sendMessage` is the documented public fallback: "a running target admits it
 * at the nearest step boundary; an idle target starts a turn, and an absent
 * direct child cold-resumes from persistence" (`lib/types/index.d.ts:143-156`).
 * The fallback is reported in the receipt (`via`) instead of being hidden, and
 * it still satisfies the one thing dispatch needs — waking an idle member.
 *
 * @param runtime - `ctx.subagents`.
 * @param parent - the exact live direct parent (the captain agent).
 * @param childId - the member's durable child session id.
 * @param text - the message body.
 * @param signal - caller cancellation, owning the call until inbox acceptance.
 * @param mode - queue a distinct turn (default) or steer the nearest step.
 * @returns the accepted message id and the path that carried it.
 * @throws when neither delivery path is available or the host rejects the send.
 */
export declare function deliverToMember(runtime: Context['subagents'], parent: Agent, childId: string, text: string, signal: AbortSignal, mode?: MemberDeliveryMode, source?: MessageSource): Promise<MemberDeliveryReceipt>;
/**
 * Requests cancellation of one member's current turn.
 *
 * Fire-and-return, and deliberately never throwing: an interrupt is
 * best-effort cleanup (`interrupt` documented "an absent target … is an
 * accepted no-op"), and a failing interrupt must not fail the tool call that
 * asked for it. The caller records the outcome for the feed.
 *
 * @param runtime - `ctx.subagents`.
 * @param parent - the exact live direct parent (the captain agent).
 * @param childId - the member's durable child session id.
 * @returns `true` when the authority was accepted, `false` for a failed call.
 */
export declare function interruptMemberTurn(runtime: Context['subagents'], parent: Agent, childId: string): {
    readonly ok: boolean;
    readonly error?: string;
};
/**
 * Releases selected resident children of one parent.
 *
 * Successor of the removed `drainContinuableChildren(parent, childIds)`: the
 * 0.2.1 surface spells the same operation `drainChildren` — "Release selected
 * resident direct children of one exact live parent" — while
 * `drainDescendants(parents)` closes admission for whole forests and is the
 * host's own teardown path, which would over-reach here.
 *
 * @param runtime - `ctx.subagents`.
 * @param parent - the exact live direct parent.
 * @param childIds - durable child ids to release.
 * @returns `{ok:false, error}` instead of throwing, so a teardown path can
 *   report per-member failures and still finish draining the rest.
 */
export declare function drainMemberChildren(runtime: Context['subagents'], parent: Agent, childIds: readonly string[]): Promise<{
    readonly ok: boolean;
    readonly error?: string;
}>;
/** One direct-child catalog row, reduced to what a factory needs. */
export interface MemberChildRow {
    readonly id: string;
    readonly label: string | undefined;
    readonly mode: 'one-shot' | 'continuable' | 'unknown';
    readonly createdAt: number | undefined;
}
/**
 * Reads the parent's durable direct-child catalog.
 *
 * Used to reconcile `factory.json` against reality after a restart (a member
 * whose session id is still recorded but whose catalog row is gone must not be
 * woken blindly). Rows are mapped defensively: the projection shape has changed
 * between harness generations (`activity` was added then made residency-only),
 * so anything unrecognised degrades to `mode: 'unknown'` instead of throwing.
 *
 * @param runtime - `ctx.subagents`.
 * @param parentSessionId - the captain's session id.
 * @param signal - optional cancellation.
 * @param onReadError - optional sink for *why* the catalog could not be read.
 *   The `undefined` return already tells the caller "unreadable" (it becomes
 *   `catalogReadable: false`); without this sink the reason is lost, which is the
 *   difference between "the harness has no catalog" and "reading it threw".
 * @returns the rows, or `undefined` when the catalog could not be read at all.
 */
export declare function listMemberChildren(runtime: Context['subagents'], parentSessionId: string, signal?: AbortSignal, onReadError?: (detail: string) => void): Promise<readonly MemberChildRow[] | undefined>;
/**
 * Names a `tools.restrict()` rejection reported as unknown, or an empty list for
 * every other failure.
 *
 * The host names the offenders verbatim and quotes only them:
 * `tools.restrict() names unknown global tool "x", "y"; known global tools: a, b`
 * (`dsh-tools/lib/index.js:2908`). Quoted names are therefore exactly the
 * unknown ones — the "known" list is comma-joined without quotes.
 *
 * @param error - the thrown value.
 * @returns the unknown names; empty when the failure is not an unknown-name report.
 */
export declare function unknownToolNamesFromError(error: unknown): readonly string[];
/** `SubagentError` / `HarnessError` code carried by a failure, when present. */
export declare function errorCodeOf(error: unknown): string | undefined;
/**
 * True when a member delivery failed because the child session can never be
 * resumed — the one failure that re-delivering cannot fix.
 *
 * The harness raises this class of failure from the cold-resume path:
 *  - `SubagentError('subagent "<id>" is unavailable', 'NOT_RESUMABLE')` —
 *    `dsh-subagent/lib/index.js:1911` and `:1938`
 *  - `SubagentError('subagent "<id>" has no supported continuation state and
 *    cannot be resumed; choose a different target', 'NOT_RESUMABLE')` —
 *    `dsh-subagent/lib/index.js:1917`
 *  - the remote face maps the same code to `subagent/not-resumable` ("subagent
 *    cannot be resumed") — `dsh-subagent/lib/index.js:78`
 *
 * `HarnessError.code` is the primary criterion
 * (`dsh-llm/lib/types/error.d.ts:12-14`: `readonly code: string`); the message
 * phrases are the fallback for a re-wrapped error that lost its code. The
 * deliberately-excluded sibling is `subagent/delivery-unavailable` ("the child
 * exists but its inbox cannot admit the message now",
 * `dsh-subagent/lib/types/control-types.d.ts:129-132`) — that one is temporary,
 * so it must NOT cost the member its session.
 *
 * @param message - `describeError(error)` from the failed delivery.
 * @param code - `errorCodeOf(error)`, when the caller still holds the raw error.
 * @returns whether the session is provably unresumable.
 */
export declare function isUnresumableDeliveryError(message: string, code?: string): boolean;
/** Outcome of one lenient start attempt. */
export interface LenientStartResult<T> {
    readonly value: T;
    /** The filter that finally succeeded (after any drops). */
    readonly filter: ToolRestriction;
    /** Names removed from the original filter because the host rejected them. */
    readonly dropped: readonly string[];
}
/**
 * Starts a member, dropping any filter name the host reports as unknown and
 * retrying.
 *
 * Ported from the reference plugin's audited strategy
 * (`harness-compat.js:288`): resolution against the registry view only covers
 * hosts that expose one, so the start itself must survive a name that is
 * registered-but-not-restrictable or a composition that mounted differently.
 * The retry only runs while the filter **strictly shrinks**, so a persistent
 * failure (or any non-unknown-name error) propagates untouched — this can never
 * spin.
 *
 * @param start - performs one start attempt for the given filter.
 * @param filter - the filter to attempt first.
 * @returns the started value, the winning filter, and every name dropped.
 */
export declare function startWithLenientFilter<T>(start: (filter: ToolRestriction) => Promise<T>, filter: ToolRestriction): Promise<LenientStartResult<T>>;
/** Options for {@link installMemberDelegationGuard}. */
export interface MemberDelegationGuardOptions {
    /**
     * Member-relative descendant budget. `0` (default) means members may not
     * delegate at all: any delegation whose parent is itself a member is refused.
     */
    readonly memberDepth?: number;
    /** Optional observer for a refused delegation (feed / session event). */
    readonly onRefused?: (info: {
        readonly parentDepth: number;
        readonly call: string;
    }) => void;
    /**
     * Optional observer for a delegation call whose parent depth could not be read.
     * The guard still stands down (that is the only safe answer), but a depth probe
     * that throws is precisely the call the depth budget exists to bound, so it is
     * reported instead of vanishing.
     */
    readonly onProbeError?: (info: {
        readonly call: string;
        readonly reason: string;
    }) => void;
}
/**
 * Installs the parent-chain delegation guard above the running runtime.
 *
 * **Why this exists**: `SubagentStartRequest.maxDepth` cannot express
 * "this member may not delegate". It is documented as an *absolute cap on this
 * creation* — "its computed depth must be less than or equal to this non-negative
 * safe integer" — and the continuation manager enforces exactly that
 * (`dsh-subagent/lib/types/child-agent.js:32-38`: `childDepth = parent + 1`, then
 * `childDepth > maxDepth ⇒ SubagentDepthError`). A captain at depth 0 has depth-1
 * children, so `maxDepth: 0` **rejects the member itself**; and the cap is not
 * inherited by the member's own later delegations, so it buys no descendant
 * budget at all. The reference plugin reached the same conclusion and forwards no
 * `maxDepth` (`members.js:534-536`), enforcing the budget with a guard instead.
 *
 * Members are therefore bounded twice: their toolFilter hides every delegation
 * tool (`computeMemberToolFilter`), and this guard refuses a delegation call
 * whose parent chain is already inside the factory. The guard is defence in
 * depth — it also covers a renamed or dynamically registered delegation tool.
 *
 * 0.2.1-rc.2 moved the start-time filter out of the public start request (the
 * host composes a fresh child from the preset composition), so on that host this
 * guard is the *remaining* runtime-enforced boundary for member delegation.
 *
 * The wrapper preserves the exact receiver and is restored from the original own
 * descriptor on dispose; when the method is inherited (no own descriptor) the
 * own property is deleted again, so a cordis reload leaves the runtime as it was.
 *
 * @param ctx - the plugin context (injects `subagents`).
 * @param options - descendant budget and refusal observer.
 * @returns the disposer that removes both guards.
 */
export declare function installMemberDelegationGuard(ctx: Context, options?: MemberDelegationGuardOptions): () => void;
/**
 * Reads one provider for diagnostics. Kept here because `getProvider` / `list`
 * are part of the same version-sensitive registry surface as the rest of this
 * file; the *policy* decision lives in `provider-guard.ts`.
 *
 * @param ctx - the plugin context.
 * @param name - the provider name.
 * @returns the provider or `undefined`.
 */
export declare function lookupProvider(ctx: Context, name: string): SubagentProvider | undefined;
/**
 * True when this provider can establish continuable children.
 *
 * Method presence **is** the capability: "Method presence selects local
 * activation execution. Providers without it execute through `start` and do not
 * accept subsequent messages" (`dsh-subagent/lib/types/types.d.ts:327-340`).
 * This is deliberately not a `SubagentCapabilities` check — those flags describe
 * which *start-time options* a backend honours, while a provider without
 * `prepareContinuable` cannot establish a continuable child at all.
 *
 * @param provider - the provider to test.
 * @returns whether a continuable start may be attempted.
 */
export declare function supportsContinuable(provider: SubagentProvider | undefined): boolean;
/** Message id type re-export so callers need one import for the seam. */
export type { MessageId };
