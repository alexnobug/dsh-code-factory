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
/** Options accepted by the write-side primitives. A subset of `node:fs` options. */
export interface WritePrimitiveOptions {
    readonly encoding?: BufferEncoding;
    readonly mode?: number;
    readonly flag?: string;
}
/**
 * What flushing a write to stable storage actually achieved.
 *
 * `fileSynced` is the part that matters for correctness: without it a power
 * loss can leave the renamed file present but empty or half-written (the
 * rename is metadata, the bytes are not). `dirSynced` is what makes the
 * *rename itself* survive on POSIX; Windows has no portable directory fsync,
 * so a `false` there is expected and reported rather than treated as an error.
 */
export interface DurabilityReport {
    /** The file's own bytes were flushed to the device (`fsync` on the handle). */
    readonly fileSynced: boolean;
    /** The containing directory was flushed, so the new name survives a power loss. */
    readonly dirSynced: boolean;
    /** Why a step could not be taken (e.g. no directory fsync on this platform). */
    readonly note?: string;
}
/**
 * The exact slice of `node:fs/promises` the store uses.
 *
 * Injecting it buys two things: the self-test can simulate a locked/EPERM
 * filesystem without a real AV product, and future hosts (a sandboxed DSH
 * worker, a vscode extension host) can swap in a mediated implementation.
 */
export interface FilePrimitives {
    /** Create a directory. `recursive` defaults to true in the Node adapter. */
    mkdir(dir: string, options?: {
        recursive?: boolean;
    }): Promise<unknown>;
    /** Write a whole file. Used for the temp file and for the direct-overwrite fallback. */
    writeFile(file: string, data: string, options?: WritePrimitiveOptions): Promise<unknown>;
    /**
     * Write a whole file and flush it to stable storage before returning.
     *
     * Optional on purpose: a fault-injecting fake may omit it, and the absence is
     * then reported as `durable: 'unsupported'` instead of being silently assumed
     * safe. The real adapter always provides it, so a production write is never
     * in that state.
     */
    writeFileDurable?(file: string, data: string, options?: WritePrimitiveOptions): Promise<DurabilityReport>;
    /** Read a whole file as text. */
    readFile(file: string, options?: {
        encoding?: BufferEncoding;
    }): Promise<string>;
    /**
     * Read at most the last `maxBytes` bytes of a file as text.
     *
     * Optional on purpose, like {@link FilePrimitives.writeFileDurable}: a fake that
     * omits it makes the caller fall back to a whole-file read, which is slower but
     * never wrong. The real adapter uses a positioned read, so a mailbox that has
     * grown for months is never loaded whole just to answer `limit: 20`.
     *
     * The returned text MAY begin mid-line. Callers that need whole lines must drop
     * everything up to the first newline.
     */
    readTail?(file: string, maxBytes: number): Promise<string>;
    /** Append one chunk. The mailbox writer relies on this being `O_APPEND`. */
    appendFile(file: string, data: string, options?: WritePrimitiveOptions): Promise<unknown>;
    /** Rename/move. May throw `EPERM` on Windows when the target is held open. */
    rename(from: string, to: string): Promise<unknown>;
    /** Remove a file or directory. `force` defaults to true in the Node adapter. */
    rm(target: string, options?: {
        force?: boolean;
        recursive?: boolean;
    }): Promise<unknown>;
    /** List directory entry names. */
    readdir(dir: string): Promise<readonly string[]>;
    /** Stat a file. Only the size is needed by the artifact register. */
    stat(file: string): Promise<{
        size: number;
        mtimeMs?: number;
    }>;
    /** Recursive copy, used by the cross-device archive fallback. */
    cp(from: string, to: string, options?: {
        recursive?: boolean;
    }): Promise<unknown>;
}
/** The real filesystem. Default `primitives` for every store call. */
export declare const nodeFilePrimitives: FilePrimitives;
/**
 * Build a unique sibling path for `file`.
 *
 * The temp file MUST live in the same directory as the target: `rename()` is
 * only guaranteed to be atomic within one filesystem/volume.
 */
export declare function temporaryPathFor(file: string, tag?: string): string;
/** Default extra rename attempts after the first one. */
export declare const DEFAULT_RENAME_RETRIES = 3;
/** Default delay between rename attempts, in milliseconds. */
export declare const DEFAULT_RENAME_RETRY_DELAY_MS = 50;
/** Options for {@link replaceFileAtomicOrDirect}. */
export interface ReplaceFileOptions {
    /** Extra rename attempts after the first one. Default {@link DEFAULT_RENAME_RETRIES}. */
    readonly retries?: number;
    /** Delay between rename attempts in ms. Default {@link DEFAULT_RENAME_RETRY_DELAY_MS}. */
    readonly retryDelayMs?: number;
    /** Encoding for both the temp write and the direct fallback. Default `utf8`. */
    readonly encoding?: BufferEncoding;
    /** Create the parent directory first. Default true. */
    readonly ensureDir?: boolean;
    /** File mode for newly created files. */
    readonly mode?: number;
    /** Injected sleep, so tests can run the retry loop without real delay. */
    readonly sleep?: (ms: number) => Promise<void>;
    /** Called after each failed rename that will be retried. */
    readonly onRetry?: (error: unknown, attempt: number) => void;
    /** Called when the rename path gave up and the direct overwrite is attempted. */
    readonly onFallback?: (error: unknown, attempts: number) => void;
    /** Called when the temp file could not be removed after a successful write. */
    readonly onCleanupError?: (error: unknown) => void;
}
/**
 * How durable the write turned out to be.
 *
 *  - `file+dir`    the bytes *and* the directory entry were flushed (POSIX best case)
 *  - `file`        the bytes were flushed; the directory entry was not (normal on Windows)
 *  - `none`        the flush failed — the bytes are in the page cache only
 *  - `unsupported` no durable primitive was injected (only reachable with a fake)
 */
export type WriteDurability = 'file+dir' | 'file' | 'none' | 'unsupported';
/** What {@link replaceFileAtomicOrDirect} ended up doing. Useful for diagnostics. */
export interface ReplaceFileReport {
    /** The target file that now holds `content`. */
    readonly file: string;
    /** The temp path that was used (and removed). */
    readonly temporary: string;
    /** `rename` = atomic path succeeded, `direct` = degraded overwrite was used. */
    readonly strategy: 'rename' | 'direct';
    /** Number of rename attempts made (0 when the temp write itself failed). */
    readonly attempts: number;
    /** How far the bytes got towards stable storage. */
    readonly durability: WriteDurability;
    /** Why `durability` is not `file+dir`, when the primitive explained it. */
    readonly durabilityNote?: string;
    /** The last rename failure, only set when `strategy === 'direct'`. */
    readonly renameError?: unknown;
}
/**
 * True when the report describes a write that is safe against a power loss:
 * atomic rename *and* the bytes actually flushed. A `direct` write is never
 * durable in this sense — the target was rewritten in place.
 */
export declare function isDurableWrite(report: ReplaceFileReport): boolean;
/** Real timer sleep. */
export declare function defaultSleep(ms: number): Promise<void>;
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
export declare function replaceFileAtomicOrDirect(temporary: string, file: string, content: string, primitives?: FilePrimitives, options?: ReplaceFileOptions): Promise<ReplaceFileReport>;
