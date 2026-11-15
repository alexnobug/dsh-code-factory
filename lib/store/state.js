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
import { createHash } from 'node:crypto';
/* ------------------------------------------------------------------ errors */
/** Base class for every error the store raises, carrying a stable `code`. */
export class FactoryError extends Error {
    /** Stable machine-readable discriminator, e.g. `'path'`, `'transition'`. */
    code;
    constructor(code, message) {
        super(message);
        this.name = 'FactoryError';
        this.code = code;
    }
}
/** A path segment (factory id, mailbox key, artifact path) failed validation. */
export class FactoryPathError extends FactoryError {
    constructor(message) {
        super('path', message);
        this.name = 'FactoryPathError';
    }
}
/** The persisted state is missing required fields or is not valid JSON. */
export class FactoryStateError extends FactoryError {
    constructor(message) {
        super('state', message);
        this.name = 'FactoryStateError';
    }
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
export class FactorySchemaVersionError extends FactoryStateError {
    /** Absolute path of the offending `factory.json`. */
    file;
    /** The `schemaVersion` found on disk, already parsed to a number. */
    found;
    /** The newest `schemaVersion` this build knows how to interpret. */
    supported;
    constructor(file, found, supported, message) {
        super(message ??
            `${file} 的 schemaVersion 是 ${found}，本版本只认到 ${supported}` +
                ` —— 这份记录是更新的插件写的，拒绝按旧 schema 猜着读。` +
                `升级 dsh-code-factory 后再打开它。`);
        this.name = 'FactorySchemaVersionError';
        this.file = file;
        this.found = found;
        this.supported = supported;
    }
}
/** A status change was requested that the transition table does not allow. */
export class FactoryTransitionError extends FactoryError {
    /** Transition family: `task` | `stage` | `member` | `phase`. */
    kind;
    from;
    to;
    constructor(kind, from, to) {
        super('transition', `illegal ${kind} transition ${from} -> ${to}` +
            ` (allowed: ${(allowedFor(kind, from) ?? []).join(', ') || 'none — terminal state'})`);
        this.name = 'FactoryTransitionError';
        this.kind = kind;
        this.from = from;
        this.to = to;
    }
}
/* ---------------------------------------------------------------- key rules */
/** Default maximum length (in code points) of a sanitised key. */
export const DEFAULT_MAX_KEY_LENGTH = 64;
/** Default length of the uniqueness digest appended on truncation/collapse. */
export const DEFAULT_KEY_DIGEST_LENGTH = 12;
/** The only separator `sanitizeKey` ever emits. */
export const KEY_SEPARATOR = '-';
/** Hard ceiling on `maxLength`, so a key always fits one NTFS path component. */
const MAX_KEY_LENGTH_CEILING = 120;
/** Unicode letters and digits — the only characters kept verbatim. */
const ALNUM = /[\p{L}\p{N}]/u;
/** Windows device names that can never be a bare file/directory name. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** Characters that are illegal (or dangerous) inside one path segment. */
const UNSAFE_SEGMENT = /[\\/:*?"<>|\u0000-\u001f]/;
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
export function sanitizeKey(name, options = {}) {
    const requestedMax = Math.trunc(options.maxLength ?? DEFAULT_MAX_KEY_LENGTH);
    const maxLength = Math.min(Math.max(requestedMax, 8), MAX_KEY_LENGTH_CEILING);
    const digestLength = Math.min(Math.max(Math.trunc(options.digestLength ?? DEFAULT_KEY_DIGEST_LENGTH), 4), Math.max(4, maxLength - 4));
    const separator = options.separator && options.separator.length > 0 ? options.separator : KEY_SEPARATOR;
    const fallbackPrefix = options.fallbackPrefix && options.fallbackPrefix.length > 0 ? options.fallbackPrefix : 'k';
    const input = (typeof name === 'string' ? name : name === null || name === undefined ? '' : String(name)).normalize('NFC');
    let folded = '';
    let separatorPending = false;
    for (const char of input) {
        if (ALNUM.test(char)) {
            if (separatorPending && folded.length > 0)
                folded += separator;
            separatorPending = false;
            folded += char;
        }
        else {
            separatorPending = true;
        }
    }
    const digest = keyDigest(input, digestLength);
    if (folded.length === 0)
        return `${fallbackPrefix}${separator}${digest}`;
    const codePoints = [...folded];
    if (codePoints.length > maxLength) {
        const budget = Math.max(1, maxLength - separator.length - digestLength);
        const head = trimTrailingSeparator(codePoints.slice(0, budget).join(''), separator);
        folded = head.length > 0 ? `${head}${separator}${digest}` : `${fallbackPrefix}${separator}${digest}`;
    }
    if (WINDOWS_RESERVED.test(folded))
        folded = `${folded}${separator}${digest}`;
    return folded;
}
/**
 * True when `key` is usable as one path segment: non-empty, no separators, no
 * traversal, no Windows-illegal characters, no trailing dot/space.
 */
export function isSafeKey(key) {
    if (typeof key !== 'string')
        return false;
    if (key.length === 0 || key.length > 255)
        return false;
    if (key === '.' || key === '..')
        return false;
    if (UNSAFE_SEGMENT.test(key))
        return false;
    if (/[. ]$/.test(key))
        return false;
    return true;
}
/**
 * Canonical factory ids: 8 hex chars from `create()`, but any safe
 * `[A-Za-z0-9](-?[A-Za-z0-9])*` token up to 64 chars is accepted. Rejects `..`,
 * separators, drive letters and trailing separators — i.e. everything that could
 * change the meaning of a joined path.
 */
export function isSafeFactoryId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/.test(id);
}
function keyDigest(input, length) {
    return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, length);
}
function trimTrailingSeparator(value, separator) {
    let out = value;
    while (out.length > 0 && out.endsWith(separator))
        out = out.slice(0, out.length - separator.length);
    return out;
}
/** Legal task transitions. `claimed` may never jump straight to `completed`. */
export const TASK_STATUS_TRANSITIONS = {
    pending: ['claimed', 'cancelled'],
    claimed: ['in_progress', 'pending', 'failed', 'cancelled'],
    in_progress: ['completed', 'failed', 'cancelled'],
    completed: [],
    // Terminal for this attempt; a retry re-enters through `pending` with a new attempt id.
    failed: ['pending'],
    cancelled: [],
};
/**
 * Legal stage transitions inside one pipeline run.
 *
 * `passed -> active|pending` is intentional: when a downstream gate fails,
 * `failGoto` rewinds an already-passed stage so its roles redo the work, and the
 * engine bumps that stage's `round`. `rejected` is the gate-said-no state; the
 * engine then either retries in place (`rejected -> active`) or rewinds to
 * `failGoto` (`rejected -> pending`).
 */
