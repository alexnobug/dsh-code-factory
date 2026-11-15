/**
 * `FactoryStore` — the durable truth for one workspace's code factories.
 *
 * ## On-disk layout
 *
 * `root = <workspace>/<stateDir>` (stateDir defaults to `.code-factory`):
 *
 * ```text
 * <root>/<factoryId>/factory.json           FactoryState + schemaVersion, pretty JSON, atomic replace
 * <root>/<factoryId>/inbox/<key>.jsonl      one FactoryMessage per line, append-only
 * <root>/<factoryId>/artifacts.json         { version, updatedAt, artifacts: ArtifactRecord[] }
 * <root>/archive/<factoryId>/…              archived factory, byte-identical layout
 * <root>/evolution.json                     cross-factory lesson ledger (see store/evolution.ts)
 * ```
 *
 * Every path segment is derived through `sanitizeKey()` and re-checked with a
 * `path.relative` containment test, so a hostile `factoryId` or mailbox key can
 * never escape `root`.
 *
 * ## Concurrency contract — READ THIS BEFORE CALLING ANYTHING
 *
 * The store has **no internal global mutex**. Serialisation is the caller's job:
 *
 * ```ts
 * await store.withLock(id, async () => {
 *   const state = await store.loadOrThrow(id)
 *   transitionMember(state.members[0]!, 'working')
 *   await store.save(state)
 * })
 * ```
 *
 * - Read-modify-write helpers (`save`, `registerArtifact`, `markDelivered`,
 *   `markRead`, `archive`, `remove`) MUST run while the caller holds
 *   `withFactoryLock(store.lockKey(id))`.
 * - `mutate(id, fn)` does lock + load + `fn` + save for you. Never nest it inside
 *   its own lock: re-entry is detected and rejected with
 *   `FactoryLockReentryError` instead of deadlocking.
 * - Pure reads (`load`, `list`, `readMailbox`, `listUnread`, `readStageArtifacts`,
 *   `inboxKeys`, `readAllMessages`) are safe to call without the lock.
 * - `mail()` is an `O_APPEND` write of one line, so it is safe without the lock;
 *   taking the lock anyway is harmless (different key than the mailbox key).
 * - `create()` is a first write, not a read-modify-write; it refuses to clobber
 *   an existing factory unless `{ overwrite: true }`.
 *
 * ## Fault tolerance
 *
 * - `factory.json` that is missing means "no such factory" (`undefined`); a
 *   present but unparsable file throws `FactoryStateError` (silently losing the
 *   truth source would be worse) — and a present but **newer-schema** file
 *   throws `FactorySchemaVersionError` instead of being guessed at
 *   (review finding M8).
 * - `inbox/*.jsonl` is parsed **line by line**: one corrupt line is reported to
 *   `onMalformedLine` and skipped, never taking the whole factory down. Rewrites
 *   (`markDelivered` / `markRead`) preserve malformed lines verbatim.
 *
 * Host-only module (Node built-ins allowed), every relative import carries `.js`.
 *
 * @module dsh-code-factory/store/store
 */
import type { ArtifactRecord, FactoryMessage, FactoryPhase, FactoryState, MemberState, MessageKind, PipelineId, PlanReviewState, SecuritySignalSource, StageStateRec } from '../shared/types.js';
import { type FilePrimitives } from './atomic.js';
import { type FactoryLockOptions } from './lock.js';
import { type FactoryFileLockOptions } from './file-lock.js';
import { EvolutionStore } from './evolution.js';
import { FactoryError } from './state.js';
/** File name of the single source of truth inside a factory directory. */
export declare const FACTORY_FILE = "factory.json";
/** File name of the artifact registry inside a factory directory. */
export declare const ARTIFACTS_FILE = "artifacts.json";
/** Directory holding one JSONL mailbox per recipient. */
export declare const INBOX_DIR = "inbox";
/** Directory holding archived factories (a sibling of the live factory dirs). */
export declare const ARCHIVE_DIR = "archive";
/** Default `<workspace>/<stateDir>` leaf. Must match `Config.stateDir` in the plugin entry. */
export declare const DEFAULT_STATE_DIR = ".code-factory";
/** Prefix of the lock key handed to `withFactoryLock`. */
export declare const FACTORY_LOCK_PREFIX = "factory:";
/**
 * Rotate a mailbox once its live file exceeds this many bytes.
 *
 * The live file is what {@link FactoryStore.readMailbox} and
 * {@link FactoryStore.listUnread} parse on every call, so this is the number that
 * decides whether a long-running factory stays cheap to read.
 */
