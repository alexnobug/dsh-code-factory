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
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { SECURITY_SIGNAL_SOURCES } from '../shared/types.js';
import { isDurableWrite, nodeFilePrimitives, replaceFileAtomicOrDirect, temporaryPathFor, } from './atomic.js';
import { withFactoryLock } from './lock.js';
import { withFactoryFileLock } from './file-lock.js';
import { EvolutionStore } from './evolution.js';
import { FACTORY_SCHEMA_VERSION_LEGACY, FactoryError, FactoryPathError, FactoryStateError, assertSupportedSchemaVersion, isSafeFactoryId, isSafeKey, migrateFactoryState, sanitizeKey, } from './state.js';
/* --------------------------------------------------------------- constants */
/** File name of the single source of truth inside a factory directory. */
export const FACTORY_FILE = 'factory.json';
/** File name of the artifact registry inside a factory directory. */
export const ARTIFACTS_FILE = 'artifacts.json';
/** Directory holding one JSONL mailbox per recipient. */
export const INBOX_DIR = 'inbox';
/** Directory holding archived factories (a sibling of the live factory dirs). */
export const ARCHIVE_DIR = 'archive';
/** Default `<workspace>/<stateDir>` leaf. Must match `Config.stateDir` in the plugin entry. */
export const DEFAULT_STATE_DIR = '.code-factory';
/** Prefix of the lock key handed to `withFactoryLock`. */
export const FACTORY_LOCK_PREFIX = 'factory:';
/* ------------------------------------------------------- mailbox bounds (B3) */
/**
 * Rotate a mailbox once its live file exceeds this many bytes.
 *
 * The live file is what {@link FactoryStore.readMailbox} and
 * {@link FactoryStore.listUnread} parse on every call, so this is the number that
 * decides whether a long-running factory stays cheap to read.
 */
export const MAILBOX_MAX_BYTES = 256 * 1024;
/** Rotate a mailbox once its live file exceeds this many lines. */
export const MAILBOX_MAX_LINES = 2000;
/**
 * Hard ceiling for one rotated generation (`<key>.jsonl.1`).
 *
 * Rotated content is append-only until this cap, after which the oldest lines are
 * dropped. Consumed history is exactly the part it is safe to lose, and dropping
 * it here is what keeps the whole mailbox bounded rather than merely smaller.
 */
export const MAILBOX_ARCHIVE_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Suffix appended AFTER `.jsonl` for the rotated generation.
 *
 * Deliberately not `<key>.1.jsonl`: {@link FactoryStore.inboxKeys} selects by
 * `endsWith('.jsonl')`, so a suffix that starts with a dot would make every
 * archive look like a member's inbox. `<key>.jsonl.1` cannot match.
 */
export const MAILBOX_ARCHIVE_SUFFIX = '.1';
/**
 * Floor for a bounded tail read of one mailbox.
 *
 * A tail read is only a win if it starts far enough back to contain the newest
 * `limit` messages; this floor covers a few hundred typical JSONL lines.
 */
export const MAILBOX_TAIL_FLOOR_BYTES = 64 * 1024;
/** Per-message byte budget used to size a bounded tail read. */
export const MAILBOX_LINE_BUDGET_BYTES = 2048;
/**
 * Above this many inboxes, the cockpit feed reads only the most recently written
 * ones instead of all of them.
 *
 * A full team is 11 roles plus `captain`, so no healthy factory ever reaches this
 * number — it only engages on a factory whose directory accumulated inboxes over
 * a long life, and it reports itself when it does.
 */
export const MAILBOX_FEED_MAX_INBOXES = 12;
/**
 * Smallest possible serialised mailbox line, in bytes.
 *
 * `{"id":"","from":"","to":"","content":"","ts":0}` is 45 bytes, so any file whose
 * size is below `MAILBOX_MAX_LINES × this` provably holds fewer than
 * `MAILBOX_MAX_LINES` lines. That turns the per-append rotation check into a
 * single `stat` for every mailbox that is nowhere near its bound, instead of a
 * whole-file read on the hot append path.
 */
export const MAILBOX_MIN_LINE_BYTES = 40;
/* ------------------------------------------------------------------ errors */
/** A store-level failure: unreadable target, refused clobber, failed archive… */
export class FactoryStoreError extends FactoryError {
    constructor(message, code = 'store') {
        super(code, message);
        this.name = 'FactoryStoreError';
    }
}
/**
 * Derive the mailbox tri-state from the message timestamps:
 * `pending` = on disk, not yet accepted by the host inbox;
 * `delivered` = the host inbox accepted it; `read` = a model consumed it.
 */
export function mailboxStatus(message) {
    if (message.readAt !== undefined)
        return 'read';
    if (message.deliveredAt !== undefined)
        return 'delivered';
    return 'pending';
}
/** Structural guard for one mailbox line. */
export function isFactoryMessage(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const record = value;
    return (typeof record.id === 'string' &&
        typeof record.from === 'string' &&
        typeof record.to === 'string' &&
        typeof record.content === 'string' &&
        typeof record.ts === 'number' &&
        (record.deliveredAt === undefined || typeof record.deliveredAt === 'number') &&
        (record.readAt === undefined || typeof record.readAt === 'number'));
}
/** Current on-disk shape version of `artifacts.json`. */
export const ARTIFACTS_VERSION = 1;
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
export const FACTORY_SCHEMA_VERSION = 1;
/**
 * Schema version of a record that carries **no** `schemaVersion` field: every
 * `factory.json` written before versioning existed. Absence is a meaningful
 * value here, not a missing one — see {@link FactoryState.schemaVersion}.
 *
 * Declared in `state.ts` beside {@link migrateFactoryState} (the two are one
 * fact) and re-exported here, where the store's other versioning constants live.
 */
