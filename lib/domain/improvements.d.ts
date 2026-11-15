/**
 * improvements.ts — turn recurring cross-task lessons into **plugin-improvement
 * proposals** (the safe half of "the factory improves itself").
 *
 * The runtime never edits its own source. What it can do is make repeated
 * mistakes impossible to miss: every lesson that recurred at least
 * {@link IMPROVEMENT_MIN_EVIDENCE} times becomes an actionable proposal that
 * names the plugin file most likely to need the fix, the concrete change to
 * make, and the evidence (`count`, whether a later round validated the fix).
 * The captain surfaces these through `factory_status`, the cockpit renders them
 * under the evolution section, and a human/captain applies the actual code or
 * doc change through the normal review + test loop.
 *
 * Proposals are **derived, not persisted**: `evolution.json` remains the single
 * durable evidence record, and this module is a deterministic projection of it.
 * That keeps a proposal from ever drifting away from the lessons that justify
 * it, and means no extra store/lock/schema is needed.
 *
 * PURITY CONTRACT (hard): only type imports from `shared/types.js` and the
 * sibling `roles.js`; no Node API, no I/O, no clock, no randomness.
 *
 * @module dsh-code-factory/domain/improvements
 */
import type { ImprovementProposal, ImprovementTarget, LessonRecord } from '../shared/types.js';
/** A lesson must recur at least this many times to become a plugin proposal. */
export declare const IMPROVEMENT_MIN_EVIDENCE = 2;
/** Hard cap so one noisy stage cannot flood the cockpit/status payload. */
export declare const IMPROVEMENT_LIMIT = 12;
/** One proposal's target file, chosen from the lesson's role/stage/gate. */
export interface ImprovementTargetDecision {
    readonly target: ImprovementTarget;
    readonly targetFile?: string;
}
/**
 * Where a lesson should be fixed in the plugin.
 *
 * The mapping is intentionally simple and reviewable (not a model call):
 *
 *  1. DoD failures → `src/domain/dod.ts`;
 *  2. gate failures owned by a process/quality role → that role's iron rules in
 *     `src/domain/roles.ts`;
 *  3. other gate failures → the pipeline template's gate in
 *     `src/domain/pipeline.ts`;
 *  4. anything left → the captain protocol (`src/prompt/captain-protocol.ts`).
 *
 * @param lesson - the recurring lesson to classify.
 * @returns the target kind and the file a change most likely belongs in.
 */
export declare function improvementTargetFor(lesson: Pick<LessonRecord, 'kind' | 'gateType' | 'role'>): ImprovementTargetDecision;
/**
 * Derive the plugin-improvement backlog from a workspace lesson ledger.
 *
 * Only lessons seen at least {@link IMPROVEMENT_MIN_EVIDENCE} times qualify:
 * a one-off mistake is handled by the injected history in the next brief, while
 * a recurring one is a signal that the plugin's own rules should change.
 *
 * Output order is `evidenceCount` desc → `lastAt` desc → `id` asc, so the most
 * expensive and most recent mistakes lead. The result is a new array of new
 * objects; input lessons are never mutated.
 *
 * @param lessons - the workspace ledger (already normalised by the store).
 * @param options - optional `minEvidence` / `limit` overrides.
 * @returns deterministic, capped proposals.
 */
export declare function deriveImprovements(lessons: readonly LessonRecord[], options?: {
    readonly minEvidence?: number;
    readonly limit?: number;
}): ImprovementProposal[];
/** Roll-up of an improvement backlog, for `factory_status`. */
export interface ImprovementStats {
    readonly total: number;
    readonly open: number;
    readonly validated: number;
}
/** Count proposals by status. Pure; the empty case is all zeroes. */
export declare function improvementStats(proposals: readonly ImprovementProposal[]): ImprovementStats;
