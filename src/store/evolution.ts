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

import { createHash } from 'node:crypto'
import path from 'node:path'

import type { EvolutionStats, EvolutionView, LessonKind, LessonRecord } from '../shared/types.js'
import { LESSON_KINDS } from '../shared/types.js'

import {
  nodeFilePrimitives,
  replaceFileAtomicOrDirect,
  temporaryPathFor,
  type FilePrimitives,
} from './atomic.js'
import { withFactoryLock } from './lock.js'

/* --------------------------------------------------------------- constants */

/** On-disk shape version of `evolution.json`. */
export const EVOLUTION_SCHEMA_VERSION = 1

/** File name of the ledger inside the state root (`.code-factory/evolution.json`). */
export const EVOLUTION_FILE = 'evolution.json'

/** Hard cap on distinct lessons kept. Older rows are dropped by `lastAt`. */
export const EVOLUTION_MAX_LESSONS = 200

/** Longest stored lesson text, in characters (one-line, whitespace collapsed). */
export const EVOLUTION_TEXT_MAX_CHARS = 400

/** Prefix of the lock key handed to `withFactoryLock`. */
export const EVOLUTION_LOCK_PREFIX = 'evolution:'

/** Default number of lessons a prompt selector / summary returns. */
export const EVOLUTION_SELECT_DEFAULT_LIMIT = 6

/* ----------------------------------------------------------------- options */

/** Construction options for {@link EvolutionStore}. */
export interface EvolutionStoreOptions {
  /** Injected filesystem face. Defaults to the real `node:fs/promises` adapter. */
  readonly primitives?: FilePrimitives
  /** Clock. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Non-fatal observation sink (corrupt file, dropped rows). Never throws. */
  readonly onWarning?: (code: string, message: string) => void
}

/** One lesson to record (the dedup id is derived, never supplied). */
export interface EvolutionRecordInput {
  /** Canonical role id that owns the fix. */
  readonly role: string
  /** Stage id the lesson applies to. */
  readonly stage: string
  /** Human-facing stage name, captured at record time. */
  readonly stageName?: string
  /** Gate type (`checklist` / `keyword` / `script` / `composite` / `dod`). */
  readonly gateType: string
  readonly kind: LessonKind
  /** The actionable lesson: what went wrong and what to do instead. */
  readonly text: string
  /** The gate's / audit's own verdict line, quoted for auditability. */
  readonly detail?: string
  /** Factory where the lesson was seen (for scoped resolution). */
  readonly factoryId?: string
  /** Task family of that factory. */
  readonly taskType?: string
}

/** What one {@link EvolutionStore.record} call changed. */
export interface EvolutionRecordReport {
  /** New distinct lessons inserted. */
  readonly added: number
  /** Existing lessons whose `count` was incremented. */
  readonly updated: number
  /** Distinct lessons in the ledger afterwards (≤ {@link EVOLUTION_MAX_LESSONS}). */
  readonly total: number
}

/** Scope of one {@link EvolutionStore.resolve} call. */
export interface EvolutionResolveInput {
  /** Only lessons last seen in this factory may be resolved. */
  readonly factoryId: string
  /** When given, only lessons of this stage are resolved. */
  readonly stage?: string
  /** When given, only lessons owned by one of these roles are resolved. */
  readonly roles?: readonly string[]
  /** Timestamp to stamp (`resolvedAt`). Defaults to the store clock. */
  readonly at?: number
}

/* -------------------------------------------------------------- signatures */

