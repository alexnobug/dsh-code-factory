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
import { AsyncLocalStorage } from 'node:async_hooks';
import { FactoryError } from './state.js';
/* ------------------------------------------------------------------ errors */
/**
 * Raised when a task tries to take a lock it already holds (would deadlock).
 *
 * The verdict comes from the ambient held-set, so it is deliberately *not* an
 * authority on "does this task own the lock": a window detached with
 * {@link runDetachedFromFactoryLocks} looks un-held to this guard, and a task
 * that reaches the same key from a detached window therefore queues behind the
 * holder instead of being rejected. That is the intended trade (see the helper).
 */
export class FactoryLockReentryError extends FactoryError {
    /** The key that was requested twice. */
    key;
    /** Human-readable identity of the subject, when the caller knew it. */
    subject;
    constructor(key, subject) {
        super('lock_reentry', `withFactoryLock("${key}") was called from inside a task that already holds it; ` +
            'nesting the same key deadlocks — restructure the call or drop the inner lock' +
            (subject === undefined ? '' : `\n  subject: ${subject}`));
        this.name = 'FactoryLockReentryError';
        this.key = key;
        this.subject = subject;
    }
}
/** Raised when the acquisition watchdog expires before the queue hands over. */
export class FactoryLockTimeoutError extends FactoryError {
    /** The key whose queue never drained in time. */
    key;
    /** The timeout that expired, in milliseconds. */
    timeoutMs;
    /** How many tasks were queued or running under `key` when we gave up. */
    queueDepth;
    /** Human-readable identity of the subject, when the caller knew it. */
    subject;
    constructor(key, timeoutMs, queueDepth, subject) {
        super('lock_timeout', `withFactoryLock("${key}") did not acquire the lock within ${timeoutMs}ms ` +
            `(${queueDepth} task(s) were queued or running under it); the caller's task was dropped without running` +
            (subject === undefined ? '' : `\n  subject: ${subject}`));
        this.name = 'FactoryLockTimeoutError';
        this.key = key;
        this.timeoutMs = timeoutMs;
        this.queueDepth = queueDepth;
        this.subject = subject;
    }
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
export const DEFAULT_FACTORY_LOCK_TIMEOUT_MS = 60_000;
/** Returned by an abandoned queued task, so its settlement stays off the caller's path. */
const ABANDONED = Symbol('factory-lock-abandoned');
/**
 * Narrows the watchdog sentinel back out of a queued turn's value.
 *
 * The sentinel is unreachable here by construction: it is produced only once the
 * watchdog wrote `abandoned`, and that same callback rejects the acquisition
 * promise the race settles on — so a caller sees the timeout, never the symbol.
 * The union type is what makes this a branch the compiler checks instead of a
 * cast it has to trust; the throw only fires if that invariant is ever broken.
 */
function discardAbandonedSentinel(value) {
    if (value === ABANDONED)
        throw new Error('factory lock: an abandoned queue turn reached its caller');
    return value;
}
/** key -> queue. Entries are deleted as soon as `pending` drops to 0. */
const queues = new Map();
/** The set of keys the current async context is already inside. */
const held = new AsyncLocalStorage();
/** Normalise a lock key. Empty keys are rejected loudly (they would be shared state). */
export function normalizeFactoryLockKey(key) {
    const normalized = typeof key === 'string' ? key.trim() : '';
    if (normalized === '')
        throw new FactoryError('lock_key', 'factory lock key must be a non-empty string');
    return normalized;
}
/** Keys with a live queue right now. */
export function factoryLockQueueKeys() {
    return [...queues.keys()].sort();
}
/** Queue depth per key, for diagnostics and leak checks. */
export function factoryLockQueueStats() {
    return [...queues.entries()]
        .map(([key, entry]) => ({ key, pending: entry.pending }))
        .sort((a, b) => a.key.localeCompare(b.key));
}
/** Keys held by the *current* async context (re-entry diagnostics). */
export function factoryLockHeldKeys() {
    return [...(held.getStore() ?? [])].sort();
}
/** True when the current async context already holds `key`. */
export function isFactoryLockHeld(key) {
    return held.getStore()?.has(normalizeFactoryLockKey(key)) ?? false;
}
/** The empty held-set: a task detached from every factory lock. */
const DETACHED_LOCK_CONTEXT = new Set();
export function runDetachedFromFactoryLocks(fn) {
    return held.run(DETACHED_LOCK_CONTEXT, fn);
}
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
export function withFactoryLock(key, fn, options = {}) {
    const normalized = normalizeFactoryLockKey(key);
    if (held.getStore()?.has(normalized) === true) {
        return Promise.reject(new FactoryLockReentryError(normalized, options.subject));
    }
    let entry = queues.get(normalized);
    if (!entry) {
        entry = { tail: Promise.resolve(), pending: 0 };
        queues.set(normalized, entry);
    }
    entry.pending += 1;
    const current = entry;
    const depthOnArrival = current.pending;
    // Set when the watchdog fires before the queue reaches us. The task stays in
    // the queue (removing it would reorder everyone behind us) but `fn` is never
    // invoked: a caller that was told "timed out" must not have its write land
    // anyway, which is precisely what the previous implementation did.
    let abandoned = false;
    let ownsLock = false;
    const turn = current.tail;
    const run = turn.then(() => {
        if (abandoned)
            return ABANDONED;
        ownsLock = true;
        const context = new Set(held.getStore() ?? []);
        context.add(normalized);
        return held.run(context, async () => await fn());
    });
    // The caller's view of that turn. Deriving it here is what turns the sentinel
    // into a checked branch: `run` may carry it, this promise may not.
    const committed = run.then(discardAbandonedSentinel);
    const settled = run.then(() => undefined, () => undefined);
    current.tail = settled;
    settled.then(() => {
        current.pending -= 1;
        if (current.pending <= 0 && queues.get(normalized) === current)
            queues.delete(normalized);
    });
    const timeoutMs = options.timeoutMs ?? DEFAULT_FACTORY_LOCK_TIMEOUT_MS;
    // `0` (or a negative) is the explicit "wait indefinitely" opt-out.
    if (!(timeoutMs > 0))
        return committed;
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            // Already holding the lock: this watchdog covers acquisition, so a slow
            // `fn` is not a timeout — rejecting here would report a failure for work
            // that is still going to complete.
            if (ownsLock)
                return;
            abandoned = true;
            reject(new FactoryLockTimeoutError(normalized, timeoutMs, depthOnArrival, options.subject));
        }, timeoutMs);
        timer.unref?.();
    });
    return Promise.race([committed, timeout]).finally(() => {
        if (timer !== undefined)
            clearTimeout(timer);
    });
}
//# sourceMappingURL=lock.js.map