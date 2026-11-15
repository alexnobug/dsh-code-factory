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
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { FactoryError } from './state.js';
/* ------------------------------------------------------------------ errors */
/** Raised when a foreign process holds the factory lock for longer than allowed. */
export class FactoryFileLockTimeoutError extends FactoryError {
    /** The lock file that could not be taken. */
    file;
    /** The key it guards. */
    key;
    /** How long the caller waited, in milliseconds. */
    waitedMs;
    /** The holder recorded in the file, when it could be read. */
    holder;
    /** Why the lock file could not be read, when it exists but is unreadable. */
    reason;
    constructor(key, file, waitedMs, holder, reason) {
        const who = holder !== undefined
            ? `pid ${holder.pid}${holder.host === undefined ? '' : ` on ${holder.host}`}`
            : reason === undefined
                ? 'another process'
                : `a lock file that cannot be read (${reason})`;
        super('file_lock_timeout', `factory "${key}" is locked by ${who} (${file}); waited ${waitedMs}ms. ` +
            (reason === undefined
                ? ''
                : `The lock file exists but could not be read (${reason}), so it is held rather than `
                    + 'treated as stale: taking it over would let two writers reach one record. ') +
            'Another DSH host has this workspace open — close it, or raise the wait, rather than letting both write.');
        this.name = 'FactoryFileLockTimeoutError';
        this.key = key;
        this.file = file;
        this.waitedMs = waitedMs;
        this.holder = holder;
        this.reason = reason;
    }
}
/* ---------------------------------------------------------------- defaults */
/** Default wait for a foreign holder. */
export const DEFAULT_FILE_LOCK_TIMEOUT_MS = 15_000;
/** Default age at which an unprobeable lock is assumed abandoned. */
export const DEFAULT_FILE_LOCK_STALE_MS = 5 * 60_000;
/** Default poll interval. */
export const DEFAULT_FILE_LOCK_POLL_MS = 100;
/** Real timer sleep. */
function realSleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
/**
 * True when a process with this id exists.
 *
 * `process.kill(pid, 0)` performs the permission check and delivers no signal;
 * `ESRCH` means "no such process". `EPERM` means the process exists but belongs
 * to someone else — which still counts as alive.
 */
export function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    if (pid === process.pid)
        return true;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        const code = error?.code;
        return code === 'EPERM';
    }
}
/* -------------------------------------------------------------- the file */
/** The lock file path for a factory under `root`. Never inside the factory dir. */
export function factoryLockFile(root, factoryId) {
    // A dedicated sibling directory, so a lock file can never be mistaken for a
    // factory (the store lists `<root>/*` and requires a `factory.json`) and can
    // never be moved by an archive/delete of the factory itself.
    return path.join(root, '.locks', `${factoryId}.lock`);
}
/**
 * Name the I/O failure behind an unreadable lock, so the refusal says something.
 *
 * @param error - whatever `readFile` / `JSON.parse` threw.
 * @returns the errno code when there is one, else the message.
 */
function readFailureReason(error) {
    const code = error?.code;
    if (typeof code === 'string' && code !== '')
        return code;
    const message = error?.message;
    if (typeof message === 'string' && message !== '')
        return message;
    return 'unnamed read failure';
}
/**
 * Read the lock file.
 *
 * `ENOENT` means the holder released between our failed create and this read —
 * that is absence, and absence is the only thing a stale-age takeover may act
 * on. Every other failure (EACCES, EBUSY, a torn or malformed body) means the
 * file is there and we do not know who holds it; callers must treat that as
 * held.
 */
async function readHolder(file) {
    try {
        const text = await readFile(file, { encoding: 'utf8' });
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object') {
            return { state: 'unreadable', reason: 'malformed lock body' };
        }
        const candidate = parsed;
        if (typeof candidate.token !== 'string' || typeof candidate.pid !== 'number') {
            return { state: 'unreadable', reason: 'malformed lock body' };
        }
        return {
            state: 'held',
            holder: {
                token: candidate.token,
                pid: candidate.pid,
                ...(typeof candidate.host === 'string' ? { host: candidate.host } : {}),
                startedAt: typeof candidate.startedAt === 'number' ? candidate.startedAt : 0,
                key: typeof candidate.key === 'string' ? candidate.key : '',
            },
        };
    }
    catch (error) {
        const code = error?.code;
        if (code === 'ENOENT')
            return { state: 'absent' };
        return { state: 'unreadable', reason: readFailureReason(error) };
    }
}
/** Age of the lock file in ms, or `undefined` when it cannot be stat-ed. */
async function lockAgeMs(file, now) {
    try {
        const info = await stat(file);
        return Math.max(0, now - info.mtimeMs);
    }
    catch {
        return undefined;
    }
}
/**
 * Acquire the lock for `key`, waiting up to `timeoutMs` for a foreign holder.
 *
 * @throws {FactoryFileLockTimeoutError} when the wait expires. The message names
 *         the holder, because "who has it" is the only actionable part.
 */
