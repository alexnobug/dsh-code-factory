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
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { DispatchAttempt, FactoryState, LessonRecord, MemberStatus, RoleDef, StageDef, StageStateRec } from '../shared/types.js';
import type { StageStaffing } from '../domain/pipeline.js';
import type { MemberReworkInstruction } from '../prompt/member-brief.js';
import type { MemberSpawnOptions, MemberSpawnResult } from './members.js';
/** What the scheduler decided to do for one role of one stage. */
export type DispatchAction = 'spawn' | 'wake' | 'rework' | 'wait' | 'skip' | 'escalate';
/**
 * One recorded dispatch. Re-exported from the shared contract because it is now
 * part of the durable `FactoryState` (`dispatchAttempts`), so the store, the tool
 * layer and this planner must agree on exactly one definition.
 */
export type { DispatchAttempt } from '../shared/types.js';
/** Everything the pure planner reads. */
export interface SchedulerInputs {
    readonly state: FactoryState;
    /** The caller's dispatch ledger (may be empty on a fresh factory). */
    readonly attempts?: readonly DispatchAttempt[];
    /** Clock. */
    readonly now: number;
    /** Live-agent probe; defaults to "unknown" so the plan stays pure. */
    readonly isLive?: (sessionId: string) => boolean;
    /** Live `Agent.status === 'running'` probe; defaults to "unknown". */
    readonly isRunning?: (sessionId: string) => boolean | undefined;
    /** Target stage override; otherwise the first non-passed stage is planned. */
    readonly stageId?: string;
    /** An attempt older than this without a live activation is "stranded" (default 30 min). */
    readonly staleAfterMs?: number;
    /** Concrete rejection items for a rework dispatch (the captain's own words). */
    readonly reworkFindings?: readonly string[];
    /** Artifacts the upstream stages produced, for the dispatch text. */
    readonly upstreamArtifacts?: readonly string[];
}
/** One decision, with its reason (the reason is user-facing). */
export interface DispatchDecision {
    readonly stageId: string;
    readonly role: string;
    /** Chinese title of the role, for logs and the cockpit. */
    readonly title: string;
    readonly action: DispatchAction;
    readonly reason: string;
    readonly sessionId?: string;
    /** True when executing this decision consumes one stage attempt. */
    readonly consumesAttempt: boolean;
    /** Set for `rework` decisions. */
    readonly rework?: MemberReworkInstruction;
    /**
     * Set when this decision exists because the member's executor was gone
     * (stranded recovery, rule 4). Recovery is never silent: this flag plus
     * {@link DispatchDecision.strandedEvidence} are what `factory_dispatch` /
     * `factory_status` show, and the consumed attempt lands in
     * `factory.json → stages[].attempts`.
     */
    readonly recoveredFromStranded?: boolean;
    /** The probe result and timing behind a stranded recovery. */
    readonly strandedEvidence?: string;
    /**
     * When a dispatching decision (`spawn` / `wake` / `rework`) was rewritten as
     * `wait` because this plan cannot dispatch (stage parked on its gate verdict, or
     * the plan escalates), the action it *would* have taken is preserved here.
     *
     * This is what keeps the plan self-consistent without losing information: the
     * decision table says `wait` (which is what actually happens — `planned=0`), and
     * `parkedFrom` records the intent that the suppression replaced.
     */
    readonly parkedFrom?: DispatchAction;
}
/** What the liveness probe can say about one member's current executor. */
export type MemberExecutorState = 'live' | 'gone' | 'unknown';
/** Verdict of the executor probe for one member session. */
export interface MemberExecutorVerdict {
    readonly state: MemberExecutorState;
    /** True only when a live executor reported `running`. */
    readonly running: boolean;
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
    readonly role: string;
    readonly from: MemberStatus;
    readonly to: 'idle';
    readonly sessionId: string;
    /** Stage the member claimed to be working on, when it recorded one. */
    readonly stageId?: string;
    readonly reason: string;
}
/** The plan for one stage. */
export interface StageDispatchPlan {
    readonly stageId: string;
    readonly stageName: string;
    readonly round: number;
    readonly parallel: boolean;
    readonly humanApproval: boolean;
    readonly maxRounds: number;
    readonly decisions: readonly DispatchDecision[];
    /** Decisions that must actually run, in order. */
    readonly dispatches: readonly DispatchDecision[];
    readonly staffing: StageStaffing;
    /** Stage roles with neither a member nor a fallback. */
    readonly missingRoles: readonly string[];
    /** True when a human is needed (unstaffable role / rounds exhausted / blocked member). */
    readonly escalate: boolean;
    readonly notes: readonly string[];
    readonly summary: string;
    /** True when there is nothing to plan because the pipeline has no such stage. */
    readonly known: boolean;
    /** Stale member statuses to converge back to `idle` (stranded executors). */
    readonly reconcile: readonly ReconcileAction[];
}
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
export declare function selectDispatchStage(state: FactoryState, stageId?: string): {
    readonly rec: StageStateRec;
    readonly def: StageDef;
} | undefined;
/** Builds the rework instruction from the stage's own last gate verdict. */
export declare function reworkInstructionFor(rec: StageStateRec, def: StageDef, findings?: readonly string[]): MemberReworkInstruction;
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
export declare function memberExecutorVerdict(inputs: SchedulerInputs, sessionId: string): MemberExecutorVerdict;
/** True for the actions that hand work to a member when they run. */
export declare function isDispatchingDecision(decision: DispatchDecision): boolean;
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
export declare function parkDecision(decision: DispatchDecision, def: StageDef, awaitingVerdict: boolean, escalate: boolean): DispatchDecision;
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
export declare function reconcileStrandedMembers(inputs: SchedulerInputs, excludeRoles?: readonly string[]): readonly ReconcileAction[];
/** Default staleness window, used only when the liveness probe is unavailable. */
export declare const DEFAULT_STALE_AFTER_MS: number;
/**
 * Plans one stage's dispatch. Pure.
 *
 * @param inputs - state, ledger, live probes and clock.
 * @returns the plan; `known: false` when the requested stage does not exist.
 */
