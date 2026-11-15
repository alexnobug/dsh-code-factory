/**
 * Code Factory cockpit — the full-width `main` panel, its sidebar entry icon,
 * and the per-turn summary card.
 *
 * Layout: the prototype's three columns (ROSTER / PIPELINE + WORK OUTPUT /
 * the always-on details column: live feed, artifacts, DoD, and the evolution
 * ledger when the snapshot carries one) projected onto real data. Everything on
 * screen is a projection of one `FactorySnapshot` read from the host route;
 * nothing is simulated. The prototype's 1x/2x/4x speed control is deliberately
 * absent — real members execute at exactly one speed.
 *
 * Roles are drawn, not illustrated: every avatar is a deterministic inline SVG
 * (palette swatch + codename glyph + hashed ornament), so the panel needs no
 * image assets and no network at all.
 *
 * WORK OUTPUT shows the selected role's **actual collaboration messages**
 * (dispatch / rejection / handoff / report) rather than a pre-written script;
 * when the role is mid-work the last line carries the prototype's typing
 * cursor.
 *
 * Degradation: with no factory on the host the panel renders the header strip
 * plus a waiting empty state, and it keeps showing the last snapshot while the
 * host restarts instead of blanking out.
 *
 * @module dsh-code-factory/client/FactoryCockpit
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
// Type-only: the framework's props-composition helpers. Erased at build time,
// so `@deepseek-ai/dsh-client-ui-slots` never enters the bundle's require list.
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ArtifactRecord,
  DodState,
  DodStatus,
  FactoryMessage,
  FactorySnapshot,
  GateDef,
  GateResult,
  ImprovementProposal,
  LessonRecord,
  MemberStatus,
  MessageKind,
  SnapshotAlert,
  SnapshotMember,
  SnapshotStage,
} from '../shared/types.js'
import { UNKNOWN_GATE_TYPE } from '../shared/types.js'
import { deriveImprovements } from '../domain/improvements.js'
import type { FactoryStateFeed, PollTarget } from './api.js'
import { UNKNOWN_ENDPOINT, currentSessionId, useFactoryState, useNow } from './api.js'
import type { PanelColumnId, PanelLayout, PanelModuleId } from './layout.js'
import {
  DEFAULT_COLUMN_WIDTHS,
  MAX_COLUMN_WIDTH,
  MAX_MODULE_HEIGHT,
  MIN_COLUMN_WIDTH,
  MIN_MODULE_HEIGHT,
  PANEL_COLUMN_IDS,
  PANEL_MODULE_IDS,
  clearModuleHeight,
  createDefaultLayout,
  hideModule,
  isPanelModuleId,
  modulePlacement,
  moveModule,
  normaliseLayout,
  readLayout,
  setColumnWidth,
  setModuleCollapsed,
  setModuleHeight,
  showModule,
  toggleModuleCollapsed,
  writeLayout,
} from './layout.js'
import type { CodeFactoryTranslate } from './locales.js'
import {
  ALERT_SEVERITY_COLOR,
  FEED_KIND_COLOR,
  LINK_COLOR,
  MEMBER_STATUS_COLOR,
  PHASE_COLOR,
  PULSING_MEMBER_STATUS,
  STAGE_STATUS_COLOR,
  TOKEN,
  roleInk,
  roleSwatch,
  wash,
} from './styles.js'

/* ------------------------------------------------------------------ props */

/** The business face `apply()` injects into every cockpit registration. */
export interface FactoryInjectedProps {
  /** Host projection route, defaulted from `api.ts`. */
  readonly route: string
  /** Polling cadence in ms. */
  readonly pollMs: number
  /** Select this plugin's `main` panel. */
  readonly openCockpit: () => void
}

/**
 * Registered components declare their props with the framework's own
 * composition helpers, exactly as the shipped slot occupants do: the runtime
 * share for the slot's kind and scope ({@link PropsRuntime}, which carries the
 * owner share and the standard hooks), the `codeFactory` dictionary seat
 * ({@link PropsLocale}), and this plugin's injected face
 * ({@link InjectFace}). Declaring the composition rather than a hand-rolled
 * interface is what makes `register()` check the component against the same
 * `SlotMap` entry it dispatches on.
 */

/** Full props of the `main` cockpit panel. */
export type FactoryCockpitProps = PropsRuntime<'main'> & PropsLocale<'codeFactory'> & InjectFace<FactoryInjectedProps>

/**
 * Full props of the `sidebar.panellist` entry.
 *
 * The sidebar owns the row button and supplies its icon share
 * (`SidebarPanelIconOwnerProps`: requested edge `size` and whether the panel is
 * `active`), which arrives through {@link PropsRuntime}.
 */
export type FactorySidebarEntryProps = PropsRuntime<'sidebar.panellist'> &
  PropsLocale<'codeFactory'> &
  InjectFace<FactoryInjectedProps>

/**
 * Full props of the `conversation.chat.turnTail` summary card.
 *
 * The turn owner share (`turn`, `seq`, `openFile`) and the session-scope
 * standard seat (`sessionId`, merged by `@deepseek-ai/dsh-client-ui-session`)
 * both arrive through {@link PropsRuntime}; only `sessionId` is read, and only
 * to scope the poll to this conversation's factory.
 */
export type FactoryTurnCardProps = PropsRuntime<'conversation.chat.turnTail'> &
  PropsLocale<'codeFactory'> &
  InjectFace<FactoryInjectedProps>

/* ----------------------------------------------------------------- icons */

function IconRadar(): ReactNode {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true" style={{ color: TOKEN.brand, flex: 'none' }}>
      <circle cx="13" cy="13" r="11" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.2" />
      <circle cx="13" cy="13" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1" />
      <line className="cf-sweep" x1="13" y1="13" x2="13" y2="3" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="13" cy="13" r="2" fill="currentColor" />
    </svg>
  )
}

function IconGrid({ size }: { readonly size: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="1.5" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9.5" y="1.5" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1.5" y="9.5" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="currentColor" fillOpacity="0.55" />
    </svg>
  )
}

function IconBranch(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: 'none' }}>
      <circle cx="3" cy="2.5" r="1.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="9" cy="2.5" r="1.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="6" cy="9.5" r="1.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="M3 3.9v1.6a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V3.9" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

function IconShield(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M6 1.2 10 2.7v3.4c0 2.3-1.7 4.1-4 4.7-2.3-.6-4-2.4-4-4.7V2.7z" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

function IconCheck(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M2 6.4 4.6 9 10 3.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function IconCross(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function IconDoc(): ReactNode {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true" style={{ flex: 'none', color: TOKEN.brand }}>
      <path d="M3 1.4h5l3 3v8.2H3z" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 1.6v3h3" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

function IconRefresh(): ReactNode {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M10 6a4 4 0 1 1-1.3-2.9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M10 1.6V4H7.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function IconChevron({ open }: { readonly open: boolean }): ReactNode {
  return (
    <svg className={open ? 'cf-chev' : 'cf-chev cf-chev-closed'} width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 3.4 5 6.5 8 3.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function IconCopy(): ReactNode {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: 'none' }}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="M8 3V2.2A1.2 1.2 0 0 0 6.8 1H2.2A1.2 1.2 0 0 0 1 2.2v4.6A1.2 1.2 0 0 0 2.2 8H3" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

function IconSearch(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: 'none' }}>
      <circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M7.6 7.6 10.4 10.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

function IconClose(): ReactNode {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function IconPause(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: 'none' }}>
      <rect x="3" y="2.2" width="2.2" height="7.6" rx="0.6" fill="currentColor" />
      <rect x="6.8" y="2.2" width="2.2" height="7.6" rx="0.6" fill="currentColor" />
    </svg>
  )
}

function IconPlay(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M3.4 2.4v7.2L9.6 6z" fill="currentColor" />
    </svg>
  )
}

function IconLayout(): ReactNode {
  return (
    <svg width="11" height="11" viewBox="0 0 14 14" aria-hidden="true" style={{ flex: 'none' }}>
      <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <path d="M5.5 1.5v11M8.5 1.5v11" fill="none" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  )
}

/* -------------------------------------------------------------- utilities */

/** Dispatch priority for auto-selecting the role whose output is most useful. */
const MEMBER_RANK: Readonly<Record<MemberStatus, number>> = {
  working: 0,
  rework: 1,
  blocked: 2,
  error: 3,
  idle: 4,
  staged: 5,
  done: 6,
  removed: 7,
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 24-hour wall clock, locale-independent. */
function formatClock(ts: number): string {
  const date = new Date(ts)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** `12.4K` above a thousand, plain digits below. */
function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(Math.round(value))
}

/** Coarse byte size for the artifact rows. */
function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/** `42s` / `3m 12s` / `1h 04m`. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${pad2(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${pad2(minutes % 60)}m`
}

/** Locale-aware "how long ago", for the header's last-updated stamp. */
function formatAgo(ms: number, t: CodeFactoryTranslate): string {
  if (!Number.isFinite(ms) || ms < 10_000) return t('ago.justNow')
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return t('ago.seconds', { count: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('ago.minutes', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('ago.hours', { count: hours })
  return t('ago.days', { count: Math.floor(hours / 24) })
}

/**
 * Copy helper with a silent fallback.
 *
 * `navigator.clipboard` is unavailable outside a secure context and can reject
 * (permissions, no focus), and the panel is decorative here: a failed copy must
 * never throw into React or open a dialog. The fallback selects a temporary
 * textarea and uses the legacy command; if that fails too, nothing happens.
 */
function copyText(text: string): void {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
    void clipboard.writeText(text).catch(() => fallbackCopy(text))
    return
  }
  fallbackCopy(text)
}

function fallbackCopy(text: string): void {
  if (typeof document === 'undefined') return
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    document.body.removeChild(area)
  } catch {
    // Silent by contract: the copy button must never surface an error dialog.
  }
}

interface Aggregate {
  readonly tokens: number
  readonly artifacts: number
  readonly dodPassed: number
  readonly dodTotal: number
  readonly stagesPassed: number
  readonly stagesTotal: number
  readonly activeMembers: number
  readonly totalMembers: number
  readonly overall: number
  readonly elapsedMs: number
}

/**
 * Verdict of one DoD row.
 *
 * A row persisted before `status` existed carries only `ok`, which cannot tell
 * a skipped audit from a passed one — `ok` is all we have for those.
 */
function dodVerdict(item: DodState): DodStatus {
  return item.status ?? (item.ok ? 'passed' : 'failed')
}

/** One pass over the snapshot for everything the header and meters show. */
function aggregate(snapshot: FactorySnapshot, now: number): Aggregate {
  let tokens = 0
  let activeMembers = 0
  for (const member of snapshot.members) {
    tokens += member.tokens || 0
    if (member.status === 'working' || member.status === 'rework') activeMembers += 1
  }
  let units = 0
  let stagesPassed = 0
  for (const stage of snapshot.stages) {
    if (stage.status === 'passed') {
      stagesPassed += 1
      units += 1
    } else if (stage.status === 'active' || stage.status === 'gate') {
      units += 0.5
    }
  }
  const stagesTotal = snapshot.stages.length
  const dodPassed = snapshot.dod.filter(item => dodVerdict(item) === 'passed').length
  const settled = snapshot.phase === 'delivered' || snapshot.phase === 'discarded'
  const overall = snapshot.phase === 'delivered' ? 100 : stagesTotal > 0 ? Math.round((units / stagesTotal) * 100) : 0
  const start = snapshot.createdAt || now
  const end = settled ? snapshot.updatedAt || now : now
  return {
    tokens,
    artifacts: snapshot.artifacts.length,
    dodPassed,
    dodTotal: snapshot.dod.length,
    stagesPassed,
    stagesTotal,
    activeMembers,
    totalMembers: snapshot.members.length,
    overall,
    elapsedMs: Math.max(0, end - start),
  }
}

/** Auto-selection: whoever the pipeline is actually blocked on, most urgent first. */
function pickMember(members: readonly SnapshotMember[]): SnapshotMember | undefined {
  let best: SnapshotMember | undefined
  for (const member of members) {
    if (member.status === 'removed') continue
    if (!best || MEMBER_RANK[member.status] < MEMBER_RANK[best.status]) best = member
  }
  return best
}

interface RoleView {
  readonly id: string
  readonly title: string
  readonly codename: string
  readonly swatch: string
  /** Why this view is degraded, for a `title` tooltip. Absent when resolved. */
  readonly hint?: string
}

/** Resolve any role id (member, captain, or unknown sender) into chip-ready parts. */
function roleView(snapshot: FactorySnapshot, roleId: string, t: CodeFactoryTranslate): RoleView {
  const member = snapshot.members.find(item => item.role === roleId)
  if (member) {
    return { id: roleId, title: member.title, codename: member.codename, swatch: roleSwatch(member.role, member.color) }
  }
  // An endpoint the parser could not read is not a party: it gets a neutral
  // swatch and its own label instead of a role swatch and a name it never had.
  if (roleId === UNKNOWN_ENDPOINT) {
    return {
      id: roleId,
      title: t('feed.endpoint.unparsed'),
      codename: '???',
      swatch: TOKEN.labelSecondary,
      hint: t('feed.endpoint.unparsedHint'),
    }
  }
  // Captains are parties of the factory but never roster members, so no host
  // colour exists for them; the brand token is the one colour the panel already
  // gives the captain (and what their avatar is required to wear).
  const title = roleId === 'captain' ? t('role.captain') : roleId === 'system' ? t('feed.kind.system') : roleId
  return {
    id: roleId,
    title,
    codename: roleId.slice(0, 3).toUpperCase(),
    swatch: roleId === 'captain' ? TOKEN.brand : roleSwatch(roleId),
  }
}

function stageName(snapshot: FactorySnapshot, stageId: string | undefined): string | undefined {
  if (!stageId) return undefined
  return snapshot.stages.find(stage => stage.id === stageId)?.name ?? stageId
}

/* ------------------------------------------------- view-model & filtering */

/**
 * The interactive list filters, kept as pure functions so a headless harness can
 * hold every control to its contract without a browser: each one takes the
 * snapshot's own records and a plain description of the current controls, and
 * returns a new list in a defined order. None of them mutate their input.
 */

/** Status chips in the ROSTER. `all` is the only non-status member. */
export type MemberStatusFilter = 'all' | 'working' | 'rework' | 'blocked' | 'error' | 'done' | 'idle'

/** Every ROSTER status chip, in reading order. */
export const MEMBER_STATUS_FILTERS: readonly MemberStatusFilter[] = ['all', 'working', 'rework', 'blocked', 'error', 'done', 'idle']

/** ROSTER ordering: the registry's own order, or the dispatch-priority order. */
export type MemberSortMode = 'roster' | 'status'

/** Message-kind filter shared by WORK OUTPUT and the live feed. */
export type FeedKindFilter = 'all' | MessageKind | 'other'

/** WORK OUTPUT / live-feed kind chips, in reading order. */
export const FEED_KIND_FILTERS: readonly FeedKindFilter[] = ['all', 'dispatch', 'report', 'reject', 'blocked', 'approval', 'other']

/** Options accepted by {@link filterFeedMessages}. */
export interface FeedFilterOptions {
  readonly query?: string
  readonly kind?: FeedKindFilter
  readonly unreadOnly?: boolean
  /** Only rows attached to this stage (the inspector's stage filter). */
  readonly stageId?: string
}

/** Artifact ordering, exposed as its own control in the artifacts section. */
export type ArtifactSortMode = 'newest' | 'oldest' | 'path' | 'size'

/** Every artifact sort mode, in reading order. */
export const ARTIFACT_SORTS: readonly ArtifactSortMode[] = ['newest', 'oldest', 'path', 'size']

/** Options accepted by {@link filterArtifacts}. */
export interface ArtifactFilterOptions {
  readonly query?: string
  readonly stageId?: string
}

/** DoD status chips. */
export type DodFilter = 'all' | DodStatus

/** Every DoD chip, in reading order (outcome first, then the two non-outcomes). */
export const DOD_FILTERS: readonly DodFilter[] = ['all', 'failed', 'pending', 'passed', 'skipped']

/** Evolution resolution chips. */
export type LessonFilterMode = 'all' | 'open' | 'resolved'

/** Every evolution chip, in reading order. */
export const LESSON_FILTERS: readonly LessonFilterMode[] = ['all', 'open', 'resolved']

/** Case-insensitive substring match over any readable field; blank matches all. */
function matchesQuery(values: readonly (string | undefined)[], query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return values.some(value => value !== undefined && value.toLowerCase().includes(needle))
}

/** ROSTER search (title / codename / role id) + status chip + ordering. */
export function filterMembers(
  members: readonly SnapshotMember[],
  query: string,
  status: MemberStatusFilter,
  sort: MemberSortMode,
): readonly SnapshotMember[] {
  const filtered = members.filter(member => {
    if (status !== 'all' && member.status !== status) return false
    return matchesQuery([member.title, member.codename, member.role], query)
  })
  if (sort === 'roster') return filtered
  return [...filtered].sort((left, right) => {
    const rank = MEMBER_RANK[left.status] - MEMBER_RANK[right.status]
    return rank !== 0 ? rank : left.title.localeCompare(right.title)
  })
}

/** Filter a message list by kind / search text / unread / stage. Order is preserved. */
export function filterFeedMessages(
  messages: readonly FactoryMessage[],
  options: FeedFilterOptions = {},
): readonly FactoryMessage[] {
  const { query = '', kind = 'all', unreadOnly = false, stageId } = options
  return messages.filter(message => {
    if (unreadOnly && message.readAt !== undefined) return false
    if (stageId !== undefined && message.stage !== stageId) return false
    if (kind !== 'all') {
      const actual = message.kind ?? 'system'
      if (kind === 'other') {
        if (actual !== 'handoff' && actual !== 'system') return false
      } else if (actual !== kind) {
        return false
      }
    }
    return matchesQuery([message.content, message.from, message.to], query)
  })
}

/** Filter artifacts by path / stage / owner text and (optionally) one stage id. */
export function filterArtifacts(
  artifacts: readonly ArtifactRecord[],
  options: ArtifactFilterOptions = {},
): readonly ArtifactRecord[] {
  const { query = '', stageId } = options
  return artifacts.filter(artifact => {
    if (stageId !== undefined && artifact.stage !== stageId) return false
    return matchesQuery([artifact.path, artifact.stage, artifact.by], query)
  })
}

/** Order artifacts newest / oldest / path / size. Returns a new array. */
export function sortArtifacts(artifacts: readonly ArtifactRecord[], sort: ArtifactSortMode): readonly ArtifactRecord[] {
  const ordered = [...artifacts]
  switch (sort) {
    case 'oldest':
      return ordered.sort((left, right) => left.at - right.at || left.path.localeCompare(right.path))
    case 'path':
      return ordered.sort((left, right) => left.path.localeCompare(right.path))
    case 'size':
      return ordered.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path))
    case 'newest':
    default:
      return ordered.sort((left, right) => right.at - left.at || left.path.localeCompare(right.path))
  }
}

/** Filter DoD rows by verdict; `all` returns a copy in its original order. */
export function filterDod(dod: readonly DodState[], filter: DodFilter = 'all'): readonly DodState[] {
  if (filter === 'all') return [...dod]
  return dod.filter(item => dodVerdict(item) === filter)
}

/** Filter lessons by resolution and (optionally) owning role. Order is preserved. */
export function filterLessons(
  lessons: readonly LessonRecord[],
  filter: LessonFilterMode = 'all',
  role?: string,
): readonly LessonRecord[] {
  return lessons.filter(lesson => {
    if (filter === 'open' && lesson.resolvedAt !== undefined) return false
    if (filter === 'resolved' && lesson.resolvedAt === undefined) return false
    if (role !== undefined && role !== '' && role !== 'all' && lesson.role !== role) return false
    return true
  })
}

/**
 * Resolve a lesson-role filter against the roles currently present.
 *
 * A role can leave the roster/ledger between snapshots. The `<select>` must
 * never show "all roles" while the rows are still filtered by the stale id, so
 * both the visible value and {@link filterLessons} use this resolved value.
 *
 * @param snapshot - snapshot supplying the roster and lesson roles.
 * @param role - requested role id, or `'all'`.
 * @returns the requested role when present, else `'all'`.
 */
export function resolveLessonRole(snapshot: FactorySnapshot, role: string): string {
  if (role === 'all') return 'all'
  if (snapshot.members.some(member => member.role === role)) return role
  if ((snapshot.evolution?.lessons ?? []).some(lesson => lesson.role === role)) return role
  return 'all'
}

/** Resolution filter for the plugin-improvement proposals. */
export type ImprovementFilterMode = 'all' | 'open' | 'validated'

/** Every improvement filter chip, in reading order. */
export const IMPROVEMENT_FILTERS: readonly ImprovementFilterMode[] = ['all', 'open', 'validated']

/** How many improvement proposals show before "show all". */
export const IMPROVEMENT_PREVIEW_LIMIT = 6

/**
 * Resolve the plugin-improvement proposals for one snapshot.
 *
 * The host's projection is authoritative when it carries the field (even an
 * empty array means "nothing to change"); otherwise the same proposals are
 * derived from the recurring lessons with the shared pure domain function, so an
 * older host still renders the backlog.
 *
 * @param snapshot - the factory snapshot.
 * @returns the proposals, most expensive/most recent first per the derivation.
 */
export function improvementProposals(snapshot: FactorySnapshot): readonly ImprovementProposal[] {
  const evolution = snapshot.evolution
  if (!evolution) return []
  return evolution.improvements !== undefined ? evolution.improvements : deriveImprovements(evolution.lessons)
}

/** Filter proposals by resolution status. Returns a new array. */
export function filterImprovements(
  proposals: readonly ImprovementProposal[],
  filter: ImprovementFilterMode = 'all',
): readonly ImprovementProposal[] {
  if (filter === 'all') return [...proposals]
  return proposals.filter(proposal => proposal.status === filter)
}

/** One stage's responsible party, resolved against the roster for avatar colour. */
export interface StageInspectorRole {
  readonly id: string
  readonly title: string
  readonly codename: string
  readonly swatch: string
  /** False when the role is required by the template but absent from the roster. */
  readonly resolved: boolean
}

/** The pure model behind the stage inspector (see {@link StageInspectorPanel}). */
export interface StageInspector {
  readonly stage: SnapshotStage
  readonly roles: readonly StageInspectorRole[]
  readonly gate?: GateDef
  readonly lastGate?: GateResult
  readonly artifactCount: number
  readonly messageCount: number
  readonly attempts: number
  readonly maxRounds?: number
  readonly gateType: SnapshotStage['gateType']
}

/**
 * Resolve one stage into everything the inspector shows.
 *
 * Pure: it only reads the snapshot and its stage id. Counts are direct scans of
 * the snapshot's own artifacts/feed, so a malformed or sparsely projected row
 * simply counts as absent instead of throwing.
 */
export function buildStageInspector(snapshot: FactorySnapshot, stageId: string): StageInspector | undefined {
  const stage = snapshot.stages.find(item => item.id === stageId)
  if (!stage) return undefined
  const roles: StageInspectorRole[] = []
  const seen = new Set<string>()
  for (const roleId of stage.roles) {
    if (seen.has(roleId)) continue
    seen.add(roleId)
    const member = snapshot.members.find(item => item.role === roleId)
    roles.push(
      member
        ? {
            id: member.role,
            title: member.title,
            codename: member.codename,
            swatch: roleSwatch(member.role, member.color),
            resolved: true,
          }
        : { id: roleId, title: roleId, codename: roleId.slice(0, 3).toUpperCase(), swatch: roleSwatch(roleId), resolved: false },
    )
  }
  return {
    stage,
    roles,
    ...(stage.gate === undefined ? {} : { gate: stage.gate }),
    ...(stage.lastGate === undefined ? {} : { lastGate: stage.lastGate }),
    artifactCount: snapshot.artifacts.filter(artifact => artifact.stage === stageId).length,
    messageCount: snapshot.feed.filter(message => message.stage === stageId).length,
    attempts: stage.attempts ?? 0,
    ...(stage.maxRounds === undefined ? {} : { maxRounds: stage.maxRounds }),
    gateType: stage.gateType,
  }
}

/* --------------------------------------------------------------- avatars */

/**
 * Every role is drawn, not shipped.
 *
 * The cockpit must add an avatar to the roster, the work-output header, and
 * every feed row without adding an asset pipeline: no images, no network, no
 * dependency. So a role is a deterministic inline SVG — its palette swatch is
 * the ring and plate, its codename is the glyph, and a hash of the role id
 * picks one of four fixed ornaments. The hash keeps a role recognisable: the
 * same `security_eng` reads the same in the roster and in the feed.
 *
 * Sizes are the three the layout actually uses (18 roster/feed, 24 lessons,
 * 32 work header), not an arbitrary scale.
 */
type RoleAvatarSize = 18 | 24 | 32

/** Stable, non-cryptographic hash: identity of the drawing, not a secret. */
function avatarSeed(role: string): number {
  let hash = 0
  for (let index = 0; index < role.length; index += 1) {
    hash = (hash * 31 + role.charCodeAt(index)) | 0
  }
  return Math.abs(hash)
}

/**
 * The glyph: two codename letters (`PM`, `FE`, `QA`), or one when the codename
 * is a single character. Punctuation is stripped so `???` (an unparsed
 * endpoint) still yields a readable mark instead of an empty plate.
 */
function avatarGlyph(codename: string): string {
  const letters = codename.replace(/[^0-9A-Za-z]/g, '')
  return letters.length >= 2 ? letters.slice(0, 2).toUpperCase() : (letters.toUpperCase() || '?')
}

/** One of four fixed ornaments, chosen by {@link avatarSeed}. */
function AvatarOrnament({ seed, color }: { readonly seed: number; readonly color: string }): ReactNode {
  switch (seed % 4) {
    case 0:
      return (
        <>
          <circle cx="16" cy="16" r="11" fill="none" stroke={color} strokeOpacity="0.32" strokeWidth="1" strokeDasharray="2 3" />
          <circle cx="16" cy="5.4" r="1.3" fill={color} opacity="0.5" />
          <circle cx="16" cy="26.6" r="1.3" fill={color} opacity="0.5" />
        </>
      )
    case 1:
      return (
        <>
          <path d="M7 22.5 16 9.5l9 13" fill="none" stroke={color} strokeOpacity="0.3" strokeWidth="1.2" strokeLinecap="round" />
          <circle cx="16" cy="9.5" r="1.5" fill={color} opacity="0.45" />
        </>
      )
    case 2:
      return (
        <>
          <path d="M8.5 24 24 8.5M8.5 16 16 8.5M16 24 24 16" fill="none" stroke={color} strokeOpacity="0.26" strokeWidth="1.1" strokeLinecap="round" />
        </>
      )
    default:
      return (
        <>
          <path d="M16 5.8 26 16 16 26.2 6 16z" fill="none" stroke={color} strokeOpacity="0.28" strokeWidth="1.1" strokeLinejoin="round" />
        </>
      )
  }
}

/**
 * One role avatar (inline SVG).
 *
 * Colour rules follow the panel's theme contract: the ring/plate come from the
 * role swatch (a host colour or the prototype palette) and a `wash()` of it,
 * and the glyph uses `roleInk()` through `currentColor` — so an engine without
 * `color-mix()` falls back to the inherited label colour instead of drawing an
 * invisible letter. No status token is used, because a role colour is
 * decoration and must never read as a status.
 *
 * @param props - role id (stable seed), swatch, codename glyph, display title, edge size.
 * @returns the avatar markup, hidden from assistive tech because every call
 *   site already renders the role's name next to it.
 */
export function RoleAvatar({
  role,
  swatch,
  codename,
  title,
  size = 24,
}: {
  readonly role: string
  readonly swatch: string
  readonly codename: string
  readonly title: string
  readonly size?: RoleAvatarSize
}): ReactNode {
  const glyph = avatarGlyph(codename)
  return (
    <svg
      className="cf-avatar"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <title>{title}</title>
      <circle cx="16" cy="16" r="15" fill={wash(swatch, 14)} stroke={swatch} strokeOpacity="0.72" strokeWidth="1.5" />
      <AvatarOrnament seed={avatarSeed(role)} color={swatch} />
      <text
        x="16"
        y="16.5"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={glyph.length > 1 ? 11 : 14}
        fontWeight="700"
        letterSpacing="0.4"
        fill="currentColor"
        style={{ color: roleInk(swatch) }}
      >
        {glyph}
      </text>
    </svg>
  )
}

/* ------------------------------------------------------------ small parts */

function Led({ color, pulse }: { readonly color: string; readonly pulse: boolean }): ReactNode {
  return <span className={pulse ? 'cf-led cf-led-pulse' : 'cf-led'} style={{ color }} aria-hidden="true" />
}

function EmptyBlock({
  title,
  body,
  action,
  wide,
}: {
  readonly title: string
  readonly body?: string
  readonly action?: ReactNode
  readonly wide?: boolean
}): ReactNode {
  return (
    <div className={wide ? 'cf-empty cf-empty-wide' : 'cf-empty'}>
      <div className="cf-empty-title cf-mono">{title}</div>
      {body ? <div className="cf-empty-body">{body}</div> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  )
}

/**
 * Copy control with a visually hidden `aria-live` confirmation.
 *
 * The confirmation is the only feedback: a failed clipboard write degrades
 * silently by design (see {@link copyText}), because a read-only cockpit has no
 * recovery action to offer.
 */
export function CopyButton({
  t,
  text,
  label,
  className = 'cf-copy',
}: {
  readonly t: CodeFactoryTranslate
  readonly text: string
  readonly label: string
  /** Optional visual variant class; the behavior/aria-live contract is shared. */
  readonly className?: string
}): ReactNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(
    () => () => {
      if (timer.current !== undefined && typeof window !== 'undefined') window.clearTimeout(timer.current)
    },
    [],
  )
  const handleCopy = () => {
    copyText(text)
    setCopied(true)
    if (typeof window !== 'undefined') {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1600)
    }
  }
  return (
    <button
      type="button"
      className={copied ? `${className} ${className}-done` : className}
      onClick={handleCopy}
      title={copied ? t('copy.done') : t('copy.aria', { label })}
      aria-label={t('copy.aria', { label })}
    >
      <IconCopy />
      <span>{copied ? t('copy.done') : t('copy.action')}</span>
      <span className="cf-sr" role="status" aria-live="polite">
        {copied ? t('copy.done') : ''}
      </span>
    </button>
  )
}

/** Controlled search box shared by the roster, feed, artifacts, and work output. */
function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  t,
}: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly placeholder: string
  readonly ariaLabel: string
  readonly t: CodeFactoryTranslate
}): ReactNode {
  return (
    <div className="cf-search">
      <IconSearch />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        onChange={event => onChange(event.target.value)}
      />
      {value !== '' ? (
        <button type="button" className="cf-icon-btn" onClick={() => onChange('')} aria-label={t('filter.clear')} title={t('filter.clear')}>
          <IconClose />
        </button>
      ) : null}
    </div>
  )
}

