/**
 * reuse.ts — purity layer for the cross-project reuse library.
 *
 * The library itself (`store/library.ts`) owns durability; this module owns
 * **ranking and presentation**, and nothing else: no filesystem, no clock, no
 * randomness, no external imports (only the shared type contract). That keeps the
 * "why did this asset surface?" question assertable offline, and keeps the store
 * free of search policy.
 *
 * Ranking contract (deterministic for identical inputs):
 *  1. `kind` is a **filter**, not a score: a search for `module` never returns a
 *     design entry.
 *  2. query tokens score by field — name 6, description 3, tags 4, taskTypes 4,
 *     file paths 2 (a token may score in several fields).
 *  3. an exact `taskType` match adds 10; each requested tag that the entry also
 *     carries adds 4.
 *  4. a query/taskType/tags search keeps only entries with `score > 0`; a
 *     kind-only listing keeps every entry of that kind (all scores 0, ordered by
 *     freshness).
 *  5. stable order: score desc → updatedAt desc → id asc, then `limit`.
 *
 * `rankReuseEntries` never mutates its inputs and treats unknown/empty input as
 * "no matches" (`[]`), so a corrupt library index degrades to an empty result
 * instead of crashing a plan or a tool call.
 *
 * @module dsh-code-factory/domain/reuse
 */
import type { ReuseEntry, ReuseKind, ReuseMatch } from '../shared/types.js';
/** Default number of search hits returned. */
export declare const REUSE_LIBRARY_DEFAULT_LIMIT = 5;
/** Hard ceiling for a caller-supplied limit (a library is not a feed). */
export declare const REUSE_LIBRARY_MAX_LIMIT = 20;
/** Max assets quoted by one planning note (keep the plan readable). */
export declare const REUSE_PLAN_NOTE_MAX_ITEMS = 3;
/** Search options accepted by {@link rankReuseEntries}. */
export interface ReuseRankOptions {
    /** Free-text query matched against name / description / tags / taskTypes / files. */
    readonly query?: string;
    /** Exact task family (`web_fullstack`); adds 10 when it matches. */
    readonly taskType?: string;
    /** Tags to intersect; each exact hit adds 4. */
    readonly tags?: readonly string[];
    /** Restrict to one kind. */
    readonly kind?: ReuseKind;
    /** Max hits (default {@link REUSE_LIBRARY_DEFAULT_LIMIT}, capped at {@link REUSE_LIBRARY_MAX_LIMIT}). */
    readonly limit?: number;
}
/**
 * Rank the library's entries for one search/list request. Pure and total.
 *
 * @param entries - persisted entries (a corrupt element is skipped, never thrown).
 * @param options - query / taskType / tags / kind / limit; see {@link ReuseRankOptions}.
 * @returns matches ordered score desc → updatedAt desc → id asc, capped by limit;
 *          `[]` for unknown/empty input.
 */
export declare function rankReuseEntries(entries: readonly ReuseEntry[] | undefined, options?: ReuseRankOptions): ReuseMatch[];
/**
 * One Chinese planning note for the matches a plan-time search produced.
 *
 * The note names the asset, its kind/tags and its id so the captain can call
 * `factory_reuse action=apply` without another search. It also states the
 * expected workflow (copy → read → adapt), because the copied files are
 * reference material, not a finished deliverable.
 *
 * @param matches - ranked matches (already limited by the caller).
 * @returns the note, or `undefined` when there is nothing to suggest.
 */
export declare function reusePlanNote(matches: readonly ReuseMatch[] | undefined): string | undefined;
