/**
 * evolution.ts — the workspace's **cross-factory lesson ledger**.
 *
 * Every gate rejection and every failed DoD audit is a mistake that already cost
 * a rework round. This module makes that mistake durable: it records *what failed,
 * for which role, at which stage*, deduplicates repeats by a normalised signature
 * (so the second occurrence increments `count` instead of adding noise), and
 * exposes deterministic selectors that the prompt layer turns into the
 * 「历史教训」 block of a member brief / rework order.
 *
 * ## On-disk shape
 *
 * `<workspace>/<stateDir>/evolution.json` — deliberately a **sibling of the
 * factory directories**, not part of one of them:
 *
 * ```json
 * { "schemaVersion": 1, "lessons": [ LessonRecord, … ] }
 * ```
 *
 * The ledger is shared by every factory in the workspace (that is the whole
 * point: "this workspace already made this mistake"), capped at
 * {@link EVOLUTION_MAX_LESSONS}. When the cap is exceeded the **newest** lessons
 * (by `lastAt`) are kept.
 *
 * ## Failure policy — a lesson must never break the pipeline
 *
 * Reading is total: a missing file, unreadable file, invalid JSON, wrong root
 * shape and individually invalid rows all degrade to "fewer lessons" (usually
 * the empty ledger) instead of throwing. The callers (`factory_gate`,
 * `factory_dod_check`, the cockpit route) additionally wrap their own calls, so
 * a broken ledger can never turn a green gate into a crash.
 *
 * Writing is serialised with `withFactoryLock` under the key
 * `evolution:<root>` (never a factory id, so it cannot collide with — or
 * re-enter — a factory lock) and persisted through the same atomic-replace path
 * as `factory.json` (`replaceFileAtomicOrDirect`).
 *
 * ## Dedup / resolution semantics
 *
 * - Signature: `role | stage | gateType | kind | normalised text`.
 * - A repeat increments `count`, refreshes `lastAt`, `factoryId`, `taskType`
 *   and the quoted `detail`, keeps `firstAt`, and **clears `resolvedAt`**: the
 *   same mistake just happened again, so the lesson is open once more. That is
 *   the honest reading of "resolved" — it says "a later round fixed it", not
 *   "it can never happen again".
 * - `resolve()` is scoped to `factoryId` + `stage` (+ the responsible roles when
 *   given), so passing the gate of one stage cannot silently close another
 *   factory's or another stage's lesson.
 *
 * Host-only module (Node built-ins allowed), every relative import carries `.js`.
 *
 * @module dsh-code-factory/store/evolution
 */