/** One toggleable filter chip; `count` renders the badge number when given. */
export function FilterChip({
  active,
  label,
  count,
  onClick,
}: {
  readonly active: boolean
  readonly label: string
  readonly count?: number
  readonly onClick: () => void
}): ReactNode {
  return (
    <button type="button" className={active ? 'cf-chip-btn cf-chip-btn-on' : 'cf-chip-btn'} aria-pressed={active} onClick={onClick}>
      <span>{label}</span>
      {count === undefined ? null : <span className="cf-chip-num">{count}</span>}
    </button>
  )
}

/** The collapsible shell every right-column section sits in. */
function SectionShell({
  t,
  id,
  title,
  titleHint,
  note,
  collapsed,
  onToggle,
  children,
}: {
  readonly t: CodeFactoryTranslate
  readonly id: string
  readonly title: string
  readonly titleHint?: string
  readonly note: string
  readonly collapsed: boolean
  readonly onToggle: () => void
  readonly children: ReactNode
}): ReactNode {
  return (
    <section className="cf-right-section" aria-label={title}>
      <div className="cf-right-head cf-mono">
        <button
          type="button"
          className="cf-sec-toggle"
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : `cf-sec-${id}`}
          title={t('aria.sectionToggle', { section: title })}
          onClick={onToggle}
        >
          <IconChevron open={!collapsed} />
          <span className="cf-col-title" title={titleHint}>
            {title}
          </span>
        </button>
        <span className="cf-col-note">{note}</span>
      </div>
      {collapsed ? null : (
        <div className="cf-sec-body" id={`cf-sec-${id}`}>
          {children}
        </div>
      )}
    </section>
  )
}

interface MessageRowProps {
  readonly snapshot: FactorySnapshot
  readonly t: CodeFactoryTranslate
  readonly message: FactoryMessage
  readonly caret?: boolean
}

/**
 * One collaboration message.
 *
 * Long bodies clamp to four lines; expansion is per-row local state because it
 * is a reading aid, not a filter the rest of the panel needs to know about. The
 * copy control and the delivered/read marker live in the meta row.
 */
export function MessageRow({ snapshot, t, message, caret = false }: MessageRowProps): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const kind: MessageKind = message.kind ?? 'system'
  const from = roleView(snapshot, message.from, t)
  const to = roleView(snapshot, message.to, t)
  const stage = stageName(snapshot, message.stage)
  const isCommand = /^\s*\$/.test(message.content)
  const long = message.content.length > 240 || message.content.split('\n').length > 4
  const meta: CSSProperties = { borderLeftColor: FEED_KIND_COLOR[kind] }
  return (
    <div className="cf-msg" style={meta}>
      <div className="cf-msg-meta cf-mono">
        <span>{formatClock(message.ts)}</span>
        <span className="cf-msg-sender" title={from.hint}>
          <RoleAvatar role={message.from} swatch={from.swatch} codename={from.codename} title={from.title} size={18} />
          <span style={{ color: roleInk(from.swatch) }}>{from.title}</span>
        </span>
        <span aria-hidden="true">→</span>
        <span className="cf-msg-sender" title={to.hint}>
          <span style={{ color: roleInk(to.swatch) }}>{to.title}</span>
          <RoleAvatar role={message.to} swatch={to.swatch} codename={to.codename} title={to.title} size={18} />
        </span>
        <span className="cf-chip" style={{ color: FEED_KIND_COLOR[kind], borderColor: wash(FEED_KIND_COLOR[kind], 40) }}>
          {t(`feed.kind.${kind}`)}
        </span>
        {stage ? <span>{t('feed.stage', { stage })}</span> : null}
        {message.round ? <span>{t('feed.round', { round: message.round })}</span> : null}
        {message.readAt !== undefined ? (
          <span className="cf-msg-flag cf-msg-flag-on">{t('work.read')}</span>
        ) : message.deliveredAt !== undefined ? (
          <span className="cf-msg-flag">{t('work.delivered')}</span>
        ) : (
          <span className="cf-msg-flag">
            <span className="cf-unread-dot" aria-hidden="true" /> {t('work.unread')}
          </span>
        )}
        <span className="cf-msg-actions">
          <CopyButton t={t} text={message.content} label={t('copy.message')} />
        </span>
      </div>
      <div
        className={`cf-msg-body${long && !expanded ? ' cf-msg-body-clamp' : ''}${caret ? ' cf-cursor' : ''}`}
        style={isCommand ? { color: TOKEN.brand, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } : undefined}
      >
        {message.content}
      </div>
      {long ? (
        <button type="button" className="cf-msg-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? t('work.collapse') : t('work.expand')}
        </button>
      ) : null}
    </div>
  )
}

function StageChip({
  stage,
  t,
  snapshot,
  selected,
  onSelect,
}: {
  readonly stage: SnapshotStage
  readonly t: CodeFactoryTranslate
  readonly snapshot: FactorySnapshot
  readonly selected: boolean
  readonly onSelect: () => void
}): ReactNode {
  const color = STAGE_STATUS_COLOR[stage.status]
  const style: CSSProperties = {
    color,
    borderColor: selected ? color : wash(color, 50),
    background: wash(color, selected ? 18 : stage.status === 'pending' ? 4 : 12),
  }
  const failGotoName = stageName(snapshot, stage.failGoto)
  return (
    <button
      type="button"
      className={selected ? 'cf-stage cf-stage-btn cf-stage-on cf-mono' : 'cf-stage cf-stage-btn cf-mono'}
      style={style}
      title={`${stage.name} · ${t(`stage.status.${stage.status}`)}`}
      aria-label={t('aria.stageChip', { stage: stage.name })}
      aria-pressed={selected}
      onClick={onSelect}
    >
      {stage.status === 'active' ? <Led color={color} pulse /> : null}
      {stage.status === 'gate' ? <Led color={color} pulse /> : null}
      {stage.status === 'passed' ? <IconCheck /> : null}
      {stage.status === 'rejected' ? <IconCross /> : null}
      <span className="cf-stage-name">{stage.name}</span>
      <span className="cf-stage-status">{t(`stage.status.${stage.status}`)}</span>
      {stage.parallel ? <IconBranch /> : null}
      {stage.humanApproval ? <IconShield /> : null}
      {stage.round > 0 ? <span style={{ opacity: 0.85 }}>{t('work.round', { round: stage.round })}</span> : null}
      {failGotoName ? <span className="cf-stage-goto" title={t('pipeline.failGoto', { stage: failGotoName })}>↩</span> : null}
      {/* No resolvable gate type: say so in a neutral chip rather than let a
          guessed type pass for the rule this stage runs. */}
      {stage.gateType === UNKNOWN_GATE_TYPE ? (
        <span className="cf-chip" style={{ color: TOKEN.labelSecondary }} title={t('pipeline.gate.unknownHint')}>
          {t('pipeline.gate.unknown')}
        </span>
      ) : null}
    </button>
  )
}

function PipelineConnector({ previous }: { readonly previous: SnapshotStage }): ReactNode {
  const live = previous.status === 'active' || previous.status === 'gate'
  const stroke = previous.status === 'active' ? TOKEN.brand : previous.status === 'passed' ? TOKEN.success : TOKEN.borderL1
  return (
    <svg className="cf-conn" width="22" height="10" aria-hidden="true">
      <line
        className={live ? 'cf-flow' : undefined}
        x1="0"
        y1="5"
        x2="22"
        y2="5"
        stroke={stroke}
        strokeWidth="1.2"
      />
    </svg>
  )
}

/* ----------------------------------------------------------------- alerts */

/**
 * How many alert rows the strip shows before the rest collapse into a count.
 *
 * Three is the most that fits above the columns without pushing the pipeline
 * they are about out of the panel; the remainder is counted rather than dropped,
 * so "more than three" stays visible.
 */
