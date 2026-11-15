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

import type { ReuseEntry, ReuseKind, ReuseMatch } from '../shared/types.js'

/* ----------------------------------------------------------------- consts */

/** Default number of search hits returned. */
export const REUSE_LIBRARY_DEFAULT_LIMIT = 5

/** Hard ceiling for a caller-supplied limit (a library is not a feed). */
export const REUSE_LIBRARY_MAX_LIMIT = 20

/** Max assets quoted by one planning note (keep the plan readable). */
export const REUSE_PLAN_NOTE_MAX_ITEMS = 3

/* ---------------------------------------------------------------- options */

/** Search options accepted by {@link rankReuseEntries}. */
export interface ReuseRankOptions {
  /** Free-text query matched against name / description / tags / taskTypes / files. */
  readonly query?: string
  /** Exact task family (`web_fullstack`); adds 10 when it matches. */
  readonly taskType?: string
  /** Tags to intersect; each exact hit adds 4. */
  readonly tags?: readonly string[]
  /** Restrict to one kind. */
  readonly kind?: ReuseKind
  /** Max hits (default {@link REUSE_LIBRARY_DEFAULT_LIMIT}, capped at {@link REUSE_LIBRARY_MAX_LIMIT}). */
  readonly limit?: number
}

/* --------------------------------------------------------------- helpers */

/**
 * Split a query into lower-cased alphanumeric / CJK tokens.
 *
 * CJK runs are also expanded into overlapping **bigrams** (`员工门户` → `员工`,
 * `工门`, `门户`). Chinese users write briefs as whole sentences with no word
 * separators; without the bigrams a prose query would almost never be a literal
 * substring of a short asset name. English tokens stay whole (`backend`).
 */
function tokenize(value: string | undefined): string[] {
  if (typeof value !== 'string') return []
  const tokens = new Set<string>()
  for (const chunk of value.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/g)) {
    if (chunk.length === 0) continue
    tokens.add(chunk)
    if (/[\u4e00-\u9fff]/.test(chunk)) {
      for (let index = 0; index + 1 < chunk.length; index += 1) {
        tokens.add(chunk.slice(index, index + 2))
      }
    }
    if (tokens.size >= 80) break
  }
  return [...tokens]
}

function lower(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** True when `needle` appears in `haystack` (both already lower-cased). */
function contains(haystack: string, needle: string): boolean {
  return needle.length > 0 && haystack.includes(needle)
}

/** A valid persisted entry: enough identity for ranking/display; files optional-safe. */
function isUsableEntry(value: unknown): value is ReuseEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Partial<ReuseEntry>
  return (
    typeof entry.id === 'string' &&
    entry.id.trim() !== '' &&
    typeof entry.name === 'string' &&
    typeof entry.updatedAt === 'number' &&
    Array.isArray(entry.tags) &&
    Array.isArray(entry.taskTypes) &&
    Array.isArray(entry.files)
  )
}

/** Score one entry against the resolved criteria. Field weights are documented above. */
function scoreEntry(
  entry: ReuseEntry,
  queryTokens: readonly string[],
  taskType: string,
  wantedTags: readonly string[],
): number {
  const name = lower(entry.name)
  const description = lower(entry.description)
  const tags = entry.tags.map(lower)
  const taskTypes = entry.taskTypes.map(lower)
  const files = entry.files.map((file) => lower(file.path)).join(' ')

  let score = 0
  for (const token of queryTokens) {
    if (contains(name, token)) score += 6
    if (contains(description, token)) score += 3
    if (tags.some((tag) => contains(tag, token))) score += 4
    if (taskTypes.some((value) => contains(value, token))) score += 4
    if (contains(files, token)) score += 2
  }
  if (taskType !== '' && taskTypes.some((value) => value === taskType)) score += 10
  for (const tag of wantedTags) {
    if (tags.some((value) => value === tag)) score += 4
  }
  return score
}

/* ---------------------------------------------------------------- ranking */

/**
 * Rank the library's entries for one search/list request. Pure and total.
 *
 * @param entries - persisted entries (a corrupt element is skipped, never thrown).
 * @param options - query / taskType / tags / kind / limit; see {@link ReuseRankOptions}.
 * @returns matches ordered score desc → updatedAt desc → id asc, capped by limit;
 *          `[]` for unknown/empty input.
 */
export function rankReuseEntries(
  entries: readonly ReuseEntry[] | undefined,
  options: ReuseRankOptions = {},
): ReuseMatch[] {
  if (!Array.isArray(entries) || entries.length === 0) return []
  const usable = entries.filter(isUsableEntry)
  if (usable.length === 0) return []

  const wantedKind: ReuseKind | undefined = options.kind
  const candidates = wantedKind === undefined ? usable : usable.filter((entry) => entry.kind === wantedKind)
  if (candidates.length === 0) return []

  const queryTokens = tokenize(options.query)
  const taskType = lower(options.taskType)
  const wantedTags = [...new Set((options.tags ?? []).map(lower).filter((tag) => tag !== ''))]
  const hasContentCriteria = queryTokens.length > 0 || taskType !== '' || wantedTags.length > 0
  // An unknown/empty request means "nothing to rank": `list` owns the recent-first
  // view, while `rankReuseEntries` is a search function and must not invent one.
  if (!hasContentCriteria && wantedKind === undefined) return []

  const rawLimit = options.limit
  const limit =
    rawLimit === undefined || !Number.isFinite(rawLimit)
      ? REUSE_LIBRARY_DEFAULT_LIMIT
      : Math.min(Math.max(0, Math.trunc(rawLimit)), REUSE_LIBRARY_MAX_LIMIT)
  if (limit === 0) return []

  const matches: ReuseMatch[] = candidates.map((entry) => ({
    entry,
    score: scoreEntry(entry, queryTokens, taskType, wantedTags),
  }))
  const filtered = hasContentCriteria ? matches.filter((match) => match.score > 0) : matches
  filtered.sort(
    (left, right) =>
      right.score - left.score ||
      right.entry.updatedAt - left.entry.updatedAt ||
      left.entry.id.localeCompare(right.entry.id),
  )
  return filtered.slice(0, limit)
}

/* ---------------------------------------------------------------- note */

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
export function reusePlanNote(matches: readonly ReuseMatch[] | undefined): string | undefined {
  if (!Array.isArray(matches) || matches.length === 0) return undefined
  const top = matches.slice(0, REUSE_PLAN_NOTE_MAX_ITEMS)
  const described = top.map((match, index) => {
    const entry = match.entry
    const tags = entry.tags.length > 0 ? `；标签 ${entry.tags.slice(0, 3).join('/')}` : ''
    return `${index + 1}) ${entry.name}（${entry.kind}${tags}；id=${entry.id}）`
  })
  return (
    `复用库命中 ${matches.length} 个可复用资产：${described.join('、')}。`
    + '确认后可用 factory_reuse action=apply entryId=<id> 复制到工作区 reuse/ 参考/适配；'
    + '复制品是参考材料，需要按本项目需求改造，不要直接当成交付物。'
  )
}