export declare function planStageDispatch(inputs: SchedulerInputs): StageDispatchPlan;
/** Options for {@link applyStageDispatch}. */
export interface ApplyDispatchOptions {
    /** Registered subagent provider name. */
    readonly provider: string;
    /** Cancellation for every spawn/delivery. */
    readonly signal: AbortSignal;
    /** Member-relative delegation budget (default 0). */
    readonly memberDepth?: number;
    /** Extra tool names to deny for spawned members. */
    readonly extraDeny?: readonly string[];
    /** Clock override. */
    readonly now?: () => number;
    /** Per-role label override. */
    readonly label?: (role: RoleDef, state: FactoryState) => string;
    /** Builds the spawn options for one role (merged over the defaults). */
    readonly spawnOptions?: (role: RoleDef, state: FactoryState) => Partial<MemberSpawnOptions>;
    /** Artifacts upstream stages produced (rendered into the dispatch). */
    readonly upstreamArtifacts?: readonly string[];
    /**
     * The workspace evolution ledger, read **once** by the engine before dispatch.
     *
     * Each dispatched role gets its own selected slice
     * (`selectLessonsForRole`, default 6) rendered as the 「历史教训」 block into
     * both the spawn brief and every later dispatch/steer text. Optional so an
     * offline planner test never has to touch the ledger.
     */
    readonly lessons?: readonly LessonRecord[];
    /**
     * Replace a member's session when a delivery proves it unresumable
     * (`NOT_RESUMABLE`). Default `true`: a dead child session is the one case where
     * retrying can never work, so the recovery creates a fresh one and records the
     * replacement. Set `false` to observe the raw failure instead.
     */
    readonly replaceUnresumableSession?: boolean;
}
/** One executed decision. */
export interface AppliedDispatch {
    readonly role: string;
    readonly stageId: string;
    readonly action: DispatchAction;
    readonly ok: boolean;
    readonly sessionId?: string;
    readonly messageId?: string;
    readonly mode?: string;
    /** The exact text delivered (or baked into the initial prompt) — mailbox copy. */
    readonly text?: string;
    readonly error?: string;
    /** Full spawn result when the decision spawned a member. */
    readonly spawn?: MemberSpawnResult;
    /** Set when this dispatch recovered from a stranded attempt (fresh attempt). */
    readonly recoveredFromStranded?: boolean;
    /**
     * The dead session id this dispatch replaced. Set when delivery proved the old
     * child unresumable (`NOT_RESUMABLE`) and the member was re-created on a fresh
     * session instead of retrying a session that can never answer.
     */
    readonly sessionReplaced?: string;
}
/** Result of applying one plan. */
export interface StageDispatchOutcome {
    readonly stageId: string;
    readonly applied: readonly AppliedDispatch[];
    readonly failed: readonly AppliedDispatch[];
    readonly spawned: readonly string[];
    readonly stageMarkedActive: boolean;
    readonly escalate: boolean;
    readonly notes: readonly string[];
    readonly summary: string;
    /** Stale member statuses that were converged back to `idle`. */
    readonly reconciled: readonly ReconcileAction[];
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
export declare function applyStageDispatch(ctx: Context, caller: Agent, state: FactoryState, plan: StageDispatchPlan, options: ApplyDispatchOptions): Promise<StageDispatchOutcome>;
/** Builds the live probes the planner needs from the plugin context. */
export declare function schedulerProbes(ctx: Context): {
    readonly isLive: (sessionId: string) => boolean;
    readonly isRunning: (sessionId: string) => boolean | undefined;
};