export { FACTORY_SCHEMA_VERSION_LEGACY } from './state.js';
/* ------------------------------------------------------------- the store */
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
export class FactoryStore {
    /** Absolute state root: `<workspace>/<stateDir>` — every factory lives under here. */
    root;
    /** Absolute workspace root. Used to resolve artifact paths and nothing else. */
    workspace;
    /** The state directory leaf (default `.code-factory`). */
    stateDir;
    /** Injected filesystem face. */
    primitives;
    /**
     * The workspace's cross-factory evolution ledger (`<root>/evolution.json`).
     *
     * Shares this store's root, filesystem face and clock, so a workspace has
     * exactly one in-process ledger instance — the same reason there is one store
     * instance per (workspace, stateDir) in `tools/context.ts`. The ledger is a
     * sibling of the factory directories: its lessons outlive any one factory.
     */
    evolution;
    /** Upper bound applied to every sanitised key. */
    maxKeyLength;
    clock;
    generateFactoryId;
    generateMessageId;
    malformedLineHandler;
    warningHandler;
    /** Store-level defaults for the cross-process factory lock. */
    fileLockOptions;
    /** Count of writes that were neither atomic nor flushed. See {@link degradedWriteCount}. */
    degradedWrites = 0;
    constructor(options = {}) {
        const { root, workspace, stateDir } = options;
        if (root === undefined && workspace === undefined) {
            throw new FactoryStoreError('FactoryStore needs either `root` or `workspace`');
        }
        this.stateDir = stateDir ?? DEFAULT_STATE_DIR;
        this.root = root !== undefined ? path.resolve(root) : path.resolve(workspace, this.stateDir);
        // When only `root` is given, the workspace is inferred as its parent: artifact
        // paths (the only thing the workspace is used for) are workspace-relative.
        this.workspace = path.resolve(workspace ?? path.dirname(this.root));
        this.primitives = options.primitives ?? nodeFilePrimitives;
        this.clock = options.now ?? Date.now;
        this.generateFactoryId = options.newFactoryId ?? (() => randomBytes(4).toString('hex'));
        this.generateMessageId = options.newMessageId ?? (() => randomUUID());
        this.malformedLineHandler = options.onMalformedLine;
        this.warningHandler = options.onWarning;
        this.maxKeyLength = options.maxKeyLength;
        this.fileLockOptions = options.fileLock;
        this.evolution = new EvolutionStore(this.root, {
            primitives: this.primitives,
            now: this.clock,
            onWarning: (code, message) => this.reportWarning(this.warningHandler, code, message),
        });
    }
    /** Current time according to the injected clock. */
    now() {
        return this.clock();
    }
    /**
     * How many writes this store performed without atomicity *and* a flush.
     *
     * Zero on a healthy run against the real filesystem. A non-zero value means
     * the durable state was written in a way a power loss can tear, so a caller
     * that surfaces health (the cockpit, a doctor command) should show it instead
     * of reporting a green state that was never actually safe on disk.
     */
    get degradedWriteCount() {
        return this.degradedWrites;
    }
    /* ----------------------------------------------------------- path access */
    /** Lock key to pass to `withFactoryLock` for this factory. */
    lockKey(factoryId) {
        return `${FACTORY_LOCK_PREFIX}${this.assertSafeFactoryId(factoryId)}`;
    }
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
    async withLock(factoryId, fn, options = {}) {
        const id = this.assertSafeFactoryId(factoryId);
        const key = this.lockKey(id);
        return await withFactoryLock(key, async () => await withFactoryFileLock(this.root, id, key, async () => await fn(), {
            ...(options.fileLock ?? {}),
            ...(this.fileLockOptions ?? {}),
            ...(options.onFileLockWait === undefined ? {} : { onWait: options.onFileLockWait }),
        }), {
            ...(options.lockOptions ?? {}),
            // `withLock` is the one frame that knows both the machine key and what it
            // stands for, so it is the one frame that can answer the reviewer's
            // "锁错误只带 key，不带人类可读的工厂身份" complaint (S2). An explicitly
            // supplied `subject` still wins — a caller that knows more says more.
            subject: options.lockOptions?.subject ?? `工厂 ${id}`,
        });
    }
    /** `<root>/<factoryId>`. Throws `FactoryPathError` on an unsafe id. */
    factoryDir(factoryId) {
        const id = this.assertSafeFactoryId(factoryId);
        const dir = path.join(this.root, id);
        assertInside(this.root, dir, `factory directory for ${JSON.stringify(factoryId)}`);
        return dir;
    }
    /** `<root>/<factoryId>/factory.json`. */
    factoryFile(factoryId) {
        return path.join(this.factoryDir(factoryId), FACTORY_FILE);
    }
    /** `<root>/<factoryId>/inbox`. */
    inboxDir(factoryId) {
        return path.join(this.factoryDir(factoryId), INBOX_DIR);
    }
    /** `<root>/<factoryId>/inbox/<sanitizedKey>.jsonl`. */
    mailboxFile(factoryId, key) {
        const dir = this.inboxDir(factoryId);
        const file = path.join(dir, `${this.mailboxKey(key)}.jsonl`);
        assertInside(dir, file, `mailbox for ${JSON.stringify(key)}`);
        return file;
    }
    /**
     * `<root>/<factoryId>/inbox/<sanitizedKey>.jsonl.1` — the rotated generation.
     *
     * The mailbox path is built first, so this inherits its containment proof and
     * cannot escape the inbox directory even for a hostile key.
     */
    mailboxArchiveFile(factoryId, key) {
        return `${this.mailboxFile(factoryId, key)}${MAILBOX_ARCHIVE_SUFFIX}`;
    }
    /** `<root>/<factoryId>/artifacts.json`. */
    artifactsFile(factoryId) {
        return path.join(this.factoryDir(factoryId), ARTIFACTS_FILE);
    }
    /** `<root>/archive/<factoryId>`. */
    archiveDir(factoryId) {
        const id = this.assertSafeFactoryId(factoryId);
        const dir = path.join(this.root, ARCHIVE_DIR, id);
        assertInside(this.root, dir, `archive directory for ${JSON.stringify(factoryId)}`);
        return dir;
    }
    /**
     * Resolve a workspace-relative POSIX path, refusing anything that escapes the
     * workspace (absolute paths, drive letters, `..` segments).
     */
    workspacePath(relativePath) {
        if (typeof relativePath !== 'string' || relativePath.trim() === '') {
            throw new FactoryPathError('artifact path must be a non-empty workspace-relative string');
        }
        const normalized = relativePath.replace(/\\/g, '/');
        if (path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
            throw new FactoryPathError(`artifact path must be workspace-relative, got ${JSON.stringify(relativePath)}`);
        }
        const resolved = path.resolve(this.workspace, normalized);
        assertInside(this.workspace, resolved, `artifact path ${JSON.stringify(relativePath)}`);
        return resolved;
    }
    /** The sanitised mailbox file stem for a human key (role id, `captain`, …). */
    mailboxKey(key) {
        if (typeof key !== 'string' || key.trim() === '') {
            throw new FactoryPathError('mailbox key must be a non-empty string');
        }
        const sanitized = sanitizeKey(key, { maxLength: this.maxKeyLength, fallbackPrefix: 'm' });
        if (!isSafeKey(sanitized)) {
            throw new FactoryPathError(`cannot derive a safe mailbox key from ${JSON.stringify(key)}`);
        }
        return sanitized;
    }
    /* ---------------------------------------------------------- factory CRUD */
    /**
     * Open a new factory record. Creates the directory, an empty inbox and an
     * empty artifact registry, then writes `factory.json`.
     *
     * @throws FactoryStoreError when the id is already taken and `overwrite` is not set.
     */
    async create(input, options = {}) {
        const id = input.id !== undefined ? this.assertSafeFactoryId(input.id) : this.generateFactoryId();
        if (!isSafeFactoryId(id))
            throw new FactoryPathError(`generated an unsafe factory id: ${JSON.stringify(id)}`);
        if (typeof input.brief !== 'string' || input.brief.trim() === '') {
            throw new FactoryStateError('create() needs a non-empty `brief`');
        }
        if (typeof input.captainSessionId !== 'string' || input.captainSessionId.trim() === '') {
            throw new FactoryStateError('create() needs a non-empty `captainSessionId`');
        }
        if ((await this.pathExists(this.factoryDir(id))) && options.overwrite !== true) {
            throw new FactoryStoreError(`factory ${id} already exists at ${this.factoryDir(id)}`);
        }
        const now = this.now();
        const state = {
            id,
            name: input.name ?? defaultName(input.brief),
            brief: input.brief,
            taskType: input.taskType,
            pipeline: input.pipeline,
            captainSessionId: input.captainSessionId,
            phase: input.phase ?? 'staged',
            securityTriggered: input.securityTriggered ?? false,
            ...(input.securityHits === undefined ? {} : { securityHits: [...input.securityHits] }),
            ...(input.securitySource === undefined ? {} : { securitySource: input.securitySource }),
            members: (input.members ?? []).map(toMemberState),
            stages: (input.stages ?? []).map(toStageStateRec),
            dod: [],
            createdAt: input.createdAt ?? now,
            updatedAt: now,
        };
        if (input.planReviewState !== undefined)
            state.planReviewState = input.planReviewState;
        await this.primitives.mkdir(this.inboxDir(id), { recursive: true });
        const saved = await this.save(state, { touch: false });
        await this.writeArtifacts(id, [], now);
        // Return what was actually persisted, not the pre-stamp literal: a caller
        // holding the returned record and the record on disk must not disagree about
        // `schemaVersion` (M8).
        return saved;
    }
    /** Read one factory record. `undefined` when `factory.json` does not exist. */
    async load(factoryId) {
        const file = this.factoryFile(factoryId);
        let text;
        try {
            text = await this.readText(file);
        }
        catch (error) {
            if (isNotFound(error))
                return undefined;
            throw new FactoryStateError(`cannot read ${file}: ${describeError(error)}`);
        }
        return parseFactoryState(text, file, this.warningHandler);
    }
    /** Like {@link load} but throws when the factory is missing. */
    async loadOrThrow(factoryId) {
        const state = await this.load(factoryId);
        if (!state)
            throw new FactoryStoreError(`no factory ${factoryId} under ${this.root}`, 'not_found');
        return state;
    }
    /** True when `<root>/<factoryId>/factory.json` exists. */
    async exists(factoryId) {
        const file = this.factoryFile(factoryId);
        try {
            await this.primitives.stat(file);
            return true;
        }
        catch (error) {
            if (isNotFound(error))
                return false;
            throw new FactoryStoreError(`cannot stat ${file}: ${describeError(error)}`);
        }
    }
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
    async save(state, options = {}) {
        const id = this.assertSafeFactoryId(state.id);
        const touched = options.touch === false ? state : { ...state, updatedAt: this.now() };
        const next = { ...touched, schemaVersion: FACTORY_SCHEMA_VERSION };
        const write = async () => {
            await this.writeJson(this.factoryFile(id), next);
            return next;
        };
        return options.lock === true ? await this.withLock(id, write) : await write();
    }
    /**
     * Lock, load, mutate in place, save. The safe default for any state change.
     *
     * `fn` receives the freshly loaded, mutable record. Returning early throws
     * nothing away: if `fn` throws, nothing is written.
     */
    async mutate(factoryId, fn, options = {}) {
        const run = async () => {
            const state = await this.loadOrThrow(factoryId);
            const value = await fn(state);
            if (options.save === false)
                return { value, state, changed: false };
            state.updatedAt = this.now();
            const saved = await this.save(state, { touch: false });
            return { value, state: saved, changed: true };
        };
        if (options.lock === false)
            return await run();
        return await this.withLock(factoryId, run, options.lockOptions === undefined ? {} : { lockOptions: options.lockOptions });
    }
    /** Compact listing of every factory under `root` (or under `archive`). */
    async list(options = {}) {
        const archived = options.archived === true;
        const base = archived ? path.join(this.root, ARCHIVE_DIR) : this.root;
        const warn = options.onWarning ?? this.warningHandler;
        let names;
        try {
            names = await this.primitives.readdir(base);
        }
        catch (error) {
            if (isNotFound(error))
                return [];
            throw new FactoryStoreError(`cannot list ${base}: ${describeError(error)}`);
        }
        const summaries = [];
        for (const name of names) {
            if (!archived && name === ARCHIVE_DIR)
                continue;
            if (!isSafeKey(name) || !isSafeFactoryId(name))
                continue;
            const file = path.join(base, name, FACTORY_FILE);
            let text;
            try {
                text = await this.readText(file);
            }
            catch (error) {
                if (isNotFound(error))
                    continue;
                this.reportWarning(warn, 'factory-unreadable', `cannot read ${file}: ${describeError(error)}`, error);
                continue;
            }
            try {
                const state = parseFactoryState(text, file, warn);
                summaries.push(summarize(state, archived ? this.archiveDir(name) : this.factoryDir(name), archived));
            }
            catch (error) {
                // One corrupt factory must not hide the rest of the list.
                this.reportWarning(warn, 'factory-corrupt', `${file}: ${describeError(error)}`, error);
            }
        }
        summaries.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
        return summaries;
    }
    /**
     * Move `<root>/<factoryId>` to `<root>/archive/<factoryId>`.
     * Tries a same-volume `rename` first and degrades to copy+delete.
     *
     * Takes the factory lock (both layers), because moving the directory out from
     * under a concurrent writer is how a half-written factory.json ends up in
     * `archive/`. The lock file lives in `<root>/.locks/`, never inside the factory
     * directory, so the move cannot carry it away.
     */
    async archive(factoryId, options = {}) {
        const id = this.assertSafeFactoryId(factoryId);
        const move = async () => {
            const from = this.factoryDir(id);
            const to = this.archiveDir(id);
            if (!(await this.pathExists(from))) {
                throw new FactoryStoreError(`no factory ${id} to archive at ${from}`, 'not_found');
            }
            if (await this.pathExists(to)) {
                if (options.overwrite !== true) {
                    throw new FactoryStoreError(`archive target ${to} already exists (pass { overwrite: true } to replace it)`);
                }
                await this.primitives.rm(to, { recursive: true, force: true });
            }
            await this.primitives.mkdir(path.dirname(to), { recursive: true });
            try {
                await this.primitives.rename(from, to);
                return { id, from, to, method: 'rename' };
            }
            catch (renameError) {
                try {
                    await this.primitives.cp(from, to, { recursive: true });
                    await this.primitives.rm(from, { recursive: true, force: true });
                    return { id, from, to, method: 'copy' };
                }
                catch (copyError) {
                    throw new AggregateError([renameError, copyError], `cannot archive factory ${id} from ${from} to ${to}`);
                }
            }
        };
        return options.lock === false ? await move() : await this.withLock(id, move);
    }
    /**
     * Delete a factory directory (live root by default, archive with
     * `{ archived: true }`). Returns false when there was nothing to delete.
     *
     * Takes the factory lock for the same reason {@link FactoryStore.archive} does.
     */
    async remove(factoryId, options = {}) {
        const id = this.assertSafeFactoryId(factoryId);
        const drop = async () => {
            const dir = options.archived === true ? this.archiveDir(id) : this.factoryDir(id);
            if (!(await this.pathExists(dir)))
                return false;
            await this.primitives.rm(dir, { recursive: true, force: true });
            return true;
        };
        return options.lock === false ? await drop() : await this.withLock(id, drop);
    }
    /* ------------------------------------------------------------- artifacts */
    /** Every registered artifact, oldest first. */
    async listArtifacts(factoryId, onWarning) {
        const file = this.artifactsFile(factoryId);
        let text;
        try {
            text = await this.readText(file);
        }
        catch (error) {
            if (isNotFound(error))
                return [];
            throw new FactoryStoreError(`cannot read ${file}: ${describeError(error)}`);
        }
        return parseArtifacts(text, file, onWarning ?? this.warningHandler);
    }
    /** Registered artifacts of one stage (all stages when omitted), oldest first. */
    async readStageArtifacts(factoryId, stage) {
        const artifacts = await this.listArtifacts(factoryId);
        const filtered = stage === undefined ? artifacts : artifacts.filter((artifact) => artifact.stage === stage);
        return filtered.slice().sort((a, b) => a.at - b.at);
    }
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
    async registerArtifact(factoryId, input, options = {}) {
        const id = this.assertSafeFactoryId(factoryId);
        const absolute = this.workspacePath(input.path);
        if (typeof input.by !== 'string' || input.by.trim() === '') {
            throw new FactoryStateError('registerArtifact() needs a non-empty `by` role id');
        }
        if (typeof input.stage !== 'string' || input.stage.trim() === '') {
            throw new FactoryStateError('registerArtifact() needs a non-empty `stage` id');
        }
        const warn = options.onWarning ?? this.warningHandler;
        const relative = input.path.replace(/\\/g, '/').replace(/^\.\//, '');
        const perform = async () => {
            let bytes = input.bytes;
            if (bytes === undefined) {
                try {
                    bytes = (await this.primitives.stat(absolute)).size;
                }
                catch (error) {
                    bytes = 0;
                    this.reportWarning(warn, 'artifact-missing', `artifact ${relative} cannot be stat'ed: ${describeError(error)}`, error);
                }
            }
            const record = {
                path: relative,
                by: input.by,
                stage: input.stage,
                bytes,
                at: this.now(),
            };
            const existing = await this.listArtifacts(id, warn);
            const index = existing.findIndex((artifact) => artifact.path === record.path);
            if (index >= 0)
                existing[index] = record;
            else
                existing.push(record);
            await this.writeArtifacts(id, existing, record.at);
            return record;
        };
        return options.lock === true ? await this.withLock(id, perform) : await perform();
    }
    /* --------------------------------------------------------------- mailbox */
    /**
     * Append one message to `<root>/<factoryId>/inbox/<key>.jsonl`.
     *
     * The line is written with `O_APPEND` and contains no raw newline
     * (`JSON.stringify` escapes them), so concurrent appends cannot interleave
     * mid-line. The message starts its life in the `pending` state: `deliveredAt`
     * and `readAt` are unset until {@link markDelivered} / {@link markRead}.
     */
    async mail(factoryId, input) {
        const id = this.assertSafeFactoryId(factoryId);
        if (typeof input.to !== 'string' || input.to.trim() === '') {
            throw new FactoryStateError('mail() needs a non-empty `to`');
        }
        if (typeof input.from !== 'string' || input.from.trim() === '') {
            throw new FactoryStateError('mail() needs a non-empty `from`');
        }
        if (typeof input.content !== 'string') {
            throw new FactoryStateError('mail() needs string `content`');
        }
        const message = {
            id: input.id ?? this.generateMessageId(),
            from: input.from,
            to: input.to,
            content: input.content,
            ts: input.ts ?? this.now(),
            // `FactoryMessage` is a readonly contract: undefined optional fields are
            // omitted by JSON.stringify, which is exactly the tri-state we want.
            kind: input.kind,
            stage: input.stage,
            round: input.round,
            deliveredAt: input.deliveredAt,
            readAt: input.readAt,
        };
        const file = this.mailboxFile(id, input.to);
        await this.primitives.mkdir(path.dirname(file), { recursive: true });
        await this.primitives.appendFile(file, `${JSON.stringify(message)}\n`, { encoding: 'utf8', flag: 'a' });
        await this.rotateMailboxIfNeeded(id, input.to);
        return message;
    }
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
    async readMailbox(factoryId, key, options = {}) {
        const file = this.mailboxFile(factoryId, key);
        const limit = options.limit;
        const bounded = limit !== undefined && Number.isFinite(limit) && limit >= 0;
        const finish = (messages) => {
            if (!bounded)
                return messages;
            return messages.length > limit ? messages.slice(messages.length - limit) : messages;
        };
        if (bounded && limit > 0 && this.primitives.readTail) {
            const budget = Math.max(MAILBOX_TAIL_FLOOR_BYTES, limit * MAILBOX_LINE_BUDGET_BYTES);
            let tail;
            try {
                tail = await this.primitives.readTail(file, budget);
            }
            catch (error) {
                if (isNotFound(error))
                    return [];
                // A tail read is an optimisation: any failure falls back to a full read
                // rather than failing the call. The public failure mode stays the same.
                tail = undefined;
            }
            if (tail !== undefined) {
                // The slice may begin mid-line. Dropping everything before the first
                // newline loses at most one partial line, and only when the message that
                // line belongs to is outside the requested window anyway.
                const whole = tail.startsWith('{') || tail.startsWith('\ufeff') ? tail : tail.slice(tail.indexOf('\n') + 1);
                const parsed = this.parseMailboxLines(file, whole, options.onMalformedLine)
                    .map((entry) => entry.message)
                    .filter((message) => message !== undefined)
                    .filter((message) => options.unreadOnly !== true || message.readAt === undefined);
                if (parsed.length >= limit)
                    return finish(parsed);
            }
        }
        let text;
        try {
            text = await this.readText(file);
        }
        catch (error) {
            if (isNotFound(error))
                return [];
            throw new FactoryStoreError(`cannot read mailbox ${file}: ${describeError(error)}`);
        }
        let messages = this.parseMailboxLines(file, text, options.onMalformedLine)
            .map((entry) => entry.message)
            .filter((message) => message !== undefined);
        if (options.unreadOnly === true)
            messages = messages.filter((message) => message.readAt === undefined);
        return finish(messages);
    }
    /** Messages nobody has consumed yet. */
    async listUnread(factoryId, key, options = {}) {
        return await this.readMailbox(factoryId, key, { ...options, unreadOnly: true });
    }
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
    async consumeMailbox(factoryId, key, options = {}) {
        const id = this.assertSafeFactoryId(factoryId);
        return await this.withLock(id, async () => {
            const messages = await this.readMailbox(id, key, options.read ?? {});
            let markedRead = 0;
            if (options.markRead !== false) {
                const unread = messages.filter((message) => message.readAt === undefined).map((message) => message.id);
                if (unread.length > 0)
                    markedRead = await this.markRead(id, key, unread);
            }
            const remainingUnread = (await this.readMailbox(id, key, { unreadOnly: true })).length;
            return { messages, markedRead, remainingUnread };
        });
    }
    /** Mailbox file stems that exist for this factory (sorted). */
    async inboxKeys(factoryId) {
        const dir = this.inboxDir(factoryId);
        let names;
        try {
            names = await this.primitives.readdir(dir);
        }
        catch (error) {
            if (isNotFound(error))
                return [];
            throw new FactoryStoreError(`cannot list mailbox directory ${dir}: ${describeError(error)}`);
        }
        return names
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => name.slice(0, -'.jsonl'.length))
            .filter((key) => isSafeKey(key))
            .sort();
    }
    /**
     * Every message of every inbox, oldest first — the cockpit's live feed.
     * `limit` keeps the newest N (still returned oldest-first).
     *
     * Two bounds keep this from degenerating on a long-lived factory: each inbox is
     * read through {@link readMailbox}'s tail path, and once a factory has more
     * inboxes than a full team could produce the feed reads only the most recently
     * written ones. The prune is reported, never silent.
     */
    async readAllMessages(factoryId, options = {}) {
        const keys = await this.inboxKeys(factoryId);
        const limit = options.limit;
        const bounded = limit !== undefined && Number.isFinite(limit) && limit >= 0;
        const selected = await this.feedInboxKeys(factoryId, keys, options.onWarning);
        const collected = [];
        for (const key of selected) {
            collected.push(...(await this.readMailbox(factoryId, key, {
                unreadOnly: options.unreadOnly,
                onMalformedLine: options.onMalformedLine,
                ...(bounded ? { limit: limit + 1 } : {}),
            })));
        }
        collected.sort((a, b) => a.ts - b.ts);
        if (bounded && collected.length > limit)
            return collected.slice(collected.length - limit);
        return collected;
    }
    /**
     * Choose which inboxes the feed reads.
     *
     * Below {@link MAILBOX_FEED_MAX_INBOXES} every inbox is read, which is the
     * correct answer. Above it the most recently written ones win — an inbox nobody
     * has appended to in a long time cannot hold the newest feed entries — and the
     * drop is reported through the warning sink.
     */
    async feedInboxKeys(factoryId, keys, onWarning) {
        if (keys.length <= MAILBOX_FEED_MAX_INBOXES)
            return keys;
        const stamped = [];
        for (const key of keys) {
            let mtimeMs = 0;
            try {
                const info = await this.primitives.stat(this.mailboxFile(factoryId, key));
                mtimeMs = info.mtimeMs ?? 0;
            }
            catch (error) {
                // An inbox we cannot stat is kept (0 sorts last but is never dropped for
                // being unreadable) — losing messages to a permissions error would be
                // exactly the silent failure this bound exists to avoid. The failure is
                // also reported, so "this inbox is unreadable" cannot be mistaken for
                // "this inbox is empty" by whoever reads the store's warnings.
                if (!isNotFound(error)) {
                    this.reportWarning(onWarning ?? this.warningHandler, 'mailbox-unreadable', `factory ${factoryId} inbox ${key} cannot be stat'ed: ${describeError(error)}`, error);
                    stamped.push({ key, mtimeMs: Number.POSITIVE_INFINITY });
                }
                continue;
            }
            stamped.push({ key, mtimeMs });
        }
        stamped.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const kept = stamped.slice(0, MAILBOX_FEED_MAX_INBOXES).map((entry) => entry.key);
        const dropped = stamped.length - kept.length;
        if (dropped > 0) {
            this.reportWarning(onWarning ?? this.warningHandler, 'mailbox-feed-pruned', `factory ${factoryId} has ${stamped.length} inboxes; the feed read the ${kept.length} most recently written and skipped ${dropped} (${stamped
                .slice(MAILBOX_FEED_MAX_INBOXES)
                .map((entry) => entry.key)
                .join(', ')})`);
        }
        return kept;
    }
    /**
     * Mark messages as `delivered` (the host inbox accepted them).
     *
     * @param ids explicit message ids, or the literal `'all'`.
     * @returns how many messages actually changed state.
     */
    async markDelivered(factoryId, key, ids, options = {}) {
        return await this.patchMailbox(factoryId, key, ids, (message, at) => (message.deliveredAt !== undefined ? undefined : { ...message, deliveredAt: at }), options);
    }
    /**
     * Mark messages as `read` (a model consumed them). A message that was never
     * marked delivered is stamped with both timestamps: consumption implies
     * delivery.
     *
     * @param ids explicit message ids, or the literal `'all'`.
     * @returns how many messages actually changed state.
     */
    async markRead(factoryId, key, ids, options = {}) {
        return await this.patchMailbox(factoryId, key, ids, (message, at) => message.readAt !== undefined
            ? undefined
            : { ...message, readAt: at, deliveredAt: message.deliveredAt ?? at }, options);
    }
    /* ------------------------------------------------------------- internals */
    /** Read-modify-write one mailbox file, preserving unparsable lines verbatim. */
    async patchMailbox(factoryId, key, ids, patch, options) {
        const id = this.assertSafeFactoryId(factoryId);
        const file = this.mailboxFile(id, key);
        const perform = async () => {
            let text;
            try {
                text = await this.readText(file);
            }
            catch (error) {
                if (isNotFound(error))
                    return 0;
                throw new FactoryStoreError(`cannot read mailbox ${file}: ${describeError(error)}`);
            }
            const wanted = ids === 'all' ? undefined : new Set(ids);
            const at = this.now();
            const lines = [];
            let changed = 0;
            for (const entry of this.parseMailboxLines(file, text, options.onMalformedLine)) {
                const message = entry.message;
                if (!message || (wanted !== undefined && !wanted.has(message.id))) {
                    lines.push(entry.raw);
                    continue;
                }
                const patched = patch(message, at);
                if (!patched) {
                    lines.push(entry.raw);
                    continue;
                }
                lines.push(JSON.stringify(patched));
                changed += 1;
            }
            if (changed === 0)
                return 0;
            await this.writeText(file, `${lines.join('\n')}\n`);
            return changed;
        };
        return options.lock === true ? await this.withLock(id, perform) : await perform();
    }
    /** Parse `.jsonl` text, reporting (and preserving) every line that cannot be used. */
    parseMailboxLines(file, text, handler) {
        const report = handler ?? this.malformedLineHandler;
        const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
        const raw = body.split(/\r?\n/);
        const entries = [];
        for (const [index, line] of raw.entries()) {
            // Blank lines (including the trailing newline of a healthy file) are not data.
            if (line.trim() === '')
                continue;
            const lineNumber = index + 1;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch (error) {
                this.reportMalformed(report, {
                    file,
                    line: lineNumber,
                    raw: truncate(line, 500),
                    error: describeError(error),
                });
                entries.push({ line: lineNumber, raw: line });
                continue;
            }
            if (!isFactoryMessage(parsed)) {
                this.reportMalformed(report, {
                    file,
                    line: lineNumber,
                    raw: truncate(line, 500),
                    error: 'not a factory message record (needs string id/from/to/content and numeric ts)',
                });
                entries.push({ line: lineNumber, raw: line });
                continue;
            }
            entries.push({ line: lineNumber, raw: line, message: parsed });
        }
        return entries;
    }
    async writeArtifacts(factoryId, artifacts, updatedAt) {
        const envelope = { version: ARTIFACTS_VERSION, updatedAt, artifacts };
        await this.writeJson(this.artifactsFile(factoryId), envelope);
    }
    /** Atomic JSON write: temp file in the same directory, rename, direct fallback. */
    async writeJson(file, value) {
        return await this.writeText(file, `${JSON.stringify(value, null, 2)}\n`);
    }
    async writeText(file, content) {
        const report = await replaceFileAtomicOrDirect(temporaryPathFor(file), file, content, this.primitives, {
            onRetry: (error, attempt) => {
                this.reportWarning(this.warningHandler, 'atomic-rename-retry', `rename onto ${file} failed (attempt ${attempt}): ${describeError(error)}`, error);
            },
            onFallback: (error) => {
                this.reportWarning(this.warningHandler, 'atomic-rename-fallback', `falling back to a direct overwrite of ${file}: ${describeError(error)}`, error);
            },
            onCleanupError: (error) => {
                this.reportWarning(this.warningHandler, 'atomic-cleanup', `cannot remove temp file for ${file}: ${describeError(error)}`, error);
            },
        });
        // A write that is not both atomic and flushed is a real risk to durable state
        // (a power loss can tear it), so it is counted and reported here rather than
        // being left in the returned report for a caller to notice.
        if (!isDurableWrite(report)) {
            this.degradedWrites += 1;
            const why = report.strategy === 'direct'
                ? 'the rename path gave up and the target was rewritten in place'
                : report.durability === 'unsupported'
                    ? (report.durabilityNote ?? 'the injected primitives cannot flush to disk')
                    : (report.durabilityNote ?? `the flush reported "${report.durability}"`);
            this.reportWarning(this.warningHandler, report.strategy === 'direct' ? 'atomic-write-degraded' : 'write-not-flushed', `${file} was written non-durably (${why}); a power loss can tear or lose it`);
        }
        return report;
    }
    async readText(file) {
        const text = await this.primitives.readFile(file, { encoding: 'utf8' });
        return typeof text === 'string' ? text : String(text);
    }
    /** True when anything exists at `target` (file or directory). */
    async pathExists(target) {
        try {
            await this.primitives.stat(target);
            return true;
        }
        catch (error) {
            if (isNotFound(error))
                return false;
            throw new FactoryStoreError(`cannot stat ${target}: ${describeError(error)}`);
        }
    }
    /** Canonical, traversal-free factory id — or a `FactoryPathError`. */
    assertSafeFactoryId(factoryId) {
        if (!isSafeFactoryId(factoryId)) {
            throw new FactoryPathError(`unsafe factory id ${JSON.stringify(factoryId)}: expected /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/`);
        }
        const sanitized = sanitizeKey(factoryId, { maxLength: this.maxKeyLength, fallbackPrefix: 'f' });
        if (sanitized !== factoryId) {
            throw new FactoryPathError(`factory id ${JSON.stringify(factoryId)} is not canonical (sanitizeKey would produce ${JSON.stringify(sanitized)})`);
        }
        return sanitized;
    }
    /**
     * Report a non-fatal store condition through the store-level warning sink.
     *
     * Used by the mailbox bound: rotation and feed pruning are normal outcomes of a
     * long-lived factory, and a caller that never hears about them cannot tell a
     * bounded mailbox from a truncated one.
     */
    warnStore(code, message) {
        this.reportWarning(this.warningHandler, code, message);
    }
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
    async rotateMailboxIfNeeded(factoryId, key) {
        const file = this.mailboxFile(factoryId, key);
        /*
         * The append path calls this on every message, so it must be cheap in the
         * common case. A file below the provable line floor is returned on the stat
         * alone — see MAILBOX_MIN_LINE_BYTES for why that inference is sound.
         */
        let size;
        try {
            size = (await this.primitives.stat(file)).size;
        }
        catch (error) {
            if (isNotFound(error))
                return;
            throw new FactoryStoreError(`cannot rotate mailbox ${file}: ${describeError(error)}`);
        }
        const provablyUnderLineCap = size < MAILBOX_MAX_LINES * MAILBOX_MIN_LINE_BYTES;
        if (size <= MAILBOX_MAX_BYTES && provablyUnderLineCap)
            return;
        let text;
        try {
            text = await this.readText(file);
        }
        catch (error) {
            if (isNotFound(error))
                return;
            throw new FactoryStoreError(`cannot rotate mailbox ${file}: ${describeError(error)}`);
        }
        const entries = this.parseMailboxLines(file, text);
        if (size <= MAILBOX_MAX_BYTES && entries.length <= MAILBOX_MAX_LINES)
            return;
        const consumed = entries.filter((entry) => entry.message?.readAt !== undefined);
        let live = entries.filter((entry) => entry.message?.readAt === undefined);
        let overflow = [];
        if (live.length > MAILBOX_MAX_LINES) {
            overflow = live.slice(0, live.length - MAILBOX_MAX_LINES);
            live = live.slice(live.length - MAILBOX_MAX_LINES);
        }
        const archived = [...consumed, ...overflow];
        if (archived.length > 0)
            await this.appendToArchive(factoryId, key, archived);
        // Write even when nothing remains: an empty live file is the point of the
        // rotation, and leaving the old bytes in place would undo it.
        await this.writeText(file, live.length === 0 ? '' : `${live.map((entry) => entry.raw).join('\n')}\n`);
        if (overflow.length > 0) {
            this.warnStore('mailbox-overflow', `mailbox ${key} of factory ${factoryId} held ${entries.length} lines with nothing consumed; kept the newest ${live.length} and archived ${overflow.length} older ones`);
        }
    }
    /**
     * Append lines to the rotated generation, trimming the oldest when it is full.
     *
     * The trim is computed in one pass over the byte sizes rather than by repeated
     * string slicing, so appending to a 4 MiB archive does not become quadratic.
     */
    async appendToArchive(factoryId, key, entries) {
        if (entries.length === 0)
            return;
        const archive = this.mailboxArchiveFile(factoryId, key);
        let existing = '';
        try {
            existing = await this.readText(archive);
        }
        catch (error) {
            if (!isNotFound(error)) {
                throw new FactoryStoreError(`cannot read mailbox archive ${archive}: ${describeError(error)}`);
            }
        }
        const lines = existing === '' ? [] : existing.split(/\r?\n/).filter((line) => line.trim() !== '');
        for (const entry of entries)
            lines.push(entry.raw);
        const sizes = lines.map((line) => Buffer.byteLength(line, 'utf8') + 1);
        let total = sizes.reduce((sum, size) => sum + size, 0);
        let start = 0;
        // Drop whole lines from the front until the archive fits, keeping at least the
        // newest line. Iterating `sizes` directly (rather than indexing it by `start`)
        // keeps this branch-free under `noUncheckedIndexedAccess`: there is no slot the
        // compiler has to take on trust.
        for (const size of sizes) {
            if (total <= MAILBOX_ARCHIVE_MAX_BYTES)
                break;
            if (start + 1 >= lines.length)
                break;
            total -= size;
            start += 1;
        }
        await this.writeText(archive, `${lines.slice(start).join('\n')}\n`);
        if (start > 0) {
            this.warnStore('mailbox-archive-trimmed', `mailbox archive ${key}.jsonl${MAILBOX_ARCHIVE_SUFFIX} of factory ${factoryId} reached its ${MAILBOX_ARCHIVE_MAX_BYTES}-byte cap; dropped the ${start} oldest consumed line(s)`);
        }
    }
    reportWarning(handler, code, message, error) {
        if (!handler)
            return;
        try {
            const warning = error === undefined ? { code, message } : { code, message, error };
            handler(warning);
        }
        catch {
            /* diagnostics must never break the store */
        }
    }
    reportMalformed(handler, info) {
        if (!handler)
            return;
        try {
            handler(info);
        }
        catch {
            /* a broken reporter must not take the factory down */
        }
    }
}
/* --------------------------------------------------------------- helpers */
/** Reject any path that does not stay strictly inside `base`. */
function assertInside(base, target, what) {
    const relative = path.relative(base, target);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new FactoryPathError(`${what} escapes ${base}: ${target}`);
    }
}
function toMemberState(member) {
    if (typeof member === 'string')
        return { role: member, status: 'staged', tokens: 0 };
    const state = {
        role: member.role,
        status: member.status ?? 'staged',
        tokens: 0,
    };
    if (member.currentStage !== undefined)
        state.currentStage = member.currentStage;
    if (member.sessionId !== undefined)
        state.sessionId = member.sessionId;
    if (member.provider !== undefined)
        state.provider = member.provider;
    if (member.model !== undefined)
        state.model = member.model;
    if (member.reasoningEffort !== undefined)
        state.reasoningEffort = member.reasoningEffort;
    return state;
}
function toStageStateRec(stage) {
    if (typeof stage === 'string')
        return { id: stage, status: 'pending', round: 0, attempts: 0 };
    return {
        id: stage.id,
        status: stage.status ?? 'pending',
        round: stage.round ?? 0,
        attempts: stage.attempts ?? 0,
    };
}
/** First non-empty line of the brief, clipped — the cockpit needs a short title. */
function defaultName(brief) {
    const firstLine = brief.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? '未命名任务';
    return truncate(firstLine, 80);
}
function truncate(value, max) {
    return value.length <= max ? value : `${value.slice(0, max)}…`;
}
function describeError(error) {
    if (error instanceof Error) {
        const code = error.code;
        return typeof code === 'string' ? `${code}: ${error.message}` : error.message;
    }
    return String(error);
}
function isNotFound(error) {
    const code = error?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
}
/**
 * Parse `factory.json`, refusing anything that is not a factory record.
 *
 * Version policy (review finding M8) — every branch is deliberate:
 *  - **absent** → {@link FACTORY_SCHEMA_VERSION_LEGACY}: written before
 *    versioning existed, so it is walked forward by the migration chain instead
 *    of being rejected. Breaking every existing record would be worse than the
 *    bug this closes.
 *  - **equal** → used as-is.
 *  - **greater** → a record from a newer plugin. Refuse loudly
 *    ({@link FactorySchemaVersionError}) naming the file, the version found and
 *    the version this build understands: interpreting it under this build's
 *    schema is the silent misread this finding is about.
 *  - **smaller** → migrate forward.
 *  - **not a number** → refuse, never coerce.
 */
