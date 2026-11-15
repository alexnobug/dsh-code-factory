/**
 * Host data channel for the cockpit panel.
 *
 * The client half has no Remote for factory state (docs/API-CONTRACTS.md §2.6),
 * so the panel polls the host's read-only HTTP projection:
 *
 *   GET <route>?id=<fid>       → one factory's full snapshot (explicit pick)
 *   GET <route>?sessionId=<s>  → the factory owned by that session (§7.2)
 *   GET <route>                → the cross-workspace factory **index** (§7.3)
 *
 * Design rules baked in here:
 *
 *   - **1 s interval, never overlapping.** The tick is skipped while a request
 *     is still in flight, so a slow or wedged host can never build a queue.
 *   - **Shape validation.** The payload is untrusted input: the top level is
 *     checked before anything is accepted, and each array item is normalized
 *     item by item. A malformed payload is reported as a link failure, not
 *     rendered.
 *   - **Last-known-good retention.** A host restart drops the route for a few
 *     seconds. The previous snapshot stays on screen and the link reports
 *     `stale` instead of blanking the panel.
 *   - **The index is not a snapshot.** §7.3 gives the bare route five summary
 *     fields per factory and no collections. It feeds the picker; it can never
 *     supply the panel body, because promoting one of its rows would put an
 *     unrelated workspace's project on screen.
 *   - **No data yet is a state, not an error.** An empty index is `idle`, which
 *     the cockpit renders as its waiting empty state.
 *
 * @module dsh-code-factory/client/api
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  ALERT_KINDS,
  ALERT_SEVERITIES,
  DOD_STATUSES,
  FACTORY_PHASES,
  GATE_TYPES,
  IMPROVEMENT_STATUSES,
  IMPROVEMENT_TARGETS,
  LESSON_KINDS,
  MEMBER_STATUSES,
  MESSAGE_KINDS,
  SECURITY_SIGNAL_SOURCES,
  STAGE_STATUSES,
  UNKNOWN_GATE_TYPE,
} from '../shared/types.js'
import type {
  AlertKind,
  AlertSeverity,
  ArtifactRecord,
  DodKind,
  DodState,
  DodStatus,
  EvolutionStats,
  EvolutionView,
  FactoryMessage,
  FactoryPhase,
  FactorySnapshot,
  GateDef,
  GateResult,
  GateType,
  ImprovementProposal,
  LessonRecord,
  MemberStatus,
  MessageKind,
  SnapshotAlert,
  SnapshotMember,
  SnapshotStage,
  StageStatus,
} from '../shared/types.js'

/* ------------------------------------------------------------------ route */

/** HTTP projection registered by the host half (`cordis.patch.yml` companion). */
export const CODE_FACTORY_STATE_ROUTE = '/plugins/code-factory/state'

/** Polling cadence. One second is the documented cockpit contract. */
export const FACTORY_POLL_MS = 1000

/** Query parameter carrying the selected factory id. */
export const FACTORY_ID_PARAM = 'id'

/** Query parameter carrying the session whose factory should be reported. */
export const SESSION_ID_PARAM = 'sessionId'

/**
 * Build the projection URL for one polling scope (docs/API-CONTRACTS.md §7.1).
 *
 * The three shapes are deliberately exclusive, and the client never sends a
 * filesystem path: workspace resolution belongs entirely to the host (§7.2).
 *
 * - `factoryId`  → `?id=<factoryId>`    one factory's snapshot
 * - `sessionId`  → `?sessionId=<sid>`   the factory owned by that session
 * - neither      → the bare route        the cross-workspace factory index
 *
 * @param route - projection route.
 * @param factoryId - explicit factory selection, when one was made.
 * @param sessionId - session scope, used by session-bound surfaces.
 * @returns the request URL.
 */
export function factoryStateUrl(
  route: string,
  factoryId: string | undefined,
  sessionId: string | undefined,
): string {
  if (factoryId !== undefined && factoryId !== '') return `${route}?${FACTORY_ID_PARAM}=${encodeURIComponent(factoryId)}`
  if (sessionId !== undefined && sessionId !== '') return `${route}?${SESSION_ID_PARAM}=${encodeURIComponent(sessionId)}`
  return route
}

/* -------------------------------------------------------------- vocabulary */

/**
 * The six closed vocabularies this parser validates against come from
 * `src/shared/types.ts` — the same constants the host half writes with.
 *
 * They used to be hand-copied here (review finding H8). A drift was invisible by
 * construction: every lookup below falls back to a default rather than throwing,
 * so a client that had fallen behind would have rendered a plausible panel built
 * from stale vocabulary and never reported anything wrong.
 */

/* ------------------------------------------------------------ link status */

/**
 * Transport state of the host channel, independent of whether a factory exists.
 *
 * - `idle` — reachable, host has no factory to report yet.
 * - `connecting` — first request of this mount is in flight.
 * - `live` — last request succeeded.
 * - `stale` — last request failed but a snapshot is still on screen (host restart).
 * - `error` — last request failed and there is nothing to show.
 */
export type FactoryLinkStatus = 'idle' | 'connecting' | 'live' | 'stale' | 'error'

