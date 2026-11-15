/**
 * Atomic file replacement with a Windows-safe fallback.
 *
 * `replaceFileAtomicOrDirect()` implements the classic write-temp-then-rename
 * dance, but unlike a plain `rename` it survives the two failure modes that
 * actually happen on Windows developer machines:
 *
 *   1. `rename()` over an existing file throws `EPERM`/`EACCES` when an editor,
 *      a virus scanner or a Dropbox-style indexer holds a handle on the target.
 *      We retry a few times (default: 3 retries, 50 ms apart) because those
 *      failures are usually transient.
 *   2. If the retries are exhausted we degrade to a *direct overwrite* of the
 *      target. That is not atomic, but durable state that is occasionally
 *      rewritten in place beats state that cannot be written at all — the
 *      reader side tolerates a torn file (`factory.json` corruption is reported,
 *      mailbox lines are parsed individually and malformed lines are skipped).
 *
 * The temporary file is removed on **every** exit path. If both the rename path
 * and the direct-write path fail, an `AggregateError` carrying every underlying
 * failure is thrown.
 *
 * Every filesystem call goes through the injected {@link FilePrimitives} face so
 * the store can be exercised against fault-injecting fakes without touching the
 * disk (see the self-test notes in `store.ts`).
 *
 * Host-only module: Node built-ins are allowed here, and every relative import
 * carries a `.js` extension (the host program compiles with `module: NodeNext`).
 *
 * @module dsh-code-factory/store/atomic
 */
import { appendFile as fsAppendFile, cp as fsCp, mkdir as fsMkdir, open as fsOpen, readFile as fsReadFile, readdir as fsReaddir, rename as fsRename, rm as fsRm, stat as fsStat, writeFile as fsWriteFile, } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
/** Human-readable one-liner for an unknown thrown value. */
function describeError(error) {
    if (error === null || error === undefined)
        return 'unknown error';
    if (error instanceof Error) {
        const code = error.code;
        return typeof code === 'string' ? `${code}: ${error.message}` : error.message;
    }
    return typeof error === 'string' ? error : JSON.stringify(error);
}
/**
 * Flush a directory entry. Best-effort by design.
 *
 * POSIX needs this for a rename to survive a power loss; Windows cannot fsync a
 * directory at all. A failure is therefore reported, never thrown: the file's own
 * bytes are already safe by the time this runs, and losing the directory flush is
 * strictly less bad than refusing to write the state at all.
 */
async function flushDirectory(dir) {
    let handle;
    try {
        handle = await fsOpen(dir, 'r');
    }
    catch (error) {
        return { dirSynced: false, note: `directory fsync unavailable (${describeError(error)})` };
    }
    try {
        await handle.sync();
        return { dirSynced: true };
    }
    catch (error) {
        return { dirSynced: false, note: `directory fsync failed (${describeError(error)})` };
    }
    finally {
        await handle.close().catch(() => undefined);
    }
}
/** The real filesystem. Default `primitives` for every store call. */
export const nodeFilePrimitives = {
    mkdir: (dir, options) => fsMkdir(dir, { recursive: options?.recursive ?? true }),
    writeFile: (file, data, options) => fsWriteFile(file, data, options ?? {}),
    writeFileDurable: async (file, data, options) => {
        const handle = await fsOpen(file, options?.flag ?? 'w', options?.mode);
        try {
            await handle.writeFile(data, { encoding: options?.encoding ?? 'utf8' });
            await handle.sync();
        }
        finally {
            await handle.close().catch(() => undefined);
        }
        const directory = await flushDirectory(path.dirname(file));
        return { fileSynced: true, dirSynced: directory.dirSynced, ...(directory.note === undefined ? {} : { note: directory.note }) };
    },
    readFile: (file, options) => fsReadFile(file, { encoding: options?.encoding ?? 'utf8' }),
    readTail: async (file, maxBytes) => {
        const handle = await fsOpen(file, 'r');
        try {
            const info = await handle.stat();
            const length = Math.max(0, Math.min(Math.floor(maxBytes), info.size));
            if (length === 0)
                return '';
            const buffer = Buffer.allocUnsafe(length);
            // Positioned read: only the requested range is ever materialised, so the
            // cost tracks `maxBytes` and not the file's history.
            const { bytesRead } = await handle.read(buffer, 0, length, info.size - length);
            return buffer.subarray(0, bytesRead).toString('utf8');
        }
        finally {
            await handle.close().catch(() => undefined);
        }
    },
    appendFile: (file, data, options) => fsAppendFile(file, data, options ?? {}),
    rename: (from, to) => fsRename(from, to),
    rm: (target, options) => fsRm(target, { force: options?.force ?? true, recursive: options?.recursive ?? false }),
    readdir: async (dir) => await fsReaddir(dir),
    stat: async (file) => {
        const info = await fsStat(file);
        return { size: info.size, mtimeMs: info.mtimeMs };
    },
    cp: (from, to, options) => fsCp(from, to, { recursive: options?.recursive ?? true }),
};
/* ------------------------------------------------------------- temp naming */
/** Monotonic counter so two temp files in the same millisecond never collide. */
let tempSequence = 0;
/**
 * Build a unique sibling path for `file`.
 *
 * The temp file MUST live in the same directory as the target: `rename()` is
 * only guaranteed to be atomic within one filesystem/volume.
 */