function parseFactoryState(text, file, onWarning) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        throw new FactoryStateError(`${file} is not valid JSON: ${describeError(error)}`);
    }
    if (!isFactoryState(parsed)) {
        throw new FactoryStateError(`${file} is not a valid factory record (missing id/name/brief/taskType/pipeline/captainSessionId/phase/members/stages/dod)`);
    }
    const rawVersion = parsed.schemaVersion;
    // Check and normalisation are one call on purpose: the version is never
    // validated on one line and re-derived on the next.
    const version = assertSupportedSchemaVersion(rawVersion, file, FACTORY_SCHEMA_VERSION, FACTORY_SCHEMA_VERSION_LEGACY);
    const migrated = migrateFactoryState(parsed, version, FACTORY_SCHEMA_VERSION);
    return normalizeSecurityVerdict(normalizeDispatchAttempts(migrated, file, onWarning), file, onWarning);
}
/**
 * Drop malformed entries from the durable dispatch ledger (review finding M13).
 *
 * The ledger now lives inside `factory.json`, which makes it part of every
 * hand-edit, every restored backup and every truncated file. A junk entry must
 * never reach the scheduler: it dereferences `attempt.settledAt` on the newest
 * entry per (stage, role), so one non-object would take the whole dispatch path
 * down. Malformed entries are therefore removed **and reported** — dropping them
 * silently would make a corrupted ledger look like a factory that never dispatched.
 */