/** Lower-cased, trimmed comparison form (role / stage / gate type / text). */
export function normaliseLessonKey(value: string): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** Collapses whitespace into one line and clips to the stored text budget. */
export function tidyLessonText(value: string): string {
  const collapsed = String(value).replace(/\s+/g, ' ').trim()
  return collapsed.length <= EVOLUTION_TEXT_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, EVOLUTION_TEXT_MAX_CHARS)}…`
}

/** The normalised text that participates in the dedup signature. */
export function normalizeLessonText(text: string): string {
  return normaliseLessonKey(tidyLessonText(text))
}

/** The dedup signature of one lesson: `role|stage|gateType|kind|normalised text`. */
export function lessonSignature(input: {
  readonly role: string
  readonly stage: string
  readonly gateType: string
  readonly kind: string
  readonly text: string
}): string {
  return [
    normaliseLessonKey(input.role),
    normaliseLessonKey(input.stage),
    normaliseLessonKey(input.gateType),
    normaliseLessonKey(input.kind),
    normalizeLessonText(input.text),
  ].join('|')
}

/** Stable lesson id: a short hash of {@link lessonSignature}. */
export function lessonIdFor(input: {
  readonly role: string
  readonly stage: string
  readonly gateType: string
  readonly kind: string
  readonly text: string
}): string {
  return createHash('sha256').update(lessonSignature(input)).digest('hex').slice(0, 16)
}

/* --------------------------------------------------------------- selectors */

/**
 * Deterministic lesson order used by every projection and selector:
 * `count` descending → `lastAt` descending → `id` ascending.
 *
 * Recurrence is the loud signal, recency breaks ties, and the id makes the order
 * total — the same inputs always produce byte-identical output, which is what
 * lets the prompt renderers stay pure.
 */
export function compareLessons(left: LessonRecord, right: LessonRecord): number {
  return right.count - left.count || right.lastAt - left.lastAt || left.id.localeCompare(right.id)
}

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
export function selectLessonsForRole(
  lessons: readonly LessonRecord[],
  role: string,
  stage?: string,
  limit: number = EVOLUTION_SELECT_DEFAULT_LIMIT,
): LessonRecord[] {
  if (!Number.isFinite(limit) || limit <= 0) return []
  const wanted = normaliseLessonKey(role)
  if (wanted === '') return []
  const wantedStage = stage === undefined ? undefined : normaliseLessonKey(stage)
  const filtered = lessons.filter(
    (lesson) =>
      normaliseLessonKey(lesson.role) === wanted
      && (wantedStage === undefined || wantedStage === '' || normaliseLessonKey(lesson.stage) === wantedStage),
  )
  return [...filtered].sort(compareLessons).slice(0, Math.trunc(limit))
}

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
export function selectEvolutionLessons(
  lessons: readonly LessonRecord[],
  options: { readonly roles?: readonly string[]; readonly limit?: number } = {},
): LessonRecord[] {
  const limit = options.limit ?? 12
  if (!Number.isFinite(limit) || limit <= 0) return []
  const roles = new Set((options.roles ?? []).map(normaliseLessonKey).filter((role) => role !== ''))
  const selected = lessons.filter(
    (lesson) => (roles.size > 0 && roles.has(normaliseLessonKey(lesson.role))) || lesson.count > 1,
  )
  return [...selected].sort(compareLessons).slice(0, Math.trunc(limit))
}

/** Roll-up of the whole ledger (`stats` is computed over all lessons, never a slice). */
export function evolutionStats(lessons: readonly LessonRecord[]): EvolutionStats {
  let recurring = 0
  let resolved = 0
  let lastAt: number | undefined
  for (const lesson of lessons) {
    if (lesson.count > 1) recurring += 1
    if (lesson.resolvedAt !== undefined) resolved += 1
    if (lastAt === undefined || lesson.lastAt > lastAt) lastAt = lesson.lastAt
  }
  return {
    total: lessons.length,
    recurring,
    resolved,
    ...(lastAt === undefined ? {} : { lastAt }),
  }
}

/**
 * Full cockpit view over any lesson list: stats over the whole set, lessons
 * deterministically ordered and capped.
 *
 * @param lessons - the ledger.
 * @param limit - max lesson rows (default 12).
 */
export function buildEvolutionView(lessons: readonly LessonRecord[], limit = 12): EvolutionView {
  const capped = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 12
  return {
    stats: evolutionStats(lessons),
    lessons: [...lessons].sort(compareLessons).slice(0, capped),
  }
}

/* --------------------------------------------------------------- validation */

function isLessonKind(value: unknown): value is LessonKind {
  return typeof value === 'string' && (LESSON_KINDS as readonly string[]).includes(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = finiteNumber(value)
  return parsed === undefined || parsed < 1 ? undefined : Math.trunc(parsed)
}

/**
 * Structural parse of one persisted row.
 *
 * Anything the record could not answer a question about is dropped (and
 * reported), never guessed: a lesson with a missing role or a non-numeric
 * `count` would corrupt every selector that reads it.
 */
function parseLesson(value: unknown): LessonRecord | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id.trim() === '') return undefined
  if (typeof record.role !== 'string' || record.role.trim() === '') return undefined
  if (typeof record.stage !== 'string' || record.stage.trim() === '') return undefined
  if (typeof record.gateType !== 'string' || record.gateType.trim() === '') return undefined
  if (!isLessonKind(record.kind)) return undefined
  if (typeof record.text !== 'string' || record.text.trim() === '') return undefined
  const count = positiveInteger(record.count)
  const firstAt = finiteNumber(record.firstAt)
  const lastAt = finiteNumber(record.lastAt)
  if (count === undefined || firstAt === undefined || lastAt === undefined) return undefined
  const resolvedAt = finiteNumber(record.resolvedAt)
  const lesson: LessonRecord = {
    id: record.id,
    role: record.role,
    stage: record.stage,
    gateType: record.gateType,
    kind: record.kind,
    text: record.text,
    count,
    firstAt,
    lastAt,
    ...(typeof record.stageName === 'string' ? { stageName: record.stageName } : {}),
    ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(typeof record.factoryId === 'string' ? { factoryId: record.factoryId } : {}),
    ...(typeof record.taskType === 'string' ? { taskType: record.taskType } : {}),
  }
  return lesson
}

function isNotFound(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { readonly code?: unknown }).code
    return typeof code === 'string' ? `${code}: ${error.message}` : error.message
  }
  return String(error)
}

/* ------------------------------------------------------------------- store */

/**
 * The workspace's evolution ledger.
 *
 * Construct with the **state root** (`<workspace>/.code-factory`), the same
 * directory {@link import('./store.js').FactoryStore} owns; `FactoryStore`
 * exposes one shared instance as `store.evolution`.
 */
export class EvolutionStore {
  /** Absolute state root (`<workspace>/<stateDir>`). */
  readonly root: string
  /** Absolute path of `evolution.json`. */
  readonly file: string

  private readonly primitives: FilePrimitives
  private readonly clock: () => number
  private readonly warn: ((code: string, message: string) => void) | undefined

  constructor(root: string, options: EvolutionStoreOptions = {}) {
    this.root = path.resolve(root)
    this.file = path.join(this.root, EVOLUTION_FILE)
    this.primitives = options.primitives ?? nodeFilePrimitives
    this.clock = options.now ?? Date.now
    this.warn = options.onWarning
  }

  /** The lock key this ledger's writers serialise on (never a factory id). */
  lockKey(): string {
    return `${EVOLUTION_LOCK_PREFIX}${this.root}`
  }

  /**
   * Read the ledger. **Total** by contract: missing file, unreadable file,
   * invalid JSON, a future schema version and individually malformed rows all
   * degrade to fewer lessons (usually `[]`); this method never throws.
   *
   * Rows are capped at {@link EVOLUTION_MAX_LESSONS}, keeping the newest
   * `lastAt`, and returned in the deterministic {@link compareLessons} order.
   */
  async read(): Promise<LessonRecord[]> {
    return await this.readUnlocked()
  }

  /** Roll-up of the ledger. Never throws (an unreadable ledger is empty). */
  async stats(): Promise<EvolutionStats> {
    return evolutionStats(await this.readUnlocked())
  }

  /**
   * The full cockpit view (`stats` over the whole ledger, lessons ordered).
   * Never throws; a corrupt ledger reads as empty.
   */
  async view(limit = 12): Promise<EvolutionView> {
    return buildEvolutionView(await this.readUnlocked(), limit)
  }

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
  async record(entries: readonly EvolutionRecordInput[]): Promise<EvolutionRecordReport> {
    const inputs: EvolutionRecordInput[] = []
    for (const entry of entries) {
      const normalised = normaliseInput(entry)
      if (normalised !== undefined) inputs.push(normalised)
    }
    if (inputs.length === 0) {
      const current = await this.readUnlocked()
      return { added: 0, updated: 0, total: current.length }
    }
    return await withFactoryLock(this.lockKey(), async (): Promise<EvolutionRecordReport> => {
      const lessons = await this.readUnlocked()
      const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]))
      const at = this.clock()
      let added = 0
      let updated = 0

      for (const input of inputs) {
        const id = lessonIdFor(input)
        const existing = byId.get(id)
        const context = {
          ...(input.stageName === undefined ? {} : { stageName: input.stageName }),
          ...(input.detail === undefined ? {} : { detail: input.detail }),
          ...(input.factoryId === undefined ? {} : { factoryId: input.factoryId }),
          ...(input.taskType === undefined ? {} : { taskType: input.taskType }),
        }
        if (existing === undefined) {
          byId.set(id, {
            id,
            role: input.role,
            stage: input.stage,
            gateType: input.gateType,
            kind: input.kind,
            text: input.text,
            count: 1,
            firstAt: at,
            lastAt: at,
            ...context,
          })
          added += 1
          continue
        }
        // Recurrence re-opens a resolved lesson: it just happened again.
        const { resolvedAt: _resolved, ...open } = existing
        byId.set(id, {
          ...open,
          text: input.text,
          count: existing.count + 1,
          lastAt: at,
          ...context,
        })
        updated += 1
      }

      const kept = [...byId.values()]
        // Cap by recency first (the cap is "keep the newest `lastAt`"), then
        // store in the deterministic selector order for a stable file diff.
        .sort((left, right) => right.lastAt - left.lastAt || left.id.localeCompare(right.id))
        .slice(0, EVOLUTION_MAX_LESSONS)
        .sort(compareLessons)
      await this.write(kept)
      return { added, updated, total: kept.length }
    })
  }

  /**
   * Mark the open lessons of one factory/stage (+optional roles) as resolved.
   *
   * Scoped resolution is deliberate: a gate that passes must never close a
   * lesson recorded by another factory, another stage, or a role that was not
   * part of this stage's fix.
   *
   * @returns how many lessons were newly stamped.
   */
  async resolve(input: EvolutionResolveInput): Promise<number> {
    const factoryId = typeof input.factoryId === 'string' ? input.factoryId.trim() : ''
    if (factoryId === '') return 0
    const roles =
      input.roles === undefined
        ? undefined
        : new Set(input.roles.map(normaliseLessonKey).filter((role) => role !== ''))
    return await withFactoryLock(this.lockKey(), async (): Promise<number> => {
      const lessons = await this.readUnlocked()
      const at = input.at ?? this.clock()
      let changed = 0
      const next = lessons.map((lesson) => {
        if (lesson.resolvedAt !== undefined) return lesson
        if (lesson.factoryId !== factoryId) return lesson
        if (input.stage !== undefined && lesson.stage !== input.stage) return lesson
        if (roles !== undefined && !roles.has(normaliseLessonKey(lesson.role))) return lesson
        changed += 1
        return { ...lesson, resolvedAt: at }
      })
      if (changed > 0) await this.write(next)
      return changed
    })
  }

  /* ------------------------------------------------------------- internals */

  /**
   * Tolerant read. Shared by the public read path and by the locked writers
   * (which already hold {@link EvolutionStore.lockKey}).
   */
  private async readUnlocked(): Promise<LessonRecord[]> {
    let raw: string
    try {
      raw = await this.primitives.readFile(this.file, { encoding: 'utf8' })
    } catch (error) {
      if (!isNotFound(error)) {
        this.report('evolution-unreadable', `无法读取 ${this.file}：${describeError(error)}；按空账本处理`)
      }
      return []
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.report('evolution-corrupt', `${this.file} 不是合法 JSON（${describeError(error)}）；按空账本处理`)
      return []
    }

    let candidates: unknown[] | undefined
    let version: unknown
    if (Array.isArray(parsed)) {
      // Legacy/hand-written shorthand: a bare array of lessons.
      candidates = parsed
    } else if (parsed !== null && typeof parsed === 'object') {
      const envelope = parsed as { readonly schemaVersion?: unknown; readonly lessons?: unknown }
      version = envelope.schemaVersion
      if (Array.isArray(envelope.lessons)) candidates = envelope.lessons
    }

    if (typeof version === 'number' && version > EVOLUTION_SCHEMA_VERSION) {
      this.report(
        'evolution-schema-newer',
        `${this.file} 的 schemaVersion=${version} 高于本版本支持的 ${EVOLUTION_SCHEMA_VERSION}；为避免误读，按空账本处理`,
      )
      return []
    }
    if (candidates === undefined) {
      this.report('evolution-shape-invalid', `${this.file} 没有 lessons 数组；按空账本处理`)
      return []
    }

    const byId = new Map<string, LessonRecord>()
    let dropped = 0
    for (const candidate of candidates) {
      const lesson = parseLesson(candidate)
      if (lesson === undefined) {
        dropped += 1
        continue
      }
      const previous = byId.get(lesson.id)
      // A duplicate id (hand-edit / double write) keeps the fresher row.
      if (previous === undefined || lesson.lastAt > previous.lastAt) byId.set(lesson.id, lesson)
    }
    if (dropped > 0) {
      this.report('evolution-entry-invalid', `${this.file} 中有 ${dropped} 条记录结构不合法，已跳过`)
    }
    return [...byId.values()]
      .sort((left, right) => right.lastAt - left.lastAt || left.id.localeCompare(right.id))
      .slice(0, EVOLUTION_MAX_LESSONS)
      .sort(compareLessons)
  }

  /** Atomic envelope write (same temp+rename+direct-fallback path as the store). */
  private async write(lessons: readonly LessonRecord[]): Promise<void> {
    const payload = `${JSON.stringify({ schemaVersion: EVOLUTION_SCHEMA_VERSION, lessons }, null, 2)}\n`
    await replaceFileAtomicOrDirect(temporaryPathFor(this.file), this.file, payload, this.primitives)
  }

  private report(code: string, message: string): void {
    if (this.warn === undefined) return
    try {
      this.warn(code, message)
    } catch {
      /* diagnostics must never break a read */
    }
  }
}

/* --------------------------------------------------------------- internals */

/** Validates and normalises one record input; `undefined` = not recordable. */
function normaliseInput(entry: EvolutionRecordInput): EvolutionRecordInput | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const role = normaliseLessonKey(entry.role)
  const stage = normaliseLessonKey(entry.stage)
  const gateType = normaliseLessonKey(entry.gateType)
  if (role === '' || stage === '' || gateType === '') return undefined
  if (!isLessonKind(entry.kind)) return undefined
  if (typeof entry.text !== 'string') return undefined
  const text = tidyLessonText(entry.text)
  if (text === '') return undefined
  return {
    role,
    stage,
    gateType,
    kind: entry.kind,
    text,
    ...(entry.stageName === undefined ? {} : { stageName: entry.stageName }),
    ...(entry.detail === undefined ? {} : { detail: tidyLessonText(entry.detail) }),
    ...(entry.factoryId === undefined ? {} : { factoryId: entry.factoryId }),
    ...(entry.taskType === undefined ? {} : { taskType: entry.taskType }),
  }
}