/** What the cockpit receives from {@link useFactoryState}. */
export interface FactoryStateFeed {
  readonly status: FactoryLinkStatus
  /** Newest accepted snapshot; retained across host restarts. */
  readonly snapshot: FactorySnapshot | undefined
  /**
   * False while {@link snapshot} is an index summary rather than a full
   * snapshot. The summary's own fields (`id` / `name` / `taskType` / `phase` /
   * `updatedAt`) are real and may be shown; its collections are normalization
   * artifacts and must never be rendered as "currently empty". The hook upgrades
   * to `?id=` on the next tick, so this is a one-tick state in practice.
   */
  readonly complete: boolean
  /** Every factory the host reported, newest first (for the header picker). */
  readonly factories: readonly FactorySnapshot[]
  /** Epoch ms of the last successful read. */
  readonly lastOkAt: number | undefined
  /** Last transport/validation failure message, when the link is not live. */
  readonly error: string | undefined
  /** True while a request is in flight. */
  readonly refreshing: boolean
  /** Force an immediate re-read (the header refresh button). */
  readonly reload: () => void
}

/** Options accepted by {@link useFactoryState}. */
export interface UseFactoryStateOptions {
  /**
   * Explicit factory id (`?id=`). Takes precedence over {@link sessionId}, and
   * is what the root-scoped cockpit sends once the user picks a factory.
   */
  readonly factoryId?: string | undefined
  /**
   * Session scope (`?sessionId=`), for surfaces mounted inside one session —
   * the turn summary card. The host resolves the workspace itself
   * (docs/API-CONTRACTS.md §7.2); the client never sends a path.
   */
  readonly sessionId?: string | undefined
  /** Polling cadence override, for tests. */
  readonly pollMs?: number | undefined
  /** Route override, for tests or a relocated projection. */
  readonly route?: string | undefined
  /**
   * Set false to stop the **interval** (the cockpit's pause switch).
   *
   * A manual `reload()` while disabled still performs exactly one read — the
   * pause button's contract is "stop polling", not "freeze every request" — and
   * turning it back on performs an immediate read before re-arming the interval.
   */
  readonly enabled?: boolean | undefined
}

/* -------------------------------------------------------------- validation */

type Unknown = Record<string, unknown>

function isRecord(value: unknown): value is Unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Accept a rendered counter: a whole, non-negative number.
 *
 * Counters are printed directly ("总教训 -1" / "×0.5" would be nonsense), so a
 * finite number is not enough — a fractional or negative one is a shape we do
 * not understand and is treated as unreadable rather than coerced.
 *
 * @param value - untrusted wire value.
 * @returns the value when it is a non-negative integer, else `undefined`.
 */
function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

/**
 * DoD check kinds, kept local because `src/shared/types.ts` exports the
 * {@link DodKind} union but no runtime whitelist for it (unlike the state
 * unions). Used only to narrow display text: an unknown kind is dropped rather
 * than rendered as a guessed check.
 */
const DOD_KINDS = ['file', 'keyword', 'script', 'git', 'crossref'] as const satisfies readonly DodKind[]

/**
 * How deep a composite gate's nested checks are followed. A self-referential or
 * pathologically nested payload must not recurse forever in the browser.
 */
const GATE_DEPTH_LIMIT = 4

/**
 * Validate one gate rule, including the nested checks of a composite.
 *
 * A gate whose `type` is unknown is not a rule the panel can explain, so it is
 * dropped (`undefined`); every other field is optional and kept only when
 * readable. Composite children are normalized recursively under
 * {@link GATE_DEPTH_LIMIT}.
 *
 * @param raw - decoded JSON value of unknown provenance.
 * @param depth - current nesting depth (0 for the stage's own gate).
 * @returns the normalized gate, or `undefined` when the shape is wrong.
 */
function normalizeGateDef(raw: unknown, depth = 0): GateDef | undefined {
  if (depth > GATE_DEPTH_LIMIT || !isRecord(raw)) return undefined
  const type = knownOf(GATE_TYPES, raw.type)
  if (type === undefined) return undefined
  const gate: GateDef = { type }
  const artifact = asString(raw.artifact)
  const rawSections = asArray(raw.requiredSections)
  const requiredSections =
    rawSections === undefined
      ? undefined
      : rawSections.filter((section): section is string => typeof section === 'string' && section.trim() !== '')
  const passWord = asString(raw.passWord)
  const failWord = asString(raw.failWord)
  const run = asString(raw.run)
  const rawChecks = asArray(raw.checks)
  const checks =
    rawChecks === undefined
      ? undefined
      : rawChecks
          .map(check => normalizeGateDef(check, depth + 1))
          .filter((check): check is GateDef => check !== undefined)
  return {
    ...gate,
    ...(artifact === undefined ? {} : { artifact }),
    ...(requiredSections === undefined ? {} : { requiredSections }),
    ...(passWord === undefined ? {} : { passWord }),
    ...(failWord === undefined ? {} : { failWord }),
    ...(run === undefined ? {} : { run }),
    ...(checks === undefined ? {} : { checks }),
  }
}

/**
 * Validate one recorded gate verdict.
 *
 * The verdict is audit evidence, so `type` / `detail` / `at` must be readable;
 * `ok` defaults to false (never a passed gate by accident) and the optional
 * exit code / artifact are kept only when present.
 *
 * @param raw - decoded JSON value of unknown provenance.
 * @returns the normalized verdict, or `undefined` when the shape is wrong.
 */