function normalizeDispatchAttempts(state, file, onWarning) {
    const raw = state.dispatchAttempts;
    if (raw === undefined)
        return state;
    if (!Array.isArray(raw)) {
        reportParseWarning(onWarning, 'dispatch-ledger-invalid', `${file}: dispatchAttempts is not an array - the dispatch ledger was discarded`);
        const { dispatchAttempts: _dropped, ...rest } = state;
        return rest;
    }
    const kept = [];
    let dropped = 0;
    for (const item of raw) {
        if (typeof item !== 'object' || item === null) {
            dropped += 1;
            continue;
        }
        const record = item;
        const { stageId, round, role, dispatchedAt, kind, sessionId, settledAt } = record;
        if (typeof stageId !== 'string' ||
            typeof round !== 'number' ||
            typeof role !== 'string' ||
            typeof dispatchedAt !== 'number' ||
            (kind !== 'initial' && kind !== 'rework')) {
            dropped += 1;
            continue;
        }
        kept.push({
            stageId,
            round,
            role,
            dispatchedAt,
            kind,
            ...(typeof sessionId === 'string' ? { sessionId } : {}),
            ...(typeof settledAt === 'number' ? { settledAt } : {}),
        });
    }
    if (dropped === 0 && kept.length === raw.length)
        return state;
    if (dropped > 0) {
        reportParseWarning(onWarning, 'dispatch-ledger-pruned', `${file}: dropped ${dropped} malformed dispatchAttempts entry(ies); ${kept.length} kept`);
    }
    return { ...state, dispatchAttempts: kept };
}
/**
 * Sanitise the persisted security verdict (H4).
 *
 * `securityTriggered` is the boolean every other reader branches on — the DoD's
 * `securityOnly` skip, the roster pin, the pipeline. `securityHits` and
 * `securitySource` exist only to explain it, so when the two disagree the
 * verdict wins and the **evidence** is dropped, with a warning. Promoting the
 * verdict from a stray word instead would let a hand-edited `factory.json`
 * silently put a running factory onto the security path on the next read.
 *
 * The reverse — `true` with no words — is legitimate: it is what every record
 * written before these fields existed looks like, and what a plan whose triggers
 * were not recorded looks like. Absent stays absent; nothing is invented.
 */