const ALERT_LIMIT = 3

/**
 * The panel's one "a human is needed" surface: the snapshot's alerts, most
 * urgent first, as a strip spanning the full width above the three columns.
 *
 * The host exposes no notification API, so this strip *is* the notification:
 * severity drives the colour, the clearing step is prefixed with an arrow, and
 * the whole thing is `null` — not an empty box — when the factory is green.
 *
 * @param props - translation seat and the alerts to render, already ordered.
 * @returns the strip, or `null` when there is nothing to raise.
 */
function AlertStrip({
  t,
  alerts,
}: {
  readonly t: CodeFactoryTranslate
  readonly alerts: readonly SnapshotAlert[]
}): ReactNode {
  if (alerts.length === 0) return null
  const shown = alerts.slice(0, ALERT_LIMIT)
  const hidden = alerts.length - shown.length
  return (
    <div className="cf-alerts" role="alert" aria-label={t('alert.aria')}>
      {shown.map(alert => {
        const color = ALERT_SEVERITY_COLOR[alert.severity]
        // One chip: the stage the alert is about, or the role when it names none.
        const chip = alert.stage ?? alert.role
        return (
          <div key={alert.id} className="cf-alert" style={{ color, borderColor: wash(color, 40), background: wash(color, 12) }}>
            <span className="cf-alert-title">{alert.title}</span>
            {alert.detail ? <span className="cf-alert-detail cf-mono">{alert.detail}</span> : null}
            {alert.next ? <span className="cf-alert-next">{`→ ${alert.next}`}</span> : null}
            {chip ? <span className="cf-alert-chip cf-mono">{chip}</span> : null}
          </div>
        )
      })}
      {hidden > 0 ? <div className="cf-alert-more cf-mono">{t('alert.more', { count: hidden })}</div> : null}
    </div>
  )
}

/* --------------------------------------------------------- right sections */

/**
 * How many lessons the right column shows before "show all".
 *
 * The host projection is already scoped to this factory's roster and its
 * hottest mistakes; six is what fits beside the other sections without turning
 * the cockpit into a copy of the whole ledger archive.
 */
const EVOLUTION_LESSON_LIMIT = 6

/** Artifacts rendered before "show all": a running factory can register ~180. */
const ARTIFACT_PREVIEW_LIMIT = 12

/** Verdict label for a DoD row. */
function dodVerdictLabel(verdict: DodStatus, t: CodeFactoryTranslate): string {
  switch (verdict) {
    case 'passed':
      return t('dod.itemOk')
    case 'skipped':
      return t('dod.itemSkip')
    case 'pending':
      return t('dod.itemPending')
    case 'failed':
    default:
      return t('dod.itemFail')
  }
}

/** Semantic colour for a DoD verdict. */
function dodVerdictColor(verdict: DodStatus): string {
  switch (verdict) {
    case 'passed':
      return TOKEN.success
    case 'failed':
      return TOKEN.error
    case 'skipped':
      return TOKEN.labelSecondary
    case 'pending':
    default:
      return TOKEN.idle
  }
}

/** Chips for every message-kind filter, in the shared reading order. */
function FeedKindChips({
  t,
  kind,
  onKind,
}: {
  readonly t: CodeFactoryTranslate
  readonly kind: FeedKindFilter
  readonly onKind: (kind: FeedKindFilter) => void
}): ReactNode {
  return (
    <div className="cf-chips">
      {FEED_KIND_FILTERS.map(option => (
        <FilterChip
          key={option}
          active={kind === option}
          label={option === 'all' ? t('work.kind.all') : option === 'other' ? t('work.kind.other') : t(`feed.kind.${option}`)}
          onClick={() => onKind(option)}
        />
      ))}
    </div>
  )
}

/**
 * One cross-task lesson card.
 *
 * The headline stays a single ellipsised line (the full text is the tooltip);
 * expansion reveals the audit fields — gate detail, source factory, task family,
 * first/last seen — and the stage's own copy control copies the lesson text.
 */