import type { EvolutionStats, EvolutionView, LessonKind, LessonRecord } from '../shared/types.js';
import { type FilePrimitives } from './atomic.js';
/** On-disk shape version of `evolution.json`. */
export declare const EVOLUTION_SCHEMA_VERSION = 1;
/** File name of the ledger inside the state root (`.code-factory/evolution.json`). */
export declare const EVOLUTION_FILE = "evolution.json";
/** Hard cap on distinct lessons kept. Older rows are dropped by `lastAt`. */
export declare const EVOLUTION_MAX_LESSONS = 200;
/** Longest stored lesson text, in characters (one-line, whitespace collapsed). */
export declare const EVOLUTION_TEXT_MAX_CHARS = 400;
/** Prefix of the lock key handed to `withFactoryLock`. */
export declare const EVOLUTION_LOCK_PREFIX = "evolution:";
/** Default number of lessons a prompt selector / summary returns. */
export declare const EVOLUTION_SELECT_DEFAULT_LIMIT = 6;
/** Construction options for {@link EvolutionStore}. */
export interface EvolutionStoreOptions {
    /** Injected filesystem face. Defaults to the real `node:fs/promises` adapter. */
    readonly primitives?: FilePrimitives;
    /** Clock. Defaults to `Date.now`. */
    readonly now?: () => number;
    /** Non-fatal observation sink (corrupt file, dropped rows). Never throws. */
    readonly onWarning?: (code: string, message: string) => void;
}
/** One lesson to record (the dedup id is derived, never supplied). */
export interface EvolutionRecordInput {
    /** Canonical role id that owns the fix. */
    readonly role: string;
    /** Stage id the lesson applies to. */
    readonly stage: string;
    /** Human-facing stage name, captured at record time. */
    readonly stageName?: string;
    /** Gate type (`checklist` / `keyword` / `script` / `composite` / `dod`). */
    readonly gateType: string;
    readonly kind: LessonKind;
    /** The actionable lesson: what went wrong and what to do instead. */
    readonly text: string;
    /** The gate's / audit's own verdict line, quoted for auditability. */
    readonly detail?: string;
    /** Factory where the lesson was seen (for scoped resolution). */
    readonly factoryId?: string;
    /** Task family of that factory. */
    readonly taskType?: string;
}
/** What one {@link EvolutionStore.record} call changed. */
export interface EvolutionRecordReport {
    /** New distinct lessons inserted. */
    readonly added: number;
    /** Existing lessons whose `count` was incremented. */
    readonly updated: number;
    /** Distinct lessons in the ledger afterwards (≤ {@link EVOLUTION_MAX_LESSONS}). */
    readonly total: number;
}
/** Scope of one {@link EvolutionStore.resolve} call. */
export interface EvolutionResolveInput {
    /** Only lessons last seen in this factory may be resolved. */
    readonly factoryId: string;
    /** When given, only lessons of this stage are resolved. */
    readonly stage?: string;
    /** When given, only lessons owned by one of these roles are resolved. */
    readonly roles?: readonly string[];
    /** Timestamp to stamp (`resolvedAt`). Defaults to the store clock. */
    readonly at?: number;
}
/** Lower-cased, trimmed comparison form (role / stage / gate type / text). */
export declare function normaliseLessonKey(value: string): string;
/** Collapses whitespace into one line and clips to the stored text budget. */
export declare function tidyLessonText(value: string): string;
/** The normalised text that participates in the dedup signature. */
export declare function normalizeLessonText(text: string): string;
/** The dedup signature of one lesson: `role|stage|gateType|kind|normalised text`. */
export declare function lessonSignature(input: {
    readonly role: string;
    readonly stage: string;
    readonly gateType: string;
    readonly kind: string;
    readonly text: string;
}): string;
/** Stable lesson id: a short hash of {@link lessonSignature}. */
export declare function lessonIdFor(input: {
    readonly role: string;
    readonly stage: string;
    readonly gateType: string;
    readonly kind: string;
    readonly text: string;
}): string;
/**
 * Deterministic lesson order used by every projection and selector:
 * `count` descending → `lastAt` descending → `id` ascending.
 *
 * Recurrence is the loud signal, recency breaks ties, and the id makes the order
 * total — the same inputs always produce byte-identical output, which is what
 * lets the prompt renderers stay pure.
 */
export declare function compareLessons(left: LessonRecord, right: LessonRecord): number;
/**
 * Lessons of one role — the selector the member brief / rework order uses.
 *
 * Pure: no clock, no randomness, no I/O. Resolved lessons are deliberately
 * **kept** (the renderer annotates them 「已修复，勿回退」); they are history a
 * member must not undo, not noise.
 *
 * @param lessons - the whole ledger (or any subset).
 * @param role - canonical role id.
 * @param stage - optional stage id filter (omitted = every stage).
 * @param limit - max rows returned (default 6).
 * @returns the matching lessons, deterministically ordered, capped.
 */
