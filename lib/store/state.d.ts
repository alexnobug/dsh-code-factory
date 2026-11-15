/**
 * Pure state logic for the factory store.
 *
 * Three responsibilities, all side-effect free:
 *  1. the legal-transition tables for tasks, stages, members and factory phases;
 *  2. `sanitizeKey()` — the single gate every on-disk path segment goes through;
 *  3. query helpers over `FactoryState` (`findStage`, `findMember`, …).
 *
 * Keeping this module free of `node:fs` means the store's rules can be reasoned
 * about (and unit-tested) without a filesystem. It does use `node:crypto` for key
 * digests — this whole directory is host-only, and the client tsconfig excludes
 * `src/store`.
 *
 * @module dsh-code-factory/store/state
 */
import type { FactoryPhase, FactoryState, MemberState, MemberStatus, StageStateRec, StageStatus } from '../shared/types.js';
/** Base class for every error the store raises, carrying a stable `code`. */
export declare class FactoryError extends Error {
    /** Stable machine-readable discriminator, e.g. `'path'`, `'transition'`. */
    readonly code: string;
    constructor(code: string, message: string);
}
/** A path segment (factory id, mailbox key, artifact path) failed validation. */
export declare class FactoryPathError extends FactoryError {
    constructor(message: string);
}
/** The persisted state is missing required fields or is not valid JSON. */
export declare class FactoryStateError extends FactoryError {
    constructor(message: string);
}
/**
 * A `factory.json` carries a `schemaVersion` this build must not interpret
 * (review finding M8).
 *
 * Distinct from its parent so a caller can tell "this file is corrupt" from
 * "this file is *newer than me*": the second is not damage, it is a downgrade,
 * and the only safe answer is to refuse rather than guess what the record means.
 *
 * @example
 * ```ts
 * catch (error) {
 *   if (error instanceof FactorySchemaVersionError) {
 *     console.error(`插件太旧，升级后重试：${error.file}（记录 v${error.found}，本版本认到 v${error.supported}）`)
 *   }
 * }
 * ```
 */
export declare class FactorySchemaVersionError extends FactoryStateError {
    /** Absolute path of the offending `factory.json`. */
    readonly file: string;
    /** The `schemaVersion` found on disk, already parsed to a number. */
    readonly found: number;
    /** The newest `schemaVersion` this build knows how to interpret. */
    readonly supported: number;
    constructor(file: string, found: number, supported: number, message?: string);
}
/** A status change was requested that the transition table does not allow. */
export declare class FactoryTransitionError extends FactoryError {
    /** Transition family: `task` | `stage` | `member` | `phase`. */
    readonly kind: string;
    readonly from: string;
    readonly to: string;
    constructor(kind: string, from: string, to: string);
}
/** Default maximum length (in code points) of a sanitised key. */
export declare const DEFAULT_MAX_KEY_LENGTH = 64;
/** Default length of the uniqueness digest appended on truncation/collapse. */
export declare const DEFAULT_KEY_DIGEST_LENGTH = 12;
/** The only separator `sanitizeKey` ever emits. */
export declare const KEY_SEPARATOR = "-";
/** Options for {@link sanitizeKey}. */
export interface SanitizeKeyOptions {
    /** Maximum length of the result in code points. Default {@link DEFAULT_MAX_KEY_LENGTH}. */
    readonly maxLength?: number;
    /** Digest length used for the uniqueness suffix. Default {@link DEFAULT_KEY_DIGEST_LENGTH}. */
    readonly digestLength?: number;
    /** Separator emitted when runs of unsafe characters are folded. Default `-`. */
    readonly separator?: string;
    /** Prefix used when the input contains no letters/digits at all. Default `k`. */
    readonly fallbackPrefix?: string;
}
/**
 * Turn an arbitrary human string into a safe, unique, single path segment.
 *
 * Rules (all deterministic):
 *  - Unicode letters and digits are kept verbatim; every other code point
 *    collapses into a single `-` (runs collapse, and no key starts or ends with
 *    the separator).
 *  - A name with no letters/digits at all (emoji-only, punctuation-only, empty)
 *    falls back to `<prefix>-<digest>`.
 *  - A name longer than `maxLength` is truncated to fit `maxLength` code points
 *    and gets a `-<digest>` suffix derived from the *full* input, so two names
 *    sharing a long prefix can never collide.
 *  - Windows device names (`CON`, `NUL`, `LPT1`, …) get the digest suffix too.
 *  - The input is NFC-normalised first, so canonically equivalent spellings map
 *    to the same key.
 *  - The result is idempotent: `sanitizeKey(sanitizeKey(x)) === sanitizeKey(x)`.
 *
 * The result never contains `/`, `\`, `.`, a drive letter, a control character,
 * a trailing space or a trailing dot, so it can be joined onto a base directory
 * without any traversal risk.
 */