export function temporaryPathFor(file, tag = 'tmp') {
    tempSequence = (tempSequence + 1) % 1_000_000;
    const unique = [
        process.pid.toString(36),
        Date.now().toString(36),
        tempSequence.toString(36),
        randomBytes(4).toString('hex'),
    ].join('-');
    return `${file}.${tag}-${unique}.tmp`;
}
/* ----------------------------------------------------------------- options */
/** Default extra rename attempts after the first one. */
export const DEFAULT_RENAME_RETRIES = 3;
/** Default delay between rename attempts, in milliseconds. */
export const DEFAULT_RENAME_RETRY_DELAY_MS = 50;
/**
 * True when the report describes a write that is safe against a power loss:
 * atomic rename *and* the bytes actually flushed. A `direct` write is never
 * durable in this sense — the target was rewritten in place.
 */
export function isDurableWrite(report) {
    return report.strategy === 'rename' && (report.durability === 'file+dir' || report.durability === 'file');
}
/** Real timer sleep. */
export function defaultSleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
/* ---------------------------------------------------------------- replace */
/**
 * Write `content` to `file`, preferring an atomic same-directory rename.
 *
 * Steps:
 *  1. `mkdir -p dirname(file)` (unless `ensureDir: false`).
 *  2. write `content` to `temporary`.
 *  3. `rename(temporary, file)` with up to `retries` extra attempts, `retryDelayMs` apart.
 *  4. on exhaustion, overwrite `file` directly.
 *  5. always `rm(temporary, { force: true })`.
 *
 * @throws AggregateError when the rename path *and* the direct path both failed.
 *         The temp-file cleanup failure (if any) is appended to `errors`.
 */
export async function replaceFileAtomicOrDirect(temporary, file, content, primitives = nodeFilePrimitives, options = {}) {
    const retries = Math.max(0, Math.trunc(options.retries ?? DEFAULT_RENAME_RETRIES));
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RENAME_RETRY_DELAY_MS);
    const encoding = options.encoding ?? 'utf8';
    const sleep = options.sleep ?? defaultSleep;
    const maxAttempts = retries + 1;
    const failures = [];
    const renameFailures = [];
    let strategy;
    let attempts = 0;
    let cleanupError;
    let durability = 'unsupported';
    let durabilityNote;
    const writeOptions = options.mode !== undefined ? { encoding, flag: 'w', mode: options.mode } : { encoding, flag: 'w' };
    const notify = (fn, ...args) => {
        if (!fn)
            return;
        try {
            ;
            fn(...args);
        }
        catch {
            /* diagnostics must never break the write */
        }
    };
    /** Write the temp file, flushing it when the primitive can. Never throws here. */
    const writeTemporary = async () => {
        const durableWrite = primitives.writeFileDurable;
        if (durableWrite === undefined) {
            durability = 'unsupported';
            durabilityNote = 'the injected primitives have no writeFileDurable (test double?)';
            await primitives.writeFile(temporary, content, writeOptions);
            return;
        }
        try {
            const flushed = await durableWrite.call(primitives, temporary, content, writeOptions);
            durability = flushed.fileSynced ? (flushed.dirSynced ? 'file+dir' : 'file') : 'none';
            if (flushed.note !== undefined)
                durabilityNote = flushed.note;
        }
        catch (error) {
            // The flush failed (or the handle write did). The bytes may be partial, so
            // rewrite them plainly — a non-durable file still beats a truncated one.
            durability = 'none';
            durabilityNote = describeError(error);
            await primitives.writeFile(temporary, content, writeOptions);
        }
    };
    if (options.ensureDir !== false) {
        try {
            await primitives.mkdir(path.dirname(file), { recursive: true });
        }
        catch (error) {
            // Without a parent directory neither path can succeed: report and stop.
            throw new AggregateError([error], `cannot create parent directory for ${file}`);
        }
    }
    try {
        await writeTemporary();
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            attempts = attempt;
            try {
                await primitives.rename(temporary, file);
                strategy = 'rename';
                break;
            }
            catch (error) {
                renameFailures.push(error);
                if (attempt < maxAttempts) {
                    notify(options.onRetry, error, attempt);
                    await sleep(retryDelayMs);
                    continue;
                }
                // Exhausted: fall through to the direct overwrite below.
            }
        }
    }
    catch (error) {
        // The temp write itself failed (read-only volume, ENOSPC, …). Still try the
        // direct path: it is the last chance to make the state durable.
        failures.push(error);
        notify(options.onFallback, error, attempts);
    }
    if (strategy === undefined) {
        const renameError = renameFailures.length > 0 ? renameFailures[renameFailures.length - 1] : undefined;
        if (renameError !== undefined) {
            failures.push(renameError);
            notify(options.onFallback, renameError, attempts);
        }
        try {
            await primitives.writeFile(file, content, writeOptions);
            strategy = 'direct';
            // Rewriting the target in place cannot be atomic; say so even though the
            // temp file *was* flushed, so no caller reads `durability` as a promise
            // about the file that actually holds the state.
            durability = 'none';
            durabilityNote = 'the target was rewritten in place after the rename path gave up';
        }
        catch (error) {
            failures.push(error);
        }
    }
    try {
        await primitives.rm(temporary, { force: true });
    }
    catch (error) {
        // A leftover temp file is noise, not a correctness problem — but it is worth
        // reporting, and it must not mask a successful write.
        cleanupError = error;
        failures.push(error);
    }
    if (strategy === undefined) {
        const detail = renameFailures.length > 0 ? `${renameFailures.length} rename attempt(s) failed` : 'temporary write failed';
        throw new AggregateError(failures, `cannot persist ${file}: ${detail} and the direct overwrite also failed`);
    }
    if (cleanupError !== undefined)
        notify(options.onCleanupError, cleanupError);
    const base = {
        file,
        temporary,
        strategy,
        attempts,
        durability,
        ...(durabilityNote === undefined ? {} : { durabilityNote }),
    };
    if (strategy === 'direct' && renameFailures.length > 0) {
        return { ...base, renameError: renameFailures[renameFailures.length - 1] };
    }
    return base;
}
//# sourceMappingURL=atomic.js.map