export declare function selectLessonsForRole(lessons: readonly LessonRecord[], role: string, stage?: string, limit?: number): LessonRecord[];
/**
 * The cockpit projection's lesson filter: lessons owned by the factory's own
 * roster **plus** globally recurring ones (`count > 1`).
 *
 * The panel is a focus surface, not an archive: a one-off mistake of a role that
 * is not even on this roster is noise, while a mistake this workspace keeps
 * repeating is worth showing even when the owning role sits elsewhere.
 *
 * @param lessons - the whole ledger.
 * @param options - `roles` = the factory roster; `limit` defaults to 12.
 * @returns the selected lessons, deterministically ordered, capped.
 */
export declare function selectEvolutionLessons(lessons: readonly LessonRecord[], options?: {
    readonly roles?: readonly string[];
    readonly limit?: number;
}): LessonRecord[];
/** Roll-up of the whole ledger (`stats` is computed over all lessons, never a slice). */
export declare function evolutionStats(lessons: readonly LessonRecord[]): EvolutionStats;
/**
 * Full cockpit view over any lesson list: stats over the whole set, lessons
 * deterministically ordered and capped.
 *
 * @param lessons - the ledger.
 * @param limit - max lesson rows (default 12).
 */
export declare function buildEvolutionView(lessons: readonly LessonRecord[], limit?: number): EvolutionView;
/**
 * The workspace's evolution ledger.
 *
 * Construct with the **state root** (`<workspace>/.code-factory`), the same
 * directory {@link import('./store.js').FactoryStore} owns; `FactoryStore`
 * exposes one shared instance as `store.evolution`.
 */
export declare class EvolutionStore {
    /** Absolute state root (`<workspace>/<stateDir>`). */
    readonly root: string;
    /** Absolute path of `evolution.json`. */
    readonly file: string;
    private readonly primitives;
    private readonly clock;
    private readonly warn;
    constructor(root: string, options?: EvolutionStoreOptions);
    /** The lock key this ledger's writers serialise on (never a factory id). */
    lockKey(): string;
    /**
     * Read the ledger. **Total** by contract: missing file, unreadable file,
     * invalid JSON, a future schema version and individually malformed rows all
     * degrade to fewer lessons (usually `[]`); this method never throws.
     *
     * Rows are capped at {@link EVOLUTION_MAX_LESSONS}, keeping the newest
     * `lastAt`, and returned in the deterministic {@link compareLessons} order.
     */
    read(): Promise<LessonRecord[]>;
    /** Roll-up of the ledger. Never throws (an unreadable ledger is empty). */
    stats(): Promise<EvolutionStats>;
    /**
     * The full cockpit view (`stats` over the whole ledger, lessons ordered).
     * Never throws; a corrupt ledger reads as empty.
     */
    view(limit?: number): Promise<EvolutionView>;
    /**
     * Record one or more lessons, deduplicating by signature.
     *
     * A repeat increments `count`, refreshes `lastAt` / `factoryId` / `taskType` /
     * `stageName` / `detail`, keeps `firstAt`, and clears `resolvedAt` (the
     * mistake recurred, so it is open again). The whole read-modify-write runs
     * under {@link EvolutionStore.lockKey} and is persisted atomically.
     *
     * @throws only when the ledger cannot be persisted — callers that must not be
     *         affected by the ledger (the gate) wrap this in try/catch.
     */
    record(entries: readonly EvolutionRecordInput[]): Promise<EvolutionRecordReport>;
    /**
     * Mark the open lessons of one factory/stage (+optional roles) as resolved.
     *
     * Scoped resolution is deliberate: a gate that passes must never close a
     * lesson recorded by another factory, another stage, or a role that was not
     * part of this stage's fix.
     *
     * @returns how many lessons were newly stamped.
     */
    resolve(input: EvolutionResolveInput): Promise<number>;
    /**
     * Tolerant read. Shared by the public read path and by the locked writers
     * (which already hold {@link EvolutionStore.lockKey}).
     */
    private readUnlocked;
    /** Atomic envelope write (same temp+rename+direct-fallback path as the store). */
    private write;
    private report;
}
