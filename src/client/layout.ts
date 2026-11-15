/**
 * Panel layout model for the cockpit — a small, pure "dockable board" layer.
 *
 * The cockpit used to be three fixed columns with fixed sections. This module
 * turns it into a layoutable board: every section is a **module**, modules live
 * in one of three columns (`left` / `mid` / `right`) or are hidden, columns have
 * persisted widths, and modules have optional persisted heights and collapsed
 * state. The UI can therefore be dragged/reordered/docked, resized and folded
 * like a Photoshop panel stack — without a layout library and without touching
 * the host half.
 *
 * PURITY CONTRACT: no imports, no I/O in the transforms, no clock, no
 * randomness. The only functions that touch storage are {@link readLayout} /
 * {@link writeLayout}, and both guard `window` so the module stays SSR-safe.
 * Every transform returns a new layout; callers never mutate the input.
 *
 * @module dsh-code-factory/client/layout
 */

/* ------------------------------------------------------------------ types */

/** The eight cockpit modules that can be docked, hidden and resized. */
export type PanelModuleId =
  | 'roster'
  | 'pipeline'
  | 'inspector'
  | 'work'
  | 'feed'
  | 'artifacts'
  | 'dod'
  | 'evolution'

/** The three docking columns. */
export type PanelColumnId = 'left' | 'mid' | 'right'

/** Widths of the two fixed side columns (the middle column takes the rest). */
export interface PanelColumnWidths {
  readonly left: number
  readonly right: number
}

/** One persisted panel layout. */
export interface PanelLayout {
  /** On-disk shape version; a future migration bumps this. */
  readonly version: 1
  /** Visible modules per column, in display order. */
  readonly columns: Readonly<Record<PanelColumnId, readonly PanelModuleId[]>>
  /** Modules the user has folded away (restorable from the layout menu). */
  readonly hidden: readonly PanelModuleId[]
  readonly widths: PanelColumnWidths
  /** Persisted module heights, in px. Absent means "flex / auto". */
  readonly heights: Readonly<Partial<Record<PanelModuleId, number>>>
  /** Persisted folded state; absent/false means expanded. */
  readonly collapsed: Readonly<Partial<Record<PanelModuleId, boolean>>>
}

/** Minimal storage face, so tests can drive the persistence layer offline. */
export interface LayoutStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/* ---------------------------------------------------------------- constants */

/** Every module, in canonical order (also the order of the layout menu). */
export const PANEL_MODULE_IDS = [
  'roster',
  'pipeline',
  'inspector',
  'work',
  'feed',
  'artifacts',
  'dod',
  'evolution',
] as const satisfies readonly PanelModuleId[]

/** Every column, left to right. */
export const PANEL_COLUMN_IDS = ['left', 'mid', 'right'] as const satisfies readonly PanelColumnId[]

/** localStorage key for the persisted layout. */
export const LAYOUT_STORAGE_KEY = 'dsh-code-factory.layout.v1'

/** Default width of the two side columns, in px. */
export const DEFAULT_COLUMN_WIDTHS: PanelColumnWidths = { left: 248, right: 380 }

/** Column width bounds; the middle column always takes the remaining space. */
export const MIN_COLUMN_WIDTH = 190
export const MAX_COLUMN_WIDTH = 640

/** Module height bounds for a manually resized module. */
export const MIN_MODULE_HEIGHT = 96
export const MAX_MODULE_HEIGHT = 1200

/** Default dock positions; also where a hidden module returns on "show". */
export const DEFAULT_MODULE_COLUMN: Readonly<Record<PanelModuleId, PanelColumnId>> = {
  roster: 'left',
  pipeline: 'mid',
  inspector: 'mid',
  work: 'mid',
  feed: 'right',
  artifacts: 'right',
  dod: 'right',
  evolution: 'right',
}

/** The default module order per column. */
const DEFAULT_COLUMN_MODULES: Readonly<Record<PanelColumnId, readonly PanelModuleId[]>> = {
  left: ['roster'],
  mid: ['pipeline', 'inspector', 'work'],
  right: ['feed', 'artifacts', 'dod', 'evolution'],
}

