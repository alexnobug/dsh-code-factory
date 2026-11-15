/**
 * engine/gate.ts — factory_gate.
 *
 * The stage gate: it runs the template gate through the gate runner, takes
 * the domain verdict, rolls a failure back to `failGoto` with the corrective
 * list, and registers the artifacts a passed stage produced.
 *
 * Moved here verbatim from the former single-file `src/tools/engine.ts`
 * (engineering review finding M5). Only this header, the imports and the
 * `export` keywords on cross-module helpers are new — no body was edited.
 *
 * @module dsh-code-factory/tools/engine/gate
 */
import type { ToolCallContext } from '../context.js';
import type { CommandRow, DodItemRow, DodSummaryRow } from './plumbing.js';
/** Arguments of {@link gateFactory}. */
export interface GateFactoryInput {
    readonly factoryId: string;
    readonly stageId?: string;
    readonly findings?: string[];
    readonly humanConfirm?: boolean;
    readonly minCommits?: number;
}
/** Result of {@link gateFactory}. */
export interface GateFactoryResult {
    readonly summary: string;
    readonly factoryId: string;
    readonly action: string;
    readonly phase: string;
    readonly stageId: string;
    readonly stageName: string;
    readonly gateType: string;
    readonly ok: boolean;
    readonly detail: string;
    readonly round: number;
    readonly maxRounds: number;
    readonly humanApproval: boolean;
    readonly needsHumanConfirm: boolean;
    readonly rejectedTo?: string;
    readonly resetStages: string[];
    readonly findings: string[];
    readonly notifiedRoles: string[];
    readonly wokenRoles: string[];
    readonly refusedCommands: string[];
    readonly commands: CommandRow[];
    readonly dod?: DodSummaryRow;
    readonly dodItems?: DodItemRow[];
    readonly nextStage?: string;
    readonly nextStageName?: string;
    readonly notes: string[];
    readonly nextAction: string;
}
/**
 * Adjudicates one stage's gate with real evidence and applies the verdict.
 *
 * `advance` marks the stage passed; `reject` rolls back to `failGoto`, increments
 * the round and writes the corrective list (plus a rework turn) to the responsible
 * roles; `escalate` is the same rollback with the human in the loop because
 * `round >= maxRounds`; `await_approval` parks a `humanApproval` stage until the
 * user confirms; `delivered` means the last stage passed and only the DoD audit
 * and `factory_deliver` remain.
 */
export declare function gateFactory(call: ToolCallContext, input: GateFactoryInput): Promise<GateFactoryResult>;
