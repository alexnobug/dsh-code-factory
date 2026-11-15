/**
 * engine/plan.ts — factory_plan / factory_edit_plan.
 *
 * The staged half of the two-phase protocol: routing a brief to a task type,
 * deciding the roster under the cap and the team floor, projecting the
 * pipeline, and writing (or amending) a plan without waking any member.
 *
 * Moved here verbatim from the former single-file `src/tools/engine.ts`
 * (engineering review finding M5). Only this header, the imports and the
 * `export` keywords on cross-module helpers are new — no body was edited.
 *
 * @module dsh-code-factory/tools/engine/plan
 */
import type { ToolCallContext } from '../context.js';
import type { PlanRoleRow } from './plumbing.js';
/** One pipeline row of a staged plan. */
export interface PlanStageRow {
    readonly id: string;
    readonly name: string;
    readonly roles: string[];
    readonly parallel: boolean;
    readonly humanApproval: boolean;
    readonly gateType: string;
    readonly maxRounds: number;
    readonly failGoto?: string;
}
/** Arguments of {@link planFactory}. */
export interface PlanFactoryInput {
    readonly brief: string;
    readonly name?: string;
    readonly taskType?: string;
    readonly members?: string[];
    readonly maxMembers?: number;
}
/** Result of {@link planFactory} / {@link editFactoryPlan}. */
export interface PlanFactoryResult {
    readonly summary: string;
    readonly factoryId: string;
    readonly name: string;
    readonly brief: string;
    readonly taskType: string;
    readonly pipeline: string;
    readonly phase: string;
    readonly planReviewState: string;
    readonly securityTriggered: boolean;
    readonly maxMembers: number;
    readonly team: PlanRoleRow[];
    readonly stages: PlanStageRow[];
    readonly reasoning: string[];
    readonly trimmed: string[];
    /**
     * Roles this task type's template requires that the cap forced out.
     *
     * Separate from {@link trimmed} on purpose: for a template whose every role is
     * required (all of `web_fullstack`), the cap drops required roles and nothing
     * else, so `trimmed` stays empty while the roster is genuinely short — and the
     * stages those roles staff will silently fall back through `ROLE_FALLBACKS`
     * unless somebody raises `maxMembers`.
     */
    readonly trimmedRequired: string[];
    readonly overCap: boolean;
    readonly factoryFile: string;
    readonly reusedPlan: boolean;
    readonly spawnedMembers: number;
    readonly childSessions: number;
    readonly notes: string[];
    readonly nextAction: string;
}
/**
 * Stage one plan. Creates the factory record (phase `staged`, review state
 * `awaiting_review`) and **nothing else** — no `startActivation`, no delivery.
 */
export declare function planFactory(call: ToolCallContext, input: PlanFactoryInput): Promise<PlanFactoryResult>;
/** Arguments of {@link editFactoryPlan}. */
export interface EditPlanInput {
    readonly factoryId: string;
    readonly brief?: string;
    readonly name?: string;
    readonly taskType?: string;
    readonly members?: string[];
    readonly maxMembers?: number;
    readonly note?: string;
}
/** Result of {@link editFactoryPlan}. */
export interface EditPlanResult extends PlanFactoryResult {
    readonly changedFields: string[];
    readonly editedAt: number;
}
/**
 * Revise a staged plan. Only legal while nothing has been spawned: once a member
 * has a session id the roster is frozen (its brief is already in its context), and
 * the refusal says so instead of silently diverging the plan from the running team.
 */
export declare function editFactoryPlan(call: ToolCallContext, input: EditPlanInput): Promise<EditPlanResult>;