export declare const MAILBOX_MAX_BYTES: number;
/** Rotate a mailbox once its live file exceeds this many lines. */
export declare const MAILBOX_MAX_LINES = 2000;
/**
 * Hard ceiling for one rotated generation (`<key>.jsonl.1`).
 *
 * Rotated content is append-only until this cap, after which the oldest lines are
 * dropped. Consumed history is exactly the part it is safe to lose, and dropping
 * it here is what keeps the whole mailbox bounded rather than merely smaller.
 */
export declare const MAILBOX_ARCHIVE_MAX_BYTES: number;
/**
 * Suffix appended AFTER `.jsonl` for the rotated generation.
 *
 * Deliberately not `<key>.1.jsonl`: {@link FactoryStore.inboxKeys} selects by
 * `endsWith('.jsonl')`, so a suffix that starts with a dot would make every
 * archive look like a member's inbox. `<key>.jsonl.1` cannot match.
 */
export declare const MAILBOX_ARCHIVE_SUFFIX = ".1";
/**
 * Floor for a bounded tail read of one mailbox.
 *
 * A tail read is only a win if it starts far enough back to contain the newest
 * `limit` messages; this floor covers a few hundred typical JSONL lines.
 */
export declare const MAILBOX_TAIL_FLOOR_BYTES: number;
/** Per-message byte budget used to size a bounded tail read. */
export declare const MAILBOX_LINE_BUDGET_BYTES = 2048;
/**
 * Above this many inboxes, the cockpit feed reads only the most recently written
 * ones instead of all of them.
 *
 * A full team is 11 roles plus `captain`, so no healthy factory ever reaches this
 * number — it only engages on a factory whose directory accumulated inboxes over
 * a long life, and it reports itself when it does.
 */
export declare const MAILBOX_FEED_MAX_INBOXES = 12;
/**
 * Smallest possible serialised mailbox line, in bytes.
 *
 * `{"id":"","from":"","to":"","content":"","ts":0}` is 45 bytes, so any file whose
 * size is below `MAILBOX_MAX_LINES × this` provably holds fewer than
 * `MAILBOX_MAX_LINES` lines. That turns the per-append rotation check into a
 * single `stat` for every mailbox that is nowhere near its bound, instead of a
 * whole-file read on the hot append path.
 */
export declare const MAILBOX_MIN_LINE_BYTES = 40;
/** A store-level failure: unreadable target, refused clobber, failed archive… */
export declare class FactoryStoreError extends FactoryError {
    constructor(message: string, code?: string);
}
/** Mailbox tri-state of one message. */
export type MailboxStatus = 'pending' | 'delivered' | 'read';
/**
 * Derive the mailbox tri-state from the message timestamps:
 * `pending` = on disk, not yet accepted by the host inbox;
 * `delivered` = the host inbox accepted it; `read` = a model consumed it.
 */