function normalizeGateResult(raw: unknown): GateResult | undefined {
  if (!isRecord(raw)) return undefined
  const type = knownOf(GATE_TYPES, raw.type)
  const detail = asString(raw.detail)
  const at = asNumber(raw.at)
  if (type === undefined || detail === undefined || at === undefined) return undefined
  const exitCode = asNumber(raw.exitCode)
  const artifact = asString(raw.artifact)
  return {
    type,
    ok: raw.ok === true,
    detail,
    at,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(artifact === undefined ? {} : { artifact }),
  }
}

/**
 * Accept a wire value that must be one of a fixed vocabulary.
 *
 * The lookup walks the allowed union, so no cast is needed to compare an
 * incoming `string` against it and the result keeps the union's literal type.
 *
 * @param allowed - the closed vocabulary.
 * @param value - untrusted wire value.
 * @param fallback - value used when the wire value is absent or unknown.
 * @returns a member of `allowed`.
 */
function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  return allowed.find((candidate): candidate is T => candidate === value) ?? fallback
}

/**
 * Narrow an untrusted wire value to one of a fixed vocabulary.
 *
 * @param allowed - the closed vocabulary.
 * @param value - untrusted wire value.
 * @returns the matching member, or `undefined` when the value is unknown.
 */
function knownOf<T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  if (typeof value !== 'string') return undefined
  return allowed.find((candidate): candidate is T => candidate === value)
}

function normalizeMember(raw: unknown): SnapshotMember | undefined {
  if (!isRecord(raw)) return undefined
  const role = asString(raw.role)
  if (!role) return undefined
  const member: SnapshotMember = {
    role,
    title: asString(raw.title) ?? role,
    codename: asString(raw.codename) ?? role.toUpperCase(),
    color: asString(raw.color) ?? '',
    duties: asString(raw.duties) ?? '',
    tier: raw.tier === 'reasoner' ? 'reasoner' : 'chat',
    status: oneOf(MEMBER_STATUSES, raw.status, 'staged'),
    tokens: asNumber(raw.tokens) ?? 0,
  }
  return attachOptionals(member, raw)
}