export declare function sanitizeKey(name: string, options?: SanitizeKeyOptions): string;
/**
 * True when `key` is usable as one path segment: non-empty, no separators, no
 * traversal, no Windows-illegal characters, no trailing dot/space.
 */
export declare function isSafeKey(key: string): boolean;
/**
 * Canonical factory ids: 8 hex chars from `create()`, but any safe
 * `[A-Za-z0-9](-?[A-Za-z0-9])*` token up to 64 chars is accepted. Rejects `..`,
 * separators, drive letters and trailing separators — i.e. everything that could
 * change the meaning of a joined path.
 */
export declare function isSafeFactoryId(id: string): boolean;
/**
 * Task-board lifecycle, mirroring the shared task list this plugin drives.
 *
 * Terminal states are immutable: a retry is a *new attempt* and therefore goes
 * back through `pending` explicitly, never `failed -> completed`.
 */
export type FactoryTaskStatus = 'pending' | 'claimed' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
/** Legal task transitions. `claimed` may never jump straight to `completed`. */
export declare const TASK_STATUS_TRANSITIONS: Readonly<Record<FactoryTaskStatus, readonly FactoryTaskStatus[]>>;
/**
 * Legal stage transitions inside one pipeline run.
 *
 * `passed -> active|pending` is intentional: when a downstream gate fails,
 * `failGoto` rewinds an already-passed stage so its roles redo the work, and the
 * engine bumps that stage's `round`. `rejected` is the gate-said-no state; the
 * engine then either retries in place (`rejected -> active`) or rewinds to
 * `failGoto` (`rejected -> pending`).
 */
export declare const STAGE_STATUS_TRANSITIONS: Readonly<Record<StageStatus, readonly StageStatus[]>>;
/**
 * Legal member transitions. `removed` is terminal; `done` can be re-opened by a later gate.
 *
 * The edges out of `staged`, `done` and `error` are wider than the happy path on purpose:
 * a member's *own* report (`factory_report` / `factory_block`) is an independent input, so it
 * can arrive before the scheduler has observed the member start (source `staged`), after an
 * earlier stage already closed it (source `done`), or after a spawn failure was recorded
 * (source `error`). Narrowing these would turn an ordinary timing difference into a crash.
 */
export declare const MEMBER_STATUS_TRANSITIONS: Readonly<Record<MemberStatus, readonly MemberStatus[]>>;
/** Legal factory-phase transitions. `delivered` and `discarded` are terminal. */
export declare const FACTORY_PHASE_TRANSITIONS: Readonly<Record<FactoryPhase, readonly FactoryPhase[]>>;
/**
 * Every member status, in lifecycle order.
 *
 * Re-exported from `src/shared/types.ts` (review finding H8): the browser half
 * parses the wire payload against the same list, and `shared` is the only layer
 * both halves may import. Declaring it here again would let the two drift, and a
 * drift is silent — the parser substitutes its fallback instead of reporting.
 */
export { FACTORY_PHASES, MEMBER_STATUSES, STAGE_STATUSES } from '../shared/types.js';
/** Throw a {@link FactoryTransitionError} unless the transition is legal. */
export declare function assertTransition(kind: 'task' | 'stage' | 'member' | 'phase', from: string, to: string): void;
/**
 * Apply a legal stage status change in place and keep its timestamps coherent.
 *
 * @throws FactoryTransitionError when the change is not in {@link STAGE_STATUS_TRANSITIONS}.
 */
