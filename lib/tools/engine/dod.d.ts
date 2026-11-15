/**
 * engine/dod.ts — DoD projections.
 *
 * The definition-of-done projections every DoD-reading tool renders: one row
 * per checklist item, the item-state vocabulary, and the pass/fail summaries
 * shared by `factory_gate`, `factory_status`, `factory_dod_check` and
 * `factory_deliver`.
 *
 * Moved here verbatim from the former single-file `src/tools/engine.ts`
 * (engineering review finding M5). Only this header, the imports and the
 * `export` keywords on cross-module helpers are new — no body was edited.
 *
 * @module dsh-code-factory/tools/engine/dod
 */
import type { DodStatus, FactoryState } from '../../shared/types.js';
import type { ToolCallContext } from '../context.js';
import type { DodItemRow, DodSummaryRow } from './plumbing.js';
/**
 * Resolves one *persisted* DoD row to its verdict.
 *
 * Rows written before `status` existed carry only `ok`, so a non-applicable
 * audit is re-derived from the item definition (exactly as {@link dodItemSkipped}
 * does). Both shapes therefore roll up honestly without a migration.
 */
export declare function dodStateStatus(item: {
    readonly id: number;
    readonly ok: boolean;
    readonly status?: DodStatus;
}, securityTriggered: boolean): DodStatus;
/** Roll-up over the persisted DoD states. */
export declare function summarizeDodStates(items: readonly {
    readonly id: number;
    readonly ok: boolean;
    readonly status?: DodStatus;
}[], securityTriggered: boolean): DodSummaryRow;
/** Roll-up of one live DoD audit. */
export declare function summarizeDodAudit(summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly pending: number;
    readonly ok: boolean;
}): DodSummaryRow;
/** Projection of one DoD audit's item rows. */
export declare function dodRows(results: readonly {
    readonly id: number;
    readonly label: string;
    readonly ok: boolean;
    readonly status: DodStatus;
    readonly skipped: boolean;
    readonly evidence: string;
    readonly needsExecution: boolean;
}[]): DodItemRow[];
/** Projection of the persisted DoD states. */
export declare function dodStateRows(items: readonly {
    readonly id: number;
    readonly label: string;
    readonly ok: boolean;
    readonly status?: DodStatus;
    readonly evidence?: string;
}[], securityTriggered: boolean): DodItemRow[];
/** Stage id a DoD lesson belongs to (there is no pipeline stage for the audit). */
export declare const DOD_LESSON_STAGE = "dod";
/** Human-facing stage name of a DoD lesson. */
export declare const DOD_LESSON_STAGE_NAME = "DoD \u603B\u9A8C\u6536";
/**
 * The role a failed DoD item is addressed to.
 *
 * The base mapping is the item's natural owner; `tech_writer` is an add-on job
 * that most rosters never staff, so the registry's own fallback ladder is walked
 * (`tech_writer → devops → pm`) instead of recording a lesson nobody will ever
 * read. The result is always a registered, canonical role id.
 *
 * @param itemId - the DoD item id (1..7).
 * @param roster - the factory's current roster, used to apply the fallback ladder.
 * @returns the canonical role id that owns the fix.
 */
export declare function dodLessonRoleFor(itemId: number, roster?: readonly string[]): string;
/** One persisted/failed DoD row this module needs to build a lesson from. */
export interface DodLessonItem {
    readonly id: number;
    readonly label: string;
    readonly status: DodStatus;
    readonly evidence?: string;
}
/**
 * Marks this factory's open DoD lessons as resolved.
 *
 * `factory_dod_check` is the only place that knows the whole audit is green, so
 * it is the only caller: a green audit proves the previously missing README
 * headings / tag / REVIEW conclusion are now in place. The stage filter is
 * `stage = 'dod'` (no role filter — the audit belongs to the factory, and any
 * role-addressed row for it is fixed by the same green run).
 *
 * Never throws, same policy as {@link recordDodLessons}: the audit verdict must
 * not depend on the ledger.
 *
 * @param call - the resolved tool call (store + logger).
 * @param factoryId - the factory whose DoD lessons are resolved.
 * @returns how many lessons were newly stamped (`0` on any failure).
 */
export declare function resolveDodLessons(call: ToolCallContext, factoryId: string): Promise<number>;
/**
 * Records every failed / still-pending DoD item as a durable lesson.
 *
 * Never throws: a broken ledger is logged and reported as `0` recorded, because
 * `factory_dod_check` must still return the audit verdict it actually measured.
 *
 * @param call - the resolved tool call (store + logger).
 * @param state - the factory record (id / taskType / roster).
 * @param items - the evaluated DoD rows.
 * @returns how many lesson entries were written (new + repeated).
 */
export declare function recordDodLessons(call: ToolCallContext, state: FactoryState, items: readonly DodLessonItem[]): Promise<number>;
