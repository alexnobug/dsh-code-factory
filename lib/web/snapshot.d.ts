/**
 * Pure projection: the durable `FactoryState` → the cockpit's `FactorySnapshot`.
 *
 * `docs/API-CONTRACTS.md` §7 makes the HTTP route the client's only data channel,
 * so this module owns exactly one job: turn what is on disk into what the panel
 * renders, without touching the filesystem itself.
 *
 * What it adds on top of the state record:
 *  - **Role facts** — `title` / `codename` / `color` / `duties` / `tier` come from
 *    the role registry, not from `factory.json` (a member row only stores its
 *    status, route and counters). Unknown roles fall back to the raw id instead
 *    of being dropped, so a factory written by an older registry still renders.
 *  - **Stage facts** — `name` / `parallel` / `humanApproval` / `gateType` /
 *    `failGoto` / `maxRounds` / `gate` come from the pipeline template; the state
 *    record carries the live status, round, attempt/start/end stamps and the last
 *    gate verdict (`lastGate`), which are projected verbatim for the stage
 *    inspector. An unknown stage id (template changed after the factory was
 *    staged) degrades to the id plus the last gate's own type, or to
 *    `UNKNOWN_GATE_TYPE` when there is not even that — it has no `gate`.
 *  - **DoD definition facts** — each persisted `DodState` is joined with its
 *    `domain/dod.ts` definition (`kind` / `artifact` / `expect` / `run` /
 *    `securityOnly`) so the panel can explain what an item checks instead of
 *    showing only its verdict. An id with no definition stays outcome-only.
 *  - **Factory metadata** — `approvedAt` / `securityHits` / `securitySource` /
 *    `deliveryPath` are passed through when the record has them.
 *  - **Snapshot is a value, never a live view** — template-sourced arrays/objects
 *    (`roles`, `gate`, `requiredSections`, those inside `composite.checks`) are
 *    copied, so a consumer mutating the snapshot cannot edit the pipeline
 *    registry every factory reads.
 *  - **Side files** — artifacts and mailbox messages are folded in by the caller
 *    (the route reads them from `FactoryStore`) and bounded here.
 *
 * Ordering contract (the panel renders these arrays verbatim):
 *  - `members`   — roster order, as stored.
 *  - `stages`    — pipeline order, as stored.
 *  - `artifacts` — registration order, oldest first (the panel is an
 *    "ARTIFACTS · 工件登记表" registry, not a newest-first activity feed).
 *  - `feed`      — chronological, oldest first, keeping only the newest
 *    `feedLimit` messages.
 *  - `alerts`    — most urgent first (see `deriveAlerts`); derived, never stored.
 *
 * No I/O, no clock, no randomness: every function here is a pure fold, which is
 * why it can be asserted against fixtures in `scripts/verify.mjs`.
 *
 * @module dsh-code-factory/web/snapshot
 */
import type { ArtifactRecord, EvolutionView, FactoryMessage, FactoryPhase, FactorySnapshot, FactoryState } from '../shared/types.js';
/** Default size of the projected message feed. */
export declare const DEFAULT_FEED_LIMIT = 50;
/** Hard ceiling for `feedLimit`, so a bad config can never make the poll heavy. */
export declare const MAX_FEED_LIMIT = 500;
/** Max lessons the cockpit evolution panel receives (the full ledger stays on disk). */
export declare const EVOLUTION_SNAPSHOT_LIMIT = 12;
/** The side files the route reads and this module folds in. */
export interface SnapshotSources {
    /** `artifacts.json` contents, any order (sorted here). */
    readonly artifacts?: readonly ArtifactRecord[];
    /** Every mailbox message, any order (sorted here). */
    readonly feed?: readonly FactoryMessage[];
    /** How many of the newest messages to keep. Defaults to {@link DEFAULT_FEED_LIMIT}. */
    readonly feedLimit?: number;
    /**
     * The workspace evolution ledger. **Absent means "no ledger read"** — the
     * snapshot then omits `evolution` instead of fabricating an empty view (the
     * client distinguishes "not read" from "no lessons ever").
     */
    readonly evolution?: EvolutionView;
}
/**
 * One row of the parameterless index response.
 *
 * Deliberately the smallest useful shape (§7.3: the panel polls once a second):
 * identity, human name, routing facts and the freshness stamp the client sorts
 * on. No members, no messages, no artifacts.
 */
export interface FactoryIndexEntry {
    readonly id: string;
    readonly name: string;
    readonly taskType: string;
    readonly phase: FactoryPhase;
    readonly updatedAt: number;
}
/**
 * Minimal input an index row can be built from.
 *
 * Both `FactoryState` (a freshly loaded record) and `FactorySummary` (a listing
 * row) satisfy this structurally, so the index needs no extra disk reads.
 */
export interface FactoryIndexSource {
    readonly id: string;
    readonly name: string;
    readonly taskType: string;
    readonly phase: FactoryPhase;
    readonly updatedAt: number;
}
/**
 * Project one durable factory record into the cockpit payload.
 *
 * @param state - the record read from `factory.json`.
 * @param sources - artifacts and messages read from the factory directory.
 * @returns the snapshot the panel polls for.
 */
export declare function buildFactorySnapshot(state: FactoryState, sources?: SnapshotSources): FactorySnapshot;
/**
 * One index row from a loaded record or a listing row.
 *
 * @param source - anything carrying identity, name, routing and freshness.
 * @returns the summary row.
 */
export declare function buildFactoryIndexEntry(source: FactoryIndexSource): FactoryIndexEntry;
/**
 * The whole index: deduplicated by factory id (a factory visible through two
 * workspaces is reported once, keeping its freshest stamp) and ordered by
 * `updatedAt` descending — the order the header picker expects.
 *
 * @param sources - every known factory, from every discovered workspace.
 * @returns the sorted index rows.
 */
export declare function buildFactoryIndex(sources: readonly FactoryIndexSource[]): FactoryIndexEntry[];