function normalizeSecurityVerdict(state, file, onWarning) {
    const problems = [];
    let hits;
    if (state.securityHits !== undefined) {
        if (!Array.isArray(state.securityHits)) {
            problems.push('securityHits is not an array');
        }
        else {
            const kept = state.securityHits.filter((hit) => typeof hit === 'string' && hit !== '');
            if (kept.length !== state.securityHits.length) {
                problems.push(`${state.securityHits.length - kept.length} securityHits entry(ies) are not non-empty strings`);
            }
            hits = kept;
        }
    }
    let source = state.securitySource;
    if (source !== undefined && !SECURITY_SIGNAL_SOURCES.includes(source)) {
        problems.push(`securitySource is not one of ${SECURITY_SIGNAL_SOURCES.join('/')}`);
        source = undefined;
    }
    const namesTriggers = (hits !== undefined && hits.length > 0) || (source !== undefined && source !== 'none');
    if (!state.securityTriggered && namesTriggers) {
        problems.push('securityTriggered is false while the record names triggers — verdict kept, evidence dropped');
        hits = undefined;
        source = undefined;
    }
    for (const problem of problems)
        reportParseWarning(onWarning, 'security-verdict-invalid', `${file}: ${problem}`);
    if (sameStrings(hits, state.securityHits) && source === state.securitySource)
        return state;
    const { securityHits: _hits, securitySource: _source, ...rest } = state;
    return {
        ...rest,
        ...(hits === undefined ? {} : { securityHits: hits }),
        ...(source === undefined ? {} : { securitySource: source }),
    };
}
/** Shallow equality for the optional string-array fields, treating both-absent as equal. */
function sameStrings(a, b) {
    if (a === undefined || b === undefined)
        return a === b;
    return a.length === b.length && a.every((value, index) => value === b[index]);
}
/** Fire-and-forget warning used by the file parsers (never throws into a read). */
function reportParseWarning(onWarning, code, message) {
    if (onWarning === undefined)
        return;
    try {
        onWarning({ code, message });
    }
    catch {
        /* a broken warning sink must never fail a read */
    }
}
/** Structural guard for a persisted factory record. */
export function isFactoryState(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const record = value;
    return (typeof record.id === 'string' &&
        typeof record.name === 'string' &&
        typeof record.brief === 'string' &&
        typeof record.taskType === 'string' &&
        typeof record.pipeline === 'string' &&
        typeof record.captainSessionId === 'string' &&
        typeof record.phase === 'string' &&
        typeof record.securityTriggered === 'boolean' &&
        Array.isArray(record.members) &&
        Array.isArray(record.stages) &&
        Array.isArray(record.dod) &&
        typeof record.createdAt === 'number' &&
        typeof record.updatedAt === 'number');
}
/** Structural guard for one artifact record. */
export function isArtifactRecord(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const record = value;
    return (typeof record.path === 'string' &&
        typeof record.by === 'string' &&
        typeof record.stage === 'string' &&
        typeof record.bytes === 'number' &&
        typeof record.at === 'number');
}
/**
 * Read `artifacts.json`, accepting both the versioned envelope and a bare array.
 * Individual junk entries are skipped (and reported), never fatal.
 */
