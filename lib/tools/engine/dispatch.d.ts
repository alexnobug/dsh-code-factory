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
import type { ToolCallContext } from '../context.js';
/** One decision/dispatch row shared by approve and dispatch. */
export interface DispatchRow {
    readonly role: string;
    readonly title: string;
    readonly action: string;
    readonly reason: string;
    readonly ok: boolean;
    readonly sessionId?: string;
    readonly messageId?: string;
    readonly mode?: string;
    readonly error?: string;
}
/** Arguments of {@link approveFactory}. */
export interface ApproveFactoryInput {
    readonly factoryId: string;
}
/** Result of {@link approveFactory}. */
export interface ApproveFactoryResult {
    readonly summary: string;
    readonly factoryId: string;
    readonly phase: string;
    readonly alreadyApproved: boolean;
    readonly approvedAt?: number;
    readonly stageId?: string;
    readonly stageName?: string;
    readonly round?: number;
    readonly planned: number;
    readonly decisions: DispatchRow[];
    readonly applied: DispatchRow[];
    readonly failed: DispatchRow[];
    readonly spawned: string[];
    readonly missingRoles: string[];
    readonly escalate: boolean;
    readonly notes: string[];
    readonly nextAction: string;
}
/**
 * Approve a staged plan: the ONLY transition that creates member sessions.
 *
 * Idempotent by construction: a factory already `running` returns its current
 * phase without dispatching again, and the dispatch itself is planned by the
 * scheduler's anti-duplicate rules (a `working` member or an unsettled attempt is
 * never dispatched twice).
 */
export declare function approveFactory(call: ToolCallContext, input: ApproveFactoryInput): Promise<ApproveFactoryResult>;
/** Arguments of {@link dispatchFactory}. */
export interface DispatchFactoryInput {
    readonly factoryId: string;
    readonly stageId?: string;
    readonly findings?: string[];
    readonly note?: string;
}
/** Result of {@link dispatchFactory}. */
export interface DispatchFactoryResult {
    readonly summary: string;
    readonly factoryId: string;
    readonly phase: string;
    readonly known: boolean;
    readonly stageId: string;
    readonly stageName: string;
    readonly round: number;
    readonly parallel: boolean;
    readonly humanApproval: boolean;
    readonly planned: number;
    readonly decisions: DispatchRow[];
    readonly applied: DispatchRow[];
    readonly failed: DispatchRow[];
    readonly waiting: DispatchRow[];
    readonly skipped: DispatchRow[];
    readonly spawned: string[];
    readonly missingRoles: string[];
    readonly escalate: boolean;
    readonly notes: string[];
    readonly nextAction: string;
}
/**
 * Runs one dispatch cycle for the current (or an explicitly named) stage.
 *
 * This is the "wake the people who have work now" operation: the scheduler picks
 * the first non-passed stage, resolves its roles against the real roster with the
 * fallback ladder, and only the roles with actual work are spawned / woken /
 * reworked.
 */
export declare function dispatchFactory(call: ToolCallContext, input: DispatchFactoryInput): Promise<DispatchFactoryResult>;
