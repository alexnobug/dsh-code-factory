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
import { roleTitle } from './roles.js';
/** A lesson must recur at least this many times to become a plugin proposal. */
export const IMPROVEMENT_MIN_EVIDENCE = 2;
/** Hard cap so one noisy stage cannot flood the cockpit/status payload. */
export const IMPROVEMENT_LIMIT = 12;
/** Gate types that are judged against an artifact/command. */
const ARTIFACT_GATE_TYPES = new Set(['checklist', 'keyword', 'script', 'composite']);
/**
 * Roles whose recurring mistakes are best fixed in their **role definition**
 * (iron rules) rather than in a single stage's gate: quality/process roles
 * whose job is to enforce a rule every time.
 */
const ROLE_RULE_ROLES = new Set(['pm', 'qa', 'reviewer', 'security_eng', 'devops']);
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
export function improvementTargetFor(lesson) {
    if (lesson.kind === 'dod') {
        return { target: 'dod', targetFile: 'src/domain/dod.ts' };
    }
    const role = lesson.role;
    if (ARTIFACT_GATE_TYPES.has(lesson.gateType)) {
        if (role !== undefined && ROLE_RULE_ROLES.has(role)) {
            return { target: 'role-rule', targetFile: 'src/domain/roles.ts' };
        }
        return { target: 'gate', targetFile: 'src/domain/pipeline.ts' };
    }
    if (role !== undefined && role !== 'captain' && role !== 'router') {
        return { target: 'role-rule', targetFile: 'src/domain/roles.ts' };
    }
    return { target: 'captain-rule', targetFile: 'src/prompt/captain-protocol.ts' };
}
function oneLine(text, maxChars) {
    const collapsed = String(text).replace(/\s+/g, ' ').trim();
    return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars)}…`;
}
function stageLabel(lesson) {
    return lesson.stageName ?? lesson.stage;
}
function suggestionFor(lesson, target) {
    const text = oneLine(lesson.text, 240);
    switch (target) {
        case 'role-rule':
            return `在 ${roleTitle(lesson.role)}（${lesson.role}）的岗位铁律中加入：${text}`;
        case 'gate':
            return `在阶段 ${stageLabel(lesson)}（${lesson.stage}）的门禁/整改清单中固定检查：${text}`;
        case 'dod':
            return `在 DoD 条目或交付前检查中固化：${text}`;
        case 'pipeline':
            return `在流水线 ${lesson.stage} 的规则中固化：${text}`;
        case 'captain-rule':
            return `在队长协议中加入规则：${text}`;
        case 'doc':
            return `在插件文档/使用说明中固化：${text}`;
    }
}
function statusFor(lesson) {
    return lesson.resolvedAt === undefined ? 'open' : 'validated';
}
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
export function deriveImprovements(lessons, options = {}) {
    const minEvidence = Number.isFinite(options.minEvidence)
        ? Math.max(1, Math.trunc(options.minEvidence))
        : IMPROVEMENT_MIN_EVIDENCE;
    const limit = Number.isFinite(options.limit)
        ? Math.max(0, Math.trunc(options.limit))
        : IMPROVEMENT_LIMIT;
    if (limit === 0 || lessons.length === 0)
        return [];
    const proposals = [];
    const seen = new Set();
    for (const lesson of lessons) {
        if (!Number.isFinite(lesson.count) || lesson.count < minEvidence)
            continue;
        const id = `imp-${lesson.id}`;
        if (seen.has(id))
            continue;
        seen.add(id);
        const decision = improvementTargetFor(lesson);
        const resolved = lesson.resolvedAt !== undefined;
        proposals.push({
            id,
            title: `避免重复：${oneLine(lesson.text, 46)}`,
            target: decision.target,
            ...(decision.targetFile === undefined ? {} : { targetFile: decision.targetFile }),
            suggestion: suggestionFor(lesson, decision.target),
            rationale: `该问题在跨任务中已出现 ${lesson.count} 次`
                + (resolved ? '，且已有一次修复验证通过' : '，目前仍可能复发')
                + '；建议从插件规则层固化，避免只依赖每次运行时的历史简报。',
            role: lesson.role,
            stage: lesson.stage,
            gateType: lesson.gateType,
            lessonIds: [lesson.id],
            evidenceCount: lesson.count,
            status: statusFor(lesson),
            lastAt: lesson.lastAt,
        });
    }
    return proposals
        .sort((left, right) => right.evidenceCount - left.evidenceCount
        || right.lastAt - left.lastAt
        || left.id.localeCompare(right.id))
        .slice(0, limit);
}
/** Count proposals by status. Pure; the empty case is all zeroes. */
export function improvementStats(proposals) {
    let open = 0;
    let validated = 0;
    for (const proposal of proposals) {
        if (proposal.status === 'validated')
            validated += 1;
        else
            open += 1;
    }
    return { total: proposals.length, open, validated };
}
//# sourceMappingURL=improvements.js.map