export declare function transitionStage(rec: StageStateRec, to: StageStatus, at?: number): StageStateRec;
/**
 * Apply a legal member status change in place and keep its timestamps coherent.
 *
 * @throws FactoryTransitionError when the change is not in {@link MEMBER_STATUS_TRANSITIONS}.
 */
export declare function transitionMember(member: MemberState, to: MemberStatus, at?: number): MemberState;
/**
 * Apply a legal phase change in place and touch the factory's `updatedAt`.
 *
 * The phase is the one field whose transitions the cockpit colours and the
 * resume path both read, and `delivered` / `discarded` are terminal — so a
 * typo'd phase is not a cosmetic bug, it is an unrecoverable factory. Routing
 * every write through here is what makes {@link FACTORY_PHASE_TRANSITIONS}
 * load-bearing instead of decorative.
 *
 * @throws FactoryTransitionError when the change is not in {@link FACTORY_PHASE_TRANSITIONS}.
 */
export declare function transitionPhase(state: FactoryState, to: FactoryPhase, at?: number): FactoryState;
/**
 * Schema version of a `factory.json` that carries **no** `schemaVersion` field:
 * every record written before versioning existed (review finding M8).
 *
 * Declared here, beside {@link migrateFactoryState} and the version assertion,
 * because those three are one fact — the store re-exports it next to its own
 * `FACTORY_SCHEMA_VERSION` so a caller only ever needs one import path.
 */
export declare const FACTORY_SCHEMA_VERSION_LEGACY = 0;
/**
 * Refuse a `factory.json` whose `schemaVersion` this build must not interpret,
 * and hand back the schema version the record should be read as.
 *
 * The return value is the point: the check and the normalisation are one step,
 * so the version can never be validated on one line and re-derived (guessed) on
 * the next.
 *
 * A **non-number** `schemaVersion` is a refusal, not a fallback: `"1"`, `null`
 * and `{}` are all "somebody or something wrote a version field this build does
 * not understand", and coercing any of them is exactly the guess M8 is about.
 *
 * @param raw the parsed JSON value of the `schemaVersion` field, unvalidated.
 * @param absent the version to resolve `undefined` to — the "written before
 *   versioning existed" value, {@link FACTORY_SCHEMA_VERSION_LEGACY} in practice.
 * @returns `absent` when the field is missing, otherwise the found version.
 * @throws FactorySchemaVersionError when the value is > `supported`, or is not a
 *   non-negative integer.
 */
export declare function assertSupportedSchemaVersion(raw: unknown, file: string, supported: number, absent: number): number;
/**
 * Bring a persisted record forward to `to`, one schema step at a time.
 *
 * This is what makes the version check load-bearing: the version travels
 * *through* here instead of being read and thrown away. A step this function
 * does not know **throws** — silently returning the record unchanged is the
 * exact bug (M8: a renamed or re-meaning field becomes a silent misread of the
 * single source of truth), so an unknown step must fail loudly rather than let
 * a caller believe the record was understood.
 *
 * 0 → 1 is a pure **stamp**. Nothing in the record moved: v1 is what every
 * existing `factory.json` already is, and the only new fact is the version
 * number itself. Inventing a field rewrite here would be a lie about a shape
 * change that never happened — and the next real migration is written against
 * whatever this chain already claims.
 *
 * @throws FactoryStateError when `from`/`to` are not usable versions, when this
 *   is a downgrade, or when a step in the chain is not implementable.
 */
export declare function migrateFactoryState(state: FactoryState, from: number, to: number): FactoryState;
/** The stage record with this id, or `undefined`. */
export declare function findStage(state: FactoryState, stageId: string): StageStateRec | undefined;
/** The member record for this role, or `undefined`. */
export declare function findMember(state: FactoryState, role: string): MemberState | undefined;
/** The stage currently being worked (or awaiting its gate), if any. */
export declare function activeStage(state: FactoryState): StageStateRec | undefined;
/** Every stage that has not passed yet, in pipeline order. */
export declare function pendingStages(state: FactoryState): StageStateRec[];
