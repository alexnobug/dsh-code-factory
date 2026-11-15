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
import type { MessageKind, DodStatus, PipelineId, StageStateRec, MemberState, FactoryState, FactoryMessage } from '../../shared/types.js';
import type { GateRunner } from '../../runtime/gates-runner.js';
import type { DispatchAttempt, StageDispatchOutcome, StageDispatchPlan } from '../../runtime/scheduler.js';
import type { ToolCallContext } from '../context.js';
/** Largest number of upstream artifacts rendered into one dispatch. */
export declare const UPSTREAM_ARTIFACT_LIMIT = 12;
/**
 * Narrows a model-supplied string to the closed `MessageKind` union.
 *
 * The list itself lives in `src/shared/types.ts` beside the union (review finding
 * H8 follow-up): the browser half validates the same field while parsing the
 * snapshot, and two hand-kept copies would let one side accept a kind the other
 * rejects, with no build error either way.
 */
export declare function isMessageKind(value: string): value is MessageKind;
/** One roster row of a staged plan. */
export interface PlanRoleRow {
    readonly role: string;
    readonly title: string;
    readonly codename: string;
    readonly tier: string;
    readonly duties: string;
}
/** One executed command, as reported by the gate runner. */
export interface CommandRow {
    readonly command: string;
    readonly ok: boolean;
    readonly detail: string;
    readonly exitCode?: number;
    readonly timedOut: boolean;
    readonly via: string;
}
/** One DoD item row. */
export interface DodItemRow {
    readonly id: number;
    readonly label: string;
    readonly ok: boolean;
    /** Verdict of this item; `ok` alone cannot tell `skipped` from `passed`. */
    readonly status: DodStatus;
    readonly skipped: boolean;
    readonly evidence: string;
    readonly needsExecution: boolean;
}
/** Roll-up of one DoD audit. */
export interface DodSummaryRow {
    readonly passed: number;
    readonly total: number;
    readonly failed: number;
    readonly pending: number;
    readonly skipped: number;
    readonly ok: boolean;
}
/** Trims a model-supplied optional string; blank means absent. */
export declare function optional(value: unknown): string | undefined;
/** Trims a required string or refuses the call. */
export declare function required(value: unknown, what: string): string;
/** Truncates a string for a mailbox line / a tool result. */
export declare function clip(text: string, max?: number): string;
/** A finite non-negative integer, or `undefined`. */
export declare function optionalCount(value: unknown, minimum?: number): number | undefined;
/** One roster row for a role id. */
export declare function roleRow(role: string): PlanRoleRow;
/** New pipeline stage records for a factory being (re)staged. */
export declare function freshStageRecords(pipeline: PipelineId): StageStateRec[];
/** New member records for a roster that has not been spawned yet. */
export declare function freshMemberRecords(team: readonly string[]): MemberState[];
/**
 * Resolves a stage **the caller named itself** (a tool argument).
 *
 * An unknown value is an error, not a fallback: `member.currentStage` and
 * `artifacts.json` both record this string, so accepting a typo invents a
 * phantom stage that no gate ever reads while the member's real stage silently
 * stays active. The message lists the ids that would have been accepted.
 */
export declare function resolveReportedStage(state: FactoryState, requested: string): string;
/**
 * The stage a member's artifact belongs to when neither the member nor its roster
 * row names one: the stage it is working, else the first stage that has not passed.
 *
 * `preferred` here is a **derived hint** (the member's own `currentStage`), not a
 * tool argument, so it is only used when it names a real stage of this pipeline —
 * a stale value left by a re-planned factory must not throw, or that record could
 * never report again. Caller-supplied values go through {@link resolveReportedStage}.
 */
export declare function artifactStageId(state: FactoryState, preferred?: string): string;
/** `<stateDir>/<id>/factory.json`, as the human sees it. */
export declare function planPath(call: ToolCallContext, factoryId: string): string;
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
export declare function ledgerFor(state: FactoryState): readonly DispatchAttempt[];
/** Records one applied dispatch so the scheduler will not repeat it. */
export declare function recordAttempt(state: FactoryState, attempt: Omit<DispatchAttempt, 'dispatchedAt'> & {
    readonly dispatchedAt?: number;
}, now: number): void;
/** Marks the attempts of one role (optionally one stage) as settled by a report. */
export declare function settleAttempts(state: FactoryState, role: string, stageId: string | undefined, now: number): number;
/** Records every dispatch one applied plan actually delivered. */
export declare function recordPlanAttempts(state: FactoryState, plan: StageDispatchPlan, outcome: StageDispatchOutcome, now: number): void;
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
export declare function parkStageAtGate(state: FactoryState, stageId: string, now: number): void;
/** Writes one mailbox line, clip-protected. */
export declare function postMail(call: ToolCallContext, factoryId: string, input: {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly content: string;
    readonly kind: MessageKind;
    readonly stage?: string;
    readonly round?: number;
    readonly deliveredAt?: number;
}): Promise<FactoryMessage>;
/** One captain log line in the feed (the captain's own inbox is the audit trail). */
export declare function captainNote(call: ToolCallContext, factoryId: string, content: string, kind?: MessageKind, extra?: {
    readonly stage?: string;
    readonly round?: number;
}): Promise<FactoryMessage>;
/** The gate executor for this call: real commands, real exit codes, template-only. */
export declare function gateRunnerFor(call: ToolCallContext, allowNodeFallback: boolean): GateRunner;
/** Projection of the commands one gate/DoD run started. */
export declare function commandRows(outcomes: readonly {
    readonly command: string;
    readonly ok: boolean;
    readonly detail: string;
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly via: string;
}[]): CommandRow[];
export declare function findMemberFactoryForCall(call: ToolCallContext): Promise<{
    readonly state: FactoryState;
    readonly member: MemberState;
} | undefined>;
export declare function findCaptainFactoryForCall(call: ToolCallContext): Promise<FactoryState | undefined>;
/** Resolves the member's own factory + roster row. */
export declare function resolveMemberFactory(call: ToolCallContext, factoryIdInput: unknown): Promise<{
    readonly state: FactoryState;
    readonly role: string;
    readonly stage?: string;
}>;