/* ------------------------------------------------------------------ guards */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when `value` is one of the eight known module ids. */
export function isPanelModuleId(value: unknown): value is PanelModuleId {
  return typeof value === 'string' && (PANEL_MODULE_IDS as readonly string[]).includes(value)
}

/** True when `value` is one of the three known columns. */
export function isPanelColumnId(value: unknown): value is PanelColumnId {
  return typeof value === 'string' && (PANEL_COLUMN_IDS as readonly string[]).includes(value)
}

/* ---------------------------------------------------------------- defaults */

/** A fresh default layout (deep clone; safe to mutate by the caller). */
export function createDefaultLayout(): PanelLayout {
  return {
    version: 1,
    columns: {
      left: [...DEFAULT_COLUMN_MODULES.left],
      mid: [...DEFAULT_COLUMN_MODULES.mid],
      right: [...DEFAULT_COLUMN_MODULES.right],
    },
    hidden: [],
    widths: { ...DEFAULT_COLUMN_WIDTHS },
    heights: {},
    collapsed: {},
  }
}

/** Reset to the default layout. */
export function resetLayout(): PanelLayout {
  return createDefaultLayout()
}

/* -------------------------------------------------------------- normalise */

function clampDimension(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function emptyColumns(): Record<PanelColumnId, PanelModuleId[]> {
  return { left: [], mid: [], right: [] }
}

function cloneLayout(layout: PanelLayout): PanelLayout {
  return {
    version: 1,
    columns: {
      left: [...layout.columns.left],
      mid: [...layout.columns.mid],
      right: [...layout.columns.right],
    },
    hidden: [...layout.hidden],
    widths: { left: layout.widths.left, right: layout.widths.right },
    heights: { ...layout.heights },
    collapsed: { ...layout.collapsed },
  }
}

/**
 * Coerce an untrusted persisted value into a valid layout.
 *
 * The rules are deliberately forgiving — this runs on data the user (or an
 * older plugin) wrote to localStorage, and a broken preference must never take
 * the panel down:
 *
 *  - unknown module ids, non-array columns and duplicate ids are dropped;
 *  - every known module missing from both `columns` and `hidden` is restored to
 *    its default column, so a schema change can never make a module disappear;
 *  - widths/heights are clamped to the published bounds; non-finite values fall
 *    back to the default;
 *  - a value that is not an object at all returns the default layout.
 *
 * @param raw - anything read from storage or passed by a caller.
 * @returns a new, valid layout.
 */
export function normaliseLayout(raw: unknown): PanelLayout {
  const defaults = createDefaultLayout()
  if (!isRecord(raw)) return defaults

  const columns = emptyColumns()
  const seen = new Set<PanelModuleId>()

  const rawColumns = isRecord(raw.columns) ? raw.columns : undefined
  for (const column of PANEL_COLUMN_IDS) {
    const list = rawColumns?.[column]
    if (!Array.isArray(list)) continue
    for (const candidate of list) {
      if (!isPanelModuleId(candidate) || seen.has(candidate)) continue
      seen.add(candidate)
      columns[column].push(candidate)
    }
  }

  const hidden: PanelModuleId[] = []
  if (Array.isArray(raw.hidden)) {
    for (const candidate of raw.hidden) {
      if (!isPanelModuleId(candidate) || seen.has(candidate)) continue
      seen.add(candidate)
      hidden.push(candidate)
    }
  }

  // Restore every module that the persisted value forgot (schema evolution,
  // hand-edited storage, or a future release that added a module).
  for (const moduleId of PANEL_MODULE_IDS) {
    if (seen.has(moduleId)) continue
    seen.add(moduleId)
    columns[DEFAULT_MODULE_COLUMN[moduleId]].push(moduleId)
  }

  const rawWidths = isRecord(raw.widths) ? raw.widths : undefined
  const widths: PanelColumnWidths = {
    left: clampDimension(rawWidths?.left, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTHS.left),
    right: clampDimension(rawWidths?.right, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTHS.right),
  }

  const heights: Partial<Record<PanelModuleId, number>> = {}
  const rawHeights = isRecord(raw.heights) ? raw.heights : undefined
  if (rawHeights !== undefined) {
    for (const moduleId of PANEL_MODULE_IDS) {
      const value = rawHeights[moduleId]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      heights[moduleId] = clampDimension(value, MIN_MODULE_HEIGHT, MAX_MODULE_HEIGHT, MIN_MODULE_HEIGHT)
    }
  }

  const collapsed: Partial<Record<PanelModuleId, boolean>> = {}
  const rawCollapsed = isRecord(raw.collapsed) ? raw.collapsed : undefined
  if (rawCollapsed !== undefined) {
    for (const moduleId of PANEL_MODULE_IDS) {
      const value = rawCollapsed[moduleId]
      if (typeof value === 'boolean') collapsed[moduleId] = value
    }
  }

  return { version: 1, columns, hidden, widths, heights, collapsed }
}

/* ---------------------------------------------------------------- lookups */

/** Column a module currently lives in, or `'hidden'`, or `undefined` if unknown. */
export function modulePlacement(layout: PanelLayout, moduleId: PanelModuleId): PanelColumnId | 'hidden' | undefined {
  for (const column of PANEL_COLUMN_IDS) {
    if (layout.columns[column].includes(moduleId)) return column
  }
  return layout.hidden.includes(moduleId) ? 'hidden' : undefined
}

/** Every visible module id, left to right / top to bottom. */
export function visibleModuleIds(layout: PanelLayout): readonly PanelModuleId[] {
  return PANEL_COLUMN_IDS.flatMap((column) => layout.columns[column])
}

/** True when the module is visible (in a column) rather than hidden. */
export function isModuleVisible(layout: PanelLayout, moduleId: PanelModuleId): boolean {
  return modulePlacement(layout, moduleId) !== 'hidden' && modulePlacement(layout, moduleId) !== undefined
}

/* --------------------------------------------------------------- transforms */

function removeEverywhere(layout: PanelLayout, moduleId: PanelModuleId): PanelLayout {
  const next = cloneLayout(layout)
  const columns = {
    left: next.columns.left.filter((id) => id !== moduleId),
    mid: next.columns.mid.filter((id) => id !== moduleId),
    right: next.columns.right.filter((id) => id !== moduleId),
  }
  return { ...next, columns, hidden: next.hidden.filter((id) => id !== moduleId) }
}

/**
 * Move a module into `column` at `index` (insertion index after removal).
 *
 * A hidden module becomes visible again as part of the move. An out-of-range
 * index is clamped; omitting it appends. Moving a module to its current place
 * still returns an equal layout (callers can cheaply skip a write).
 *
 * @param layout - current layout.
 * @param moduleId - module to move.
 * @param column - destination column.
 * @param index - insertion index after the module is removed (default: append).
 * @returns a new layout.
 */
export function moveModule(
  layout: PanelLayout,
  moduleId: PanelModuleId,
  column: PanelColumnId,
  index?: number,
): PanelLayout {
  const base = removeEverywhere(normaliseLayout(layout), moduleId)
  const target = [...base.columns[column]]
  const at = typeof index === 'number' && Number.isFinite(index)
    ? Math.min(target.length, Math.max(0, Math.trunc(index)))
    : target.length
  target.splice(at, 0, moduleId)
  return { ...base, columns: { ...base.columns, [column]: target } }
}

/** Hide a module (it can be restored from the layout menu). */
export function hideModule(layout: PanelLayout, moduleId: PanelModuleId): PanelLayout {
  const base = removeEverywhere(normaliseLayout(layout), moduleId)
  return { ...base, hidden: [...base.hidden, moduleId] }
}

/** Restore a hidden module to its default column (append position). */
export function showModule(layout: PanelLayout, moduleId: PanelModuleId): PanelLayout {
  const normal = normaliseLayout(layout)
  if (isModuleVisible(normal, moduleId)) return normal
  const base = removeEverywhere(normal, moduleId)
  const column = DEFAULT_MODULE_COLUMN[moduleId]
  return { ...base, columns: { ...base.columns, [column]: [...base.columns[column], moduleId] } }
}

/** Fold/unfold one module (only the header remains when folded). */
export function setModuleCollapsed(layout: PanelLayout, moduleId: PanelModuleId, collapsed: boolean): PanelLayout {
  const base = normaliseLayout(layout)
  return { ...base, collapsed: { ...base.collapsed, [moduleId]: collapsed } }
}

/** Toggle the folded state of one module. */
export function toggleModuleCollapsed(layout: PanelLayout, moduleId: PanelModuleId): PanelLayout {
  return setModuleCollapsed(layout, moduleId, !layout.collapsed[moduleId])
}

/** Resize one side column (the middle column takes the remaining space). */
export function setColumnWidth(layout: PanelLayout, side: 'left' | 'right', width: number): PanelLayout {
  const base = normaliseLayout(layout)
  return { ...base, widths: { ...base.widths, [side]: clampDimension(width, MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, base.widths[side]) } }
}

/** Persist one module's height; the column scrolls when its modules exceed it. */
export function setModuleHeight(layout: PanelLayout, moduleId: PanelModuleId, height: number): PanelLayout {
  const base = normaliseLayout(layout)
  return {
    ...base,
    heights: { ...base.heights, [moduleId]: clampDimension(height, MIN_MODULE_HEIGHT, MAX_MODULE_HEIGHT, MIN_MODULE_HEIGHT) },
  }
}

/** Drop a persisted height so the module returns to flexible sizing. */
export function clearModuleHeight(layout: PanelLayout, moduleId: PanelModuleId): PanelLayout {
  const base = normaliseLayout(layout)
  const heights = { ...base.heights }
  delete heights[moduleId]
  return { ...base, heights }
}

/** Copy a layout into a stable JSON string (order-stable for tests/diffs). */
export function serializeLayout(layout: PanelLayout): string {
  const normal = normaliseLayout(layout)
  return JSON.stringify({
    version: normal.version,
    columns: { left: normal.columns.left, mid: normal.columns.mid, right: normal.columns.right },
    hidden: normal.hidden,
    widths: normal.widths,
    heights: normal.heights,
    collapsed: normal.collapsed,
  })
}

/* --------------------------------------------------------------- storage */

function browserStorage(): LayoutStorage | undefined {
  try {
    if (typeof window === 'undefined') return undefined
    return window.localStorage
  } catch {
    return undefined
  }
}

/**
 * Read the persisted layout.
 *
 * Missing storage, a missing key, malformed JSON, a throwing storage
 * implementation and an out-of-date shape all fall back to the default layout —
 * a broken preference must never blank the cockpit.
 *
 * @param storage - optional storage face (tests); defaults to `window.localStorage`.
 * @returns a validated layout.
 */
export function readLayout(storage?: LayoutStorage | null): PanelLayout {
  try {
    const source = storage === undefined ? browserStorage() : storage
    if (source === null || source === undefined) return createDefaultLayout()
    const raw = source.getItem(LAYOUT_STORAGE_KEY)
    if (raw === null || raw === '') return createDefaultLayout()
    return normaliseLayout(JSON.parse(raw))
  } catch {
    return createDefaultLayout()
  }
}

/**
 * Persist the layout.
 *
 * Storage failures (quota, disabled cookies, a throwing test double) are
 * swallowed: the in-memory layout is still correct, and the next read simply
 * falls back to the default.
 *
 * @param layout - layout to persist.
 * @param storage - optional storage face (tests); defaults to `window.localStorage`.
 */
export function writeLayout(layout: PanelLayout, storage?: LayoutStorage | null): void {
  try {
    const target = storage === undefined ? browserStorage() : storage
    if (target === null || target === undefined) return
    target.setItem(LAYOUT_STORAGE_KEY, serializeLayout(layout))
  } catch {
    /* a preference write must never break the panel */
  }
}
