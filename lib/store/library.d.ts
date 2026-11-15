/**
 * library.ts — the **global cross-project reuse library**.
 *
 * A delivered factory's useful parts (a module, copy, design spec, test kit, ops
 * recipe) are not worth re-inventing in the next project. This store keeps those
 * assets **outside** any one workspace:
 *
 * ```text
 * <root>/index.json                          { schemaVersion: 1, entries: ReuseEntry[] }
 * <root>/entries/<id>/files/<relative-path>  one harvested asset's files
 * ```
 *
 * ## Safety rules (the reason this file is careful)
 *
 *  - **Path containment**: every stored and applied path is workspace-relative
 *    POSIX; absolute paths, drive letters, `..`, `.code-factory`, `.git`,
 *    `node_modules`, `.env*`, `*.pem` and `*.key` are refused. Windows separators
 *    are normalised before validation.
 *  - **No symlinks**: harvesting and applying both `lstat`/`Dirent`-check, and a
 *    symlink is an error, never followed — a link could point outside the
 *    workspace or leak a secret.
 *  - **Bounds**: ≤5 MB per file, ≤50 MB per harvest, ≤500 files per harvest.
 *  - **Atomic index + cross-process lock**: read-modify-write of `index.json`
 *    runs under `withFactoryFileLock(<root>, 'library', 'harvest')` and persists
 *    through the same temp-write + rename path as `factory.json`.
 *  - **Tolerant reads**: missing/corrupt/future-schema index degrades to an empty
 *    library (with a warning), never to a thrown status/plan call.
 *  - **No execution**: `apply()` only copies bytes. Nothing here runs, imports or
 *    evaluates the harvested code.
 *
 * Host-only module (Node built-ins allowed), every relative import carries `.js`.
 *
 * @module dsh-code-factory/store/library
 */
import type { ReuseEntry, ReuseKind, ReuseMatch } from '../shared/types.js';
import { type ReuseRankOptions } from '../domain/reuse.js';
/** On-disk shape version of `index.json`. */
export declare const REUSE_LIBRARY_SCHEMA_VERSION = 1;
/** File name of the library index. */
export declare const REUSE_LIBRARY_INDEX_FILE = "index.json";
/** Directory holding one sub-directory per entry. */
export declare const REUSE_LIBRARY_ENTRIES_DIR = "entries";
/** Directory holding the copied files of one entry. */
export declare const REUSE_LIBRARY_FILES_DIR = "files";
/** Max bytes for one stored file (5 MB). */
export declare const REUSE_LIBRARY_MAX_FILE_BYTES: number;
/** Max bytes for one harvest in total (50 MB). */
export declare const REUSE_LIBRARY_MAX_TOTAL_BYTES: number;
/** Max files in one harvest. */
export declare const REUSE_LIBRARY_MAX_FILES = 500;
/** Prefix of the lock key handed to `withFactoryLock`. */
export declare const REUSE_LIBRARY_LOCK_PREFIX = "reuse:";
/** Default number of rows a plain `list` returns. */
export declare const REUSE_LIBRARY_LIST_LIMIT = 20;
/** A refused library operation: unsafe path, missing entry, size bound, … */
export declare class ReuseLibraryError extends Error {
    /** Machine-ish code for the engine to branch on / quote. */
    readonly code: string;
    constructor(message: string, code?: string);
}
/** Non-fatal observation sink. */
export type ReuseLibraryWarningHandler = (code: string, message: string) => void;
/** Construction options. `root` is `<libraryDir>` resolved by the caller. */
export interface ReuseLibraryOptions {
    /** Clock. Defaults to `Date.now`. */
    readonly now?: () => number;
    /** Non-fatal warning sink (corrupt index, unreadable file). */
    readonly onWarning?: ReuseLibraryWarningHandler;
}
/** What `harvest()` accepts. */
export interface ReuseHarvestInput {
    readonly sourceFactoryId: string;
    readonly sourceFactoryName: string;
    /** Absolute source workspace root. */
    readonly sourceWorkspace: string;
    /** Workspace-relative POSIX paths (files or directories). */
    readonly paths: readonly string[];
    readonly name: string;
    readonly description?: string;
    readonly kind?: ReuseKind;
    readonly tags?: readonly string[];
    readonly taskTypes?: readonly string[];
}
/** What one `apply()` copied. All paths are workspace-relative POSIX. */
export interface ReuseApplyResult {
    readonly entryId: string;
    readonly targetDir: string;
    readonly copied: readonly string[];
    readonly skipped: readonly string[];
}
/**
 * The default global library directory: `$DSH_HOME/code-factory-library`
 * (falling back to the OS home directory when `DSH_HOME` is unset/blank).
 */
