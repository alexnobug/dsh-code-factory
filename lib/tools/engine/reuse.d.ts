/**
 * engine/reuse.ts — `factory_reuse`: search / harvest / apply the global reuse
 * library.
 *
 * The tool is **captain-only** and deliberately narrow:
 *
 *  - `list` / `search` are read-only — no plan or factory state is touched;
 *  - `harvest` may only read a **delivered** factory (a running or staged
 *    factory has no stable deliverable to preserve) and copies its files into
 *    the workspace-independent library;
 *  - `apply` copies library files into the current workspace's `reuse/`
 *    directory and executes nothing.
 *
 * All refusals are `FactoryToolError`s written for the model to act on (which
 * phase is wrong, which path is unsafe, which entry id is unknown). Lower-level
 * `ReuseLibraryError`s are translated; unexpected errors are logged and surfaced
 * as a tool error rather than silently swallowed.
 *
 * @module dsh-code-factory/tools/engine/reuse
 */
import type { ReuseEntry, ReuseMatch } from '../../shared/types.js';
import type { ReuseRankOptions } from '../../domain/reuse.js';
import type { ToolCallContext } from '../context.js';
/** Accepted `action` values. */
export declare const REUSE_ACTIONS: readonly ["list", "search", "harvest", "apply"];
/** One `factory_reuse` action. */
export type ReuseAction = (typeof REUSE_ACTIONS)[number];
/** Arguments of {@link reuseFactory}. */
export interface ReuseFactoryInput {
    readonly action?: string;
    readonly query?: string;
    readonly taskType?: string;
    readonly tags?: string[];
    readonly kind?: string;
    readonly limit?: number;
    readonly factoryId?: string;
    readonly paths?: string[];
    readonly name?: string;
    readonly description?: string;
    readonly taskTypes?: string[];
    readonly entryId?: string;
    readonly targetDir?: string;
    readonly overwrite?: boolean;
}
/** Result of {@link reuseFactory}. */
export interface ReuseFactoryResult {
    readonly summary: string;
    readonly action: string;
    readonly entries: ReuseEntry[];
    readonly entry?: ReuseEntry;
    readonly appliedFiles?: string[];
    readonly targetDir?: string;
    readonly notes: string[];
    readonly nextAction: string;
}
/**
 * Read-only search used by `factory_plan` to suggest reusable assets.
 *
 * Never throws and never blocks planning: an unreadable/corrupt library reads as
 * empty, and an unexpected error is swallowed with a warning (the plan is more
 * important than the suggestion).
 *
 * @param call - the resolved tool call (workspace + config).
 * @param options - query / taskType / limit (kind/tags supported too).
 * @returns ranked matches, `[]` when the library is empty or unreadable.
 */
export declare function searchReuse(call: ToolCallContext, options?: ReuseRankOptions): Promise<ReuseMatch[]>;
/**
 * Execute one `factory_reuse` action.
 *
 * @param call - the resolved tool call.
 * @param input - action plus action-specific arguments.
 * @returns the tool result (always includes `entries`, even when empty).
 * @throws {FactoryToolError} for an unknown action, a non-delivered factory, an
 *         unsafe path, an unknown entry id or a library failure.
 */
export declare function reuseFactory(call: ToolCallContext, input: ReuseFactoryInput): Promise<ReuseFactoryResult>;
/**
 * Rank entries without touching the filesystem — re-exported for callers that
 * already have an in-memory entry list (tests / future read-only projections).
 */
export declare function rankReuse(entries: readonly ReuseEntry[], options?: ReuseRankOptions): ReuseMatch[];
/** Build the planning note from matches without re-implementing the wording. */
export declare function reusePlanningNote(matches: readonly ReuseMatch[]): string | undefined;
