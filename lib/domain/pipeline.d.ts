/**
 * pipeline.ts — the five pipeline templates.
 *
 * Order is data, not control flow: the engine walks `role → gate → failGoto`
 * and may never skip a stage. All five templates are complete — the skeleton's
 * omitted-stub templates (api / data) are filled in here — and every `failGoto`
 * points at an **earlier** stage of the same template (a gate can only send work
 * back, never forward).
 *
 * Stage order of the prototype pipeline (实施方案 §1.2 流水线表) is preserved
 * verbatim for `fullstack`:
 *
 *   requirement(人工审批) → design(并行 ui/sys/db) → contract(人工审批) →
 *   threat → implement(并行 fe/be) → review(打回 implement, 3 轮) →
 *   sec_audit(打回 implement) → test(composite, 打回 implement) →
 *   deliver → document(dod 总验收)
 *
 * Template stack assumptions (the factory is opinionated on purpose — gate
 * commands come from these templates and may NEVER be supplied by a model):
 *   - `npm run build --if-present` … JS/TS stacks (a missing build script is a
 *     no-op, never a false failure)
 *   - `python -m compileall -q …` … Python stacks (no `.py` files = success)
 *   - `python -m pytest -q`      … the DoD's test command
 *   - `bash start.sh --check`    … the delivery self-check the prototype names
 *
 * Stage staffing: the roster cap may trim a specialist (see `router.ts`), so
 * {@link resolveStageRoles} resolves each stage against the actual team and
 * falls back along `roles.ts` → `ROLE_FALLBACKS`, reporting substitutions and
 * genuinely unstaffed stages instead of failing at dispatch time.
 *
 * **`fe_dev` is a slot, not (any more) the default assignment.** The implement
 * stages keep the generic `fe_dev` role id, while `router.assembleTeam` replaces
 * the frontend slot with the detected platform specialist (`web_dev` /
 * `flutter_dev` / `mini_program_dev`). `resolveStageRoles` therefore maps the
 * generic slot onto the real specialist via `ROLE_FALLBACKS.fe_dev`, and an old
 * roster that really did staff `fe_dev` still resolves directly.
 *
 * PURITY CONTRACT (hard): no external imports, no Node API, no side effects.
 *
 * @module dsh-code-factory/domain/pipeline
 */
import type { PipelineId, Pipelines, StageDef } from '../shared/types.js';
/** Artifact paths the pipeline templates gate on (single source of truth). */
export declare const ARTIFACTS: {
    readonly prd: "PRD.md";
    readonly uiSpec: "UI_SPEC.md";
    readonly architecture: "ARCHITECTURE.md";
    readonly dbDesign: "DB_DESIGN.md";
    readonly apiContract: "API_CONTRACT.md";
    readonly threatModel: "THREAT_MODEL.md";
    readonly securityAudit: "SECURITY_AUDIT.md";
    readonly review: "REVIEW.md";
    readonly testReport: "TEST_REPORT.md";
    readonly readme: "README.md";
    readonly delivery: "DELIVERY.md";
    readonly startScript: "start.sh";
};
/** Conclusion lines the keyword gates accept — member briefs quote the same strings. */
export declare const CONCLUSIONS: {
    readonly reviewPass: "结论: APPROVED";
    readonly reviewFail: "结论: REJECTED";
    readonly secPass: "结论: SEC_PASS";
    readonly secFail: "结论: SEC_FAIL";
    readonly testPass: "结论: PASS";
    readonly testFail: "结论: FAIL";
};
/** Test command used by the test stage and by DoD item 2. */
export declare const TEST_COMMAND = "python -m pytest -q";
/** Delivery self-check command used by the deliver stage and by DoD item 5. */
export declare const DELIVERY_CHECK_COMMAND = "bash start.sh --check";
/** The prototype's stage order; `fullstack` must contain it, in order. */
export declare const PROTOTYPE_STAGE_ORDER: readonly string[];
/** All template ids; the router only ever returns one of these. */
export declare const PIPELINE_IDS: readonly PipelineId[];
/**
 * All five templates. `fullstack` is the prototype pipeline; the other four are
 * the same discipline with the specialist stages they actually need.
 */
export declare const PIPELINES: Pipelines;
/** True when `id` names a template. */
export declare function hasPipeline(id: PipelineId): boolean;
/** Template stages, or `[]` for an unknown id (callers validate separately). */
export declare function getPipeline(id: PipelineId): readonly StageDef[];
/** All stage ids of one template, in order. */
export declare function stageIds(id: PipelineId): readonly string[];
/** One stage by id. */
export declare function getStage(id: PipelineId, stageId: string): StageDef | undefined;
/** 0-based position of a stage, `-1` when unknown. */
export declare function stageIndex(id: PipelineId, stageId: string): number;
/** The stage after `stageId`, if any. */
export declare function nextStageId(id: PipelineId, stageId: string): string | undefined;
/** True when `stageId` is the last stage of its template. */
export declare function isFinalStage(id: PipelineId, stageId: string): boolean;
/** One role that had to be covered by somebody else. */
export interface StageSubstitution {
    readonly required: string;
    readonly assigned: string;
}
/** Resolution of one stage against the roster actually assembled. */
export interface StageStaffing {
    readonly stageId: string;
    /** Distinct members who work this stage. */
    readonly assigned: readonly string[];
    /** Stage roles that are in the team. */
    readonly direct: readonly string[];
    readonly substituted: readonly StageSubstitution[];
    /** Stage roles with neither a member nor a fallback — dispatch must escalate. */
    readonly missing: readonly string[];
    readonly fallbackUsed: boolean;
}
/**
 * Maps a stage onto the real roster. Direct members win; otherwise the stage
 * role walks its `ROLE_FALLBACKS` ladder (a capped/trimmed specialist is
 * covered by the nearest retained role). Reuse is allowed as a last resort so a
 * stage is never left empty while any candidate exists.
 */
export declare function resolveStageRoles(stageDef: StageDef, team: readonly string[]): StageStaffing;
/** Staffing of every stage of a template against one roster. */
export declare function pipelineStaffing(id: PipelineId, team: readonly string[]): readonly StageStaffing[];
/** Result of validating one template. */
export interface PipelineValidation {
    readonly ok: boolean;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
}
/** Validates one template: ids, order, gate parameters, roles and back-edges. */
export declare function validatePipeline(id: PipelineId): PipelineValidation;
/** Validates every template; `byPipeline` keeps the per-template verdicts. */
export declare function validateAllPipelines(): {
    readonly ok: boolean;
    readonly errors: readonly string[];
    readonly warnings: readonly string[];
    readonly byPipeline: Readonly<Record<string, PipelineValidation>>;
};