/** Copy the optional fields without ever writing an explicit `undefined`. */
function attachOptionals(member: SnapshotMember, raw: Unknown): SnapshotMember {
  const currentStage = asString(raw.currentStage)
  const sessionId = asString(raw.sessionId)
  const spawnError = asString(raw.spawnError)
  const provider = asString(raw.provider)
  const model = asString(raw.model)
  const reasoningEffort = asString(raw.reasoningEffort)
  const startedAt = asNumber(raw.startedAt)
  const endedAt = asNumber(raw.endedAt)
  return {
    ...member,
    ...(currentStage === undefined ? {} : { currentStage }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(spawnError === undefined ? {} : { spawnError }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
  }
}

function normalizeStage(raw: unknown): SnapshotStage | undefined {
  if (!isRecord(raw)) return undefined
  const id = asString(raw.id)
  if (!id) return undefined
  const failGoto = asString(raw.failGoto)
  const maxRounds = asCount(raw.maxRounds)
  const attempts = asCount(raw.attempts)
  const startedAt = asNumber(raw.startedAt)
  const endedAt = asNumber(raw.endedAt)
  const lastGate = normalizeGateResult(raw.lastGate)
  const gate = normalizeGateDef(raw.gate)
  const stage: SnapshotStage = {
    id,
    name: asString(raw.name) ?? id,
    status: oneOf(STAGE_STATUSES, raw.status, 'pending'),
    round: asNumber(raw.round) ?? 0,
    roles: (asArray(raw.roles) ?? []).filter((role): role is string => typeof role === 'string'),
    parallel: raw.parallel === true,
    humanApproval: raw.humanApproval === true,
    // A `gateType` the host could not resolve is reported as such, not as the
    // most permissive rule available.
    gateType: knownOf(GATE_TYPES, raw.gateType) ?? UNKNOWN_GATE_TYPE,
  }
  return {
    ...stage,
    ...(failGoto === undefined ? {} : { failGoto }),
    ...(maxRounds === undefined ? {} : { maxRounds }),
    ...(attempts === undefined ? {} : { attempts }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(lastGate === undefined ? {} : { lastGate }),
    ...(gate === undefined ? {} : { gate }),
  }
}

function normalizeDod(raw: unknown): DodState | undefined {
  if (!isRecord(raw)) return undefined
  const id = asNumber(raw.id)
  if (id === undefined) return undefined
  const evidence = asString(raw.evidence)
  const status = DOD_STATUSES.find((candidate) => candidate === raw.status)
  const kind = knownOf(DOD_KINDS, raw.kind)
  const artifact = asString(raw.artifact)
  const expect = asString(raw.expect)
  const run = asString(raw.run)
  const item: DodState = {
    id,
    label: asString(raw.label) ?? String(id),
    ok: raw.ok === true,
    ...(status === undefined ? {} : { status }),
    ...(kind === undefined ? {} : { kind }),
    ...(artifact === undefined ? {} : { artifact }),
    ...(expect === undefined ? {} : { expect }),
    ...(run === undefined ? {} : { run }),
    ...(raw.securityOnly === true ? { securityOnly: true } : {}),
  }
  return evidence === undefined ? item : { ...item, evidence }
}

function normalizeArtifact(raw: unknown): ArtifactRecord | undefined {
  if (!isRecord(raw)) return undefined
  const path = asString(raw.path)
  if (!path) return undefined
  return {
    path,
    by: asString(raw.by) ?? '',
    stage: asString(raw.stage) ?? '',
    bytes: asNumber(raw.bytes) ?? 0,
    at: asNumber(raw.at) ?? 0,
  }
}

/**
 * Endpoint shown for a feed row whose `from`/`to` could not be read.
 *
 * A feed row is the one place the panel speaks for two parties at once, and a
 * malformed one used to be attributed to `system → captain`: names the durable
 * record never contained, rendered as an authoritative sender and recipient.
 * A row that cannot be attributed carries this marker instead — the row is still
 * shown (something did arrive, and its body may still be readable), but the
 * endpoint renders as unparsed rather than as a party that never wrote.
 */
export const UNKNOWN_ENDPOINT = 'unknown'

/**
 * Read one feed endpoint.
 *
 * Unlike the other optional fields, `from`/`to` must not be defaulted to a
 * plausible value: `system` and `captain` are real senders, so substituting one
 * would invent the fact the row is missing.
 *
 * @param value - untrusted wire value.
 * @returns the recorded endpoint, or {@link UNKNOWN_ENDPOINT} when it is absent
 *   or blank.
 */
function endpointOf(value: unknown): string {
  const text = asString(value)
  if (text === undefined || text.trim() === '') return UNKNOWN_ENDPOINT
  return text
}

function normalizeMessage(raw: unknown): FactoryMessage | undefined {
  if (!isRecord(raw)) return undefined
  const id = asString(raw.id)
  const ts = asNumber(raw.ts)
  if (!id || ts === undefined) return undefined
  const message: FactoryMessage = {
    id,
    from: endpointOf(raw.from),
    to: endpointOf(raw.to),
    content: asString(raw.content) ?? '',
    ts,
  }
  const kind = knownOf(MESSAGE_KINDS, raw.kind)
  const stage = asString(raw.stage)
  const round = asNumber(raw.round)
  const deliveredAt = asNumber(raw.deliveredAt)
  const readAt = asNumber(raw.readAt)
  return {
    ...message,
    ...(kind === undefined ? {} : { kind }),
    ...(stage === undefined ? {} : { stage }),
    ...(round === undefined ? {} : { round }),
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
    ...(readAt === undefined ? {} : { readAt }),
  }
}

/**
 * Validate one payload entry as an alert.
 *
 * An alert with an unknown `kind` or `severity` is dropped rather than coerced:
 * a banner that says nothing useful is worse than no banner, and the whitelists
 * come from `src/shared/types.ts` so they cannot drift from the server.
 *
 * @param raw - decoded JSON value of unknown provenance.
 * @returns the normalized alert, or `undefined` when the shape is wrong.
 */
function normalizeAlert(raw: unknown): SnapshotAlert | undefined {
  if (!isRecord(raw)) return undefined
  const id = asString(raw.id)
  const title = asString(raw.title)
  const detail = asString(raw.detail)
  const next = asString(raw.next)
  const kind = knownOf<AlertKind>(ALERT_KINDS, raw.kind)
  const severity = knownOf<AlertSeverity>(ALERT_SEVERITIES, raw.severity)
  if (!id || !title || kind === undefined || severity === undefined) return undefined
  const stage = asString(raw.stage)
  const role = asString(raw.role)
  return {
    id,
    kind,
    severity,
    title,
    detail: detail ?? '',
    next: next ?? '',
    ...(stage === undefined ? {} : { stage }),
    ...(role === undefined ? {} : { role }),
  }
}

function normalizeList<T>(value: unknown, item: (raw: unknown) => T | undefined): readonly T[] {
  const list = asArray(value)
  if (!list) return []
  const out: T[] = []
  for (const raw of list) {
    const normalized = item(raw)
    if (normalized !== undefined) out.push(normalized)
  }
  return out
}

/**
 * Validate one payload entry as an evolution lesson.
 *
 * The ledger is a durable file written by hosts of different plugin versions,
 * so a row lacking its identity (`id` / `role` / `stage` / `text`) is dropped:
 * it cannot name a role, a stage, or the action to take, so showing it would
 * be a card that says nothing. Optional audit fields are kept only when the
 * wire value is readable — never written back as an explicit `undefined`.
 *
 * @param raw - decoded JSON value of unknown provenance.
 * @returns the normalized lesson, or `undefined` when the shape is wrong.
 */
function normalizeLesson(raw: unknown): LessonRecord | undefined {
  if (!isRecord(raw)) return undefined
  const id = asString(raw.id)
  const role = asString(raw.role)
  const stage = asString(raw.stage)
  const text = asString(raw.text)
  if (id === undefined || role === undefined || stage === undefined || text === undefined) return undefined
  const lesson: LessonRecord = {
    id,
    role,
    stage,
    gateType: asString(raw.gateType) ?? '',
    kind: knownOf(LESSON_KINDS, raw.kind) ?? 'gate',
    text,
    count: asNumber(raw.count) ?? 1,
    firstAt: asNumber(raw.firstAt) ?? 0,
    lastAt: asNumber(raw.lastAt) ?? 0,
  }
  const stageName = asString(raw.stageName)
  const detail = asString(raw.detail)
  const resolvedAt = asNumber(raw.resolvedAt)
  const factoryId = asString(raw.factoryId)
  const taskType = asString(raw.taskType)
  return {
    ...lesson,
    ...(stageName === undefined ? {} : { stageName }),
    ...(detail === undefined ? {} : { detail }),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(factoryId === undefined ? {} : { factoryId }),
    ...(taskType === undefined ? {} : { taskType }),
  }
}

/**
 * Validate the evolution roll-up counters.
 *
 * The three counters are the only reason the section exists without lessons;
 * a payload missing any of them — or carrying a negative/fractional one — is a
 * shape we do not know how to render, so the whole projection is rejected (and
 * the section omitted) rather than shown as zeroes that would read as "nothing
 * was ever learned", or as a literal "-1 lessons".
 *
 * @param raw - decoded JSON value of unknown provenance.
 * @returns the normalized stats, or `undefined` when the shape is wrong.
 */
function normalizeEvolutionStats(raw: unknown): EvolutionStats | undefined {
  if (!isRecord(raw)) return undefined
  const total = asCount(raw.total)
  const recurring = asCount(raw.recurring)
  const resolved = asCount(raw.resolved)
  if (total === undefined || recurring === undefined || resolved === undefined) return undefined
  const lastAt = asNumber(raw.lastAt)
  return lastAt === undefined ? { total, recurring, resolved } : { total, recurring, resolved, lastAt }
}

/**
 * Validate one evolution payload entry as a plugin-improvement proposal.
 *
 * A proposal without its actionable core (`id` / `title` / `suggestion` /
 * `rationale`), or with an unknown `target`/`status`, is dropped: it cannot tell
 * a human where to change the plugin or what state the evidence is in. The
 * optional fields are kept only when readable.
 *
 * @param raw - decoded JSON value of unknown provenance.
 * @returns the normalized proposal, or `undefined` when the shape is wrong.
 */
export function normalizeImprovement(raw: unknown): ImprovementProposal | undefined {
  if (!isRecord(raw)) return undefined
  const id = asString(raw.id)
  const title = asString(raw.title)
  const suggestion = asString(raw.suggestion)
  const rationale = asString(raw.rationale)
  const target = knownOf(IMPROVEMENT_TARGETS, raw.target)
  const status = knownOf(IMPROVEMENT_STATUSES, raw.status)
  if (
    id === undefined
    || title === undefined
    || suggestion === undefined
    || rationale === undefined
    || target === undefined
    || status === undefined
  ) {
    return undefined
  }
  const targetFile = asString(raw.targetFile)
  const role = asString(raw.role)
  const stage = asString(raw.stage)
  const gateType = asString(raw.gateType)
  const rawLessonIds = asArray(raw.lessonIds)
  const lessonIds =
    rawLessonIds === undefined
      ? []
      : rawLessonIds.filter((lessonId): lessonId is string => typeof lessonId === 'string' && lessonId.trim() !== '')
  return {
    id,
    title,
    target,
    ...(targetFile === undefined ? {} : { targetFile }),
    suggestion,
    rationale,
    ...(role === undefined ? {} : { role }),
    ...(stage === undefined ? {} : { stage }),
    ...(gateType === undefined ? {} : { gateType }),
    lessonIds,
    evidenceCount: asCount(raw.evidenceCount) ?? 0,
    status,
    lastAt: asNumber(raw.lastAt) ?? 0,
  }
}

/**
 * Defensively parse the cockpit's read-only evolution projection.
 *
 * `evolution` is optional on the wire (an older host omits it entirely), and a
 * malformed one must never blank the cockpit: anything unreadable becomes
 * `undefined`, which the panel renders as "no evolution section" while the
 * three columns keep working.
 *
 * `improvements` follows a narrower rule: a missing/non-array value is simply
 * omitted (the panel derives proposals from the lessons instead), while an array
 * keeps its readable rows and drops malformed ones — a bad proposal must never
 * take the evolution section down with it.
 *
 * @param raw - decoded JSON value of unknown provenance.
 * @returns the normalized projection, or `undefined` when the shape is wrong.
 */
export function normalizeEvolution(raw: unknown): EvolutionView | undefined {
  if (!isRecord(raw)) return undefined
  const stats = normalizeEvolutionStats(raw.stats)
  const lessons = asArray(raw.lessons)
  if (stats === undefined || lessons === undefined) return undefined
  const rawImprovements = asArray(raw.improvements)
  const improvements =
    rawImprovements === undefined ? undefined : normalizeList(rawImprovements, normalizeImprovement)
  return {
    stats,
    lessons: normalizeList(lessons, normalizeLesson),
    ...(improvements === undefined ? {} : { improvements }),
  }
}

/**
 * Validate one payload entry as a factory snapshot.
 *
 * Strict on identity and phase (`id`, `phase`), lenient on the collections:
 * a single malformed member row must not blank the whole cockpit. The optional
 * `evolution` projection follows the same rule — unreadable becomes absent
 * ({@link normalizeEvolution}), never a thrown poll or a blank panel.
 *
 * @param value - decoded JSON value of unknown provenance.
 * @returns the normalized snapshot, or `undefined` when the shape is wrong.
 */
export function normalizeSnapshot(value: unknown): FactorySnapshot | undefined {
  if (!isRecord(value)) return undefined
  const id = asString(value.id)
  if (!id) return undefined
  const phase = oneOf(FACTORY_PHASES, value.phase, 'staged')
  const createdAt = asNumber(value.createdAt) ?? 0
  const snapshot: FactorySnapshot = {
    id,
    name: asString(value.name) ?? id,
    brief: asString(value.brief) ?? '',
    taskType: asString(value.taskType) ?? '',
    pipeline: asString(value.pipeline) ?? '',
    phase,
    securityTriggered: value.securityTriggered === true,
    members: normalizeList(value.members, normalizeMember),
    stages: normalizeList(value.stages, normalizeStage),
    dod: normalizeList(value.dod, normalizeDod),
    artifacts: normalizeList(value.artifacts, normalizeArtifact),
    feed: normalizeList(value.feed, normalizeMessage),
    alerts: normalizeList(value.alerts, normalizeAlert),
    createdAt,
    updatedAt: asNumber(value.updatedAt) ?? createdAt,
  }
  const planReviewState = asString(value.planReviewState)
  let result: FactorySnapshot = snapshot
  if (planReviewState === 'awaiting_review' || planReviewState === 'awaiting_feedback') {
    result = { ...result, planReviewState }
  }
  // Absent means "the host did not project the ledger", which is exactly the
  // optional contract; only a readable projection earns a section in the panel.
  const evolution = normalizeEvolution(value.evolution)
  if (evolution !== undefined) result = { ...result, evolution }
  const approvedAt = asNumber(value.approvedAt)
  if (approvedAt !== undefined) result = { ...result, approvedAt }
  const rawHits = asArray(value.securityHits)
  if (rawHits !== undefined) {
    result = {
      ...result,
      securityHits: rawHits.filter((hit): hit is string => typeof hit === 'string' && hit.trim() !== ''),
    }
  }
  const securitySource = knownOf(SECURITY_SIGNAL_SOURCES, value.securitySource)
  if (securitySource !== undefined) result = { ...result, securitySource }
  const deliveryPath = asString(value.deliveryPath)
  if (deliveryPath !== undefined) result = { ...result, deliveryPath }
  return result
}

/**
 * Collections a full `FactorySnapshot` always carries and an index summary
 * never does.
 *
 * docs/API-CONTRACTS.md §7.3 pins the index shape to five fields
 * (`id` / `name` / `taskType` / `phase` / `updatedAt`) precisely so a 1-second
 * poll stays cheap. These two are the ones the cockpit cannot render without,
 * so their absence is what separates "a factory with no members yet" from
 * "a summary of a factory we have not read yet".
 */
const SNAPSHOT_MARKERS: readonly string[] = ['members', 'stages']

/**
 * Whether a payload entry is a full snapshot rather than an index summary.
 *
 * @param value - one decoded payload entry.
 * @returns true when the entry carries the snapshot-only collections.
 */
export function isFullSnapshot(value: unknown): boolean {
  return isRecord(value) && SNAPSHOT_MARKERS.every(key => Array.isArray(value[key]))
}

/** One normalized payload entry plus what its shape lets us render. */
export interface FactoryEntry {
  readonly snapshot: FactorySnapshot
  /**
   * False when the entry was an index summary: `id` / `name` / `taskType` /
   * `phase` / `updatedAt` are real, every collection in {@link snapshot} is an
   * artifact of normalization and must NOT be shown as "currently empty".
   */
  readonly complete: boolean
}

/** One decoded payload, normalized without erasing its summary/snapshot shape. */
export interface NormalizedPayload {
  readonly entries: readonly FactoryEntry[]
  /** Just the snapshots, newest first — for the header's factory picker. */
  readonly factories: readonly FactorySnapshot[]
}

/**
 * Normalize a payload while keeping the summary/snapshot distinction.
 *
 * Accepts the shapes the host projection may legitimately use — a bare
 * snapshot, `{ snapshot }`, or an index (`{ factories: [...] }` / a top-level
 * array) — so the panel keeps working while the route's envelope settles.
 *
 * @param value - decoded JSON value of unknown provenance.
 * @returns entries newest first, each flagged complete or summary.
 */
export function normalizePayload(value: unknown): NormalizedPayload {
  const candidates: readonly unknown[] = Array.isArray(value)
    ? value
    : isRecord(value)
      ? (asArray(value.factories) ?? asArray(value.items) ?? (value.snapshot !== undefined ? [value.snapshot] : [value]))
      : []
  const entries: FactoryEntry[] = []
  for (const candidate of candidates) {
    const snapshot = normalizeSnapshot(candidate)
    if (snapshot) entries.push({ snapshot, complete: isFullSnapshot(candidate) })
  }
  entries.sort((left, right) => right.snapshot.updatedAt - left.snapshot.updatedAt)
  return { entries, factories: entries.map(entry => entry.snapshot) }
}

/**
 * Extract every factory a payload describes, shape information discarded.
 *
 * @param value - decoded JSON value of unknown provenance.
 * @returns normalized snapshots, newest first.
 */
export function normalizeFactories(value: unknown): readonly FactorySnapshot[] {
  return normalizePayload(value).factories
}

/** Newest first, by the timestamp the header shows for each factory. */
function sortNewestFirst(list: readonly FactorySnapshot[]): readonly FactorySnapshot[] {
  return [...list].sort((left, right) => (right.updatedAt || right.createdAt) - (left.updatedAt || left.createdAt))
}

/**
 * Identity of the evolution projection for the poll's "nothing moved" check.
 *
 * `updatedAt` belongs to the factory record, but the lesson ledger is
 * workspace-scoped: a lesson recorded (or resolved) while another factory runs
 * changes what this panel projects without touching this factory's
 * `updatedAt`. Folding the roll-up into the comparison keeps the evolution
 * section live without dropping the last-known-good snapshot every tick.
 *
 * @param snapshot - the snapshot last accepted, when there is one.
 * @returns a string that changes exactly when the projection's summary moves.
 */
function evolutionSignature(snapshot: FactorySnapshot | undefined): string {
  const evolution = snapshot?.evolution
  if (!evolution) return '—'
  const { total, recurring, resolved, lastAt } = evolution.stats
  return `${total}/${recurring}/${resolved}/${lastAt ?? 0}/${evolution.lessons.length}`
}

/* ------------------------------------------------------------ poll scope */

/** What one request asks the host for. */
export interface PollTarget {
  readonly factoryId: string | undefined
  readonly sessionId: string | undefined
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value === ''
}

/**
 * Whether a target names a factory at all.
 *
 * Only a naming request may supply the panel's displayed factory. The bare route
 * returns the **cross-workspace** index (§7.1), so displaying one of its rows
 * would show an unrelated project's factory — the defect this rule removes.
 *
 * @param target - the scope a request used.
 * @returns true when the request asked for one specific factory.
 */
export function namesFactory(target: PollTarget): boolean {
  return !isBlank(target.factoryId) || !isBlank(target.sessionId)
}

/**
 * The session the Conversation is currently showing.
 *
 * A root-scoped slot (`main`) has no session binding of its own, so the identity
 * is read off the session list: the row the main view holds a reference to. This
 * is the modern equivalent of the older `state.current` and the same derivation
 * the reference plugin uses; `mainView` is contributed by
 * `@deepseek-ai/dsh-client-ui-session`.
 *
 * It matters because the panel must speak for **this** session: the host turns
 * `?sessionId=` into that session's workspace and factory (§7.2), which is the
 * only way the client can get at its own project without ever sending a path.
 *
 * @param state - the session list snapshot.
 * @returns the current session id, or `undefined` while none is selected.
 */
export function currentSessionId(state: SessionListState): SessionId | undefined {
  return Object.values(state.byId).find(row => (row.retainedBy?.mainView ?? 0) > 0)?.id
}

/* ------------------------------------------------------------------- poll */

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

interface InternalState {
  readonly status: FactoryLinkStatus
  readonly snapshot: FactorySnapshot | undefined
  /**
   * False while {@link snapshot} came from an index summary. The header can
   * still show its five real fields; the three columns cannot be rendered.
   */
  readonly complete: boolean
  readonly factories: readonly FactorySnapshot[]
  readonly lastOkAt: number | undefined
  readonly error: string | undefined
  readonly refreshing: boolean
}

const INITIAL: InternalState = {
  status: 'connecting',
  snapshot: undefined,
  complete: false,
  factories: [],
  lastOkAt: undefined,
  error: undefined,
  refreshing: true,
}

/** What one successful read handed back, plus how it was asked for. */
interface ReadResult {
  readonly entries: readonly FactoryEntry[]
  /** The bare-route index read: it owns the whole factory list, and none of it is displayable. */
  readonly indexRead: boolean
  /** True when the request named a factory (so its payload may be displayed). */
  readonly named: boolean
  /** The id this request named, when it named one. */
  readonly requestedId: string | undefined
}

/**
 * Union one snapshot read into the known factory list.
 *
 * A `?id=` read returns ONE factory, so replacing the list with it would drop
 * every other entry and take the header's picker away right after the panel
 * upgraded. Entries are keyed by id, with the fresh read winning.
 */
function mergeFactoryLists(
  previous: readonly FactorySnapshot[],
  incoming: readonly FactorySnapshot[],
): readonly FactorySnapshot[] {
  const byId = new Map(previous.map(factory => [factory.id, factory]))
  for (const factory of incoming) byId.set(factory.id, factory)
  return sortNewestFirst([...byId.values()])
}

/** Fold one successful read into the previous state, keeping identity when nothing moved. */
function mergeSuccess(previous: InternalState, read: ReadResult, at: number): InternalState {
  const factories = read.indexRead
    ? sortNewestFirst(read.entries.map(entry => entry.snapshot))
    : mergeFactoryLists(previous.factories, read.entries.map(entry => entry.snapshot))
  // Keep showing the factory already on screen when it is still in the payload;
  // otherwise take the newest the payload describes. An index read may not
  // display anything: it describes every workspace, and this panel speaks for
  // one session, so showing a row from it would be another project's factory.
  const wanted = read.requestedId ?? previous.snapshot?.id
  const chosen = read.named
    ? ((wanted ? read.entries.find(entry => entry.snapshot.id === wanted) : undefined) ?? read.entries[0])
    : undefined
  const snapshot = chosen?.snapshot
  const complete = chosen?.complete === true
  const reset: InternalState = {
    status: snapshot ? 'live' : 'idle',
    snapshot,
    complete,
    factories,
    lastOkAt: at,
    error: undefined,
    refreshing: false,
  }
  const unchanged =
    previous.error === undefined &&
    previous.refreshing === false &&
    previous.status === reset.status &&
    previous.complete === complete &&
    previous.snapshot?.id === snapshot?.id &&
    previous.snapshot?.updatedAt === snapshot?.updatedAt &&
    evolutionSignature(previous.snapshot) === evolutionSignature(snapshot) &&
    previous.factories.length === factories.length
  return unchanged ? previous : reset
}

/** Fold one failed read into the previous state: never drop a snapshot. */
function mergeFailure(previous: InternalState, message: string): InternalState {
  const status: FactoryLinkStatus = previous.snapshot ? 'stale' : 'error'
  if (previous.status === status && previous.error === message && !previous.refreshing) return previous
  return { ...previous, status, error: message, refreshing: false }
}

/** True for the abort we raise ourselves when the effect tears down. */
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

/**
 * Poll the host's factory projection.
 *
 * @param options - polling scope (factory id or session id), cadence, route, and enablement.
 * @returns the current feed state plus a manual `reload`.
 */
export function useFactoryState(options: UseFactoryStateOptions = {}): FactoryStateFeed {
  const { factoryId, sessionId, pollMs = FACTORY_POLL_MS, route = CODE_FACTORY_STATE_ROUTE, enabled = true } = options
  const [state, setState] = useState<InternalState>(INITIAL)
  const [nonce, setNonce] = useState(0)
  const inFlight = useRef(false)
  const alive = useRef(true)
  const mounted = useRef(false)
  const scope = useRef<PollTarget>({ factoryId, sessionId })
  scope.current = { factoryId, sessionId }

  const reload = useCallback(() => setNonce(value => value + 1), [])

  useEffect(() => {
    alive.current = true
    let controller: AbortController | undefined

    const read = async (): Promise<void> => {
      // In-flight guard: a slow host must never accumulate queued requests.
      if (inFlight.current) return
      inFlight.current = true
      controller = new AbortController()
      const target = scope.current
      // An explicit pick outranks the session scope; with neither, the bare
      // route returns the index, which only ever feeds the picker.
      const url = factoryStateUrl(route, target.factoryId, target.sessionId)
      try {
        const response = await fetch(url, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = normalizePayload(await response.json())
        if (!alive.current) return
        setState(previous =>
          mergeSuccess(
            previous,
            {
              entries: payload.entries,
              indexRead: !namesFactory(target),
              named: namesFactory(target),
              requestedId: target.factoryId,
            },
            Date.now(),
          ),
        )
      } catch (error) {
        if (!alive.current || isAbort(error)) return
        setState(previous => mergeFailure(previous, describeError(error)))
      } finally {
        inFlight.current = false
      }
    }

    // Every effect run performs exactly one read — including while paused. That
    // is what keeps the "refresh now" button alive when auto-refresh is off:
    // `reload()` bumps `nonce`, which re-runs this effect and therefore performs
    // exactly one fetch, without ever arming the interval below.
    void read()

    // Auto-refresh off: the single read above is the whole effect. Keep this
    // literal `!enabled` branch (rather than folding it into the timer setup) so
    // the pause contract stays explicit: no interval, but manual reads still work.
    if (!enabled) {
      return () => {
        alive.current = false
        controller?.abort()
        inFlight.current = false
      }
    }

    const timer = window.setInterval(() => {
      void read()
    }, Math.max(200, pollMs))

    return () => {
      alive.current = false
      window.clearInterval(timer)
      controller?.abort()
      inFlight.current = false
    }
  }, [enabled, pollMs, route, nonce])

  useEffect(() => {
    // The mount pass is already covered by the polling effect's first read; only
    // an actual caller-driven scope switch needs to short-circuit the interval
    // (the cockpit picking a factory, or the card binding to another session).
    if (!mounted.current) {
      mounted.current = true
      return
    }
    setState(previous => ({
      ...previous,
      status: previous.snapshot ? 'live' : 'connecting',
      refreshing: true,
    }))
    setNonce(value => value + 1)
  }, [factoryId, sessionId])

  return { ...state, reload }
}

/**
 * A wall clock that ticks on its own schedule.
 *
 * The cockpit needs a live clock and elapsed time even while the poll result is
 * unchanged, and the poll must stay free to keep its previous snapshot identity.
 *
 * @param intervalMs - tick period; 1000 by default.
 * @returns the current epoch ms, refreshed every `intervalMs`.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), Math.max(200, intervalMs))
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}