function LessonCard({
  snapshot,
  t,
  lesson,
}: {
  readonly snapshot: FactorySnapshot
  readonly t: CodeFactoryTranslate
  readonly lesson: LessonRecord
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const owner = roleView(snapshot, lesson.role, t)
  const stage = lesson.stageName || stageName(snapshot, lesson.stage) || lesson.stage
  const resolved = lesson.resolvedAt !== undefined
  const hasAudit =
    lesson.detail !== undefined ||
    lesson.factoryId !== undefined ||
    lesson.taskType !== undefined ||
    lesson.firstAt > 0 ||
    lesson.lastAt > 0
  return (
    <div className={resolved ? 'cf-card cf-lesson cf-lesson-resolved' : 'cf-card cf-lesson'}>
      <RoleAvatar role={lesson.role} swatch={owner.swatch} codename={owner.codename} title={owner.title} size={24} />
      <div className="cf-card-main">
        <div className="cf-lesson-meta cf-mono">
          <span style={{ color: roleInk(owner.swatch) }}>{owner.title}</span>
          <span className="cf-ellipsis" title={t('feed.stage', { stage })}>
            {t('feed.stage', { stage })}
          </span>
          <span
            className={lesson.count > 1 ? 'cf-lesson-count cf-mono' : 'cf-lesson-count cf-lesson-count-once cf-mono'}
            title={t('evolution.countHint', { count: lesson.count })}
          >
            {t('evolution.count', { count: lesson.count })}
          </span>
          {resolved ? (
            <span className="cf-chip cf-lesson-ok cf-mono">
              <IconCheck />
              {t('evolution.resolved')}
            </span>
          ) : null}
          {hasAudit ? (
            <button
              type="button"
              className="cf-msg-more"
              aria-expanded={expanded}
              onClick={() => setExpanded(value => !value)}
            >
              {expanded ? t('evolution.collapse') : t('evolution.expand')}
            </button>
          ) : null}
          <span className="cf-msg-actions">
            <CopyButton t={t} text={lesson.text} label={t('copy.lesson')} />
          </span>
        </div>
        <div className="cf-card-name cf-ellipsis" title={lesson.text}>
          {lesson.text}
        </div>
        {expanded ? (
          <div className="cf-evo-detail cf-mono">
            {lesson.detail ? <div className="cf-kv"><span className="cf-kv-k">{t('evolution.detail')}</span><span className="cf-kv-v cf-kv-v-wrap">{lesson.detail}</span></div> : null}
            {lesson.factoryId ? <div className="cf-kv"><span className="cf-kv-k">{t('evolution.factory')}</span><span className="cf-kv-v cf-kv-v-mono">{lesson.factoryId}</span></div> : null}
            {lesson.taskType ? <div className="cf-kv"><span className="cf-kv-k">{t('evolution.taskType')}</span><span className="cf-kv-v">{lesson.taskType}</span></div> : null}
            {lesson.gateType ? <div className="cf-kv"><span className="cf-kv-k">{t('inspector.gateType')}</span><span className="cf-kv-v">{lesson.gateType}</span></div> : null}
            {lesson.firstAt > 0 ? <div className="cf-kv"><span className="cf-kv-k">{t('evolution.firstSeen', { time: formatClock(lesson.firstAt) })}</span></div> : null}
            {lesson.lastAt > 0 ? <div className="cf-kv"><span className="cf-kv-k">{t('evolution.lastSeen', { time: formatClock(lesson.lastAt) })}</span></div> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* ---------------------------------------------------- plugin improvements */

/**
 * One plugin-improvement proposal card.
 *
 * No avatar: proposals are about the plugin's own files, not about a party in
 * the factory. Every card carries exactly one copy control (target file +
 * suggestion), so the section adds no chrome-level copy/avatar noise.
 */
function ImprovementCard({
  snapshot,
  t,
  now,
  proposal,
}: {
  readonly snapshot: FactorySnapshot
  readonly t: CodeFactoryTranslate
  readonly now?: number
  readonly proposal: ImprovementProposal
}): ReactNode {
  const [expanded, setExpanded] = useState(false)
  const role = proposal.role === undefined ? undefined : roleView(snapshot, proposal.role, t)
  const stage = stageName(snapshot, proposal.stage)
  const statusColor = proposal.status === 'validated' ? TOKEN.success : TOKEN.warn
  const lastAt =
    proposal.lastAt > 0
      ? now === undefined
        ? formatClock(proposal.lastAt)
        : formatAgo(now - proposal.lastAt, t)
      : undefined
  const copyValue = proposal.targetFile === undefined ? proposal.suggestion : `${proposal.targetFile}\n${proposal.suggestion}`
  return (
    <div className="cf-improvement">
      <div className="cf-improvement-main">
        <div className="cf-improvement-head cf-mono">
          <span className="cf-improvement-title" title={proposal.title}>
            {proposal.title}
          </span>
          <span className="cf-improvement-status cf-mono" style={{ color: statusColor, borderColor: wash(statusColor, 45) }}>
            {t(`evolution.improvements.status.${proposal.status}`)}
          </span>
          <span className="cf-improvement-evidence" title={t('evolution.countHint', { count: proposal.evidenceCount })}>
            {t('evolution.count', { count: proposal.evidenceCount })}
          </span>
        </div>
        <div className="cf-improvement-meta cf-mono">
          {role ? <span style={{ color: roleInk(role.swatch) }}>{role.title}</span> : null}
          {stage ? <span>{t('feed.stage', { stage })}</span> : null}
          {lastAt ? <span>{t('evolution.improvements.lastAt', { ago: lastAt })}</span> : null}
        </div>
        <div className="cf-improvement-target cf-mono">
          <span className="cf-improvement-target-label">{t('evolution.improvements.target')}</span>
          {proposal.targetFile ? (
            <span className="cf-improvement-file" title={proposal.targetFile}>
              {proposal.targetFile}
            </span>
          ) : (
            <span className="cf-improvement-target-none">{t('format.none')}</span>
          )}
        </div>
        <div className={expanded ? 'cf-improvement-suggestion' : 'cf-improvement-suggestion cf-improvement-clamp'}>
          {proposal.suggestion}
        </div>
        <button
          type="button"
          className="cf-improvement-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? t('evolution.improvements.collapse') : t('evolution.improvements.expand')}
        </button>
        <div className="cf-improvement-rationale cf-mono" title={proposal.rationale}>
          {proposal.rationale}
        </div>
        <div className="cf-improvement-actions">
          <CopyButton t={t} text={copyValue} label={t('evolution.improvements.copy')} className="cf-improvement-copy" />
        </div>
      </div>
    </div>
  )
}

/** Props of the exported {@link ImprovementsPanel} (explicit filters for SSR). */
export interface ImprovementsPanelProps {
  readonly snapshot: FactorySnapshot
  readonly t: CodeFactoryTranslate
  /** Clock for the relative last-seen stamp; omitted in a static fixture. */
  readonly now?: number
  readonly proposals: readonly ImprovementProposal[]
  readonly filter: ImprovementFilterMode
  readonly onFilter: (filter: ImprovementFilterMode) => void
}

/**
 * "Plugin improvements": the recurring-lesson backlog as actionable proposals.
 *
 * Owns only the preview/expansion state; the filter and the proposal list are
 * explicit props so an offline check can render every state (all / open /
 * validated / empty) without a browser.
 */
export function ImprovementsPanel({
  snapshot,
  t,
  now,
  proposals,
  filter,
  onFilter,
}: ImprovementsPanelProps): ReactNode {
  const [showAll, setShowAll] = useState(false)
  useEffect(() => {
    setShowAll(false)
  }, [filter])
  const openCount = proposals.filter(proposal => proposal.status === 'open').length
  const validatedCount = proposals.length - openCount
  const filtered = filterImprovements(proposals, filter)
  const shown = showAll ? filtered : filtered.slice(0, IMPROVEMENT_PREVIEW_LIMIT)
  const hidden = filtered.length - shown.length
  return (
    <section className="cf-improvements" aria-label={t('aria.improvements')}>
      <div className="cf-improvements-head cf-mono">
        <span className="cf-improvements-title">{t('evolution.improvements.title')}</span>
        <span className="cf-improvements-note">{t('evolution.improvements.count', { count: proposals.length })}</span>
      </div>
      <div className="cf-improvement-toolbar cf-chips">
        {IMPROVEMENT_FILTERS.map(option => (
          <FilterChip
            key={option}
            active={filter === option}
            label={
              option === 'all'
                ? t('evolution.improvements.filter.all')
                : option === 'open'
                  ? t('evolution.improvements.filter.open')
                  : t('evolution.improvements.filter.validated')
            }
            count={option === 'all' ? proposals.length : option === 'open' ? openCount : validatedCount}
            onClick={() => onFilter(option)}
          />
        ))}
      </div>
      {proposals.length === 0 ? (
        <div className="cf-improvement-empty cf-mono">{t('evolution.improvements.empty')}</div>
      ) : filtered.length === 0 ? (
        <div className="cf-improvement-empty cf-mono">{t('evolution.improvements.noMatch')}</div>
      ) : (
        <>
          {shown.map(proposal => (
            <ImprovementCard key={proposal.id} snapshot={snapshot} t={t} now={now} proposal={proposal} />
          ))}
          {hidden > 0 ? (
            <button type="button" className="cf-improvement-more" onClick={() => setShowAll(true)}>
              {t('evolution.improvements.showAll', { count: filtered.length })}
            </button>
          ) : null}
          {showAll && filtered.length > IMPROVEMENT_PREVIEW_LIMIT ? (
            <button type="button" className="cf-improvement-more" onClick={() => setShowAll(false)}>
              {t('evolution.improvements.showLess')}
            </button>
          ) : null}
        </>
      )}
    </section>
  )
}

/** Props of the exported {@link EvolutionSection}: explicit, controlled filters. */
export interface EvolutionSectionProps {
  readonly snapshot: FactorySnapshot
  readonly t: CodeFactoryTranslate
  readonly collapsed: boolean
  readonly onToggleCollapsed: () => void
  readonly filter: LessonFilterMode
  readonly onFilter: (filter: LessonFilterMode) => void
  readonly role: string
  readonly onRole: (role: string) => void
  /** Clock for proposal last-seen stamps; omitted in a static fixture. */
  readonly now?: number
}

/** Props of the exported {@link EvolutionContent} (a section body, no shell). */
export interface EvolutionContentProps {
  readonly snapshot: FactorySnapshot
  readonly t: CodeFactoryTranslate
  readonly filter: LessonFilterMode
  readonly onFilter: (filter: LessonFilterMode) => void
  readonly role: string
  readonly onRole: (role: string) => void
  /** Clock for proposal last-seen stamps; omitted in a static fixture. */
  readonly now?: number
}

/**
 * The evolution section body: stats, resolution/role filters, lesson cards and
 * the two distinguishable empty states. The section header/collapse chrome is
 * supplied by {@link SectionShell} (standalone) or by a dock module (board).
 */
export function EvolutionContent({ snapshot, t, filter, onFilter, role, onRole, now }: EvolutionContentProps): ReactNode {
  const [showAll, setShowAll] = useState(false)
  const [improvementFilter, setImprovementFilter] = useState<ImprovementFilterMode>('all')
  const evolution = snapshot.evolution
  useEffect(() => {
    setShowAll(false)
  }, [filter, role])
  if (!evolution) return null
  const roleOptions: string[] = []
  for (const member of snapshot.members) roleOptions.push(member.role)
  for (const lesson of evolution.lessons) {
    if (!roleOptions.includes(lesson.role)) roleOptions.push(lesson.role)
  }
  roleOptions.sort((left, right) => left.localeCompare(right))
  // A role can leave the roster/ledger between snapshots. The <select> must
  // never show "all roles" while the rows are still filtered by the stale id:
  // the displayed value and the filter are derived from the same variable.
  const effectiveRole = resolveLessonRole(snapshot, role)
  const filtered = filterLessons(evolution.lessons, filter, effectiveRole)
  const shown = showAll ? filtered : filtered.slice(0, EVOLUTION_LESSON_LIMIT)
  const hidden = filtered.length - shown.length
  const emptyLedger = evolution.lessons.length === 0
  return (
    <div className="cf-pad">
      <div className="cf-evo-stats cf-mono">
        <span className="cf-evo-stat">{t('evolution.stat.total', { count: evolution.stats.total })}</span>
        <span className="cf-evo-stat cf-evo-stat-recurring">
          {t('evolution.stat.recurring', { count: evolution.stats.recurring })}
        </span>
        <span className="cf-evo-stat cf-evo-stat-resolved">
          {t('evolution.stat.resolved', { count: evolution.stats.resolved })}
        </span>
      </div>
      <div className="cf-evo-toolbar">
        <div className="cf-chips">
          {LESSON_FILTERS.map(option => (
            <FilterChip
              key={option}
              active={filter === option}
              label={
                option === 'all'
                  ? t('evolution.filter.all')
                  : option === 'open'
                    ? t('evolution.filter.open')
                    : t('evolution.filter.resolved')
              }
              onClick={() => onFilter(option)}
            />
          ))}
        </div>
        <select
          className="cf-tool-select"
          aria-label={t('evolution.roleFilter')}
          value={effectiveRole}
          onChange={event => onRole(event.target.value)}
        >
          <option value="all">{t('evolution.roleAll')}</option>
          {roleOptions.map(option => (
            <option key={option} value={option}>
              {roleView(snapshot, option, t).title}
            </option>
          ))}
        </select>
      </div>
      {shown.length === 0 ? (
        <div className="cf-evo-empty">
          <div className="cf-evo-empty-title">
            {emptyLedger
              ? evolution.stats.total > 0
                ? t('evolution.emptyFiltered', { total: evolution.stats.total })
                : t('evolution.empty')
              : t('evolution.noMatch')}
          </div>
          <div className="cf-evo-empty-body">
            {emptyLedger ? (evolution.stats.total > 0 ? t('evolution.emptyFilteredBody') : t('evolution.emptyBody')) : t('evolution.noMatchBody')}
          </div>
        </div>
      ) : (
        <>
          {shown.map(lesson => (
            <LessonCard key={lesson.id} snapshot={snapshot} t={t} lesson={lesson} />
          ))}
          {hidden > 0 ? (
            <button type="button" className="cf-showmore" onClick={() => setShowAll(true)}>
              {t('evolution.showAll', { count: filtered.length })}
            </button>
          ) : null}
          {showAll && filtered.length > EVOLUTION_LESSON_LIMIT ? (
            <button type="button" className="cf-showmore" onClick={() => setShowAll(false)}>
              {t('evolution.showLess')}
            </button>
          ) : null}
        </>
      )}
      <ImprovementsPanel
        snapshot={snapshot}
        t={t}
        now={now}
        proposals={improvementProposals(snapshot)}
        filter={improvementFilter}
        onFilter={setImprovementFilter}
      />
    </div>
  )
}

/**
 * Standalone evolution section (shell + content), kept for the offline checks
 * that render each right-column section directly.
 */
export function EvolutionSection({
  snapshot,
  t,
  collapsed,
  onToggleCollapsed,
  filter,
  onFilter,
  role,
  onRole,
  now,
}: EvolutionSectionProps): ReactNode {
  if (!snapshot.evolution) return null
  const lessons = snapshot.evolution.lessons
  const count = filterLessons(lessons, filter, resolveLessonRole(snapshot, role)).length
  return (
    <SectionShell
      t={t}
      id="evolution"
      title={t('section.evolution')}
      note={t('section.evolutionNote', { count })}
      collapsed={collapsed}
      onToggle={onToggleCollapsed}
    >
      <EvolutionContent snapshot={snapshot} t={t} filter={filter} onFilter={onFilter} role={role} onRole={onRole} now={now} />
    </SectionShell>
  )
}

/** Props of the exported {@link FeedSection}. */
export interface FeedSectionProps {
  readonly snapshot: FactorySnapshot
  readonly t: CodeFactoryTranslate
  readonly collapsed: boolean
  readonly onToggleCollapsed: () => void
  readonly query: string
  readonly onQuery: (query: string) => void
  readonly kind: FeedKindFilter
  readonly onKind: (kind: FeedKindFilter) => void
}

/** Props of the exported {@link FeedContent} (a section body, no shell). */
export interface FeedContentProps {
  readonly snapshot: FactorySnapshot
  readonly t: CodeFactoryTranslate
  readonly query: string
  readonly onQuery: (query: string) => void
  readonly kind: FeedKindFilter
  readonly onKind: (kind: FeedKindFilter) => void
}

/** Live feed body: chronological list, kind chips, search, copy, expand. */
export function FeedContent({ snapshot, t, query, onQuery, kind, onKind }: FeedContentProps): ReactNode {
  const ordered = useMemo(() => snapshot.feed.slice().sort((left, right) => left.ts - right.ts), [snapshot.feed])
  const filtered = filterFeedMessages(ordered, { query, kind })
  return (
    <>
      <div className="cf-toolbar">
        <SearchField
          t={t}
          value={query}
          onChange={onQuery}
          placeholder={t('feed.search')}
          ariaLabel={t('aria.feedSearch')}
        />
        <FeedKindChips t={t} kind={kind} onKind={onKind} />
      </div>
      <div className="cf-pad">
        {ordered.length === 0 ? (
          <EmptyBlock title={t('feed.empty.title')} body={t('feed.empty.body')} />
        ) : filtered.length === 0 ? (
          <EmptyBlock title={t('feed.filteredEmptyTitle')} body={t('feed.filteredEmptyBody')} />
        ) : (
          filtered.map(message => <MessageRow key={message.id} snapshot={snapshot} t={t} message={message} />)
        )}
      </div>
    </>
  )
}

/** Standalone feed section (shell + content), kept for direct offline rendering. */
export function FeedSection({
  snapshot,
  t,
  collapsed,
  onToggleCollapsed,
  query,
  onQuery,
  kind,
  onKind,
}: FeedSectionProps): ReactNode {
  return (
    <SectionShell
      t={t}
      id="feed"
      title={t('section.feed')}
      note={t('section.feedNote', { count: filterFeedMessages(snapshot.feed, { query, kind }).length })}
      collapsed={collapsed}
      onToggle={onToggleCollapsed}
    >
      <FeedContent snapshot={snapshot} t={t} query={query} onQuery={onQuery} kind={kind} onKind={onKind} />
    </SectionShell>
  )
}

/** Props of the exported {@link ArtifactsSection}. */
export interface ArtifactsSectionProps {
  readonly snapshot: FactorySnapshot
  readonly t: CodeFactoryTranslate
  readonly now: number
  readonly collapsed: boolean
  readonly onToggleCollapsed: () => void
  readonly query: string
  readonly onQuery: (query: string) => void
  readonly sort: ArtifactSortMode
  readonly onSort: (sort: ArtifactSortMode) => void
  /** When set, only this stage's artifacts are listed (the inspector filter). */
  readonly stageId: string | undefined
  readonly onClearStage: () => void
}

/** Props of the exported {@link ArtifactsContent} (a section body, no shell). */
export interface ArtifactsContentProps {
  readonly snapshot: FactorySnapshot
  readonly t: CodeFactoryTranslate
  readonly now: number
  readonly query: string
  readonly onQuery: (query: string) => void
  readonly sort: ArtifactSortMode
  readonly onSort: (sort: ArtifactSortMode) => void
  readonly stageId: string | undefined
  readonly onClearStage: () => void
}

/**
 * The artifact registry body: search, sort, stage filter, owner avatar,
 * path/size/ago, click-to-expand full path + copy. A running factory can
 * register ~180 artifacts, so the default view is a bounded preview with an
 * explicit "show all"; filtering/sorting resets the expansion window.
 */
export function ArtifactsContent({
  snapshot,
  t,
  now,
  query,
  onQuery,
  sort,
  onSort,
  stageId,
  onClearStage,
}: ArtifactsContentProps): ReactNode {
  const [showAll, setShowAll] = useState(false)
  const [openPath, setOpenPath] = useState<string | undefined>(undefined)
  useEffect(() => {
    setShowAll(false)
    setOpenPath(undefined)
  }, [query, sort, stageId])
  const filtered = filterArtifacts(snapshot.artifacts, { query, stageId })
  const ordered = sortArtifacts(filtered, sort)
  const visible = showAll ? ordered : ordered.slice(0, ARTIFACT_PREVIEW_LIMIT)
  return (
    <>
      <div className="cf-toolbar">
        <SearchField
          t={t}
          value={query}
          onChange={onQuery}
          placeholder={t('artifacts.search')}
          ariaLabel={t('aria.artifactSearch')}
        />
        <select
          className="cf-tool-select"
          aria-label={t('artifacts.sortLabel')}
          value={sort}
          onChange={event => onSort(event.target.value as ArtifactSortMode)}
        >
          {ARTIFACT_SORTS.map(option => (
            <option key={option} value={option}>
              {t(`artifacts.sort.${option}`)}
            </option>
          ))}
        </select>
        {stageId !== undefined ? (
          <button type="button" className="cf-tool-btn cf-tool-btn-on" onClick={onClearStage}>
            {t('artifacts.stageFilter', { stage: stageName(snapshot, stageId) ?? stageId })} ×
          </button>
        ) : null}
      </div>
      <div className="cf-pad">
        {snapshot.artifacts.length === 0 ? (
          <EmptyBlock title={t('artifacts.empty')} wide />
        ) : filtered.length === 0 ? (
          <EmptyBlock title={t('artifacts.emptyFiltered')} wide />
        ) : (
          <>
            {visible.map(artifact => {
              const owner = roleView(snapshot, artifact.by, t)
              const open = openPath === artifact.path
              return (
                <div key={artifact.path} className="cf-card cf-art">
                  <div className="cf-card-main">
                    <button
                      type="button"
                      className="cf-art-head"
                      aria-expanded={open}
                      onClick={() => setOpenPath(open ? undefined : artifact.path)}
                    >
                      <RoleAvatar role={artifact.by} swatch={owner.swatch} codename={owner.codename} title={owner.title} size={18} />
                      <span className="cf-card-main" style={{ textAlign: 'left' }}>
                        <span className="cf-card-name cf-mono cf-ellipsis" title={artifact.path} style={{ display: 'block' }}>
                          {artifact.path}
                        </span>
                        <span className="cf-card-sub cf-mono" style={{ display: 'block' }}>
                          {t('artifacts.by', { role: owner.title })} · {t('artifacts.stage', { stage: stageName(snapshot, artifact.stage) ?? artifact.stage })} · {formatBytes(artifact.bytes)} · {formatAgo(now - artifact.at, t)}
                        </span>
                      </span>
                      <IconChevron open={open} />
                    </button>
                    {open ? (
                      <div className="cf-art-expanded cf-mono">
                        <div className="cf-kv">
                          <span className="cf-kv-k">{t('artifacts.title')}</span>
                          <span className="cf-kv-v cf-kv-v-wrap cf-kv-v-mono">{artifact.path}</span>
                        </div>
                        <div className="cf-kv">
                          <span className="cf-kv-k">{t('inspector.at')}</span>
                          <span className="cf-kv-v">{formatClock(artifact.at)}</span>
                        </div>
                        <div className="cf-art-actions">
                          <CopyButton t={t} text={artifact.path} label={t('copy.path')} />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}
            {ordered.length > ARTIFACT_PREVIEW_LIMIT ? (
              <button type="button" className="cf-showmore" onClick={() => setShowAll(value => !value)}>
                {showAll ? t('artifacts.showLess') : t('artifacts.showAll', { count: ordered.length })}
              </button>
            ) : null}
          </>
        )}
      </div>
    </>
  )
}

/** Standalone artifacts section (shell + content), kept for direct offline rendering. */
export function ArtifactsSection({
  snapshot,
  t,
  now,
  collapsed,
  onToggleCollapsed,
  query,
  onQuery,
  sort,
  onSort,
  stageId,
  onClearStage,
}: ArtifactsSectionProps): ReactNode {
  return (
    <SectionShell
      t={t}
      id="artifacts"
      title={t('section.artifacts')}
      titleHint={t('artifacts.title')}
      note={t('section.artifactsNote', { count: filterArtifacts(snapshot.artifacts, { query, stageId }).length })}
      collapsed={collapsed}
      onToggle={onToggleCollapsed}
    >
      <ArtifactsContent
        snapshot={snapshot}
        t={t}
        now={now}
        query={query}
        onQuery={onQuery}
        sort={sort}
        onSort={onSort}
        stageId={stageId}
        onClearStage={onClearStage}
      />
    </SectionShell>
  )
}

/** Props of the exported {@link DodSection}. */
export interface DodSectionProps {
  readonly snapshot: FactorySnapshot
  readonly t: CodeFactoryTranslate
  readonly collapsed: boolean
  readonly onToggleCollapsed: () => void
  readonly filter: DodFilter
  readonly onFilter: (filter: DodFilter) => void
}

/** Props of the exported {@link DodContent} (a section body, no shell). */
export interface DodContentProps {
  readonly snapshot: FactorySnapshot
  readonly t: CodeFactoryTranslate
  readonly filter: DodFilter
  readonly onFilter: (filter: DodFilter) => void
}

/** DoD checks body: status chips with counts, progress bar, expandable definitions. */
export function DodContent({ snapshot, t, filter, onFilter }: DodContentProps): ReactNode {
  const [openId, setOpenId] = useState<number | undefined>(undefined)
  const verdicts = snapshot.dod.map(item => dodVerdict(item))
  const passed = verdicts.filter(verdict => verdict === 'passed').length
  const counts: Readonly<Record<DodStatus, number>> = {
    passed,
    skipped: verdicts.filter(verdict => verdict === 'skipped').length,
    failed: verdicts.filter(verdict => verdict === 'failed').length,
    pending: verdicts.filter(verdict => verdict === 'pending').length,
  }
  const filtered = filterDod(snapshot.dod, filter)
  const progress = snapshot.dod.length > 0 ? Math.round((passed / snapshot.dod.length) * 100) : 0
  return (
    <>
      <div className="cf-toolbar">
        <div className="cf-chips">
          {DOD_FILTERS.map(option => (
            <FilterChip
              key={option}
              active={filter === option}
              label={
                option === 'all'
                  ? t('dod.filter.all')
                  : option === 'failed'
                    ? t('dod.filter.failed')
                    : option === 'pending'
                      ? t('dod.filter.pending')
                      : option === 'passed'
                        ? t('dod.filter.passed')
                        : t('dod.filter.skipped')
              }
              count={option === 'all' ? snapshot.dod.length : counts[option]}
              onClick={() => onFilter(option)}
            />
          ))}
        </div>
      </div>
      <div className="cf-pad">
        <div className="cf-dod-progress cf-mono">
          <span>{t('dod.passed', { passed, total: snapshot.dod.length })}</span>
          <div className="cf-meter" role="progressbar" aria-label={t('dod.passed', { passed, total: snapshot.dod.length })} aria-valuenow={passed} aria-valuemin={0} aria-valuemax={snapshot.dod.length}>
            <div className="cf-meter-fill" style={{ width: `${progress}%`, background: TOKEN.success }} />
          </div>
        </div>
        {snapshot.dod.length === 0 ? (
          <EmptyBlock title={t('dod.empty')} wide />
        ) : filtered.length === 0 ? (
          <EmptyBlock title={t('dod.emptyFiltered')} wide />
        ) : (
          filtered.map(item => {
            const verdict = dodVerdict(item)
            const color = dodVerdictColor(verdict)
            const open = openId === item.id
            const detail = item.kind !== undefined || item.artifact !== undefined || item.expect !== undefined || item.run !== undefined || item.securityOnly === true
            return (
              <div key={item.id} className="cf-card">
                <div className="cf-card-main">
                  <button
                    type="button"
                    className="cf-art-head"
                    aria-expanded={open}
                    onClick={() => setOpenId(open ? undefined : item.id)}
                    title={item.evidence}
                  >
                    <span style={{ color, flex: 'none', marginTop: 1 }}>{verdict === 'passed' ? <IconCheck /> : verdict === 'failed' ? <IconCross /> : <Led color={color} pulse={false} />}</span>
                    <span className="cf-card-main" style={{ textAlign: 'left' }}>
                      <span className="cf-card-name" style={{ display: 'block', whiteSpace: 'normal', color: verdict === 'passed' ? TOKEN.labelPrimary : TOKEN.labelSecondary }}>
                        {item.id}. {item.label}
                      </span>
                      {item.evidence ? (
                        <span className="cf-card-sub cf-mono cf-ellipsis" title={item.evidence} style={{ display: 'block' }}>
                          {t('dod.evidence')}: {item.evidence}
                        </span>
                      ) : null}
                    </span>
                    <span className="cf-chip cf-mono" style={{ color, borderColor: wash(color, 45) }}>
                      {dodVerdictLabel(verdict, t)}
                    </span>
                    <IconChevron open={open} />
                  </button>
                  {open ? (
                    <div className="cf-dod-detail cf-mono">
                      {item.kind ? <div className="cf-kv"><span className="cf-kv-k">{t('dod.field.kind')}</span><span className="cf-kv-v"><span className="cf-kind-chip">{t(`dod.kind.${item.kind}`)}</span></span></div> : null}
                      {item.securityOnly ? <div className="cf-kv"><span className="cf-kv-k">{t('dod.field.securityOnly')}</span><span className="cf-kv-v">{t('format.yes')}</span></div> : null}
                      {item.artifact ? <div className="cf-kv"><span className="cf-kv-k">{t('dod.field.artifact')}</span><span className="cf-kv-v cf-kv-v-wrap cf-kv-v-mono">{item.artifact}</span></div> : null}
                      {item.expect ? <div className="cf-kv"><span className="cf-kv-k">{t('dod.field.expect')}</span><span className="cf-kv-v cf-kv-v-wrap cf-kv-v-mono">{item.expect}</span></div> : null}
                      {item.run ? <div className="cf-kv"><span className="cf-kv-k">{t('dod.field.run')}</span><span className="cf-kv-v cf-kv-v-wrap cf-kv-v-mono">{item.run}</span></div> : null}
                      {item.evidence ? (
                        <div className="cf-art-actions">
                          <CopyButton t={t} text={item.evidence} label={t('copy.evidence')} />
                        </div>
                      ) : null}
                      {!detail && !item.evidence ? <div className="cf-kv-v">{t('format.none')}</div> : null}
                    </div>
                  ) : null}
                </div>
              </div>
            )
          })
        )}
      </div>
    </>
  )
}

/** Standalone DoD section (shell + content), kept for direct offline rendering. */
export function DodSection({ snapshot, t, collapsed, onToggleCollapsed, filter, onFilter }: DodSectionProps): ReactNode {
  const passed = snapshot.dod.filter(item => dodVerdict(item) === 'passed').length
  return (
    <SectionShell
      t={t}
      id="dod"
      title={t('section.dod')}
      titleHint={t('dod.title')}
      note={t('section.dodNote', { passed, total: snapshot.dod.length })}
      collapsed={collapsed}
      onToggle={onToggleCollapsed}
    >
      <DodContent snapshot={snapshot} t={t} filter={filter} onFilter={onFilter} />
    </SectionShell>
  )
}

/* ------------------------------------------------------------ roster panel */

/** Props of the exported {@link RosterPanel}. */
export interface RosterPanelProps {
  readonly snapshot: FactorySnapshot
  readonly t: CodeFactoryTranslate
  readonly selectedRole: string | undefined
  readonly onSelectRole: (role: string) => void
  readonly query: string
  readonly onQuery: (query: string) => void
  readonly statusFilter: MemberStatusFilter
  readonly onStatusFilter: (filter: MemberStatusFilter) => void
  readonly sort: MemberSortMode
  readonly onSort: (sort: MemberSortMode) => void
}

/** Props of {@link RosterContent}: the roster body without the column chrome. */
export type RosterContentProps = RosterPanelProps

/**
 * The roster body: search, status chips with counts, ordering, expandable rows.
 *
 * Selecting a row still drives WORK OUTPUT; the expand control is a sibling
 * button (never nested) so both actions stay keyboard-reachable. The column
 * title/head is supplied by the dock module (or by {@link RosterPanel} when it
 * is rendered standalone by an offline check).
 */
export function RosterContent({
  snapshot,
  t,
  selectedRole,
  onSelectRole,
  query,
  onQuery,
  statusFilter,
  onStatusFilter,
  sort,
  onSort,
}: RosterPanelProps): ReactNode {
  const [expandedRole, setExpandedRole] = useState<string | undefined>(undefined)
  const filtered = filterMembers(snapshot.members, query, statusFilter, sort)
  const counts = useMemo(() => {
    const byStatus: Record<MemberStatus, number> = {
      staged: 0,
      idle: 0,
      working: 0,
      rework: 0,
      blocked: 0,
      done: 0,
      error: 0,
      removed: 0,
    }
    for (const member of snapshot.members) byStatus[member.status] += 1
    return byStatus
  }, [snapshot.members])
  return (
    <>
      <div className="cf-roster-tools">
        <SearchField
          t={t}
          value={query}
          onChange={onQuery}
          placeholder={t('roster.search')}
          ariaLabel={t('aria.rosterSearch')}
        />
        <div className="cf-chips">
          {MEMBER_STATUS_FILTERS.map(option => (
            <FilterChip
              key={option}
              active={statusFilter === option}
              label={option === 'all' ? t('roster.filter.all') : t(`member.status.${option}`)}
              count={option === 'all' ? snapshot.members.length : counts[option]}
              onClick={() => onStatusFilter(option)}
            />
          ))}
        </div>
        <div className="cf-chips">
          <span className="cf-col-note cf-mono" style={{ marginRight: 2 }}>
            {t('roster.sortLabel')}
          </span>
          <FilterChip active={sort === 'roster'} label={t('roster.sort.roster')} onClick={() => onSort('roster')} />
          <FilterChip active={sort === 'status'} label={t('roster.sort.status')} onClick={() => onSort('status')} />
        </div>
      </div>
      <div className="cf-fill cf-scroll">
        {snapshot.members.length === 0 ? (
          <EmptyBlock title={t('roster.empty')} body={t('work.empty.body')} />
        ) : filtered.length === 0 ? (
          <EmptyBlock title={t('roster.filteredEmpty')} body={t('work.filteredEmptyBody')} />
        ) : (
          filtered.map(member => {
            const color = MEMBER_STATUS_COLOR[member.status]
            const swatch = roleSwatch(member.role, member.color)
            const isActive = selectedRole === member.role
            const expanded = expandedRole === member.role
            const belongs = snapshot.stages.find(stage => stage.id === member.currentStage)
            const startedAt = member.startedAt
            const endedAt = member.endedAt
            return (
              <div key={member.role} className={isActive ? 'cf-role cf-role-on' : 'cf-role'}>
                <div className="cf-role-row">
                  <button
                    type="button"
                    className="cf-role-main"
                    aria-label={t('aria.role', { role: member.title })}
                    title={member.duties}
                    onClick={() => onSelectRole(member.role)}
                  >
                    <div className="cf-role-top">
                      <RoleAvatar role={member.role} swatch={swatch} codename={member.codename} title={member.title} size={18} />
                      <span className="cf-role-name">{member.title}</span>
                      <span
                        className="cf-chip cf-mono"
                        style={{ color: roleInk(swatch), borderColor: wash(swatch, 45), background: wash(swatch, 12) }}
                      >
                        {member.codename}
                      </span>
                    </div>
                    <div className="cf-role-meta cf-mono">
                      <span className="cf-role-state" style={{ color }}>
                        <Led color={color} pulse={PULSING_MEMBER_STATUS[member.status]} />
                        <span>{t(`member.status.${member.status}`)}</span>
                      </span>
                      <span style={{ color: TOKEN.labelSecondary }}>
                        {t(member.tier === 'reasoner' ? 'roster.tier.reasoner' : 'roster.tier.chat')}
                        {member.tokens > 0 ? ` · ${formatTokens(member.tokens)}` : ''}
                      </span>
                    </div>
                    <div className="cf-role-note cf-mono">
                      {member.spawnError
                        ? `${t('work.spawnError')}: ${member.spawnError}`
                        : belongs
                          ? `${belongs.name}${belongs.round > 0 ? ` · ${t('work.round', { round: belongs.round })}` : ''}`
                          : t('roster.stageNone')}
                    </div>
                  </button>
                  <button
                    type="button"
                    className="cf-icon-btn cf-role-expand"
                    aria-expanded={expanded}
                    aria-label={expanded ? t('roster.collapse') : t('roster.expand')}
                    title={expanded ? t('roster.collapse') : t('roster.expand')}
                    onClick={() => setExpandedRole(expanded ? undefined : member.role)}
                  >
                    <IconChevron open={expanded} />
                  </button>
                </div>
                {expanded ? (
                  <div className="cf-role-details cf-mono">
                    {member.sessionId ? (
                      <div className="cf-kv">
                        <span className="cf-kv-k">{t('roster.details.session')}</span>
                        <span className="cf-kv-v cf-kv-v-mono" title={member.sessionId}>{member.sessionId}</span>
                      </div>
                    ) : null}
                    {member.provider || member.model ? (
                      <div className="cf-kv">
                        <span className="cf-kv-k">{member.provider ?? t('roster.details.model')}</span>
                        <span className="cf-kv-v">{member.model ?? t('format.none')}</span>
                      </div>
                    ) : null}
                    {member.reasoningEffort ? (
                      <div className="cf-kv">
                        <span className="cf-kv-k">{t('roster.details.effort')}</span>
                        <span className="cf-kv-v">{member.reasoningEffort}</span>
                      </div>
                    ) : null}
                    {startedAt !== undefined ? (
                      <div className="cf-kv">
                        <span className="cf-kv-k">{t('roster.details.started')}</span>
                        <span className="cf-kv-v cf-kv-v-mono">
                          {formatClock(startedAt)}
                          {endedAt !== undefined ? ` · ${formatDuration(endedAt - startedAt)}` : ''}
                        </span>
                      </div>
                    ) : null}
                    {endedAt !== undefined && startedAt === undefined ? (
                      <div className="cf-kv">
                        <span className="cf-kv-k">{t('roster.details.ended')}</span>
                        <span className="cf-kv-v cf-kv-v-mono">{formatClock(endedAt)}</span>
                      </div>
                    ) : null}
                    <div className="cf-kv">
                      <span className="cf-kv-k">{t('roster.details.tokens')}</span>
                      <span className="cf-kv-v cf-kv-v-mono">{formatTokens(member.tokens)}</span>
                    </div>
                    <div className="cf-kv">
                      <span className="cf-kv-k">{t('roster.details.stage')}</span>
                      <span className="cf-kv-v">{belongs ? belongs.name : t('roster.stageNone')}</span>
                    </div>
                    {member.spawnError ? (
                      <div className="cf-kv">
                        <span className="cf-kv-k" style={{ color: TOKEN.error }}>{t('work.spawnError')}</span>
                        <span className="cf-kv-v cf-kv-v-wrap" style={{ color: TOKEN.error }}>{member.spawnError}</span>
                      </div>
                    ) : null}
                    <div className="cf-kv">
                      <span className="cf-kv-k">{t('work.duties')}</span>
                      <span className="cf-kv-v cf-kv-v-wrap">{member.duties || t('format.none')}</span>
                    </div>
                    {member.sessionId ? (
                      <div className="cf-art-actions">
                        <CopyButton t={t} text={member.sessionId} label={t('copy.session')} />
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>
      <div className="cf-legend cf-mono">
        <div className="cf-legend-row">
          <span>{t('roster.tier.reasoner')}</span>
          <span>{t('roster.legend.reasoner')}</span>
        </div>
        <div className="cf-legend-row">
          <span>{t('roster.tier.chat')}</span>
          <span>{t('roster.legend.chat')}</span>
        </div>
      </div>
    </>
  )
}

/**
 * Standalone left column (column chrome + content), kept for direct offline
 * rendering by the checks that assert the roster column structure.
 */
export function RosterPanel(props: RosterPanelProps): ReactNode {
  const { snapshot, t } = props
  const active = snapshot.members.filter(member => member.status === 'working' || member.status === 'rework').length
  return (
    <aside className="cf-col cf-left" aria-label={t('aria.roster')}>
      <div className="cf-col-head">
        <span className="cf-col-title cf-mono">{t('roster.title')}</span>
        <span className="cf-col-note cf-mono">{t('roster.active', { active, total: snapshot.members.length })}</span>
      </div>
      <RosterContent {...props} />
    </aside>
  )
}

/* -------------------------------------------------------- stage inspector */

/** One gate rule line; composite children render recursively, indented. */
function GateRuleView({ gate, t, depth }: { readonly gate: GateDef; readonly t: CodeFactoryTranslate; readonly depth: number }): ReactNode {
  return (
    <div className={depth > 0 ? 'cf-gate-checks' : undefined}>
      <div className="cf-gate-line">
        <span className="cf-gate-k">{t('inspector.gateType')}</span>
        <span className="cf-gate-v">{t(`pipeline.gate.${gate.type}`)}</span>
      </div>
      {gate.artifact ? (
        <div className="cf-gate-line">
          <span className="cf-gate-k">{t('inspector.gateArtifact')}</span>
          <span className="cf-gate-v">{gate.artifact}</span>
        </div>
      ) : null}
      {gate.requiredSections !== undefined && gate.requiredSections.length > 0 ? (
        <div className="cf-gate-line">
          <span className="cf-gate-k">{t('inspector.gateSections')}</span>
          <span className="cf-gate-v">{gate.requiredSections.join(' · ')}</span>
        </div>
      ) : null}
      {gate.passWord ? (
        <div className="cf-gate-line">
          <span className="cf-gate-k">{t('inspector.gatePassWord')}</span>
          <span className="cf-gate-v">{gate.passWord}</span>
        </div>
      ) : null}
      {gate.failWord ? (
        <div className="cf-gate-line">
          <span className="cf-gate-k">{t('inspector.gateFailWord')}</span>
          <span className="cf-gate-v">{gate.failWord}</span>
        </div>
      ) : null}
      {gate.run ? (
        <div className="cf-gate-line">
          <span className="cf-gate-k">{t('inspector.gateRun')}</span>
          <span className="cf-gate-v">{gate.run}</span>
        </div>
      ) : null}
      {gate.checks !== undefined && gate.checks.length > 0 ? (
        <>
          <div className="cf-gate-line">
            <span className="cf-gate-k">{t('inspector.gateChecks')}</span>
            <span className="cf-gate-v">{gate.checks.length}</span>
          </div>
          {gate.checks.map((check, index) => (
            <GateRuleView key={index} gate={check} t={t} depth={depth + 1} />
          ))}
        </>
      ) : null}
    </div>
  )
}

/** Props of the exported {@link StageInspectorPanel}. */
export interface StageInspectorPanelProps {
  readonly snapshot: FactorySnapshot
  readonly t: CodeFactoryTranslate
  readonly now: number
  readonly inspector: StageInspector
  readonly stageOnly: boolean
  readonly onToggleStageOnly: () => void
  readonly onClose: () => void
}

/**
 * The stage inspector under the pipeline: every projected stage fact in one
 * place, plus the "only this stage" switch that drives the work-output message
 * filter and the artifacts section.
 */
export function StageInspectorPanel({
  snapshot,
  t,
  now,
  inspector,
  stageOnly,
  onToggleStageOnly,
  onClose,
}: StageInspectorPanelProps): ReactNode {
  const { stage } = inspector
  const color = STAGE_STATUS_COLOR[stage.status]
  const lastGate = inspector.lastGate
  const failGotoName = stageName(snapshot, stage.failGoto)
  const duration = stage.startedAt === undefined ? undefined : formatDuration((stage.endedAt ?? now) - stage.startedAt)
  return (
    <div className="cf-inspector" aria-label={t('aria.inspector')}>
      <div className="cf-inspector-head cf-mono">
        <span className="cf-col-title">{t('inspector.title')}</span>
        <span className="cf-chip" style={{ color, borderColor: wash(color, 45) }}>
          {stage.name} · {t(`stage.status.${stage.status}`)}
        </span>
        <button type="button" className="cf-icon-btn" onClick={onClose} aria-label={t('inspector.close')} title={t('inspector.close')}>
          <IconClose />
        </button>
      </div>
      <div className="cf-inspector-body">
        <div className="cf-inspect-flags cf-mono">
          <span className="cf-inspect-flag">{t('inspector.status')}: {t(`stage.status.${stage.status}`)}</span>
          <span className="cf-inspect-flag">
            {t('inspector.rounds', { round: stage.round, max: inspector.maxRounds ?? t('format.none') })}
          </span>
          <span className="cf-inspect-flag">{t('inspector.attempts')}: {inspector.attempts}</span>
          <span className="cf-inspect-flag">{t('inspector.artifacts')}: {inspector.artifactCount}</span>
          <span className="cf-inspect-flag">{t('inspector.messages')}: {inspector.messageCount}</span>
          {stage.humanApproval ? (
            <span className="cf-inspect-flag">
              <IconShield /> {t('inspector.humanApproval')}
            </span>
          ) : null}
          {stage.parallel ? (
            <span className="cf-inspect-flag">
              <IconBranch /> {t('inspector.parallel')}
            </span>
          ) : null}
          {failGotoName ? <span className="cf-inspect-flag">{t('inspector.failGoto', { stage: failGotoName })}</span> : null}
        </div>
        <div className="cf-inspect-grid cf-mono">
          <div className="cf-kv">
            <span className="cf-kv-k">{t('inspector.started')}</span>
            <span className="cf-kv-v cf-kv-v-mono">{stage.startedAt === undefined ? t('format.none') : formatClock(stage.startedAt)}</span>
          </div>
          <div className="cf-kv">
            <span className="cf-kv-k">{t('inspector.ended')}</span>
            <span className="cf-kv-v cf-kv-v-mono">{stage.endedAt === undefined ? t('format.none') : formatClock(stage.endedAt)}</span>
          </div>
          <div className="cf-kv">
            <span className="cf-kv-k">{t('inspector.duration')}</span>
            <span className="cf-kv-v cf-kv-v-mono">{duration ?? t('format.none')}</span>
          </div>
          <div className="cf-kv">
            <span className="cf-kv-k">{t('inspector.gateType')}</span>
            <span className="cf-kv-v">
              {inspector.gateType === UNKNOWN_GATE_TYPE ? t('pipeline.gate.unknown') : t(`pipeline.gate.${inspector.gateType}`)}
            </span>
          </div>
        </div>
        <div className="cf-inspect-section">
          <div className="cf-inspect-heading cf-mono">{t('inspector.roles')}</div>
          <div className="cf-inspect-roles">
            {inspector.roles.map(role => (
              <span key={role.id} className="cf-role-inline" title={role.resolved ? role.title : t('inspector.unresolvedRole')}>
                <RoleAvatar role={role.id} swatch={role.swatch} codename={role.codename} title={role.title} size={18} />
                <span style={{ color: roleInk(role.swatch) }}>{role.title}</span>
                {!role.resolved ? <span className="cf-chip cf-mono" style={{ color: TOKEN.labelSecondary }}>{t('inspector.unresolvedRole')}</span> : null}
              </span>
            ))}
          </div>
        </div>
        <div className="cf-inspect-section">
          <div className="cf-inspect-heading cf-mono">{t('inspector.gate')}</div>
          {inspector.gate ? <GateRuleView gate={inspector.gate} t={t} depth={0} /> : <div className="cf-kv-v">{t('inspector.noGate')}</div>}
        </div>
        <div className="cf-inspect-section">
          <div className="cf-inspect-heading cf-mono">{t('inspector.lastGate')}</div>
          {lastGate ? (
            <div className="cf-mono">
              <div className="cf-gate-line">
                <span className="cf-gate-k">{t('inspector.status')}</span>
                <span className="cf-gate-v" style={{ color: lastGate.ok ? TOKEN.success : TOKEN.error }}>
                  {lastGate.ok ? t('inspector.lastGatePass') : t('inspector.lastGateFail')} · {lastGate.detail}
                </span>
              </div>
              {lastGate.exitCode !== undefined ? (
                <div className="cf-gate-line">
                  <span className="cf-gate-k">{t('inspector.exitCode')}</span>
                  <span className="cf-gate-v">{lastGate.exitCode}</span>
                </div>
              ) : null}
              <div className="cf-gate-line">
                <span className="cf-gate-k">{t('inspector.at')}</span>
                <span className="cf-gate-v">{formatClock(lastGate.at)}</span>
              </div>
            </div>
          ) : (
            <div className="cf-kv-v">{t('inspector.noVerdict')}</div>
          )}
        </div>
        <div className="cf-inspect-actions">
          <button type="button" className={stageOnly ? 'cf-tool-btn cf-tool-btn-on' : 'cf-tool-btn'} onClick={onToggleStageOnly}>
            {stageOnly ? t('inspector.stageOnlyOff') : t('inspector.stageOnlyOn')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------- dockable board */

/** Drag payload type for a panel module; `text/plain` carries a fallback id. */
export const PANEL_MODULE_MIME = 'application/x-code-factory-module'

/** Text PanelBoard renders in one module's header. */
export interface PanelModuleMeta {
  readonly title: string
  readonly titleHint?: string
}

/** Props of the exported {@link DockModule} shell. */
export interface DockModuleProps {
  readonly t: CodeFactoryTranslate
  readonly id: PanelModuleId
  readonly title: string
  readonly titleHint?: string
  readonly note?: string
  readonly collapsed: boolean
  readonly height: number | undefined
  readonly grow: boolean
  /** Right-column modules keep the legacy `.cf-right-*` class contract. */
  readonly legacySection: boolean
  readonly dragging: boolean
  readonly onToggleCollapsed: () => void
  readonly onMove: (direction: 'up' | 'down' | 'left' | 'right') => void
  readonly onHide: () => void
  readonly onClearHeight: () => void
  readonly onResizeHeight: (height: number) => void
  readonly onDragStart: (event: ReactDragEvent<HTMLDivElement>) => void
  readonly onDragEnd: () => void
  readonly children: ReactNode
}

/**
 * One dockable module shell: draggable header, fold button, per-module ⋯ menu,
 * body (omitted while folded) and a bottom height grip.
 *
 * The shell owns its transient UI state (menu open, pointer-resize listeners)
 * and receives the persisted layout through props; all mutations go back to the
 * board via the callbacks. `legacySection` keeps the right column's historical
 * `.cf-right-section` / `.cf-right-head` / `.cf-sec-toggle` / `cf-sec-<id>`
 * contract that the offline checks assert.
 */
export function DockModule({
  t,
  id,
  title,
  titleHint,
  note,
  collapsed,
  height,
  grow,
  legacySection,
  dragging,
  onToggleCollapsed,
  onMove,
  onHide,
  onClearHeight,
  onResizeHeight,
  onDragStart,
  onDragEnd,
  children,
}: DockModuleProps): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const resizeCleanup = useRef<(() => void) | undefined>(undefined)

  useEffect(() => {
    if (!menuOpen || typeof window === 'undefined') return undefined
    const onPointerDown = (event: PointerEvent) => {
      const root = menuRef.current
      if (root !== null && !root.contains(event.target as Node | null)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  useEffect(
    () => () => {
      resizeCleanup.current?.()
    },
    [],
  )

  const currentHeight = (): number => {
    if (height !== undefined) return height
    const measured = rootRef.current?.getBoundingClientRect().height
    return typeof measured === 'number' && measured > 0 ? measured : MIN_MODULE_HEIGHT
  }

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (typeof window === 'undefined') return
    event.preventDefault()
    const startY = event.clientY
    const startHeight = currentHeight()
    const move = (moveEvent: PointerEvent) => {
      onResizeHeight(startHeight + moveEvent.clientY - startY)
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
      resizeCleanup.current = undefined
    }
    resizeCleanup.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', cleanup)
  }

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      const step = event.key === 'ArrowUp' ? -24 : 24
      const next = currentHeight() + step
      onResizeHeight(Math.min(MAX_MODULE_HEIGHT, Math.max(MIN_MODULE_HEIGHT, next)))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      onResizeHeight(MIN_MODULE_HEIGHT)
    } else if (event.key === 'End') {
      event.preventDefault()
      onResizeHeight(MAX_MODULE_HEIGHT)
    }
  }

  const handleDragStart = (event: ReactDragEvent<HTMLDivElement>) => {
    event.dataTransfer.effectAllowed = 'move'
    try {
      event.dataTransfer.setData(PANEL_MODULE_MIME, id)
      event.dataTransfer.setData('text/plain', id)
    } catch {
      // Some embedded webviews restrict custom payload types; text/plain above
      // is the fallback the board also reads on drop.
    }
    onDragStart(event)
  }

  const headClass = legacySection ? 'cf-right-head cf-mono' : 'cf-module-head cf-mono'
  const toggleClass = legacySection ? 'cf-sec-toggle' : 'cf-module-toggle'
  const bodyId = `cf-sec-${id}`
  return (
    <section
      ref={rootRef}
      className={legacySection ? 'cf-right-section' : 'cf-module'}
      style={!collapsed && height !== undefined ? ({ flex: '0 0 auto', height: `${height}px` } as CSSProperties) : undefined}
      aria-label={title}
      data-cf-module={id}
      data-grow={grow ? 'true' : 'false'}
      data-collapsed={collapsed ? 'true' : 'false'}
      data-dragging={dragging ? 'true' : 'false'}
    >
      <div
        className={headClass}
        draggable
        title={t('layout.dragHint')}
        onDragStart={handleDragStart}
        onDragEnd={onDragEnd}
      >
        <span className="cf-module-grip" aria-hidden="true">⠿</span>
        <button
          type="button"
          className={toggleClass}
          aria-expanded={!collapsed}
          aria-controls={collapsed ? undefined : bodyId}
          title={t('aria.sectionToggle', { section: title })}
          onClick={onToggleCollapsed}
        >
          <IconChevron open={!collapsed} />
          <span className="cf-col-title" title={titleHint}>
            {title}
          </span>
        </button>
        {note ? <span className="cf-col-note">{note}</span> : null}
        <div className="cf-module-menu-root" ref={menuRef}>
          <button
            type="button"
            className="cf-icon-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t('layout.menu')}
            title={t('layout.menu')}
            onClick={() => setMenuOpen(value => !value)}
          >
            ⋯
          </button>
          {menuOpen ? (
            <div className="cf-module-menu" role="menu" aria-label={t('layout.menu')}>
              <button type="button" role="menuitem" onClick={() => { onMove('up'); setMenuOpen(false) }}>
                {`↑ ${t('layout.moveUp', { module: title })}`}
              </button>
              <button type="button" role="menuitem" onClick={() => { onMove('down'); setMenuOpen(false) }}>
                {`↓ ${t('layout.moveDown', { module: title })}`}
              </button>
              <button type="button" role="menuitem" onClick={() => { onMove('left'); setMenuOpen(false) }}>
                {`← ${t('layout.moveLeft', { module: title })}`}
              </button>
              <button type="button" role="menuitem" onClick={() => { onMove('right'); setMenuOpen(false) }}>
                {`→ ${t('layout.moveRight', { module: title })}`}
              </button>
              <div className="cf-module-menu-sep" aria-hidden="true" />
              <button type="button" role="menuitem" onClick={() => { onToggleCollapsed(); setMenuOpen(false) }}>
                {collapsed ? t('layout.unfold') : t('layout.fold')}
              </button>
              {height !== undefined ? (
                <button type="button" role="menuitem" onClick={() => { onClearHeight(); setMenuOpen(false) }}>
                  {t('layout.customHeight')}
                </button>
              ) : null}
              <div className="cf-module-menu-sep" aria-hidden="true" />
              <button type="button" role="menuitem" onClick={() => { onHide(); setMenuOpen(false) }}>
                {t('layout.hideModule', { module: title })}
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {collapsed ? null : legacySection ? (
        <div className="cf-sec-body" id={bodyId}>
          <div className="cf-module-body">{children}</div>
        </div>
      ) : (
        <div className="cf-module-body" id={bodyId}>
          {children}
        </div>
      )}
      {collapsed ? null : (
        <div
          className="cf-module-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('layout.heightHint')}
          aria-valuemin={MIN_MODULE_HEIGHT}
          aria-valuemax={MAX_MODULE_HEIGHT}
          aria-valuenow={height === undefined ? undefined : Math.round(height)}
          tabIndex={0}
          title={t('layout.heightHint')}
          onPointerDown={handleResizePointerDown}
          onKeyDown={handleResizeKeyDown}
          onDoubleClick={onClearHeight}
        />
      )}
    </section>
  )
}

/** One column-width splitter: pointer drag, arrow keys, double-click reset. */
function ColumnSplitter({
  t,
  side,
  value,
  onChange,
  onReset,
}: {
  readonly t: CodeFactoryTranslate
  readonly side: 'left' | 'right'
  readonly value: number
  readonly onChange: (width: number) => void
  readonly onReset: () => void
}): ReactNode {
  const cleanupRef = useRef<(() => void) | undefined>(undefined)
  useEffect(
    () => () => {
      cleanupRef.current?.()
    },
    [],
  )
  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (typeof window === 'undefined') return
    event.preventDefault()
    const board = event.currentTarget.parentElement
    const rect = board?.getBoundingClientRect()
    if (rect === undefined) return
    const move = (moveEvent: PointerEvent) => {
      onChange(side === 'left' ? moveEvent.clientX - rect.left : rect.right - moveEvent.clientX)
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', cleanup)
      cleanupRef.current = undefined
    }
    cleanupRef.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', cleanup)
  }
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowRight' ? 16 : -16
    // The left splitter grows the left column to the right; the right splitter
    // grows the right column to the left.
    onChange(value + (side === 'left' ? delta : -delta))
  }
  return (
    <button
      type="button"
      className="cf-splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? t('layout.resizeLeft') : t('layout.resizeRight')}
      aria-valuenow={value}
      aria-valuemin={MIN_COLUMN_WIDTH}
      aria-valuemax={MAX_COLUMN_WIDTH}
      title={t('layout.resizeHint')}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={onReset}
    />
  )
}

/** Resolve the localized header title for one module. */
function panelModuleTitle(t: CodeFactoryTranslate, id: PanelModuleId): string {
  switch (id) {
    case 'roster':
      return t('roster.title')
    case 'pipeline':
      return t('pipeline.title')
    case 'inspector':
      return t('inspector.title')
    case 'work':
      return t('work.title')
    case 'feed':
      return t('section.feed')
    case 'artifacts':
      return t('section.artifacts')
    case 'dod':
      return t('section.dod')
    case 'evolution':
      return t('section.evolution')
    default:
      return id
  }
}

/** Optional title tooltip text for one module (the long registry names). */
function panelModuleHint(t: CodeFactoryTranslate, id: PanelModuleId): string | undefined {
  if (id === 'artifacts') return t('artifacts.title')
  if (id === 'dod') return t('dod.title')
  return undefined
}

/** Props of the exported {@link PanelBoard}: layout in, modules out. */
export interface PanelBoardProps {
  readonly t: CodeFactoryTranslate
  readonly layout: PanelLayout
  readonly onChangeLayout: (layout: PanelLayout) => void
  /** Render one module's body; the board supplies only the module chrome. */
  readonly renderModule: (moduleId: PanelModuleId) => ReactNode
  /** Optional header note (counts) for one module. */
  readonly moduleNote?: (moduleId: PanelModuleId) => string | undefined
}

/**
 * The three-column dockable board.
 *
 * Owns only layout mechanics: HTML5 drag/drop (same-column reorder and
 * cross-column docking), the two column-width splitters, and the mapping from a
 * persisted {@link PanelLayout} to {@link DockModule} shells. Content rendering
 * is injected through `renderModule`, so the board is SSR-renderable with any
 * layout and any module bodies.
 */
export function PanelBoard({ t, layout, onChangeLayout, renderModule, moduleNote }: PanelBoardProps): ReactNode {
  const [dragging, setDragging] = useState<PanelModuleId | undefined>(undefined)
  const [dropTarget, setDropTarget] = useState<{ readonly column: PanelColumnId; readonly index: number } | undefined>(undefined)
  const boardRef = useRef<HTMLDivElement | null>(null)

  const commit = (next: PanelLayout): void => onChangeLayout(next)

  const moveByDirection = (moduleId: PanelModuleId, direction: 'up' | 'down' | 'left' | 'right'): void => {
    const placement = modulePlacement(layout, moduleId)
    if (placement === undefined || placement === 'hidden') return
    const index = layout.columns[placement].indexOf(moduleId)
    if (direction === 'up') {
      if (index > 0) commit(moveModule(layout, moduleId, placement, index - 1))
      return
    }
    if (direction === 'down') {
      if (index >= 0 && index < layout.columns[placement].length - 1) commit(moveModule(layout, moduleId, placement, index + 1))
      return
    }
    const target: PanelColumnId | undefined =
      direction === 'left'
        ? placement === 'right' ? 'mid' : placement === 'mid' ? 'left' : undefined
        : placement === 'left' ? 'mid' : placement === 'mid' ? 'right' : undefined
    if (target !== undefined) commit(moveModule(layout, moduleId, target))
  }

  /** Insertion index drawn from the pointer's half-of-module position. */
  const computeDropIndex = (column: PanelColumnId, clientY: number): number => {
    const modules = layout.columns[column]
    const board = boardRef.current
    if (board === null) return modules.length
    const columnElement = board.querySelector<HTMLElement>(`[data-cf-column="${column}"]`)
    if (columnElement === null) return modules.length
    const elements = [...columnElement.querySelectorAll<HTMLElement>('[data-cf-module]')]
    for (let index = 0; index < elements.length; index += 1) {
      const rect = elements[index].getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) return index
    }
    return modules.length
  }

  /**
   * Drop a dragged module at a *visual* insertion index.
   *
   * `layout.moveModule` removes the module first and then inserts at `index`, so
   * a same-column move to a later visual position must shift the index back by
   * one (without this, dragging a module below itself lands it back in place).
   * Cross-column and upward moves need no correction.
   */
  const dropModule = (moduleId: PanelModuleId, column: PanelColumnId, visualIndex: number): void => {
    commit(planModuleDrop(layout, moduleId, column, visualIndex))
  }

  const columnDragHandlers = (column: PanelColumnId) => ({
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      // `dragging` is state and may not have rendered yet on the first dragover;
      // the dataTransfer type is the synchronous signal that this is our drag.
      const carriesModule = dragging !== undefined || Array.from(event.dataTransfer.types).includes(PANEL_MODULE_MIME)
      if (!carriesModule) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const index = computeDropIndex(column, event.clientY)
      setDropTarget(previous =>
        previous !== undefined && previous.column === column && previous.index === index ? previous : { column, index },
      )
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault()
      let raw = ''
      try {
        raw = event.dataTransfer.getData(PANEL_MODULE_MIME) || event.dataTransfer.getData('text/plain')
      } catch {
        raw = ''
      }
      const moduleId = isPanelModuleId(raw) ? raw : dragging
      const index = computeDropIndex(column, event.clientY)
      if (moduleId !== undefined) dropModule(moduleId, column, index)
      setDragging(undefined)
      setDropTarget(undefined)
    },
  })

  const renderColumn = (column: PanelColumnId): ReactNode => {
    const modules = layout.columns[column]
    const isOver = dragging !== undefined && dropTarget?.column === column
    const stack = (
      <div className="cf-board-stack">
        {modules.length === 0 && !isOver ? <div className="cf-board-empty">{t('layout.emptyColumn')}</div> : null}
        {isOver && modules.length === 0 ? <div className="cf-drop-line" aria-hidden="true" /> : null}
        {modules.map((moduleId, index) => (
          <Fragment key={moduleId}>
            {isOver && dropTarget?.index === index ? <div className="cf-drop-line" aria-hidden="true" /> : null}
            <DockModule
              t={t}
              id={moduleId}
              title={panelModuleTitle(t, moduleId)}
              titleHint={panelModuleHint(t, moduleId)}
              note={moduleNote?.(moduleId)}
              collapsed={layout.collapsed[moduleId] === true}
              height={layout.heights[moduleId]}
              grow={moduleId !== 'pipeline'}
              legacySection={column === 'right'}
              dragging={dragging === moduleId}
              onToggleCollapsed={() => commit(toggleModuleCollapsed(layout, moduleId))}
              onMove={direction => moveByDirection(moduleId, direction)}
              onHide={() => commit(hideModule(layout, moduleId))}
              onClearHeight={() => commit(clearModuleHeight(layout, moduleId))}
              onResizeHeight={next => commit(setModuleHeight(layout, moduleId, next))}
              onDragStart={() => {
                setDragging(moduleId)
                setDropTarget(undefined)
              }}
              onDragEnd={() => {
                setDragging(undefined)
                setDropTarget(undefined)
              }}
            >
              {renderModule(moduleId)}
            </DockModule>
          </Fragment>
        ))}
        {isOver && dropTarget?.index === modules.length && modules.length > 0 ? <div className="cf-drop-line" aria-hidden="true" /> : null}
      </div>
    )
    const handlers = columnDragHandlers(column)
    const overClass = isOver ? ' cf-board-col-over' : ''
    if (column === 'left') {
      return (
        <aside className={`cf-col cf-left${overClass}`} aria-label={t('aria.roster')} data-cf-column="left" {...handlers}>
          {stack}
        </aside>
      )
    }
    if (column === 'mid') {
      return (
        <section className={`cf-col cf-mid${overClass}`} aria-label={t('aria.pipeline')} data-cf-column="mid" {...handlers}>
          {stack}
        </section>
      )
    }
    return (
      <aside className={`cf-col cf-right${overClass}`} aria-label={t('aria.detail')} data-cf-column="right" {...handlers}>
        <div className="cf-right-scroll cf-scroll">{stack}</div>
      </aside>
    )
  }

  const boardStyle = {
    '--cf-left-w': `${layout.widths.left}px`,
    '--cf-right-w': `${layout.widths.right}px`,
  } as unknown as CSSProperties
  return (
    <div
      ref={boardRef}
      className="cf-body cf-board"
      style={boardStyle}
      onDragLeave={(event: ReactDragEvent<HTMLDivElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDropTarget(undefined)
      }}
    >
      {renderColumn('left')}
      <ColumnSplitter
        t={t}
        side="left"
        value={layout.widths.left}
        onChange={width => commit(setColumnWidth(layout, 'left', width))}
        onReset={() => commit(setColumnWidth(layout, 'left', DEFAULT_COLUMN_WIDTHS.left))}
      />
      {renderColumn('mid')}
      <ColumnSplitter
        t={t}
        side="right"
        value={layout.widths.right}
        onChange={width => commit(setColumnWidth(layout, 'right', width))}
        onReset={() => commit(setColumnWidth(layout, 'right', DEFAULT_COLUMN_WIDTHS.right))}
      />
      {renderColumn('right')}
    </div>
  )
}

/**
 * Plan one dock drop for a *visual* insertion index.
 *
 * `layout.moveModule` removes the module first and then inserts at `index`, so
 * a same-column move to a later visual position must shift the index back by
 * one (without this, dragging a module below itself lands it back in place).
 * Cross-column and upward moves need no correction. Exported so the HTML5 drop
 * handler and the offline checks share one implementation.
 *
 * @param layout - current layout.
 * @param moduleId - dragged module.
 * @param column - target column.
 * @param visualIndex - insertion index as seen by the user (0..length).
 * @returns the new layout (or an equal one for a no-op).
 */
export function planModuleDrop(
  layout: PanelLayout,
  moduleId: PanelModuleId,
  column: PanelColumnId,
  visualIndex: number,
): PanelLayout {
  let index = visualIndex
  if (modulePlacement(layout, moduleId) === column) {
    const sourceIndex = layout.columns[column].indexOf(moduleId)
    if (sourceIndex !== -1 && sourceIndex < index) index -= 1
  }
  return moveModule(layout, moduleId, column, index)
}

/** Props of the exported {@link LayoutMenu}. */
export interface LayoutMenuProps {
  readonly t: CodeFactoryTranslate
  readonly layout: PanelLayout
  readonly onChangeLayout: (layout: PanelLayout) => void
}

/** Expand every folded module in one layout, without touching positions. */
function expandAllModules(layout: PanelLayout): PanelLayout {
  return PANEL_MODULE_IDS.reduce(
    (next, moduleId) => (next.collapsed[moduleId] === true ? setModuleCollapsed(next, moduleId, false) : next),
    layout,
  )
}

/**
 * The header's layout popover: per-column module controls (visibility, ↑↓←→,
 * fold), the hidden-module restore list, expand-all and reset. Escape and an
 * outside pointer both close it; every control is a real keyboard-reachable
 * button/checkbox.
 */
export function LayoutMenu({ t, layout, onChangeLayout }: LayoutMenuProps): ReactNode {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current
      if (root !== null && !root.contains(event.target as Node | null)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])
  const moduleLabel = (moduleId: PanelModuleId): string => t(`module.${moduleId}`)
  const moveColumn = (moduleId: PanelModuleId, column: PanelColumnId): void => onChangeLayout(moveModule(layout, moduleId, column))
  return (
    <div className="cf-layout-menu-root" ref={rootRef}>
      <button
        type="button"
        className={open ? 'cf-btn cf-btn-on cf-mono' : 'cf-btn cf-mono'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('aria.layoutMenu')}
        title={t('layout.open')}
        onClick={() => setOpen(value => !value)}
      >
        <IconLayout />
        {t('layout.title')}
      </button>
      {open ? (
        <div className="cf-layout-pop" role="dialog" aria-label={t('aria.layoutMenu')}>
          {PANEL_COLUMN_IDS.map(column => (
            <div className="cf-layout-group" key={column}>
              <div className="cf-layout-heading cf-mono">{t(`layout.column.${column}`)}</div>
              {layout.columns[column].map((moduleId, index) => {
                const collapsed = layout.collapsed[moduleId] === true
                const label = moduleLabel(moduleId)
                return (
                  <div className="cf-layout-row" key={moduleId}>
                    <input
                      type="checkbox"
                      checked
                      aria-label={t('layout.hideModule', { module: label })}
                      title={t('layout.hideModule', { module: label })}
                      onChange={() => onChangeLayout(hideModule(layout, moduleId))}
                    />
                    <span className="cf-layout-name" title={label}>{label}</span>
                    <button
                      type="button"
                      className="cf-icon-btn"
                      disabled={index === 0}
                      aria-label={t('layout.moveUp', { module: label })}
                      title={t('layout.moveUp', { module: label })}
                      onClick={() => onChangeLayout(moveModule(layout, moduleId, column, index - 1))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="cf-icon-btn"
                      disabled={index === layout.columns[column].length - 1}
                      aria-label={t('layout.moveDown', { module: label })}
                      title={t('layout.moveDown', { module: label })}
                      onClick={() => onChangeLayout(moveModule(layout, moduleId, column, index + 1))}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="cf-icon-btn"
                      disabled={column === 'left'}
                      aria-label={t('layout.moveLeft', { module: label })}
                      title={t('layout.moveLeft', { module: label })}
                      onClick={() => moveColumn(moduleId, column === 'right' ? 'mid' : 'left')}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      className="cf-icon-btn"
                      disabled={column === 'right'}
                      aria-label={t('layout.moveRight', { module: label })}
                      title={t('layout.moveRight', { module: label })}
                      onClick={() => moveColumn(moduleId, column === 'left' ? 'mid' : 'right')}
                    >
                      →
                    </button>
                    <button
                      type="button"
                      className="cf-icon-btn"
                      aria-pressed={collapsed}
                      aria-label={collapsed ? t('layout.unfoldModule', { module: label }) : t('layout.foldModule', { module: label })}
                      title={collapsed ? t('layout.unfold') : t('layout.fold')}
                      onClick={() => onChangeLayout(toggleModuleCollapsed(layout, moduleId))}
                    >
                      {collapsed ? '▸' : '▾'}
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
          <div className="cf-layout-group">
            <div className="cf-layout-heading cf-mono">{t('layout.hidden')}</div>
            {layout.hidden.length === 0 ? (
              <div className="cf-layout-muted">{t('layout.noHidden')}</div>
            ) : (
              layout.hidden.map(moduleId => (
                <div className="cf-layout-hidden-row" key={moduleId}>
                  <span className="cf-layout-name">{moduleLabel(moduleId)}</span>
                  <button
                    type="button"
                    className="cf-tool-btn"
                    aria-label={t('layout.showModule', { module: moduleLabel(moduleId) })}
                    onClick={() => onChangeLayout(showModule(layout, moduleId))}
                  >
                    {t('layout.show')}
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="cf-layout-footer">
            <button type="button" className="cf-tool-btn" onClick={() => onChangeLayout(expandAllModules(layout))}>
              {t('layout.expandAll')}
            </button>
            <button type="button" className="cf-tool-btn cf-tool-btn-danger" onClick={() => onChangeLayout(createDefaultLayout())}>
              {t('layout.reset')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------- panel body */

/** Props of {@link FactoryCockpitBody}: pure data in, markup out. */
export interface FactoryCockpitBodyProps {
  readonly t: CodeFactoryTranslate
  readonly snapshot: FactorySnapshot
  readonly now: number
  /**
   * Whether {@link snapshot} is a full snapshot. When false it is an index
   * summary: its five scalar fields are real, but every collection is a
   * normalization artifact (docs/API-CONTRACTS.md §7.3), so the columns are not
   * rendered at all rather than showing an empty roster and an empty pipeline
   * that would read as "this factory has no members".
   */
  readonly complete: boolean
  /**
   * First-frame board layout override for offline checks. The default is
   * {@link readLayout} (SSR-safe: no window → default layout). A layout passed
   * here is never persisted; only user-driven changes are.
   */
  readonly initialLayout?: PanelLayout
  /** Controlled layout (the cockpit header owns the same object). */
  readonly layout?: PanelLayout
  /** Layout-change sink for the controlled mode; absent means the body owns it. */
  readonly onChangeLayout?: (layout: PanelLayout) => void
}

/**
 * The three dockable columns, as a pure projection of one snapshot.
 *
 * Exported separately from {@link FactoryCockpit} so the board can be rendered
 * against a fixture without a host (offline verification, story-style specs).
 *
 * @param props - translation seat, snapshot, clock, completeness, and layout override/control.
 * @returns the alert strip above the dockable board, or the "waiting for the
 *   full snapshot" notice while only a summary is known.
 */
export function FactoryCockpitBody({
  t,
  snapshot,
  now,
  complete,
  initialLayout,
  layout,
  onChangeLayout,
}: FactoryCockpitBodyProps): ReactNode {
  const stats = aggregate(snapshot, now)
  const [choice, setChoice] = useState<{ factoryId: string; role: string } | undefined>(undefined)
  const [selectedStageId, setSelectedStageId] = useState<string | undefined>(undefined)
  const [stageOnly, setStageOnly] = useState(false)
  // ROSTER controls.
  const [rosterQuery, setRosterQuery] = useState('')
  const [rosterStatus, setRosterStatus] = useState<MemberStatusFilter>('all')
  const [rosterSort, setRosterSort] = useState<MemberSortMode>('roster')
  // WORK OUTPUT controls.
  const [workQuery, setWorkQuery] = useState('')
  const [workKind, setWorkKind] = useState<FeedKindFilter>('all')
  const [workUnread, setWorkUnread] = useState(false)
  // Right-column controls.
  const [feedQuery, setFeedQuery] = useState('')
  const [feedKind, setFeedKind] = useState<FeedKindFilter>('all')
  const [artifactQuery, setArtifactQuery] = useState('')
  const [artifactSort, setArtifactSort] = useState<ArtifactSortMode>('newest')
  const [dodFilter, setDodFilter] = useState<DodFilter>('all')
  const [lessonFilter, setLessonFilter] = useState<LessonFilterMode>('all')
  const [lessonRole, setLessonRole] = useState('all')
  // The board layout: controlled by the cockpit when provided, otherwise local
  // (offline checks pass `initialLayout`; a normal mount reads the persisted one).
  const [internalLayout, setInternalLayout] = useState<PanelLayout>(() => normaliseLayout(initialLayout ?? readLayout()))
  const activeLayout = layout === undefined ? internalLayout : normaliseLayout(layout)

  const commitLayout = useCallback(
    (next: PanelLayout) => {
      const normal = normaliseLayout(next)
      if (onChangeLayout !== undefined) {
        onChangeLayout(normal)
        return
      }
      setInternalLayout(normal)
    },
    [onChangeLayout],
  )

  // Persist only locally-owned, user-driven layouts; `initialLayout` is a test /
  // first-frame override and must never be written back over the stored one. The
  // write is debounced so pointer-resizing does not hit localStorage per frame.
  useEffect(() => {
    if (layout !== undefined || initialLayout !== undefined || typeof window === 'undefined') return undefined
    const timer = window.setTimeout(() => writeLayout(internalLayout), 50)
    return () => window.clearTimeout(timer)
  }, [internalLayout, layout, initialLayout])

  const selected = useMemo<SnapshotMember | undefined>(() => {
    const wanted = choice && choice.factoryId === snapshot.id ? snapshot.members.find(m => m.role === choice.role) : undefined
    return wanted ?? pickMember(snapshot.members)
  }, [choice, snapshot])

  const roleMessages = useMemo(() => {
    if (!selected) return []
    return snapshot.feed
      .filter(message => message.from === selected.role || message.to === selected.role)
      .slice()
      .sort((left, right) => left.ts - right.ts)
  }, [selected, snapshot.feed])

  const inspector = useMemo<StageInspector | undefined>(
    () => (selectedStageId === undefined ? undefined : buildStageInspector(snapshot, selectedStageId)),
    [snapshot, selectedStageId],
  )
  // A stage can disappear from the snapshot (a re-plan, a new factory). Drop the
  // selection then, so the inspector and its filter do not linger over nothing.
  useEffect(() => {
    if (selectedStageId !== undefined && inspector === undefined) {
      setSelectedStageId(undefined)
      setStageOnly(false)
    }
  }, [selectedStageId, inspector])
  // A stage filter only applies while the stage still exists in this snapshot.
  const effectiveStageId = stageOnly ? inspector?.stage.id : undefined
  const messages = useMemo(
    () =>
      filterFeedMessages(roleMessages, {
        query: workQuery,
        kind: workKind,
        unreadOnly: workUnread,
        stageId: effectiveStageId,
      }),
    [roleMessages, workQuery, workKind, workUnread, effectiveStageId],
  )

  // An index summary carries no members, stages, artifacts or DoD. Rendering the
  // columns anyway would show four empty lists — indistinguishable from a real
  // factory that has not started, which is exactly the defect this guards
  // against. The hook upgrades the next request to `?id=`, so this is transient.
  if (!complete) {
    return (
      <div className="cf-fill cf-scroll">
        <EmptyBlock title={t('state.summary.title')} body={t('state.summary.body')} />
      </div>
    )
  }

  const activeStages = snapshot.stages.filter(stage => stage.status === 'active' || stage.status === 'gate')
  const progressColor = snapshot.phase === 'delivered' ? TOKEN.success : TOKEN.brand
  const liveWork = selected ? PULSING_MEMBER_STATUS[selected.status] : false
  const selectedSwatch = selected ? roleSwatch(selected.role, selected.color) : ''
  const workFiltering = workQuery.trim() !== '' || workKind !== 'all' || workUnread || effectiveStageId !== undefined
  const activeMembers = snapshot.members.filter(member => member.status === 'working' || member.status === 'rework').length
  const passedDod = snapshot.dod.filter(item => dodVerdict(item) === 'passed').length
  const handleSelectStage = (stageId: string): void => {
    if (selectedStageId === stageId) {
      setSelectedStageId(undefined)
      setStageOnly(false)
      return
    }
    setSelectedStageId(stageId)
  }

  const renderModule = (moduleId: PanelModuleId): ReactNode => {
    switch (moduleId) {
      case 'roster':
        return (
          <RosterContent
            snapshot={snapshot}
            t={t}
            selectedRole={selected?.role}
            onSelectRole={role => setChoice({ factoryId: snapshot.id, role })}
            query={rosterQuery}
            onQuery={setRosterQuery}
            statusFilter={rosterStatus}
            onStatusFilter={setRosterStatus}
            sort={rosterSort}
            onSort={setRosterSort}
          />
        )
      case 'pipeline':
        return (
          <div className="cf-pipe">
            {snapshot.stages.length === 0 ? (
              <EmptyBlock title={t('pipeline.empty')} />
            ) : (
              <div className="cf-pipe-track cf-scroll" role="list">
                {snapshot.stages.map((stage, index) => (
                  <div key={stage.id} role="listitem" style={{ display: 'flex', alignItems: 'center', flex: 'none' }}>
                    {index > 0 ? <PipelineConnector previous={snapshot.stages[index - 1]} /> : null}
                    <StageChip
                      stage={stage}
                      t={t}
                      snapshot={snapshot}
                      selected={selectedStageId === stage.id}
                      onSelect={() => handleSelectStage(stage.id)}
                    />
                  </div>
                ))}
              </div>
            )}
            <div className="cf-pipe-legend cf-mono">
              <span className="cf-pipe-legend-item">
                <IconBranch /> {t('pipeline.legend.parallel')}
              </span>
              <span className="cf-pipe-legend-item">
                <IconShield /> {t('pipeline.legend.approval')}
              </span>
              <span className="cf-pipe-legend-item">
                <span className="cf-led" style={{ color: TOKEN.error }} /> {t('pipeline.legend.rework')}
              </span>
            </div>
          </div>
        )
      case 'inspector':
        return inspector ? (
          <StageInspectorPanel
            snapshot={snapshot}
            t={t}
            now={now}
            inspector={inspector}
            stageOnly={stageOnly}
            onToggleStageOnly={() => setStageOnly(value => !value)}
            onClose={() => {
              setSelectedStageId(undefined)
              setStageOnly(false)
            }}
          />
        ) : (
          <div className="cf-module-empty cf-mono">{t('inspector.empty')}</div>
        )
      case 'work':
        return (
          <div className="cf-work">
            {selected ? (
              <>
                <div className="cf-work-head">
                  <div className="cf-work-avatar">
                    <RoleAvatar
                      role={selected.role}
                      swatch={selectedSwatch}
                      codename={selected.codename}
                      title={selected.title}
                      size={32}
                    />
                    <span className="cf-work-code cf-mono" style={{ color: roleInk(selectedSwatch) }}>
                      {selected.codename}
                    </span>
                  </div>
                  <div className="cf-work-id">
                    <div className="cf-work-name">
                      <span>{selected.title}</span>
                      <span
                        className="cf-chip cf-mono"
                        style={{ color: MEMBER_STATUS_COLOR[selected.status], borderColor: wash(MEMBER_STATUS_COLOR[selected.status], 45) }}
                      >
                        {t(`member.status.${selected.status}`)}
                      </span>
                    </div>
                    <div className="cf-work-duties">{selected.duties || t('format.none')}</div>
                  </div>
                  <div className="cf-work-side cf-mono">
                    <span>
                      {t('roster.model')}: {selected.model ?? t(selected.tier === 'reasoner' ? 'roster.tier.reasoner' : 'roster.tier.chat')}
                    </span>
                    {selected.provider ? <span>{t('roster.details.provider')}: {selected.provider}</span> : null}
                    {selected.reasoningEffort ? <span>{t('roster.details.effort')}: {selected.reasoningEffort}</span> : null}
                    {selected.sessionId ? <span>{t('work.session')}: {selected.sessionId.slice(0, 12)}</span> : null}
                    <span>{t('work.messages', { count: messages.length })}</span>
                  </div>
                </div>
                <div className="cf-toolbar">
                  <SearchField
                    t={t}
                    value={workQuery}
                    onChange={setWorkQuery}
                    placeholder={t('work.search')}
                    ariaLabel={t('work.search')}
                  />
                  <FeedKindChips t={t} kind={workKind} onKind={setWorkKind} />
                  <FilterChip active={workUnread} label={t('work.unreadOnly')} onClick={() => setWorkUnread(value => !value)} />
                  {effectiveStageId !== undefined ? (
                    <button type="button" className="cf-tool-btn cf-tool-btn-on" onClick={() => setStageOnly(false)}>
                      {t('inspector.stageFilter', { stage: stageName(snapshot, effectiveStageId) ?? effectiveStageId })} ×
                    </button>
                  ) : null}
                </div>
                <div className="cf-stream cf-scroll">
                  <div className="cf-stream-head cf-mono">{t('work.title')}</div>
                  {roleMessages.length === 0 ? (
                    <EmptyBlock title={t('work.streamEmpty')} body={t('work.empty.body')} />
                  ) : messages.length === 0 ? (
                    <EmptyBlock title={t('work.filteredEmptyTitle')} body={t('work.filteredEmptyBody')} />
                  ) : (
                    messages.map((message, index) => (
                      <MessageRow
                        key={message.id}
                        snapshot={snapshot}
                        t={t}
                        message={message}
                        caret={liveWork && !workFiltering && index === messages.length - 1}
                      />
                    ))
                  )}
                </div>
                {selected.spawnError ? (
                  <div className="cf-halt cf-mono" style={{ color: TOKEN.error }}>
                    {t('work.spawnError')}: {selected.spawnError}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="cf-fill cf-scroll">
                <EmptyBlock title={t('work.none')} body={t('work.empty.body')} />
              </div>
            )}
            <div className="cf-halt cf-mono">
              <span>
                {t('header.progress')} {stats.overall}%
              </span>
              <div className="cf-meter" role="progressbar" aria-label={t('aria.progress', { percent: stats.overall })} aria-valuenow={stats.overall} aria-valuemin={0} aria-valuemax={100}>
                <div className="cf-meter-fill" style={{ width: `${stats.overall}%`, background: progressColor }} />
              </div>
              <span>
                {t('header.tokens')} {formatTokens(stats.tokens)}
              </span>
              <span>
                {activeStages.length > 0 ? `${activeStages[0]?.name ?? ''}` : t('format.none')}
              </span>
            </div>
          </div>
        )
      case 'feed':
        return (
          <FeedContent
            snapshot={snapshot}
            t={t}
            query={feedQuery}
            onQuery={setFeedQuery}
            kind={feedKind}
            onKind={setFeedKind}
          />
        )
      case 'artifacts':
        return (
          <ArtifactsContent
            snapshot={snapshot}
            t={t}
            now={now}
            query={artifactQuery}
            onQuery={setArtifactQuery}
            sort={artifactSort}
            onSort={setArtifactSort}
            stageId={effectiveStageId}
            onClearStage={() => setStageOnly(false)}
          />
        )
      case 'dod':
        return <DodContent snapshot={snapshot} t={t} filter={dodFilter} onFilter={setDodFilter} />
      case 'evolution':
        return (
          <EvolutionContent
            snapshot={snapshot}
            t={t}
            filter={lessonFilter}
            onFilter={setLessonFilter}
            role={lessonRole}
            onRole={setLessonRole}
            now={now}
          />
        )
      default:
        return null
    }
  }

  const moduleNote = (moduleId: PanelModuleId): string | undefined => {
    switch (moduleId) {
      case 'roster':
        return t('roster.active', { active: activeMembers, total: snapshot.members.length })
      case 'pipeline':
        return `${snapshot.pipeline || t('format.none')} · ${t('pipeline.subtitle')}`
      case 'inspector':
        return inspector ? inspector.stage.name : t('format.none')
      case 'work':
        return selected ? t('work.messages', { count: messages.length }) : t('format.none')
      case 'feed':
        return t('section.feedNote', { count: filterFeedMessages(snapshot.feed, { query: feedQuery, kind: feedKind }).length })
      case 'artifacts':
        return t('section.artifactsNote', {
          count: filterArtifacts(snapshot.artifacts, { query: artifactQuery, stageId: effectiveStageId }).length,
        })
      case 'dod':
        return t('section.dodNote', { passed: passedDod, total: snapshot.dod.length })
      case 'evolution':
        return t('section.evolutionNote', {
          count: filterLessons(snapshot.evolution?.lessons ?? [], lessonFilter, resolveLessonRole(snapshot, lessonRole)).length,
        })
      default:
        return undefined
    }
  }

  // The evolution module only exists when the snapshot carries the projection;
  // the layout keeps it (so it comes back when the host projects a ledger again)
  // but the board is rendered without it, preserving the old "no evolution → no
  // section at all" behaviour that the offline checks pin.
  const displayLayout: PanelLayout =
    snapshot.evolution !== undefined
      ? activeLayout
      : {
          ...activeLayout,
          columns: {
            left: activeLayout.columns.left.filter(id => id !== 'evolution'),
            mid: activeLayout.columns.mid.filter(id => id !== 'evolution'),
            right: activeLayout.columns.right.filter(id => id !== 'evolution'),
          },
        }

  return (
    <>
      {/* Above the board and full width: the panel's only channel for telling
          someone that the pipeline is waiting on them. `AlertStrip` renders
          nothing at all when the snapshot carries no alerts. */}
      <AlertStrip t={t} alerts={snapshot.alerts} />
      <PanelBoard
        t={t}
        layout={displayLayout}
        onChangeLayout={commitLayout}
        renderModule={renderModule}
        moduleNote={moduleNote}
      />
    </>
  )
}

/* ----------------------------------------------------------------- header */

/**
 * What the cockpit's request is currently bound to.
 *
 * - `session` — the current session's factory (`?sessionId=`); the normal state.
 * - `picked`  — a factory the user chose from the header picker (`?id=`).
 * - `index`   — nothing of ours yet: the only request left is the bare route,
 *   which returns the cross-workspace index. It fills the picker and nothing
 *   else; the panel shows "no factory for this session" rather than a row from
 *   another workspace's project.
 */
export type FactoryScope = 'session' | 'picked' | 'index'

/** Props of {@link FactoryCockpitHeader}. */
export interface FactoryCockpitHeaderProps {
  readonly t: CodeFactoryTranslate
  readonly snapshot: FactorySnapshot | undefined
  readonly feed: FactoryStateFeed
  readonly now: number
  readonly selectedId: string | undefined
  readonly onSelect: (id: string | undefined) => void
  /**
   * Whether the feed's snapshot is a full snapshot. A summary's identity fields
   * are real and still rendered; its derived metrics are not, so they show the
   * "unknown" placeholder instead of four zeroes that read as real data.
   */
  readonly complete: boolean
  /** What the request is bound to; shown so the user can tell whose factory this is. */
  readonly scope: FactoryScope
  /** True while the user has stopped the automatic poller. */
  readonly paused?: boolean
  /** Toggles the automatic poller; absent in an offline fixture, where the control is inert. */
  readonly onTogglePause?: () => void
  /** Current board layout; with {@link onChangeLayout} present the header shows the layout menu. */
  readonly layout?: PanelLayout
  /** Persist a layout change from the header menu. */
  readonly onChangeLayout?: (layout: PanelLayout) => void
}

/** Per-scope chip colour. `picked` is amber: an override of the session scope. */
const SCOPE_COLOR: Readonly<Record<FactoryScope, string>> = {
  session: TOKEN.brand,
  picked: TOKEN.warn,
  index: TOKEN.idle,
}

/**
 * The cockpit's top strip: identity, phase, link state, scope, mission brief,
 * runtime metrics, and the auto-refresh / picker actions. Exported so a headless
 * check can render it against a fixture feed.
 *
 * The brief clamps to two lines and expands on demand; security hits are a
 * separate full-width row (a header child would squeeze the metric strip), and
 * both are local UI state so the pure data path stays unchanged.
 *
 * @param props - translation seat, snapshot, feed state, clock, completeness, scope, and control wiring.
 * @returns the header markup plus the expandable security-hits row.
 */
export function FactoryCockpitHeader({
  t,
  snapshot,
  feed,
  now,
  selectedId,
  onSelect,
  complete,
  scope,
  paused = false,
  onTogglePause,
  layout,
  onChangeLayout,
}: FactoryCockpitHeaderProps): ReactNode {
  const [briefOpen, setBriefOpen] = useState(false)
  const [hitsOpen, setHitsOpen] = useState(false)
  // Metrics are aggregates over members/stages/dod/artifacts — none of which an
  // index summary carries, so a summary yields no stats rather than zero stats.
  const stats = snapshot && complete ? aggregate(snapshot, now) : undefined
  const phaseColor = snapshot ? PHASE_COLOR[snapshot.phase] : TOKEN.idle
  const linkColor = LINK_COLOR[feed.status]
  const progress = stats?.overall ?? 0
  // What is blocking the pipeline, against everything waiting on a human. The
  // badge counts the blocking ones when there are any — that is the number that
  // means "nothing moves without you" — and the total otherwise.
  const alerts: readonly SnapshotAlert[] = snapshot?.alerts ?? []
  const actions = alerts.filter(alert => alert.severity === 'action').length
  const alertColor = actions > 0 ? TOKEN.error : TOKEN.warn
  const firstAlert = alerts[0]
  const hits = snapshot?.securityHits ?? []
  const securityTriggered = snapshot?.securityTriggered === true
  const securitySource = snapshot?.securitySource
  const brief = snapshot?.brief || t('empty.body')
  const briefLong = brief.length > 120 || brief.includes('\n')
  const updatedAgo = snapshot ? formatAgo(now - (snapshot.updatedAt || snapshot.createdAt), t) : t('format.none')
  return (
    <>
      <header className="cf-header">
        <div className="cf-brand">
          <IconRadar />
          <div style={{ minWidth: 0 }}>
            <div className="cf-brand-name cf-mono">{t('app.brand')}</div>
            <div className="cf-brand-sub cf-mono">{t('app.brandSub')}</div>
          </div>
        </div>

        <span className="cf-badge cf-mono" style={{ color: phaseColor, borderColor: wash(phaseColor, 40) }}>
          <Led color={phaseColor} pulse={snapshot?.phase === 'running'} />
          {snapshot ? t(`header.phase.${snapshot.phase}`) : t('header.factoryNone')}
        </span>

        <span className="cf-badge cf-mono" style={{ color: linkColor, borderColor: wash(linkColor, 40) }} title={feed.error}>
          <Led color={linkColor} pulse={feed.status === 'connecting' || feed.status === 'stale'} />
          {t(`header.link.${feed.status}`)}
        </span>

        {paused ? (
          <span className="cf-badge cf-mono" style={{ color: TOKEN.warn, borderColor: wash(TOKEN.warn, 40) }}>
            {t('header.paused')}
          </span>
        ) : null}

        {/* Same shape as the phase badge next door — the severity token, a 40%
            wash of it for the border — plus a 12% wash of it as a background, so
            it reads as the loudest chip in the row. Absent when nothing is owed. */}
        {firstAlert ? (
          <span
            className="cf-badge cf-mono"
            style={{ color: alertColor, borderColor: wash(alertColor, 40), background: wash(alertColor, 12) }}
            title={t('alert.badgeTitle', { title: firstAlert.title, next: firstAlert.next })}
          >
            {t('alert.badge', { count: actions > 0 ? actions : alerts.length })}
          </span>
        ) : null}

        <span
          className="cf-chip cf-mono"
          style={{ color: SCOPE_COLOR[scope], borderColor: wash(SCOPE_COLOR[scope], 40) }}
          title={t('header.scope.hint')}
        >
          {t(`header.scope.${scope}`)}
        </span>

        <div className="cf-mission">
          <div className="cf-mission-line cf-mono">
            <span className="cf-ellipsis">
              {t('header.mission')}: {snapshot ? snapshot.name : t('header.factoryNone')}
            </span>
            <span className="cf-ellipsis">
              {snapshot?.taskType ? `${t('header.taskType')} ${snapshot.taskType}` : ''}
              {snapshot?.pipeline ? ` · ${t('header.pipeline')} ${snapshot.pipeline}` : ''}
              {securityTriggered ? ` · ${t('header.security')} ${t('header.securityOn')}` : ''}
            </span>
          </div>
          <div className={briefOpen ? 'cf-mission-text cf-mission-text-open cf-mono' : 'cf-mission-text cf-mono'} title={brief}>
            {brief}
          </div>
          <div className="cf-mission-tools cf-mono">
            {briefLong ? (
              <button type="button" className="cf-linkish" aria-expanded={briefOpen} onClick={() => setBriefOpen(value => !value)}>
                {briefOpen ? t('header.briefCollapse') : t('header.briefExpand')}
              </button>
            ) : null}
            {securityTriggered && hits.length > 0 ? (
              <button type="button" className="cf-chip-btn" aria-expanded={hitsOpen} onClick={() => setHitsOpen(value => !value)}>
                {t('header.securityHits')} ({hits.length})
              </button>
            ) : null}
            {snapshot?.approvedAt ? (
              <span className="cf-chip cf-mono" style={{ color: TOKEN.success, borderColor: wash(TOKEN.success, 40) }}>
                {t('header.approved')} · {formatClock(snapshot.approvedAt)}
              </span>
            ) : null}
            {snapshot?.deliveryPath ? (
              <span className="cf-chip cf-mono cf-ellipsis" style={{ maxWidth: 200 }} title={snapshot.deliveryPath}>
                {t('header.deliveryPath')}: {snapshot.deliveryPath}
              </span>
            ) : null}
            <span className="cf-chip cf-mono" style={{ color: TOKEN.labelSecondary }}>
              {t('header.updatedAgo', { ago: updatedAgo })}
            </span>
          </div>
          {stats ? (
            <div
              className="cf-bar"
              role="progressbar"
              aria-label={t('aria.progress', { percent: progress })}
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="cf-bar-fill"
                style={{ width: `${progress}%`, background: snapshot?.phase === 'delivered' ? TOKEN.success : TOKEN.brand }}
              />
            </div>
          ) : null}
        </div>

        <div className="cf-metrics cf-mono">
          <div className="cf-metric">
            <span className="cf-metric-k">{t('header.stages')}</span>
            <span className="cf-metric-v">{stats ? `${stats.stagesPassed}/${stats.stagesTotal}` : t('format.none')}</span>
          </div>
          <div className="cf-metric">
            <span className="cf-metric-k">{t('header.tokens')}</span>
            <span className="cf-metric-v">{stats ? formatTokens(stats.tokens) : t('format.none')}</span>
          </div>
          <div className="cf-metric">
            <span className="cf-metric-k">{t('header.artifacts')}</span>
            <span className="cf-metric-v">{stats ? stats.artifacts : t('format.none')}</span>
          </div>
          <div className="cf-metric">
            <span className="cf-metric-k">{t('header.dod')}</span>
            <span className="cf-metric-v">{stats ? `${stats.dodPassed}/${stats.dodTotal}` : t('format.none')}</span>
          </div>
          <div className="cf-metric">
            <span className="cf-metric-k">{t('header.messages')}</span>
            <span className="cf-metric-v">{snapshot?.feed.length ?? t('format.none')}</span>
          </div>
          <div className="cf-metric">
            <span className="cf-metric-k">{t('header.alerts')}</span>
            <span className="cf-metric-v" style={alerts.length > 0 ? { color: alertColor } : undefined}>
              {snapshot ? alerts.length : t('format.none')}
            </span>
          </div>
          <div className="cf-metric">
            <span className="cf-metric-k">{t('header.elapsed')}</span>
            <span className="cf-metric-v">{stats ? formatDuration(stats.elapsedMs) : t('format.none')}</span>
          </div>
          <div className="cf-metric">
            <span className="cf-metric-k">{t('header.clock')}</span>
            <span className="cf-metric-v" style={{ color: TOKEN.brand }}>
              {formatClock(now)}
            </span>
          </div>
        </div>

        <div className="cf-actions">
          {feed.factories.length > 0 ? (
            /*
             * One source of truth for what is selected: the explicit pick, and
             * only the explicit pick. Deriving `value` from the displayed snapshot
             * as well let the control disagree with the state — when no <option>
             * matched, the browser showed its own first row while the panel body
             * showed a different factory, which reads as "a name and an id that do
             * not belong together". The empty option makes "no explicit pick" a
             * representable, selectable state, and selecting it returns the panel
             * to this session's own factory.
             */
            <select
              className="cf-select cf-mono"
              aria-label={t('header.pickFactory')}
              value={selectedId ?? ''}
              onChange={event => onSelect(event.target.value || undefined)}
            >
              <option value="">{t('header.pickFactoryHint')}</option>
              {feed.factories.map(factory => (
                <option key={factory.id} value={factory.id}>
                  {factory.name} · {factory.id}
                </option>
              ))}
            </select>
          ) : null}
          {layout !== undefined && onChangeLayout !== undefined ? (
            <LayoutMenu t={t} layout={layout} onChangeLayout={onChangeLayout} />
          ) : null}
          <button
            type="button"
            className={paused ? 'cf-btn cf-btn-on cf-mono' : 'cf-btn cf-mono'}
            onClick={onTogglePause}
            aria-pressed={paused}
            aria-label={t('aria.autoRefresh')}
            title={paused ? t('header.resume') : t('header.pause')}
          >
            {paused ? <IconPlay /> : <IconPause />}
            {paused ? t('header.resume') : t('header.pause')}
          </button>
          <button type="button" className="cf-btn cf-mono" onClick={feed.reload} title={t('header.refresh')}>
            <IconRefresh />
            {t('header.refresh')}
          </button>
        </div>
      </header>
      {securityTriggered && hitsOpen ? (
        <div className="cf-hits cf-mono" aria-label={t('aria.hits')}>
          <span>{t('header.securityHits')}</span>
          {hits.length === 0 ? (
            <span>{t('format.none')}</span>
          ) : (
            hits.map(hit => (
              <span key={hit} className="cf-chip" style={{ color: TOKEN.warn, borderColor: wash(TOKEN.warn, 40) }}>
                {hit}
              </span>
            ))
          )}
          <span>{securitySource ? t(`header.securitySource.${securitySource}`) : t('header.securitySource.none')}</span>
        </div>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------ main panel */

/**
 * The waiting-state headline for a link that has no snapshot to show.
 *
 * The headline stays "no factory yet" from the first tick onward — only the
 * sub-line reports transport progress — so a slow first read cannot flash a
 * different message and then swap it out.
 */
function waitingTitle(t: CodeFactoryTranslate, feed: FactoryStateFeed): string {
  switch (feed.status) {
    case 'error':
      return t('empty.error', { message: feed.error ?? '' })
    case 'stale':
      return t('empty.stale')
    default:
      return t('empty.title')
  }
}

/**
 * The poll scope the cockpit actually asks for.
 *
 * This is the one place the panel's request scope is decided, and it is exported
 * so the offline harness can hold it to the contract. The defect it encodes is a
 * main panel that only ever polled the bare route: that route returns the
 * cross-workspace **index** (docs/API-CONTRACTS.md §7.1/§7.3), five summary
 * fields with no members, stages, DoD or feed — so the header filled in while
 * everything else rendered as empty collections. Naming this session upgrades
 * the request to the full snapshot, exactly like the turn card does it.
 *
 * An explicit pick from the header picker outranks the session: `factoryStateUrl`
 * gives `?id=` precedence, so the derivation can never override a user's choice.
 *
 * @param selectedId - the user's explicit pick, or `undefined` for none.
 * @param sessionId - the session this panel speaks for, or `undefined` if unknown.
 * @returns the scope `useFactoryState` polls with.
 */
export function cockpitPollTarget(selectedId: string | undefined, sessionId: string | undefined): PollTarget {
  return { factoryId: selectedId, sessionId }
}

/**
 * The cockpit's `main`-slot occupant.
 *
 * @param props - the injected business face plus the framework's `t` seat.
 * @returns the full-width three-column cockpit, or its waiting empty state.
 */
export function FactoryCockpit(props: FactoryCockpitProps): ReactNode {
  const { t, route, pollMs, useSessions } = props
  // `selectedId` is only ever the user's explicit pick from the header picker.
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  // Auto-refresh is a user-controlled switch: pausing stops the interval, and
  // resuming schedules an immediate read (never waits for the next tick).
  const [paused, setPaused] = useState(false)
  // Dockable-board layout: read once (SSR-safe default), shared by the header's
  // layout menu and the board itself so both always show the same arrangement.
  const [layout, setLayout] = useState<PanelLayout>(() => readLayout())
  // Persist user-driven layout changes with a short debounce: pointer-resizing a
  // column or module would otherwise write localStorage on every frame.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const timer = window.setTimeout(() => writeLayout(layout), 50)
    return () => window.clearTimeout(timer)
  }, [layout])
  /**
   * The session this panel speaks for.
   *
   * `main` is root-scoped, so the identity comes off the session list rather
   * than a session binding. It is what makes the poll ask for *this* project:
   * the host turns `?sessionId=` into that session's workspace and factory
   * (docs/API-CONTRACTS.md §7.2), whereas the bare route would return every
   * workspace's factories and put someone else's project on screen.
   *
   * `currentSessionId` is passed by reference on purpose: the seat is a
   * snapshot-selector hook, and a module-level selector keeps a stable identity
   * across renders.
   */
  const sessionId: string | undefined = useSessions(currentSessionId)
  // One object, two consumers: the poller and the header's scope chip. Deriving
  // the chip from the poll target is deliberate — the chip then *is* an
  // observation of what was requested, not a second guess at it.
  const pollTarget = cockpitPollTarget(selectedId, sessionId)
  const feed = useFactoryState({ route, pollMs, ...pollTarget, enabled: !paused })
  // What the panel is bound to, shown in the header. The index is never a
  // display source, so "index" means "no factory of ours yet", not "the newest
  // factory on the machine".
  const scope: FactoryScope = pollTarget.factoryId ? 'picked' : pollTarget.sessionId ? 'session' : 'index'
  const now = useNow(1000)
  const snapshot = feed.snapshot
  const togglePause = (): void => {
    if (paused) {
      setPaused(false)
      feed.reload()
      return
    }
    setPaused(true)
  }

  return (
    <div className="cf-root">
      <span className="cf-scan" aria-hidden="true" />
      <FactoryCockpitHeader
        t={t}
        snapshot={snapshot}
        feed={feed}
        now={now}
        selectedId={selectedId}
        onSelect={setSelectedId}
        complete={feed.complete}
        scope={scope}
        paused={paused}
        onTogglePause={togglePause}
        layout={layout}
        onChangeLayout={setLayout}
      />
      {snapshot ? (
        <FactoryCockpitBody
          key={snapshot.id}
          t={t}
          snapshot={snapshot}
          now={now}
          complete={feed.complete}
          layout={layout}
          onChangeLayout={setLayout}
        />
      ) : (
        <div className="cf-fill cf-scroll">
          <EmptyBlock
            title={waitingTitle(t, feed)}
            body={feed.status === 'error' ? t('empty.body') : t('empty.waiting')}
            action={
              <button type="button" className="cf-btn cf-mono" onClick={feed.reload}>
                <IconRefresh />
                {t('empty.retry')}
              </button>
            }
          />
        </div>
      )}
    </div>
  )
}

/* --------------------------------------------------------- sidebar entry */

/**
 * `sidebar.panellist` entry: the icon for this plugin's `main` panel.
 *
 * The sidebar owns the row: it declares `sidebar.panellist` as a list whose
 * *"each list id addresses the matching main panel; the sidebar owns the button
 * and resolves its label from list metadata"*. So this component renders the
 * glyph only — no `<button>`, no `onClick`, no accessible name (a nested
 * interactive element inside the shell's button would be invalid HTML, and the
 * row already performs `selectPanel` for the matching `main` key).
 *
 * The owner share drives the two things the shell wants the glyph to express:
 *
 *   `size`   — the requested square edge in pixels, so the icon matches the
 *              rail's other panel glyphs at whatever geometry the column is in.
 *   `active` — whether this panel is the selected one in the main column.
 *              Selected: the brand token, so the choice is unambiguous.
 *              Otherwise `currentColor`, which lets the shell's own hover and
 *              rail styling show through instead of fighting it.
 *
 * A small dot still marks a running factory; it is decorative and carries no
 * interactive semantics of its own.
 *
 * @param props - the owner share plus the injected business face and `t` seat.
 * @returns the panel glyph, sized and tinted for the sidebar row.
 */
export function FactorySidebarEntry(props: FactorySidebarEntryProps): ReactNode {
  const { route, pollMs, size, active } = props
  const feed = useFactoryState({ route, pollMs })
  const running = feed.snapshot?.phase === 'running'
  return (
    <span className="cf-entry-icon" style={{ width: size, height: size, color: active ? TOKEN.brand : 'currentColor' }}>
      <IconGrid size={size} />
      {running ? <span className="cf-entry-dot" aria-hidden="true" /> : null}
    </span>
  )
}

/* ------------------------------------------------------- conversation card */

/**
 * `conversation.chat.turnTail` contribution: a compact summary of **this
 * session's** factory that opens the cockpit. Renders nothing while the host
 * reports no factory for the session, so the turn tail stays clean in ordinary
 * conversations.
 *
 * The poll is scoped by `sessionId` (`?sessionId=`, docs/API-CONTRACTS.md §7.1):
 * the card must show the factory this conversation is driving, not whichever
 * factory happens to be the most recently updated in the cross-workspace index.
 * The host resolves the workspace from the session itself; no path is ever sent.
 *
 * @param props - the session-scope standard seat, the injected business face, and `t`.
 * @returns the summary card, or `null` when there is no factory for this session.
 */
export function FactoryTurnCard(props: FactoryTurnCardProps): ReactNode {
  const { t, route, pollMs, openCockpit, sessionId } = props
  const feed = useFactoryState({ route, pollMs, sessionId })
  const now = useNow(5000)
  const snapshot = feed.snapshot
  if (!snapshot) return null

  const stats = aggregate(snapshot, now)
  const phaseColor = PHASE_COLOR[snapshot.phase]
  const stage = snapshot.stages.find(item => item.status === 'active' || item.status === 'gate')
  // A summary's collections are normalization artifacts; the card shows the
  // identity it really has and waits rather than counting to zero.
  const detailed = feed.complete
  return (
    <div className="cf-card-shell">
      <div className="cf-card-head">
        <span className="cf-brand-name cf-mono" style={{ fontSize: 11, letterSpacing: '.16em' }}>
          {t('card.title')}
        </span>
        <span className="cf-badge cf-mono" style={{ color: phaseColor, borderColor: wash(phaseColor, 40) }}>
          <Led color={phaseColor} pulse={snapshot.phase === 'running'} />
          {t(`header.phase.${snapshot.phase}`)}
        </span>
        <span className="cf-chip cf-mono cf-ellipsis" style={{ maxWidth: 220 }} title={snapshot.brief}>
          {snapshot.name}
        </span>
      </div>
      {detailed ? (
        <div className="cf-card-stats cf-mono">
          <span>{t('card.stage', { done: stats.stagesPassed, total: stats.stagesTotal })}</span>
          <span>{t('card.members', { count: stats.totalMembers })}</span>
          <span>{t('card.dod', { passed: stats.dodPassed, total: stats.dodTotal })}</span>
          <span>{t('card.artifacts', { count: stats.artifacts })}</span>
          {stage ? <span style={{ color: STAGE_STATUS_COLOR[stage.status] }}>{stage.name}</span> : <span>{t('card.waiting')}</span>}
        </div>
      ) : (
        <div className="cf-card-stats cf-mono">
          <span>{t('card.waiting')}</span>
        </div>
      )}
      <div className="cf-card-head">
        <div className="cf-bar" style={{ flex: '1 1 120px', marginTop: 0 }}>
          <div
            className="cf-bar-fill"
            style={{ width: `${detailed ? stats.overall : 0}%`, background: snapshot.phase === 'delivered' ? TOKEN.success : TOKEN.brand }}
          />
        </div>
        <button type="button" className="cf-linkish cf-mono" onClick={openCockpit}>
          {t('card.open')}
        </button>
        <span className="cf-card-sub cf-mono">
          {t('card.updated', { time: formatClock(snapshot.updatedAt || snapshot.createdAt) })}
        </span>
      </div>
    </div>
  )
}
