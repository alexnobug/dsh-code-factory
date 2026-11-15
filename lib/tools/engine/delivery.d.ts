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
import type { ToolCallContext } from '../context.js';
import type { CommandRow, DodItemRow } from './plumbing.js';
/** Arguments of {@link checkDod}. */
export interface DodCheckInput {
    readonly factoryId: string;
    readonly minCommits?: number;
}
/** Result of {@link checkDod}. */
export interface DodCheckResult {
    readonly summary: string;
    readonly factoryId: string;
    readonly ok: boolean;
    readonly passed: number;
    readonly total: number;
    readonly failed: number;
    readonly pending: number;
    readonly skipped: number;
    readonly securityTriggered: boolean;
    readonly items: DodItemRow[];
    readonly commands: CommandRow[];
    readonly commits: number;
    readonly tags: string[];
    readonly gitError?: string;
    readonly refusedCommands: string[];
    readonly missing: string[];
    readonly notes: string[];
    readonly nextAction: string;
}
/**
 * Runs the seven-item Definition-of-Done audit with real reads, real commands and
 * real git facts, then persists the verdicts into the factory record.
 */
export declare function checkDod(call: ToolCallContext, input: DodCheckInput): Promise<DodCheckResult>;
/** Arguments of {@link haltFactory}. */
export interface HaltFactoryInput {
    readonly factoryId: string;
    readonly reason?: string;
}
/** Result of {@link haltFactory}. */
export interface HaltFactoryResult {
    readonly summary: string;
    readonly factoryId: string;
    readonly phase: string;
    readonly alreadyHalted: boolean;
    readonly interrupted: string[];
    readonly failed: string[];
    readonly reason: string;
    readonly nextAction: string;
}
/** Stops the pipeline: interrupts every working member and parks the factory. */
export declare function haltFactory(call: ToolCallContext, input: HaltFactoryInput): Promise<HaltFactoryResult>;
/** Arguments of {@link resumeFactory}. */
export interface ResumeFactoryInput {
    readonly factoryId: string;
    readonly reason: string;
}
/** Result of {@link resumeFactory}. */
export interface ResumeFactoryResult {
    readonly summary: string;
    readonly factoryId: string;
    readonly phase: string;
    readonly alreadyRunning: boolean;
    readonly reason: string;
    readonly currentStage?: string;
    readonly nextAction: string;
}
/** Resumes a halted factory. Never dispatches by itself. */
export declare function resumeFactory(call: ToolCallContext, input: ResumeFactoryInput): Promise<ResumeFactoryResult>;
/** Arguments of {@link deliverFactory}. */
export interface DeliverFactoryInput {
    readonly factoryId: string;
    readonly deliveryPath?: string;
    readonly note?: string;
    readonly minCommits?: number;
}
/** Result of {@link deliverFactory}. */
export interface DeliverFactoryResult {
    readonly summary: string;
    readonly factoryId: string;
    readonly delivered: boolean;
    readonly alreadyDelivered: boolean;
    readonly phase: string;
    readonly deliveryPath?: string;
    readonly dodPassed: number;
    readonly dodTotal: number;
    readonly blocked: string[];
    readonly stagesPassed: boolean;
    readonly items: DodItemRow[];
    readonly nextAction: string;
}
/**
 * The delivery gate: stages all passed **and** the DoD audit green — re-verified
 * here, never trusted from an earlier run, because a delivered factory is a
 * promise the plugin makes to the user.
 */
export declare function deliverFactory(call: ToolCallContext, input: DeliverFactoryInput): Promise<DeliverFactoryResult>;
/** Arguments of {@link deleteFactory}. */
export interface DeleteFactoryInput {
    readonly factoryId: string;
    readonly mode?: string;
    readonly confirm?: boolean;
}
/** Result of {@link deleteFactory}. */
export interface DeleteFactoryResult {
    readonly summary: string;
    readonly factoryId: string;
    readonly mode: string;
    readonly archived: boolean;
    readonly removed: boolean;
    readonly drained: string[];
    readonly drainErrors: string[];
    readonly path?: string;
    readonly nextAction: string;
}
/**
 * Ends a factory: interrupts and releases every member, marks the record
 * `discarded`, then archives (default) or destroys the directory.
 *
 * Archiving is the default because a hard delete loses the audit trail of a
 * pipeline that may have produced real artifacts; `mode: 'destroy'` requires an
 * explicit `confirm: true`.
 */
export declare function deleteFactory(call: ToolCallContext, input: DeleteFactoryInput): Promise<DeleteFactoryResult>;
