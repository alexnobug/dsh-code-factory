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
import { getDodItem } from '../../domain/dod.js';
import { dodStatusOf } from '../../domain/gates.js';
import { ROLE_FALLBACKS, canonicalRoleId, getRole } from '../../domain/roles.js';
import { logLine } from '../context.js';
/**
 * True when a persisted DoD item was skipped because the factory never took the
 * security path. `DodState` (the persisted shape) has no `skipped` flag, so the
 * reason is re-derived from the item definition instead of being invented.
 */
function dodItemSkipped(id, securityTriggered) {
    return !securityTriggered && getDodItem(id)?.securityOnly === true;
}
/**
 * Resolves one *persisted* DoD row to its verdict.
 *
 * Rows written before `status` existed carry only `ok`, so a non-applicable
 * audit is re-derived from the item definition (exactly as {@link dodItemSkipped}
 * does). Both shapes therefore roll up honestly without a migration.
 */
export function dodStateStatus(item, securityTriggered) {
    return dodStatusOf({
        ok: item.ok,
        ...(item.status === undefined ? {} : { status: item.status }),
        skipped: dodItemSkipped(item.id, securityTriggered),
    });
}
/** Roll-up over the persisted DoD states. */
export function summarizeDodStates(items, securityTriggered) {
    const verdicts = items.map((item) => dodStateStatus(item, securityTriggered));
    const count = (status) => verdicts.filter((verdict) => verdict === status).length;
    const failed = count('failed');
    const pending = count('pending');
    return {
        passed: count('passed'),
        total: items.length,
        failed,
        pending,
        skipped: count('skipped'),
        ok: failed === 0 && pending === 0,
    };
}
/** Roll-up of one live DoD audit. */
export function summarizeDodAudit(summary) {
    return {
        passed: summary.passed,
        total: summary.total,
        failed: summary.failed,
        pending: summary.pending,
        skipped: summary.skipped,
        ok: summary.ok,
    };
}
/** Projection of one DoD audit's item rows. */
export function dodRows(results) {
    return results.map((item) => ({
        id: item.id,
        label: item.label,
        ok: item.ok,
        status: item.status,
        skipped: item.skipped,
        evidence: item.evidence,
        needsExecution: item.needsExecution,
    }));
}
/** Projection of the persisted DoD states. */
export function dodStateRows(items, securityTriggered) {
    return items.map((item) => {
        const status = dodStateStatus(item, securityTriggered);
        return {
            id: item.id,
            label: item.label,
            ok: item.ok,
            status,
            skipped: status === 'skipped',
            evidence: item.evidence ?? '',
            needsExecution: false,
        };
    });
}
/* ------------------------------------------------ evolution ledger (DoD) */
/** Stage id a DoD lesson belongs to (there is no pipeline stage for the audit). */
export const DOD_LESSON_STAGE = 'dod';
/** Human-facing stage name of a DoD lesson. */
export const DOD_LESSON_STAGE_NAME = 'DoD 总验收';
/** The role that owns each DoD item by default (before roster fallbacks). */
const DOD_ITEM_BASE_ROLE = {
    1: 'pm', // PRD ↔ TEST_REPORT cross-reference: acceptance ids come from PRD.md
    2: 'qa', // pytest run
    3: 'reviewer', // REVIEW.md conclusion
    4: 'security_eng', // SECURITY_AUDIT.md conclusion
    5: 'devops', // start.sh --check
    6: 'tech_writer', // README four headings — falls back to devops/qa when not staffed
    7: 'devops', // per-stage commits + v1.0.0 tag
};
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
export function dodLessonRoleFor(itemId, roster = []) {
    const preferred = canonicalRoleId(DOD_ITEM_BASE_ROLE[itemId] ?? 'qa');
    const role = getRole(preferred) === undefined ? 'qa' : preferred;
    if (roster.length === 0)
        return role;
    const present = new Set(roster.map((member) => canonicalRoleId(member)));
    if (present.has(role))
        return role;
    for (const candidate of ROLE_FALLBACKS[role] ?? []) {
        const canonical = canonicalRoleId(candidate);
        if (present.has(canonical) && getRole(canonical) !== undefined)
            return canonical;
    }
    return role;
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
export async function resolveDodLessons(call, factoryId) {
    try {
        return await call.store.evolution.resolve({
            factoryId,
            stage: DOD_LESSON_STAGE,
            at: call.store.now(),
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logLine(call.plugin, 'warn', `DoD 教训库 resolve 失败（已忽略，不影响 DoD 结论）: ${message}`);
        return 0;
    }
}
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
export async function recordDodLessons(call, state, items) {
    const failures = items.filter((item) => item.status === 'failed' || item.status === 'pending');
    if (failures.length === 0)
        return 0;
    const roster = state.members.map((member) => member.role);
    try {
        const report = await call.store.evolution.record(failures.map((item) => ({
            role: dodLessonRoleFor(item.id, roster),
            stage: DOD_LESSON_STAGE,
            stageName: DOD_LESSON_STAGE_NAME,
            gateType: 'dod',
            kind: 'dod',
            text: `DoD #${item.id} ${item.label} 未通过：${item.evidence ?? '无证据'}`,
            ...(item.evidence === undefined ? {} : { detail: item.evidence }),
            factoryId: state.id,
            taskType: state.taskType,
        })));
        return report.added + report.updated;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logLine(call.plugin, 'warn', `DoD 教训库记录失败（已忽略，不影响 DoD 结论）: ${message}`);
        return 0;
    }
}
//# sourceMappingURL=dod.js.map