/**
 * Cross-process advisory lock for one factory's state directory.
 *
 * ## Why this exists (see REVIEW-工程评审报告.md H1)
 *
 * {@link withFactoryLock} serialises tasks **inside one process**. That is all it
 * ever claimed, but it is not enough: the same workspace can be opened by two
 * hosts at once (the Electron app *and* a `dsh web` server, two Electron windows,
 * a CLI run next to a live GUI). Each host builds its own `FactoryStore`, each
 * queue is empty, and the two read-modify-write sequences interleave through the
 * filesystem. The last writer wins, silently, and the loser's stage transition
 * simply ceases to exist.
 *
 * This module adds the missing half: a lock file per factory, created with
 * `O_EXCL` so the create itself is the arbitration, holding the owner's identity.
 * A second process waits for it instead of racing it.
 *
 * ## Deliberate design choices
 *
 *  - **Advisory, not mandatory.** Nothing stops a process that does not call this
 *    module. It is a contract between cooperating hosts, which is what the plugin
 *    can actually enforce.
 *  - **Ownership is a token, not a file.** The lock is only removed by the holder
 *    that wrote it. A process that waited, timed out and then took over a stale
 *    lock writes a NEW token; the original owner's release sees a token mismatch
 *    and leaves the file alone instead of deleting the new owner's lock.
 *  - **Staleness is judged by liveness first, age second, and never on a file we
 *    could not read.** A lock whose owning process is gone is abandoned
 *    immediately (no waiting out a timeout after a crash). Age is only the
 *    fallback for a pid that has been recycled or that this platform refuses to
 *    probe. A lock file that exists but cannot be parsed (EACCES, EBUSY, a torn
 *    write) is *not* evidence of an abandoned lock: it is a holder that cannot be
 *    disproved, so it is treated as held and the wait ends in a
 *    {@link FactoryFileLockTimeoutError} that names the reason. Taking over a
 *    file we could not read is how two writers reach one record.
 *  - **Waiting is bounded and reported.** The wait never spins silently: the
 *    caller gets `onWait` callbacks and, at the deadline, a
 *    {@link FactoryFileLockTimeoutError} naming the holder — so "the GUI stopped
 *    responding" has an answer instead of a guess.
 *
 * Host-only module: Node built-ins are allowed here.
 *
 * @module dsh-code-factory/store/file-lock
 */
import { FactoryError } from './state.js';
/** Raised when a foreign process holds the factory lock for longer than allowed. */
export declare class FactoryFileLockTimeoutError extends FactoryError {
    /** The lock file that could not be taken. */
    readonly file: string;
    /** The key it guards. */
    readonly key: string;
    /** How long the caller waited, in milliseconds. */
    readonly waitedMs: number;
    /** The holder recorded in the file, when it could be read. */
    readonly holder: FactoryFileLockHolder | undefined;
    /** Why the lock file could not be read, when it exists but is unreadable. */
    readonly reason: string | undefined;
    constructor(key: string, file: string, waitedMs: number, holder: FactoryFileLockHolder | undefined, reason?: string);
}
/** What the lock file records about its owner. */
export interface FactoryFileLockHolder {
    /** Random token identifying one acquisition (never reused). */
    readonly token: string;
    /** Owning process id. */
    readonly pid: number;
    /** Owning host name, for the error message. */
    readonly host?: string;
    /** Wall-clock time the lock was taken. */
    readonly startedAt: number;
    /** The factory key the lock guards (sanity check when reading). */
    readonly key: string;
}
/** Options for {@link withFactoryFileLock}. */
export interface FactoryFileLockOptions {
    /** How long to wait for a foreign holder before giving up. Default: 15s. */
    readonly timeoutMs?: number;
    /** Age after which a lock whose owner cannot be probed is presumed abandoned. Default: 5min. */
    readonly staleMs?: number;
    /** Poll interval while waiting. Default: 100ms. */
    readonly pollMs?: number;
    /** Called once per poll while waiting, so a stall is visible instead of silent. */
    readonly onWait?: (info: {
        file: string;
        waitedMs: number;
        holder: FactoryFileLockHolder | undefined;
    }) => void;
    /** Called when an abandoned lock was taken over (crash recovery). */
    readonly onStale?: (info: {
        file: string;
        holder: FactoryFileLockHolder | undefined;
        ageMs: number;
    }) => void;
    /** Injected sleep, so tests need no real delay. */
    readonly sleep?: (ms: number) => Promise<void>;
    /** Injected clock. */
    readonly now?: () => number;
    /** Injected process-liveness probe, so tests need no real second process. */
    readonly isAlive?: (pid: number) => boolean;
}
/** Default wait for a foreign holder. */
export declare const DEFAULT_FILE_LOCK_TIMEOUT_MS = 15000;
/** Default age at which an unprobeable lock is assumed abandoned. */
export declare const DEFAULT_FILE_LOCK_STALE_MS: number;
/** Default poll interval. */
export declare const DEFAULT_FILE_LOCK_POLL_MS = 100;
/**
 * True when a process with this id exists.
 *
 * `process.kill(pid, 0)` performs the permission check and delivers no signal;
 * `ESRCH` means "no such process". `EPERM` means the process exists but belongs
 * to someone else — which still counts as alive.
 */
export declare function isProcessAlive(pid: number): boolean;
/** The lock file path for a factory under `root`. Never inside the factory dir. */
export declare function factoryLockFile(root: string, factoryId: string): string;
/** The acquired lock. `release()` is idempotent and never throws. */
export interface FactoryFileLockHandle {
    /** The lock file. */
    readonly file: string;
    /** This acquisition's token. */
    readonly token: string;
    /** Whether an abandoned lock had to be taken over. */
    readonly stole: boolean;
    /** Release the lock. Safe to call twice, and safe after a takeover. */
    release(): Promise<void>;
}
/**
 * Acquire the lock for `key`, waiting up to `timeoutMs` for a foreign holder.
 *
 * @throws {FactoryFileLockTimeoutError} when the wait expires. The message names
 *         the holder, because "who has it" is the only actionable part.
 */
export declare function acquireFactoryFileLock(root: string, factoryId: string, key: string, options?: FactoryFileLockOptions): Promise<FactoryFileLockHandle>;
/** Live queues per lock file, for diagnostics and leak hunting. */
export declare function factoryFileLockLocalStats(): {
    file: string;
    depth: number;
}[];
/**
 * Run `fn` holding the cross-process lock for one factory.
 *
 * Two layers, in this order:
 *  1. a process-wide FIFO queue keyed by the lock file, so several stores in one
 *     process take turns instead of fighting over a lock they already own;
 *  2. the lock file itself, which is what actually excludes *other* processes.
 *
 * The lock is always released, including when `fn` throws. The file is left
 * behind when release fails — a stale lock is recovered by the next acquisition
 * (liveness check), whereas a missing one would silently unprotect the factory.
 */
export declare function withFactoryFileLock<T>(root: string, factoryId: string, key: string, fn: () => Promise<T>, options?: FactoryFileLockOptions): Promise<T>;