export declare function defaultReuseLibraryDir(): string;
/**
 * Validate + normalise one workspace-relative POSIX path.
 *
 * Refuses empty paths, absolute paths, drive letters, `..`, `.code-factory`,
 * `.git`, `node_modules`, `.env*`, `*.pem` and `*.key`. Backslashes are
 * normalised first, so a Windows-style path is validated instead of silently
 * becoming a literal directory name on POSIX.
 */
export declare function normalizeReusePath(input: string, what?: string): string;
/**
 * The global reuse library.
 *
 * Construct with the resolved library root (`config.libraryDir`, default
 * {@link defaultReuseLibraryDir}). Every mutation is serialised on
 * `reuse:<root>` and the index is written atomically.
 */
export declare class ReuseLibrary {
    /** Absolute library root. */
    readonly root: string;
    /** Absolute path of `index.json`. */
    readonly indexPath: string;
    private readonly clock;
    private readonly warn;
    constructor(root: string, options?: ReuseLibraryOptions);
    /** Lock key this library's writers serialise on (never a factory id). */
    lockKey(): string;
    /** The raw index (tolerant: missing/corrupt => []). Sorted newest first. */
    readIndex(): Promise<ReuseEntry[]>;
    /** Entries ordered by freshness (updatedAt desc, id asc), capped at 20. */
    list(limit?: number): Promise<ReuseEntry[]>;
    /** Pure ranking over the index (see `domain/reuse.rankReuseEntries`). */
    search(options?: ReuseRankOptions): Promise<ReuseMatch[]>;
    /**
     * Copy a delivered factory's files/directories into the library.
     *
     * The id is stable: SHA-1 of `sourceFactoryId | sorted paths | per-file
     * sha256`. Re-harvesting the same selection updates the same entry (name /
     * description / kind latest, tags and taskTypes unioned) instead of creating a
     * duplicate.
     *
     * @throws {ReuseLibraryError} on unsafe paths, symlinks, missing inputs or
     *         size/count bounds — the caller turns it into a Chinese tool error.
     */
    harvest(input: ReuseHarvestInput): Promise<ReuseEntry>;
    /**
     * Copy one entry's files into `<workspace>/<targetDir>` (default `reuse/<id>`).
     *
     * Never overwrites by default: an existing destination file is reported in
     * `skipped` and left untouched (`overwrite: true` opts in). Nothing is
     * executed or imported; the copied files are reference material.
     *
     * @throws {ReuseLibraryError} on an unknown entry, unsafe target, missing
     *         stored file, or a symlink in the library tree.
     */
    apply(entryIdRaw: string, workspaceRaw: string, targetDirRaw?: string, overwrite?: boolean): Promise<ReuseApplyResult>;
    /** Tolerant index read; sorted newest first. Never throws. */
    private readIndexUnlocked;
    /** Whole-index atomic write. Caller holds {@link lockKey}. */
    private writeIndex;
    /** Walk the requested paths (files or directories), never following symlinks. */
    private collectFiles;
    private kindOf;
    /** `lstat` that maps ENOENT to `undefined` (missing is not an error here). */
    private lstatOrUndefined;
    /**
     * Reject a destination whose existing ancestors contain a symlink/non-directory.
     * Missing ancestors are allowed (the caller creates them).
     */
    private assertNoSymlinkAncestors;
    private report;
}