export const STAGE_STATUS_TRANSITIONS = {
    pending: ['active'],
    active: ['gate', 'rejected', 'pending'],
    gate: ['passed', 'rejected', 'active'],
    passed: ['active', 'pending', 'gate'],
    rejected: ['active', 'pending'],
};
/**
 * Legal member transitions. `removed` is terminal; `done` can be re-opened by a later gate.
 *
 * The edges out of `staged`, `done` and `error` are wider than the happy path on purpose:
 * a member's *own* report (`factory_report` / `factory_block`) is an independent input, so it
 * can arrive before the scheduler has observed the member start (source `staged`), after an
 * earlier stage already closed it (source `done`), or after a spawn failure was recorded
 * (source `error`). Narrowing these would turn an ordinary timing difference into a crash.
 */
export const MEMBER_STATUS_TRANSITIONS = {
    staged: ['idle', 'working', 'blocked', 'done', 'error', 'removed'],
    idle: ['working', 'rework', 'blocked', 'done', 'error', 'removed'],
    working: ['idle', 'rework', 'blocked', 'done', 'error', 'removed'],
    rework: ['working', 'idle', 'blocked', 'done', 'error', 'removed'],
    blocked: ['idle', 'working', 'rework', 'done', 'error', 'removed'],
    done: ['working', 'rework', 'idle', 'blocked', 'error', 'removed'],
    error: ['idle', 'working', 'staged', 'blocked', 'done', 'removed'],
    removed: [],
};
/** Legal factory-phase transitions. `delivered` and `discarded` are terminal. */
export const FACTORY_PHASE_TRANSITIONS = {
    staged: ['running', 'discarded'],
    running: ['halted', 'delivered', 'discarded', 'staged'],
    halted: ['running', 'delivered', 'discarded'],
    delivered: [],
    discarded: [],
};
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
export function assertTransition(kind, from, to) {
    const allowed = allowedFor(kind, from);
    if (allowed !== undefined && allowed.includes(to))
        return;
    throw new FactoryTransitionError(kind, from, to);
}
function allowedFor(kind, from) {
    switch (kind) {
        case 'task':
            return TASK_STATUS_TRANSITIONS[from];
        case 'stage':
            return STAGE_STATUS_TRANSITIONS[from];
        case 'member':
            return MEMBER_STATUS_TRANSITIONS[from];
        case 'phase':
            return FACTORY_PHASE_TRANSITIONS[from];
        default:
            return undefined;
    }
}
/* --------------------------------------------------------------- mutators */
/**
 * Apply a legal stage status change in place and keep its timestamps coherent.
 *
 * @throws FactoryTransitionError when the change is not in {@link STAGE_STATUS_TRANSITIONS}.
 */