export declare function mailboxStatus(message: FactoryMessage): MailboxStatus;
/** Structural guard for one mailbox line. */
export declare function isFactoryMessage(value: unknown): value is FactoryMessage;
/** One skipped mailbox line, handed to `onMalformedLine`. */
export interface MalformedLineInfo {
    /** Absolute path of the JSONL file. */
    readonly file: string;
    /** 1-based line number in the original file. */
    readonly line: number;
    /** The offending text, truncated to 500 characters. */
    readonly raw: string;
    /** Why it was skipped (`JSON.parse` message, or a shape complaint). */
    readonly error: string;
}
/** Receives one report per skipped line. Must never throw (it is wrapped). */
export type MalformedLineHandler = (info: MalformedLineInfo) => void;
/** Non-fatal store observation (corrupt sibling file, failed artifact stat, …). */
export interface FactoryStoreWarning {
    readonly code: string;
    readonly message: string;
    readonly error?: unknown;
}
/** Receives non-fatal observations. */
export type WarningHandler = (warning: FactoryStoreWarning) => void;
/** Construction options. Give either `root` or `workspace` (+ optional `stateDir`). */
export interface FactoryStoreOptions {
    /** Absolute or relative state root. Overrides `workspace`/`stateDir` when given. */
    readonly root?: string;
    /** Workspace root — in DSH this is always `caller.session.header.cwd`. */
    readonly workspace?: string;
    /** State directory leaf under `workspace`. Default {@link DEFAULT_STATE_DIR}. */
    readonly stateDir?: string;
    /** Injected filesystem face. Defaults to the real `node:fs/promises`. */
    readonly primitives?: FilePrimitives;
    /** Clock. Defaults to `Date.now`. */
    readonly now?: () => number;
    /** Factory id generator. Defaults to 8 lowercase hex chars. */
    readonly newFactoryId?: () => string;
    /** Message id generator. Defaults to `crypto.randomUUID()`. */
    readonly newMessageId?: () => string;
    /** Default malformed-JSONL-line reporter (per-call options override it). */
    readonly onMalformedLine?: MalformedLineHandler;
    /** Default non-fatal warning sink. */
    readonly onWarning?: WarningHandler;
    /** Upper bound for sanitised keys. Defaults to `sanitizeKey`'s 64. */
    readonly maxKeyLength?: number;
    /**
     * Defaults for the cross-process factory lock taken by {@link FactoryStore.withLock}.
     *
     * Leave unset to use the module defaults — a 15 s wait before giving up, a 5 min
     * staleness horizon and a 100 ms poll. Set `{ timeoutMs: 0 }` to fail immediately
     * instead of waiting when another host holds the factory.
     */
    readonly fileLock?: FactoryFileLockOptions;
}
/** Who worked which stage, plus the metric the cockpit shows. */
export interface CreateFactoryMemberInput {
    readonly role: string;
    readonly status?: MemberState['status'];
    readonly currentStage?: string;
    readonly sessionId?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly reasoningEffort?: string;
}
/** One stage of a freshly created factory. */
export interface CreateFactoryStageInput {
    readonly id: string;
    readonly status?: StageStateRec['status'];
    readonly round?: number;
    readonly attempts?: number;
}
/** Everything needed to open a factory record. */
export interface CreateFactoryInput {
    /** The user's original brief. */
    readonly brief: string;
    /** Human-facing title. Defaults to the first line of `brief`. */
    readonly name?: string;
    readonly taskType: string;
    readonly pipeline: PipelineId;
    readonly captainSessionId: string;
    readonly securityTriggered?: boolean;
    /** The words that caused the security path, and which input they came from (H4). */
    readonly securityHits?: readonly string[];
    readonly securitySource?: SecuritySignalSource;
    /** Roster: role ids, or pre-built member records. */
    readonly members?: readonly (string | CreateFactoryMemberInput)[];
    /** Pipeline stages: stage ids, or pre-built stage records (order = pipeline order). */
    readonly stages?: readonly (string | CreateFactoryStageInput)[];
    readonly phase?: FactoryPhase;
    readonly planReviewState?: PlanReviewState;
    /** Explicit id (must be canonical). Defaults to a generated 8-hex id. */
    readonly id?: string;
    readonly createdAt?: number;
}
/** Options for {@link FactoryStore.create}. */
export interface CreateFactoryOptions {
    /** Replace an existing factory directory. Default false (refuses). */
    readonly overwrite?: boolean;
}
/** Options for {@link FactoryStore.save}. */
export interface SaveFactoryOptions {
    /** Do not refresh `updatedAt`. Default false. */
    readonly touch?: boolean;
    /** Acquire the factory lock around the write. Default false — the caller holds it. */
    readonly lock?: boolean;
}
/** Options for {@link FactoryStore.mutate}. */
export interface MutateOptions {
    /** Persist the mutated state. Default true. */
    readonly save?: boolean;
    /** Skip the internal lock (only when the caller already holds it). Default false. */
    readonly lock?: boolean;
    /** Lock acquisition options, forwarded to `withFactoryLock`. */
    readonly lockOptions?: FactoryLockOptions;
}
/** Options for {@link FactoryStore.withLock}. */
export interface LockedRunOptions {
    /** In-process queue options, forwarded to `withFactoryLock`. */
    readonly lockOptions?: FactoryLockOptions;
    /** Cross-process lock options for this run; overrides the store-level defaults. */
    readonly fileLock?: FactoryFileLockOptions;
    /** Called once per poll while waiting for another host to release the factory. */
    readonly onFileLockWait?: FactoryFileLockOptions['onWait'];
}
/** Result of one {@link FactoryStore.mutate} call. */
export interface MutationResult<T> {
    /** Whatever `fn` returned. */
    readonly value: T;
    /** The state that was persisted (carries the refreshed `updatedAt`). */
    readonly state: FactoryState;
    /** False when `save: false` was requested. */
    readonly changed: boolean;
}
/** Compact row returned by {@link FactoryStore.list}. */
export interface FactorySummary {
    readonly id: string;
    readonly name: string;
    readonly phase: FactoryPhase;
    readonly taskType: string;
    readonly pipeline: PipelineId;
    readonly captainSessionId: string;
    readonly securityTriggered: boolean;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly memberCount: number;
    readonly stageCount: number;
    readonly stagesPassed: number;
    readonly dir: string;
    readonly archived: boolean;
}
/** Options for {@link FactoryStore.list}. */
export interface ListFactoriesOptions {
    /** List `<root>/archive` instead of the live factories. Default false. */
    readonly archived?: boolean;
    readonly onWarning?: WarningHandler;
}
/** Options for {@link FactoryStore.archive} / {@link FactoryStore.remove}. */
export interface ArchiveOptions {
    /** Replace an existing archive target. Default false (refuses). */
    readonly overwrite?: boolean;
    /** Take the factory lock around the move. Default true; false only inside an existing window. */
    readonly lock?: boolean;
}
/** Result of {@link FactoryStore.archive}. */
export interface ArchiveResult {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    /** `rename` = same-volume move, `copy` = copy+delete fallback (EXDEV/EPERM). */
    readonly method: 'rename' | 'copy';
}
/** Options for {@link FactoryStore.remove}. */
export interface RemoveFactoryOptions {
    /** Remove from `<root>/archive` instead of the live root. Default false. */
    readonly archived?: boolean;
    /** Take the factory lock around the delete. Default true; false only inside an existing window. */
    readonly lock?: boolean;
}
/** Input for {@link FactoryStore.registerArtifact}. */
export interface RegisterArtifactInput {
    /** Workspace-relative POSIX path of the artifact. */
    readonly path: string;
    /** Role id that produced it. */
    readonly by: string;
    /** Stage id it belongs to. */
    readonly stage: string;
    /** Byte size. Omitted = stat the file (falls back to 0 with a warning). */
    readonly bytes?: number;
}
/** Options for {@link FactoryStore.registerArtifact}. */
export interface RegisterArtifactOptions {
    /** Acquire the factory lock around the read-modify-write. Default false. */
    readonly lock?: boolean;
    readonly onWarning?: WarningHandler;
}
/** Input for {@link FactoryStore.mail}. */
export interface MailInput {
    /** `captain` or a role id. Sanitised before it becomes a file name. */
    readonly to: string;
    /** `captain` or a role id. */
    readonly from: string;
    readonly content: string;
    readonly kind?: MessageKind;
    readonly stage?: string;
    readonly round?: number;
    /** Explicit message id (tests, idempotent replays). */
    readonly id?: string;
    /** Explicit timestamp. Defaults to now. */
    readonly ts?: number;
    readonly deliveredAt?: number;
    readonly readAt?: number;
}
/** Options for {@link FactoryStore.readMailbox} / {@link FactoryStore.listUnread}. */
export interface MailboxReadOptions {
    /** Only messages with `readAt` unset. */
    readonly unreadOnly?: boolean;
    /** Keep only the newest N messages (still returned oldest-first). */
    readonly limit?: number;
    readonly onMalformedLine?: MalformedLineHandler;
}
/** Options for {@link FactoryStore.markDelivered} / {@link FactoryStore.markRead}. */
export interface MailboxPatchOptions {
    /** Acquire the factory lock around the mailbox rewrite. Default false. */
    readonly lock?: boolean;
    readonly onMalformedLine?: MalformedLineHandler;
}
/** Options for {@link FactoryStore.consumeMailbox}. */
export interface MailboxConsumeOptions {
    /** How to read; `unreadOnly` is the usual choice for an inbox. */
    readonly read?: MailboxReadOptions;
    /**
     * Mark the returned messages read in the same locked window. Default `true`;
     * `false` is the "read without consuming" mode (`includeRead`).
     */
    readonly markRead?: boolean;
}
/** What {@link FactoryStore.consumeMailbox} observed and changed. */
export interface MailboxConsumeResult {
    /** The messages returned by the read, oldest first. */
    readonly messages: FactoryMessage[];
    /** How many of them this call actually flipped to read. */
    readonly markedRead: number;
    /** Unread messages still in the mailbox afterwards. */
    readonly remainingUnread: number;
}
/** Options for {@link FactoryStore.readAllMessages} (the cockpit feed). */
export interface FeedReadOptions {
    /** Keep only the newest N messages across every inbox. */
    readonly limit?: number;
    /** Only messages nobody has read yet. */
    readonly unreadOnly?: boolean;
    readonly onMalformedLine?: MalformedLineHandler;
    /**
     * Observe the feed's own bounds.
     *
     * The feed prunes which inboxes it reads once a factory has more of them than a
     * full team could produce; a caller that cannot see that happen cannot tell a
     * complete feed from a bounded one.
     */
    readonly onWarning?: WarningHandler;
}
/** Current on-disk shape version of `artifacts.json`. */
export declare const ARTIFACTS_VERSION = 1;
/**
 * Current on-disk shape version of `factory.json` — the single source of truth
 * (review finding M8).
 *
 * Every write stamps it ({@link FactoryStore.save}) and every read validates it
 * ({@link parseFactoryState}), because this file has no second copy to fall back
 * on: a field renamed between two plugin versions, read without a version check,
 * is a **silent misread of the truth**, not a crash. Bump this whenever the
 * record's shape or a field's meaning changes, and teach
 * {@link migrateFactoryState} how to walk the old shape forward.
 */