export async function acquireFactoryFileLock(root, factoryId, key, options = {}) {
    const file = factoryLockFile(root, factoryId);
    const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_FILE_LOCK_TIMEOUT_MS);
    const staleMs = Math.max(0, options.staleMs ?? DEFAULT_FILE_LOCK_STALE_MS);
    const pollMs = Math.max(1, options.pollMs ?? DEFAULT_FILE_LOCK_POLL_MS);
    const sleep = options.sleep ?? realSleep;
    const now = options.now ?? Date.now;
    const alive = options.isAlive ?? isProcessAlive;
    await mkdir(path.dirname(file), { recursive: true });
    const token = randomUUID();
    const started = now();
    let stole = false;
    let waited = 0;
    for (;;) {
        try {
            // `wx` = O_CREAT|O_EXCL|O_WRONLY. The create IS the arbitration: exactly one
            // process can win it, on every platform.
            const handle = await open(file, 'wx');
            try {
                const holder = {
                    token,
                    pid: process.pid,
                    host: hostname(),
                    startedAt: started,
                    key,
                };
                await handle.writeFile(`${JSON.stringify(holder)}\n`, { encoding: 'utf8' });
            }
            finally {
                await handle.close();
            }
            return {
                file,
                token,
                stole,
                release: async () => {
                    // Only ever remove OUR lock. After a stale takeover the token differs,
                    // and deleting it would drop the new owner's mutual exclusion. An
                    // unreadable file is left alone too: it cannot be proven to be ours.
                    const current = await readHolder(file);
                    if (current.state === 'held' && current.holder.token !== token)
                        return;
                    await rm(file, { force: true });
                },
            };
        }
        catch (error) {
            const code = error?.code;
            if (code !== 'EEXIST')
                throw error;
        }
        // Someone holds it — or the last holder just released it. Liveness first: a
        // crashed owner must not cost a timeout. Age is the fallback, and it applies
        // only to `absent`: an unreadable lock file is a holder we cannot disprove,
        // so it is treated as held and reported instead of taken over.
        const read = await readHolder(file);
        const ageMs = await lockAgeMs(file, now());
        const holder = read.state === 'held' ? read.holder : undefined;
        const ownerGone = read.state === 'held' && !alive(read.holder.pid);
        const absentAndOld = read.state === 'absent' && ageMs !== undefined && ageMs > staleMs;
        if (ownerGone || absentAndOld) {
            options.onStale?.({ file, holder, ageMs: ageMs ?? 0 });
            await rm(file, { force: true });
            stole = true;
            continue;
        }
        if (waited >= timeoutMs) {
            throw new FactoryFileLockTimeoutError(key, file, waited, holder, read.state === 'unreadable' ? read.reason : undefined);
        }
        options.onWait?.({ file, waitedMs: waited, holder });
        await sleep(pollMs);
        waited += pollMs;
    }
}
/**
 * One queue per lock file, for the whole process.
 *
 * {@link withFactoryLock} only serialises callers that share a `FactoryStore`
 * instance, and the plugin builds several for the same workspace (the tool
 * context, the cockpit's state route). Without this queue, two instances in one
 * process would each take the file lock, see `pid === process.pid`, treat it as a
 * foreign holder and wait for each other until the timeout. Queuing here means
 * the file lock is taken exactly once and released exactly once, no matter how
 * many stores the process opened.
 */
const localQueues = new Map();
/** Live queues per lock file, for diagnostics and leak hunting. */
export function factoryFileLockLocalStats() {
    return [...localQueues.entries()]
        .map(([file, entry]) => ({ file, depth: entry.depth }))
        .sort((a, b) => a.file.localeCompare(b.file));
}
/** Queue behind everything already waiting for `file`; returns the release fn. */
async function enterLocalQueue(file) {
    let entry = localQueues.get(file);
    if (entry === undefined) {
        entry = { tail: Promise.resolve(), depth: 0 };
        localQueues.set(file, entry);
    }
    const current = entry;
    current.depth += 1;
    const turn = current.tail;
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    current.tail = turn.then(() => gate);
    await turn;
    return () => {
        release();
        current.depth -= 1;
        if (current.depth <= 0 && localQueues.get(file) === current)
            localQueues.delete(file);
    };
}
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
export async function withFactoryFileLock(root, factoryId, key, fn, options = {}) {
    const file = factoryLockFile(root, factoryId);
    const releaseLocal = await enterLocalQueue(file);
    let lock;
    try {
        lock = await acquireFactoryFileLock(root, factoryId, key, options);
        return await fn();
    }
    finally {
        if (lock !== undefined)
            await lock.release().catch(() => undefined);
        releaseLocal();
    }
}
//# sourceMappingURL=file-lock.js.map