export function transitionStage(rec, to, at = Date.now()) {
    // Landing on the state you are already in is a NO-OP, not an illegal move.
    // This matters because the callers are retry paths: `rollbackFor` rewinds a
    // whole range of stages and may meet one that a previous round already
    // rewound, and a re-dispatch may re-assert `active` on an active stage.
    // Without this short-circuit the guards would turn today's harmless re-write
    // into a thrown error - the transition *table* is about real changes.
    if (rec.status === to)
        return rec;
    assertTransition('stage', rec.status, to);
    rec.status = to;
    switch (to) {
        case 'active':
            // Re-entering `active` (inline retry or failGoto rewind) starts a new run.
            rec.startedAt = at;
            rec.endedAt = undefined;
            break;
        case 'passed':
        case 'rejected':
            rec.startedAt = rec.startedAt ?? at;
            rec.endedAt = at;
            break;
        case 'pending':
            rec.startedAt = undefined;
            rec.endedAt = undefined;
            break;
        case 'gate':
        default:
            break;
    }
    return rec;
}
/**
 * Apply a legal member status change in place and keep its timestamps coherent.
 *
 * @throws FactoryTransitionError when the change is not in {@link MEMBER_STATUS_TRANSITIONS}.
 */
export function transitionMember(member, to, at = Date.now()) {
    // See {@link transitionStage}: re-asserting the current status is a no-op.
    // `MEMBER_STATUS_TRANSITIONS` has no self-edge (`working -> working` is not
    // listed), yet the scheduler legitimately re-wakes an already-working member
    // and the engine re-derives `idle` for a member that is already idle.
    if (member.status === to)
        return member;
    assertTransition('member', member.status, to);
    member.status = to;
    switch (to) {
        case 'working':
        case 'rework':
            member.startedAt = member.startedAt ?? at;
            member.endedAt = undefined;
            break;
        case 'done':
        case 'error':
        case 'removed':
            member.startedAt = member.startedAt ?? at;
            member.endedAt = at;
            break;
        default:
            member.endedAt = undefined;
            break;
    }
    return member;
}
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
export function transitionPhase(state, to, at = Date.now()) {
    // See {@link transitionStage}: re-asserting the current phase is a no-op.
    if (state.phase === to)
        return state;
    assertTransition('phase', state.phase, to);
    state.phase = to;
    state.updatedAt = at;
    return state;
}
/* -------------------------------------------------------- schema migration */
/**
 * Schema version of a `factory.json` that carries **no** `schemaVersion` field:
 * every record written before versioning existed (review finding M8).
 *
 * Declared here, beside {@link migrateFactoryState} and the version assertion,
 * because those three are one fact — the store re-exports it next to its own
 * `FACTORY_SCHEMA_VERSION` so a caller only ever needs one import path.
 */
export const FACTORY_SCHEMA_VERSION_LEGACY = 0;
/** How a raw `schemaVersion` value reads in a refusal message. */
function describeRawVersion(raw) {
    if (typeof raw === 'number')
        return String(raw);
    if (typeof raw === 'string')
        return JSON.stringify(raw);
    if (raw === null)
        return 'null';
    return JSON.stringify(raw) ?? String(raw);
}
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
export function assertSupportedSchemaVersion(raw, file, supported, absent) {
    if (raw === undefined)
        return absent;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
        throw new FactorySchemaVersionError(file, absent, supported, `${file} 的 schemaVersion 是 ${describeRawVersion(raw)}（${raw === null ? 'null' : typeof raw}），不是非负整数` +
            ` —— 无法判断这份记录属于哪一版 schema，拒绝按旧 schema 猜着读。`);
    }
    if (raw > supported)
        throw new FactorySchemaVersionError(file, raw, supported);
    return raw;
}
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
export function migrateFactoryState(state, from, to) {
    if (!Number.isInteger(from) || from < 0) {
        throw new FactoryStateError(`migrateFactoryState: "from" must be a non-negative integer, got ${describeRawVersion(from)}`);
    }
    if (!Number.isInteger(to) || to < 0) {
        throw new FactoryStateError(`migrateFactoryState: "to" must be a non-negative integer, got ${describeRawVersion(to)}`);
    }
    if (from > to) {
        throw new FactoryStateError(`migrateFactoryState: refusing to downgrade factory ${state.id} from schema ${from} to ${to}`);
    }
    let current = state;
    let version = from;
    while (version < to) {
        switch (version) {
            case 0:
                // 0 -> 1: PURE STAMP, the record shape genuinely did not change.
                current = { ...current, schemaVersion: 1 };
                break;
            default:
                throw new FactoryStateError(`migrateFactoryState: no migration step ${version} -> ${version + 1} for factory ${state.id}` +
                    ` —— 版本链在这里断了，拒绝把记录原样当成新版使用。`);
        }
        version += 1;
    }
    return current;
}
/* ---------------------------------------------------------------- queries */
/** The stage record with this id, or `undefined`. */
export function findStage(state, stageId) {
    return state.stages.find((stage) => stage.id === stageId);
}
/** The member record for this role, or `undefined`. */
export function findMember(state, role) {
    return state.members.find((member) => member.role === role);
}
/** The stage currently being worked (or awaiting its gate), if any. */
export function activeStage(state) {
    return state.stages.find((stage) => stage.status === 'active' || stage.status === 'gate');
}
/** Every stage that has not passed yet, in pipeline order. */
export function pendingStages(state) {
    return state.stages.filter((stage) => stage.status !== 'passed');
}
//# sourceMappingURL=state.js.map