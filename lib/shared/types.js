/**
 * Shared domain contract for code-factory.
 *
 * ZERO imports, on purpose: this module is compiled by BOTH tsc programs and is
 * bundled into the browser half. Keep it types-only plus small pure constants so
 * the client never drags host code into the bundle.
 *
 * @module dsh-code-factory/shared/types
 */
/**
 * Runtime whitelist for {@link SecuritySignalSource}. The store sanitises a
 * persisted `securitySource` against it, and a hand-copied second list would
 * drift exactly the way `src/client/api.ts` used to (review finding H8).
 */
export const SECURITY_SIGNAL_SOURCES = [
    'none',
    'brief',
    'document',
];
/** Runtime whitelist for {@link LessonKind}. See {@link MEMBER_STATUSES}. */
export const LESSON_KINDS = ['gate', 'dod'];
/** Runtime whitelist for {@link ImprovementTarget}. See {@link MEMBER_STATUSES}. */
export const IMPROVEMENT_TARGETS = [
    'role-rule',
    'captain-rule',
    'gate',
    'dod',
    'pipeline',
    'doc',
];
/** Runtime whitelist for {@link ImprovementStatus}. */
export const IMPROVEMENT_STATUSES = ['open', 'validated'];
/** Runtime whitelist for {@link ReuseKind}. See {@link MEMBER_STATUSES}. */
export const REUSE_KINDS = [
    'module',
    'content',
    'design',
    'test',
    'ops',
    'other',
];
/**
 * Runtime whitelists for the alert unions, kept **next to the union** so the
 * browser half imports them instead of hand-copying a second list.
 *
 * `src/client/api.ts` used to re-declare every server enum by hand; a drift there
 * was invisible because the parser falls back to a default instead of throwing
 * (review finding H8). New enums must not repeat that mistake.
 */
export const ALERT_KINDS = [
    'awaiting-plan-review',
    'awaiting-approval',
    'rounds-exhausted',
    'stage-rejected',
    'member-blocked',
    'member-error',
    'halted',
];
/** Runtime whitelist for {@link AlertSeverity}. See {@link ALERT_KINDS}. */
export const ALERT_SEVERITIES = ['action', 'attention'];
/**
 * Runtime whitelists for the five state unions, for the same reason as
 * {@link ALERT_KINDS} — and until review finding H8 was closed the browser half
 * DID hand-copy all five.
 *
 * They live here rather than in `src/store/state.ts` (where three of them used
 * to sit) because `shared` is the only layer both halves may depend on: the
 * layering rule in `docs/architecture.md` puts `store` and `domain` ABOVE
 * `shared`, so a client importing the store would invert it.
 *
 * `src/store/state.ts` and `src/domain/gates.ts` re-export these rather than
 * re-declaring them, so every existing import path keeps working and there is
 * exactly one list per union.
 */
export const MEMBER_STATUSES = [
    'staged',
    'idle',
    'working',
    'rework',
    'blocked',
    'done',
    'error',
    'removed',
];
/** Every stage status, in lifecycle order. See {@link MEMBER_STATUSES}. */
export const STAGE_STATUSES = [
    'pending',
    'active',
    'gate',
    'passed',
    'rejected',
];
/** Every factory phase. See {@link MEMBER_STATUSES}. */
export const FACTORY_PHASES = [
    'staged',
    'running',
    'halted',
    'delivered',
    'discarded',
];
/** Every gate type. See {@link MEMBER_STATUSES}. */
export const GATE_TYPES = [
    'checklist',
    'keyword',
    'script',
    'composite',
    'dod',
];
/**
 * Reported in place of a gate type when **no source can be resolved**.
 *
 * A stage's gate type is projected from two places: the pipeline template's gate,
 * or — when the template is gone — the type recorded on the stage's last verdict.
 * With neither, the cockpit projection, the captain's status row and the panel's
 * parser all used to assert `'checklist'`: a real gate type, and the most
 * permissive-looking one, so every surface named a rule no record contained.
 *
 * This marker replaces that guess. It is deliberately **not** a member of
 * {@link GateType}, so it can never be evaluated as a rule, and it lives here
 * because this module — zero imports, imported by both halves — is the one place
 * every projection can agree on.
 */
export const UNKNOWN_GATE_TYPE = 'unknown';
/** Every DoD item verdict. See {@link MEMBER_STATUSES}. */
export const DOD_STATUSES = [
    'passed',
    'skipped',
    'failed',
    'pending',
];
/**
 * Every mailbox message kind. See {@link MEMBER_STATUSES}.
 *
 * Not named by review finding H8, which counted five unions — this is the sixth:
 * the same list was hand-copied into `src/tools/engine.ts` (the caption's
 * validator) and `src/client/api.ts` (the panel's parser), so a new kind added
 * to one would have been rejected by the other with no build error.
 */
export const MESSAGE_KINDS = [
    'dispatch',
    'reject',
    'handoff',
    'report',
    'blocked',
    'approval',
    'system',
];
//# sourceMappingURL=types.js.map