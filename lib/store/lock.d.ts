/**
 * In-process per-key serialisation for factory state mutations.
 *
 * `withFactoryLock(key, fn)` chains `fn` onto the tail of a promise queue keyed
 * by `key`, so two concurrent read-modify-write sequences on the same factory
 * can never interleave. The queue is process-local by design: it is the cheap
 * inner layer. **Cross-process exclusion is a separate layer** — see
 * {@link ./file-lock.js}, which every `FactoryStore` mutation takes through
 * `store.withLock(...)`; callers that need both should use that method rather
 * than this function directly.
 *
 * ## Contract for callers
 *
 * - Everything that reads state, changes it and writes it back MUST run inside
 *   `withFactoryLock(store.lockKey(factoryId), …)` (or, preferably,
 *   `store.withLock(factoryId, …)`, which adds the file lock).
 * - Do NOT nest `withFactoryLock` on the same key: it cannot be satisfied and
 *   would deadlock. The lock detects this via `AsyncLocalStorage` and rejects
 *   with {@link FactoryLockReentryError} instead of hanging.
 * - Inside a locked window, every `await` of work that **starts, wakes or tears
 *   down another session** (member spawn, prompt delivery, drain, interrupt) MUST
 *   be wrapped in `runDetachedFromFactoryLocks(…)`. That work's async lineage
 *   otherwise inherits this task's held set, and the woken session's first
 *   attempt to mutate the same factory is rejected as a false re-entry.
 * - Acquisition is guarded by a watchdog by default
 *   ({@link DEFAULT_FACTORY_LOCK_TIMEOUT_MS}). When it expires the caller gets a
 *   {@link FactoryLockTimeoutError} **and its task is dropped without running** —
 *   a timed-out caller must never be able to perform the write it was told had
 *   failed. Pass `{ timeoutMs: 0 }` to wait indefinitely on purpose.
 * - `factoryLockQueueKeys()` / `factoryLockQueueStats()` exist for diagnostics
 *   and leak hunting (an entry that never disappears means a task never settled).
 *
 * @module dsh-code-factory/store/lock
 */
import { FactoryError } from './state.js';
/**
 * Raised when a task tries to take a lock it already holds (would deadlock).
 *
 * The verdict comes from the ambient held-set, so it is deliberately *not* an
 * authority on "does this task own the lock": a window detached with
 * {@link runDetachedFromFactoryLocks} looks un-held to this guard, and a task
 * that reaches the same key from a detached window therefore queues behind the
 * holder instead of being rejected. That is the intended trade (see the helper).
 */
export declare class FactoryLockReentryError extends FactoryError {
    /** The key that was requested twice. */
    readonly key: string;
    /** Human-readable identity of the subject, when the caller knew it. */
    readonly subject: string | undefined;
    constructor(key: string, subject?: string);
}
/** Raised when the acquisition watchdog expires before the queue hands over. */
export declare class FactoryLockTimeoutError extends FactoryError {
    /** The key whose queue never drained in time. */
    readonly key: string;
    /** The timeout that expired, in milliseconds. */
    readonly timeoutMs: number;
    /** How many tasks were queued or running under `key` when we gave up. */
    readonly queueDepth: number;
    /** Human-readable identity of the subject, when the caller knew it. */
    readonly subject: string | undefined;
    constructor(key: string, timeoutMs: number, queueDepth: number, subject?: string);
}
/**
 * Acquisition watchdog applied when the caller passes no `timeoutMs`.
 *
 * There is a default on purpose. Without one, a single task that never settles
 * parks every later mutation of that factory forever, and the symptom is a
 * factory that quietly stops reacting rather than an error anyone can read.
 * 60 s is far longer than any real mutation (the slow ones are member I/O, which
 * runs outside the window) and far shorter than a human's patience.
 */
export declare const DEFAULT_FACTORY_LOCK_TIMEOUT_MS = 60000;
/** Options for {@link withFactoryLock}. */
export interface FactoryLockOptions {
    /**
     * Acquisition watchdog, in milliseconds. Defaults to
     * {@link DEFAULT_FACTORY_LOCK_TIMEOUT_MS}; pass `0` to wait indefinitely.
     *
     * When it expires the caller gets a {@link FactoryLockTimeoutError} and its
     * queued task is **dropped without running**, so a timed-out caller can never
     * perform the write it was told had failed. A watchdog that fires after the
     * lock was acquired is ignored: it guards acquisition, not execution.
     */
    readonly timeoutMs?: number;
    /**
     * Human-readable identity of whatever `key` stands for, woven into every error
     * this lock raises (`工厂 9f3ac2d1`).
     *
     * The lock layer is deliberately generic — it only ever sees a key — so it
     * cannot name the subject itself, and a maintainer reading
     * `withFactoryLock("factory:9f3ac2d1")` had to decode a machine key to learn
     * *which* factory stalled. Callers that know the subject pass it here; callers
     * that do not get the key alone, which is still better than a guess.
     */
    readonly subject?: string;
}
/** Normalise a lock key. Empty keys are rejected loudly (they would be shared state). */
export declare function normalizeFactoryLockKey(key: string): string;
/** Keys with a live queue right now. */
export declare function factoryLockQueueKeys(): string[];
/** Queue depth per key, for diagnostics and leak checks. */
export declare function factoryLockQueueStats(): {
    key: string;
    pending: number;
}[];
/** Keys held by the *current* async context (re-entry diagnostics). */
export declare function factoryLockHeldKeys(): string[];
/** True when the current async context already holds `key`. */
export declare function isFactoryLockHeld(key: string): boolean;
/**
 * Run `fn` with the held-key set cleared.
 *
 * Member-facing I/O (member spawn, prompt delivery, drain, interrupt) is awaited
 * inside a locked window, and the held key would otherwise ride
 * `AsyncLocalStorage` into the session started by that call — leaving that
 * session's first factory mutation rejected as a re-entry. The lock's scope is
 * the state mutation it protects, never the session a mutation wakes.
 *
 * The wrapper is transparent: it returns whatever `fn` returns, rethrows what it
 * throws, and restores the caller's context on the way out (including on throw).
 *
 * @param fn - the host call that starts, wakes or tears down another session.
 * @returns `fn`'s own result, with the same sync/async shape.
 */
export declare function runDetachedFromFactoryLocks<T>(fn: () => Promise<T>): Promise<T>;
/** Synchronous form: preserves the return value's type for sync call sites. */
export declare function runDetachedFromFactoryLocks<T>(fn: () => T): T;
/**
 * Run `fn` exclusively with respect to every other task queued under `key`.
 *
 * Resolution order is FIFO. A rejecting task never poisons the queue: later
 * tasks still run, and the rejection is delivered only to the caller that owned
 * the failing task.
 *
 * Acquisition is watched by a default timeout. A caller that gives up has its
 * task **dropped rather than merely un-awaited** — see {@link FactoryLockOptions}.
 */
export declare function withFactoryLock<T>(key: string, fn: () => T | Promise<T>, options?: FactoryLockOptions): Promise<T>;