export declare const FACTORY_SCHEMA_VERSION = 1;
/**
 * Schema version of a record that carries **no** `schemaVersion` field: every
 * `factory.json` written before versioning existed. Absence is a meaningful
 * value here, not a missing one — see {@link FactoryState.schemaVersion}.
 *
 * Declared in `state.ts` beside {@link migrateFactoryState} (the two are one
 * fact) and re-exported here, where the store's other versioning constants live.
 */
export { FACTORY_SCHEMA_VERSION_LEGACY } from './state.js';
/**
 * Durable, atomic, per-workspace persistence for code factories.
 *
 * @example
 * ```ts
 * const store = new FactoryStore({ workspace: caller.session.header.cwd, stateDir: '.code-factory' })
 * const state = await store.create({ brief, taskType: 'script_tool', pipeline: 'lightweight', captainSessionId, members: ['pm', 'qa', 'dev'], stages: ['requirement', 'implement'] })
 * await store.mail(state.id, { from: 'captain', to: 'pm', content: '开工', kind: 'dispatch' })
 * ```
 */
export declare class FactoryStore {
    /** Absolute state root: `<workspace>/<stateDir>` — every factory lives under here. */
    readonly root: string;
    /** Absolute workspace root. Used to resolve artifact paths and nothing else. */
    readonly workspace: string;
    /** The state directory leaf (default `.code-factory`). */
    readonly stateDir: string;
    /** Injected filesystem face. */
    readonly primitives: FilePrimitives;
    /**
     * The workspace's cross-factory evolution ledger (`<root>/evolution.json`).
     *
     * Shares this store's root, filesystem face and clock, so a workspace has
     * exactly one in-process ledger instance — the same reason there is one store
     * instance per (workspace, stateDir) in `tools/context.ts`. The ledger is a
     * sibling of the factory directories: its lessons outlive any one factory.
     */
    readonly evolution: EvolutionStore;
    /** Upper bound applied to every sanitised key. */
    readonly maxKeyLength: number | undefined;
    private readonly clock;
    private readonly generateFactoryId;
    private readonly generateMessageId;
    private readonly malformedLineHandler;
    private readonly warningHandler;
    /** Store-level defaults for the cross-process factory lock. */
    private readonly fileLockOptions;
    /** Count of writes that were neither atomic nor flushed. See {@link degradedWriteCount}. */
    private degradedWrites;
    constructor(options?: FactoryStoreOptions);
    /** Current time according to the injected clock. */
    now(): number;
    /**
     * How many writes this store performed without atomicity *and* a flush.
     *
     * Zero on a healthy run against the real filesystem. A non-zero value means
     * the durable state was written in a way a power loss can tear, so a caller
     * that surfaces health (the cockpit, a doctor command) should show it instead
     * of reporting a green state that was never actually safe on disk.
     */
    get degradedWriteCount(): number;
    /** Lock key to pass to `withFactoryLock` for this factory. */
    lockKey(factoryId: string): string;
    /**
     * Run `fn` as the sole writer of one factory — in this process *and* on this disk.
     *
     * Two layers, because they solve different problems:
     *  - `withFactoryLock(key)` orders the tasks of one process (rejects re-entry);
     *  - `withFactoryFileLock(…)` keeps a *second* host (the Electron app and a
     *    `dsh web` server on the same workspace, two windows, a CLI beside a live
     *    GUI) from interleaving its read-modify-write with ours. Without it, both
     *    would write `factory.json` and the loser's stage transition would vanish
     *    with no error anywhere.
     *
     * The file lock is process-wide (see `file-lock.ts`), so opening two stores on
     * one workspace does not make a store wait for itself.
     *
     * @throws {FactoryLockReentryError} on nested use of the same key.
     * @throws {FactoryFileLockTimeoutError} when another host holds the factory
     *         longer than `fileLock.timeoutMs`.
     */
    withLock<T>(factoryId: string, fn: () => T | Promise<T>, options?: LockedRunOptions): Promise<T>;
    /** `<root>/<factoryId>`. Throws `FactoryPathError` on an unsafe id. */
    factoryDir(factoryId: string): string;
    /** `<root>/<factoryId>/factory.json`. */
    factoryFile(factoryId: string): string;
    /** `<root>/<factoryId>/inbox`. */
    inboxDir(factoryId: string): string;
    /** `<root>/<factoryId>/inbox/<sanitizedKey>.jsonl`. */
    mailboxFile(factoryId: string, key: string): string;
    /**
     * `<root>/<factoryId>/inbox/<sanitizedKey>.jsonl.1` — the rotated generation.
     *
     * The mailbox path is built first, so this inherits its containment proof and
     * cannot escape the inbox directory even for a hostile key.
     */
    mailboxArchiveFile(factoryId: string, key: string): string;
    /** `<root>/<factoryId>/artifacts.json`. */
    artifactsFile(factoryId: string): string;
    /** `<root>/archive/<factoryId>`. */
    archiveDir(factoryId: string): string;
    /**
     * Resolve a workspace-relative POSIX path, refusing anything that escapes the
     * workspace (absolute paths, drive letters, `..` segments).
     */
    workspacePath(relativePath: string): string;
    /** The sanitised mailbox file stem for a human key (role id, `captain`, …). */
    mailboxKey(key: string): string;
    /**
     * Open a new factory record. Creates the directory, an empty inbox and an
     * empty artifact registry, then writes `factory.json`.
     *
     * @throws FactoryStoreError when the id is already taken and `overwrite` is not set.
     */
    create(input: CreateFactoryInput, options?: CreateFactoryOptions): Promise<FactoryState>;
    /** Read one factory record. `undefined` when `factory.json` does not exist. */
    load(factoryId: string): Promise<FactoryState | undefined>;
    /** Like {@link load} but throws when the factory is missing. */
    loadOrThrow(factoryId: string): Promise<FactoryState>;
    /** True when `<root>/<factoryId>/factory.json` exists. */
    exists(factoryId: string): Promise<boolean>;
    /**
     * Persist one factory record with an atomic replace.
     *
     * Call inside `withFactoryLock(store.lockKey(id), …)` (or pass `{ lock: true }`).
     * This is last-writer-wins: it does NOT merge with what is on disk, so a
     * read-modify-write that skips the lock can lose updates.
     *
     * The record is stamped with {@link FACTORY_SCHEMA_VERSION} as the **only**
     * place `factory.json` is serialised (`mutate` and `create` both route through
     * here), so a write without a version is not expressible.
     *
     * @returns the record as written (it carries the refreshed `updatedAt`).
     */
    save(state: FactoryState, options?: SaveFactoryOptions): Promise<FactoryState>;
    /**
     * Lock, load, mutate in place, save. The safe default for any state change.
     *
     * `fn` receives the freshly loaded, mutable record. Returning early throws
     * nothing away: if `fn` throws, nothing is written.
     */
    mutate<T>(factoryId: string, fn: (state: FactoryState) => T | Promise<T>, options?: MutateOptions): Promise<MutationResult<T>>;
    /** Compact listing of every factory under `root` (or under `archive`). */
    list(options?: ListFactoriesOptions): Promise<FactorySummary[]>;
    /**
     * Move `<root>/<factoryId>` to `<root>/archive/<factoryId>`.
     * Tries a same-volume `rename` first and degrades to copy+delete.
     *
     * Takes the factory lock (both layers), because moving the directory out from
     * under a concurrent writer is how a half-written factory.json ends up in
     * `archive/`. The lock file lives in `<root>/.locks/`, never inside the factory
     * directory, so the move cannot carry it away.
     */
    archive(factoryId: string, options?: ArchiveOptions): Promise<ArchiveResult>;
    /**
     * Delete a factory directory (live root by default, archive with
     * `{ archived: true }`). Returns false when there was nothing to delete.
     *
     * Takes the factory lock for the same reason {@link FactoryStore.archive} does.
     */
    remove(factoryId: string, options?: RemoveFactoryOptions): Promise<boolean>;
    /** Every registered artifact, oldest first. */
    listArtifacts(factoryId: string, onWarning?: WarningHandler): Promise<ArtifactRecord[]>;
    /** Registered artifacts of one stage (all stages when omitted), oldest first. */
    readStageArtifacts(factoryId: string, stage?: string): Promise<ArtifactRecord[]>;
    /**
     * Register (or refresh) one artifact in `artifacts.json`.
     *
     * Read-modify-write: call inside `withFactoryLock(store.lockKey(id), …)` or pass
     * `{ lock: true }`. The path is validated against the workspace: absolute paths
     * and `..` escapes are rejected with `FactoryPathError`.
     *
     * When `bytes` is omitted the file is stat'ed; a missing file is reported as a
     * warning and recorded with `bytes: 0` (the DoD audit decides whether that is
     * fatal).
     */
    registerArtifact(factoryId: string, input: RegisterArtifactInput, options?: RegisterArtifactOptions): Promise<ArtifactRecord>;
    /**
     * Append one message to `<root>/<factoryId>/inbox/<key>.jsonl`.
     *
     * The line is written with `O_APPEND` and contains no raw newline
     * (`JSON.stringify` escapes them), so concurrent appends cannot interleave
     * mid-line. The message starts its life in the `pending` state: `deliveredAt`
     * and `readAt` are unset until {@link markDelivered} / {@link markRead}.
     */
    mail(factoryId: string, input: MailInput): Promise<FactoryMessage>;
    /**
     * Read one mailbox, oldest first.
     *
     * Malformed lines are skipped and reported to `onMalformedLine` (per-call, then
     * the store default): a single corrupt line never makes a factory unreadable.
     *
     * When `limit` is set the read is answered from the **tail** of the file
     * whenever the tail alone can prove the answer: the newest `limit` messages of
     * a chronological file are the last `limit` lines, and the newest `limit`
     * unread messages are the last `limit` unread lines. If the tail turns out to
     * be too small to contain that many, the whole file is read instead — the fast
     * path is an optimisation, never an approximation.
     */
    readMailbox(factoryId: string, key: string, options?: MailboxReadOptions): Promise<FactoryMessage[]>;
    /** Messages nobody has consumed yet. */
    listUnread(factoryId: string, key: string, options?: MailboxReadOptions): Promise<FactoryMessage[]>;
    /**
     * Read a mailbox and, **inside one locked window**, mark what was returned read.
     *
     * Reading and marking used to be two separate calls with the lock only on the
     * second one. Once mailboxes rotate (see `rotateMailboxIfNeeded`) that is a
     * message-loss window rather than a theoretical one: a message that rotation
     * moves into the archive between the read and the mark is no longer in the
     * live file, so the mark matches nothing and the archived copy stays unread
     * forever — and archives are never read back.
     */
    consumeMailbox(factoryId: string, key: string, options?: MailboxConsumeOptions): Promise<MailboxConsumeResult>;
    /** Mailbox file stems that exist for this factory (sorted). */
    inboxKeys(factoryId: string): Promise<string[]>;
    /**
     * Every message of every inbox, oldest first — the cockpit's live feed.
     * `limit` keeps the newest N (still returned oldest-first).
     *
     * Two bounds keep this from degenerating on a long-lived factory: each inbox is
     * read through {@link readMailbox}'s tail path, and once a factory has more
     * inboxes than a full team could produce the feed reads only the most recently
     * written ones. The prune is reported, never silent.
     */
    readAllMessages(factoryId: string, options?: FeedReadOptions): Promise<FactoryMessage[]>;
    /**
     * Choose which inboxes the feed reads.
     *
     * Below {@link MAILBOX_FEED_MAX_INBOXES} every inbox is read, which is the
     * correct answer. Above it the most recently written ones win — an inbox nobody
     * has appended to in a long time cannot hold the newest feed entries — and the
     * drop is reported through the warning sink.
     */
    private feedInboxKeys;
    /**
     * Mark messages as `delivered` (the host inbox accepted them).
     *
     * @param ids explicit message ids, or the literal `'all'`.
     * @returns how many messages actually changed state.
     */
    markDelivered(factoryId: string, key: string, ids: readonly string[] | 'all', options?: MailboxPatchOptions): Promise<number>;
    /**
     * Mark messages as `read` (a model consumed them). A message that was never
     * marked delivered is stamped with both timestamps: consumption implies
     * delivery.
     *
     * @param ids explicit message ids, or the literal `'all'`.
     * @returns how many messages actually changed state.
     */
    markRead(factoryId: string, key: string, ids: readonly string[] | 'all', options?: MailboxPatchOptions): Promise<number>;
    /** Read-modify-write one mailbox file, preserving unparsable lines verbatim. */
    private patchMailbox;
    /** Parse `.jsonl` text, reporting (and preserving) every line that cannot be used. */
    private parseMailboxLines;
    private writeArtifacts;
    /** Atomic JSON write: temp file in the same directory, rename, direct fallback. */
    private writeJson;
    private writeText;
    private readText;
    /** True when anything exists at `target` (file or directory). */
    private pathExists;
    /** Canonical, traversal-free factory id — or a `FactoryPathError`. */
    private assertSafeFactoryId;
    /**
     * Report a non-fatal store condition through the store-level warning sink.
     *
     * Used by the mailbox bound: rotation and feed pruning are normal outcomes of a
     * long-lived factory, and a caller that never hears about them cannot tell a
     * bounded mailbox from a truncated one.
     */
    private warnStore;
    /**
     * Rotate one mailbox when it has outgrown its bounds.
     *
     * Consumed messages (`readAt` set) are the ones that only history needs, so they
     * move to `<key>.jsonl.1`, oldest first, which is itself capped at
     * {@link MAILBOX_ARCHIVE_MAX_BYTES}. Everything still unconsumed stays live.
     *
     * A mailbox can also be over the line cap while *every* line is unconsumed
     * (a factory nobody ever read from). Past {@link MAILBOX_MAX_LINES} the newest
     * lines are kept and the rest are archived, and the drop is reported: at that
     * point the only bounded behaviour is to drop the oldest, and doing it silently
     * would be the actual defect.
     */
    private rotateMailboxIfNeeded;
    /**
     * Append lines to the rotated generation, trimming the oldest when it is full.
     *
     * The trim is computed in one pass over the byte sizes rather than by repeated
     * string slicing, so appending to a 4 MiB archive does not become quadratic.
     */
    private appendToArchive;
    private reportWarning;
    private reportMalformed;
}
/** Structural guard for a persisted factory record. */
export declare function isFactoryState(value: unknown): value is FactoryState;
/** Structural guard for one artifact record. */
export declare function isArtifactRecord(value: unknown): value is ArtifactRecord;
export { FactoryError, FactoryPathError, FactorySchemaVersionError, FactoryStateError, assertSupportedSchemaVersion, isSafeFactoryId, isSafeKey, migrateFactoryState, sanitizeKey, } from './state.js';
export { isDurableWrite, nodeFilePrimitives, replaceFileAtomicOrDirect, temporaryPathFor } from './atomic.js';
export type { DurabilityReport, FilePrimitives, ReplaceFileOptions, ReplaceFileReport, WriteDurability } from './atomic.js';
export { DEFAULT_FILE_LOCK_POLL_MS, DEFAULT_FILE_LOCK_STALE_MS, DEFAULT_FILE_LOCK_TIMEOUT_MS, FactoryFileLockTimeoutError, acquireFactoryFileLock, factoryFileLockLocalStats, factoryLockFile, isProcessAlive, withFactoryFileLock, } from './file-lock.js';
export type { FactoryFileLockHandle, FactoryFileLockHolder, FactoryFileLockOptions } from './file-lock.js';