function parseArtifacts(text, file, onWarning) {
    const warn = (message, error) => {
        if (!onWarning)
            return;
        try {
            onWarning(error === undefined ? { code: 'artifact-invalid', message } : { code: 'artifact-invalid', message, error });
        }
        catch {
            /* ignore */
        }
    };
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        warn(`${file} is not valid JSON: ${describeError(error)}`, error);
        return [];
    }
    let candidates;
    if (Array.isArray(parsed)) {
        candidates = parsed;
    }
    else if (typeof parsed === 'object' && parsed !== null && Array.isArray(parsed.artifacts)) {
        candidates = parsed.artifacts;
    }
    else {
        warn(`${file} has no artifact array; treating it as empty`);
        return [];
    }
    const records = [];
    for (const candidate of candidates) {
        if (isArtifactRecord(candidate))
            records.push(candidate);
        else
            warn(`${file} contains an invalid artifact record; it was skipped`);
    }
    return records;
}
function summarize(state, dir, archived) {
    return {
        id: state.id,
        name: state.name,
        phase: state.phase,
        taskType: state.taskType,
        pipeline: state.pipeline,
        captainSessionId: state.captainSessionId,
        securityTriggered: state.securityTriggered,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        memberCount: state.members.length,
        stageCount: state.stages.length,
        stagesPassed: state.stages.filter((stage) => stage.status === 'passed').length,
        dir,
        archived,
    };
}
/* -------------------------------------------------------------- re-exports */
export { FactoryError, FactoryPathError, FactorySchemaVersionError, FactoryStateError, assertSupportedSchemaVersion, isSafeFactoryId, isSafeKey, migrateFactoryState, sanitizeKey, } from './state.js';
export { isDurableWrite, nodeFilePrimitives, replaceFileAtomicOrDirect, temporaryPathFor } from './atomic.js';
export { DEFAULT_FILE_LOCK_POLL_MS, DEFAULT_FILE_LOCK_STALE_MS, DEFAULT_FILE_LOCK_TIMEOUT_MS, FactoryFileLockTimeoutError, acquireFactoryFileLock, factoryFileLockLocalStats, factoryLockFile, isProcessAlive, withFactoryFileLock, } from './file-lock.js';
//# sourceMappingURL=store.js.map