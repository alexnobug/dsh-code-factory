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

import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { ReuseEntry, ReuseFile, ReuseKind, ReuseMatch } from '../shared/types.js'
import { REUSE_KINDS } from '../shared/types.js'
import { rankReuseEntries, type ReuseRankOptions } from '../domain/reuse.js'
import { nodeFilePrimitives, replaceFileAtomicOrDirect, temporaryPathFor } from './atomic.js'
import { withFactoryFileLock } from './file-lock.js'

/* --------------------------------------------------------------- constants */

/** On-disk shape version of `index.json`. */
export const REUSE_LIBRARY_SCHEMA_VERSION = 1

/** File name of the library index. */
export const REUSE_LIBRARY_INDEX_FILE = 'index.json'

/** Directory holding one sub-directory per entry. */
export const REUSE_LIBRARY_ENTRIES_DIR = 'entries'

/** Directory holding the copied files of one entry. */
export const REUSE_LIBRARY_FILES_DIR = 'files'

/** Max bytes for one stored file (5 MB). */
export const REUSE_LIBRARY_MAX_FILE_BYTES = 5 * 1024 * 1024

/** Max bytes for one harvest in total (50 MB). */
export const REUSE_LIBRARY_MAX_TOTAL_BYTES = 50 * 1024 * 1024

/** Max files in one harvest. */
export const REUSE_LIBRARY_MAX_FILES = 500

/** Prefix of the lock key handed to `withFactoryLock`. */
export const REUSE_LIBRARY_LOCK_PREFIX = 'reuse:'

/** Default number of rows a plain `list` returns. */
export const REUSE_LIBRARY_LIST_LIMIT = 20

/* ------------------------------------------------------------------ errors */

/** A refused library operation: unsafe path, missing entry, size bound, … */
export class ReuseLibraryError extends Error {
  /** Machine-ish code for the engine to branch on / quote. */
  readonly code: string

  constructor(message: string, code = 'reuse') {
    super(message)
    this.name = 'ReuseLibraryError'
    this.code = code
  }
}

/* --------------------------------------------------------------- options */

/** Non-fatal observation sink. */
export type ReuseLibraryWarningHandler = (code: string, message: string) => void

/** Construction options. `root` is `<libraryDir>` resolved by the caller. */
export interface ReuseLibraryOptions {
  /** Clock. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Non-fatal warning sink (corrupt index, unreadable file). */
  readonly onWarning?: ReuseLibraryWarningHandler
}

/** What `harvest()` accepts. */
export interface ReuseHarvestInput {
  readonly sourceFactoryId: string
  readonly sourceFactoryName: string
  /** Absolute source workspace root. */
  readonly sourceWorkspace: string
  /** Workspace-relative POSIX paths (files or directories). */
  readonly paths: readonly string[]
  readonly name: string
  readonly description?: string
  readonly kind?: ReuseKind
  readonly tags?: readonly string[]
  readonly taskTypes?: readonly string[]
}

/** What one `apply()` copied. All paths are workspace-relative POSIX. */
export interface ReuseApplyResult {
  readonly entryId: string
  readonly targetDir: string
  readonly copied: readonly string[]
  readonly skipped: readonly string[]
}

/** One file collected by a harvest scan (bytes kept in memory for hashing+coping). */
interface HarvestFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly data: Buffer
}

/* ----------------------------------------------------------- default root */

/**
 * The default global library directory: `$DSH_HOME/code-factory-library`
 * (falling back to the OS home directory when `DSH_HOME` is unset/blank).
 */
export function defaultReuseLibraryDir(): string {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  const home = configured === '' ? os.homedir() : configured
  return path.join(home, 'code-factory-library')
}

/* ----------------------------------------------------------- path helpers */

function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
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

function forbiddenSegment(segment: string): boolean {
  const lower = segment.toLowerCase()
  return lower === '.code-factory' || lower === '.git' || lower === 'node_modules'
}

function forbiddenFileSegment(segment: string): boolean {
  const lower = segment.toLowerCase()
  if (lower.startsWith('.env')) return true
  if (['.ssh', '.gnupg', 'credentials', 'secrets'].includes(lower)) return true
  if (['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'].includes(lower)) return true
  return ['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.crt', '.cer', '.der', '.p8', '.ppk']
    .some((suffix) => lower.endsWith(suffix))
}

/** Windows device names and trailing dots/spaces are unsafe path segments. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

function unsafeWindowsSegment(segment: string): boolean {
  return segment !== segment.replace(/[. ]+$/, '') || WINDOWS_RESERVED.test(segment)
}

/**
 * Validate + normalise one workspace-relative POSIX path.
 *
 * Refuses empty paths, absolute paths, drive letters, `..`, `.code-factory`,
 * `.git`, `node_modules`, `.env*`, `*.pem` and `*.key`. Backslashes are
 * normalised first, so a Windows-style path is validated instead of silently
 * becoming a literal directory name on POSIX.
 */
export function normalizeReusePath(input: string, what = '路径'): string {
  const raw = toPosix(String(input ?? '').trim())
  if (raw === '') throw new ReuseLibraryError(`${what}不能为空`, 'path')
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new ReuseLibraryError(`${what}必须是工作区相对路径（POSIX），实际是 ${JSON.stringify(input)}`, 'path')
  }
  const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) throw new ReuseLibraryError(`${what}不能是根目录/空路径: ${JSON.stringify(input)}`, 'path')
  for (const segment of segments) {
    if (segment === '..') throw new ReuseLibraryError(`${what}不能包含 ..（越界）: ${JSON.stringify(input)}`, 'path')
    if (forbiddenSegment(segment)) {
      throw new ReuseLibraryError(`${what}包含禁止的目录 ${segment}: ${JSON.stringify(input)}`, 'path')
    }
    if (forbiddenFileSegment(segment)) {
      throw new ReuseLibraryError(`${what}包含禁止的文件 ${segment}: ${JSON.stringify(input)}`, 'path')
    }
    if (unsafeWindowsSegment(segment)) {
      throw new ReuseLibraryError(`${what}包含不安全/保留的 Windows 路径段 ${segment}: ${JSON.stringify(input)}`, 'path')
    }
  }
  return segments.join('/')
}

/** Resolve `relative` strictly inside `base` (defence in depth after validation). */
function resolveInside(base: string, relative: string, what: string): string {
  const absolute = path.resolve(base, ...relative.split('/'))
  const inside = path.relative(base, absolute)
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new ReuseLibraryError(`${what}越界（不在 ${base} 内）: ${relative}`, 'path')
  }
  return absolute
}

function sanitizeLabels(values: readonly string[] | undefined): string[] {
  const result: string[] = []
  for (const value of values ?? []) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed === '') continue
    if (result.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) continue
    result.push(trimmed)
  }
  return result
}

function sha256Of(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(0, Math.trunc(value)), max)
}

function safeEntryId(value: string): string {
  const id = String(value ?? '').trim()
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new ReuseLibraryError(`entryId 非法: ${JSON.stringify(value)}（应为库生成的短 id）`, 'invalid-input')
  }
  return id
}

/* ----------------------------------------------------------------- parsing */

/** Tolerant structural parse of one persisted entry; `undefined` = drop it. */
function parseEntry(value: unknown): ReuseEntry | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return undefined
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return undefined
  const kind = typeof raw.kind === 'string' && (REUSE_KINDS as readonly string[]).includes(raw.kind)
    ? (raw.kind as ReuseKind)
    : 'other'
  const files: ReuseFile[] = []
  if (Array.isArray(raw.files)) {
    for (const candidate of raw.files) {
      if (candidate === null || typeof candidate !== 'object') continue
      const file = candidate as Record<string, unknown>
      if (typeof file.path !== 'string') continue
      let normalized: string
      try {
        normalized = normalizeReusePath(file.path, '库文件路径')
      } catch {
        continue
      }
      const bytes = typeof file.bytes === 'number' && Number.isFinite(file.bytes) ? Math.max(0, file.bytes) : 0
      const sha256 = typeof file.sha256 === 'string' ? file.sha256 : ''
      files.push({ path: normalized, bytes, sha256 })
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt
  return {
    id,
    name: raw.name,
    kind,
    description: typeof raw.description === 'string' ? raw.description : '',
    tags: sanitizeLabels(Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : []),
    taskTypes: sanitizeLabels(
      Array.isArray(raw.taskTypes) ? raw.taskTypes.filter((item): item is string => typeof item === 'string') : [],
    ),
    sourceFactoryId: typeof raw.sourceFactoryId === 'string' ? raw.sourceFactoryId : '',
    sourceFactoryName: typeof raw.sourceFactoryName === 'string' ? raw.sourceFactoryName : '',
    sourceWorkspace: typeof raw.sourceWorkspace === 'string' ? raw.sourceWorkspace : '',
    files,
    createdAt,
    updatedAt,
  }
}

/* ------------------------------------------------------------------ store */

/**
 * The global reuse library.
 *
 * Construct with the resolved library root (`config.libraryDir`, default
 * {@link defaultReuseLibraryDir}). Every mutation is serialised on
 * `reuse:<root>` and the index is written atomically.
 */
export class ReuseLibrary {
  /** Absolute library root. */
  readonly root: string
  /** Absolute path of `index.json`. */
  readonly indexPath: string

  private readonly clock: () => number
  private readonly warn: ReuseLibraryWarningHandler | undefined

  constructor(root: string, options: ReuseLibraryOptions = {}) {
    this.root = path.resolve(root)
    this.indexPath = path.join(this.root, REUSE_LIBRARY_INDEX_FILE)
    this.clock = options.now ?? Date.now
    this.warn = options.onWarning
  }

  /** Lock key this library's writers serialise on (never a factory id). */
  lockKey(): string {
    return `${REUSE_LIBRARY_LOCK_PREFIX}${this.root}`
  }

  /** The raw index (tolerant: missing/corrupt => []). Sorted newest first. */
  async readIndex(): Promise<ReuseEntry[]> {
    return await this.readIndexUnlocked()
  }

  /** Entries ordered by freshness (updatedAt desc, id asc), capped at 20. */
  async list(limit: number = REUSE_LIBRARY_LIST_LIMIT): Promise<ReuseEntry[]> {
    const entries = await this.readIndexUnlocked()
    const capped = clampLimit(limit, REUSE_LIBRARY_LIST_LIMIT, REUSE_LIBRARY_LIST_LIMIT)
    return [...entries].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)).slice(0, capped)
  }

  /** Pure ranking over the index (see `domain/reuse.rankReuseEntries`). */
  async search(options: ReuseRankOptions = {}): Promise<ReuseMatch[]> {
    return rankReuseEntries(await this.readIndexUnlocked(), options)
  }

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
  async harvest(input: ReuseHarvestInput): Promise<ReuseEntry> {
    if (input === null || typeof input !== 'object') throw new ReuseLibraryError('harvest 参数为空', 'invalid-input')
    const sourceFactoryId = String(input.sourceFactoryId ?? '').trim()
    if (sourceFactoryId === '') throw new ReuseLibraryError('harvest 缺少 sourceFactoryId', 'invalid-input')
    const rawWorkspace = String(input.sourceWorkspace ?? '').trim()
    if (rawWorkspace === '' || !path.isAbsolute(rawWorkspace)) {
      throw new ReuseLibraryError('sourceWorkspace 必须是绝对路径（工作区根）', 'invalid-input')
    }
    const sourceWorkspace = path.resolve(rawWorkspace)
    const name = String(input.name ?? '').trim()
    if (name === '') throw new ReuseLibraryError('harvest 需要 name（资产名称）', 'invalid-input')
    const kind = this.kindOf(input.kind)
    const tags = sanitizeLabels(input.tags)
    const taskTypes = sanitizeLabels(input.taskTypes)
    const rawPaths = Array.isArray(input.paths) ? input.paths : []
    if (rawPaths.length === 0) throw new ReuseLibraryError('paths 不能为空：至少选择一个工作区相对路径', 'invalid-input')
    const paths = [...new Set(rawPaths.map((entry, index) => normalizeReusePath(entry, `paths[${index}]`)))].sort()

    const files = await this.collectFiles(sourceWorkspace, paths)
    if (files.length === 0) throw new ReuseLibraryError('没有收集到任何文件（路径为空目录？）', 'empty')

    const normalizedPaths = paths.join(',')
    const hashInput = files
      .slice()
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => `${file.path}:${file.sha256}`)
      .join(',')
    const id = createHash('sha1').update(`${sourceFactoryId}|${normalizedPaths}|${hashInput}`).digest('hex').slice(0, 12)

    await mkdir(this.root, { recursive: true })
    return await withFactoryFileLock(this.root, 'library', 'harvest', async (): Promise<ReuseEntry> => {
      const entries = await this.readIndexUnlocked()
      const existing = entries.find((entry) => entry.id === id)
      const now = this.clock()
      const storedFiles: ReuseFile[] = files
        .map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }))
        .sort((left, right) => left.path.localeCompare(right.path))
      const description = typeof input.description === 'string' ? input.description.trim() : ''
      const sourceFactoryName = String(input.sourceFactoryName ?? '').trim()

      // Replace the entry's file tree so a re-harvest cannot leave stale files.
      const filesRoot = path.join(this.root, REUSE_LIBRARY_ENTRIES_DIR, id, REUSE_LIBRARY_FILES_DIR)
      await rm(filesRoot, { recursive: true, force: true })
      await mkdir(filesRoot, { recursive: true })
      for (const file of files) {
        const destination = resolveInside(filesRoot, file.path, `库中文件 ${file.path}`)
        await mkdir(path.dirname(destination), { recursive: true })
        await writeFile(destination, file.data)
      }

      const entry: ReuseEntry =
        existing === undefined
          ? {
              id,
              name,
              kind,
              description,
              tags,
              taskTypes,
              sourceFactoryId,
              sourceFactoryName: sourceFactoryName === '' ? sourceFactoryId : sourceFactoryName,
              sourceWorkspace,
              files: storedFiles,
              createdAt: now,
              updatedAt: now,
            }
          : {
              ...existing,
              name,
              kind,
              description: description === '' ? existing.description : description,
              tags: sanitizeLabels([...existing.tags, ...tags]),
              taskTypes: sanitizeLabels([...existing.taskTypes, ...taskTypes]),
              sourceFactoryName: sourceFactoryName === '' ? existing.sourceFactoryName : sourceFactoryName,
              sourceWorkspace,
              files: storedFiles,
              updatedAt: now,
            }

      const next = existing === undefined ? [...entries, entry] : entries.map((item) => (item.id === id ? entry : item))
      await this.writeIndex(next)
      return entry
    })
  }

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
  async apply(
    entryIdRaw: string,
    workspaceRaw: string,
    targetDirRaw?: string,
    overwrite = false,
  ): Promise<ReuseApplyResult> {
    const entryId = safeEntryId(entryIdRaw)
    const rawWorkspace = String(workspaceRaw ?? '').trim()
    if (rawWorkspace === '' || !path.isAbsolute(rawWorkspace)) {
      throw new ReuseLibraryError('apply 需要绝对工作区路径', 'invalid-input')
    }
    const workspace = path.resolve(rawWorkspace)
    const targetDir = normalizeReusePath(
      targetDirRaw === undefined || String(targetDirRaw).trim() === '' ? `reuse/${entryId}` : String(targetDirRaw),
      'targetDir',
    )
    const entries = await this.readIndexUnlocked()
    const entry = entries.find((item) => item.id === entryId)
    if (entry === undefined) {
      throw new ReuseLibraryError(`复用库中没有 entryId=${entryId}；先 factory_reuse action=search 找可复用资产`, 'not-found')
    }

    const filesRoot = path.join(this.root, REUSE_LIBRARY_ENTRIES_DIR, entryId, REUSE_LIBRARY_FILES_DIR)
    if (entry.files.length > REUSE_LIBRARY_MAX_FILES) {
      throw new ReuseLibraryError(
        `entry ${entryId} 的索引列出 ${entry.files.length} 个文件，超过上限 ${REUSE_LIBRARY_MAX_FILES}；拒绝 apply`,
        'limit',
      )
    }
    const totalBytes = entry.files.reduce((sum, file) => sum + (Number.isFinite(file.bytes) ? file.bytes : 0), 0)
    if (totalBytes > REUSE_LIBRARY_MAX_TOTAL_BYTES) {
      throw new ReuseLibraryError(
        `entry ${entryId} 总大小超过 apply 上限 ${REUSE_LIBRARY_MAX_TOTAL_BYTES} 字节；拒绝 apply`,
        'limit',
      )
    }
    const copied: string[] = []
    const skipped: string[] = []
    for (const file of entry.files) {
      // Re-validate the stored path: a hand-edited index must not escape either tree.
      const storedRelative = normalizeReusePath(file.path, `entry ${entryId} 文件`)
      const source = resolveInside(filesRoot, storedRelative, `库文件 ${storedRelative}`)
      let sourceInfo: Stats
      try {
        sourceInfo = await lstat(source)
      } catch {
        throw new ReuseLibraryError(`库文件缺失: ${entryId}/${storedRelative}（索引与目录不一致）`, 'missing-file')
      }
      if (sourceInfo.isSymbolicLink()) {
        throw new ReuseLibraryError(`拒绝跟随符号链接: ${entryId}/${storedRelative}`, 'symlink')
      }
      if (!sourceInfo.isFile()) {
        throw new ReuseLibraryError(`库中路径不是普通文件: ${entryId}/${storedRelative}`, 'not-file')
      }
      const targetRelative = normalizeReusePath(`${targetDir}/${storedRelative}`, 'apply 目标路径')
      const target = resolveInside(workspace, targetRelative, 'apply 目标')
      // Never traverse a symlinked directory while creating/copying into the
      // workspace: the destination tree is user data and a link could point
      // outside. Missing ancestors are fine — they are created below.
      await this.assertNoSymlinkAncestors(workspace, targetRelative)
      await mkdir(path.dirname(target), { recursive: true })
      const existing = await this.lstatOrUndefined(target)
      if (existing !== undefined) {
        if (existing.isSymbolicLink()) {
          throw new ReuseLibraryError(`拒绝覆盖符号链接: ${targetRelative}`, 'symlink')
        }
        if (existing.isDirectory()) {
          throw new ReuseLibraryError(`目标路径已是目录，不能写入文件: ${targetRelative}`, 'not-file')
        }
        if (overwrite !== true) {
          skipped.push(targetRelative)
          continue
        }
      }
      const data = await readFile(source)
      if (data.length !== file.bytes || sha256Of(data) !== file.sha256) {
        throw new ReuseLibraryError(
          `库文件校验失败: ${entryId}/${storedRelative}（索引 sha256/bytes 与实际文件不一致）`,
          'corrupt',
        )
      }
      await writeFile(target, data)
      copied.push(targetRelative)
    }
    return { entryId, targetDir, copied, skipped }
  }

  /* ------------------------------------------------------------- internals */

  /** Tolerant index read; sorted newest first. Never throws. */
  private async readIndexUnlocked(): Promise<ReuseEntry[]> {
    let text: string
    try {
      text = await readFile(this.indexPath, 'utf8')
    } catch (error) {
      if (!isNotFound(error)) this.report('reuse-index-unreadable', `无法读取 ${this.indexPath}: ${describeError(error)}；按空库处理`)
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.report('reuse-index-corrupt', `${this.indexPath} 不是合法 JSON（${describeError(error)}）；按空库处理`)
      return []
    }
    if (parsed === null || typeof parsed !== 'object') {
      this.report('reuse-index-shape', `${this.indexPath} 没有 entries 数组；按空库处理`)
      return []
    }
    const envelope = parsed as { readonly schemaVersion?: unknown; readonly entries?: unknown }
    if (typeof envelope.schemaVersion === 'number' && envelope.schemaVersion > REUSE_LIBRARY_SCHEMA_VERSION) {
      this.report(
        'reuse-index-newer',
        `${this.indexPath} 的 schemaVersion=${envelope.schemaVersion} 高于本版本 ${REUSE_LIBRARY_SCHEMA_VERSION}；按空库处理`,
      )
      return []
    }
    if (!Array.isArray(envelope.entries)) {
      this.report('reuse-index-shape', `${this.indexPath} 没有 entries 数组；按空库处理`)
      return []
    }
    const entries: ReuseEntry[] = []
    let dropped = 0
    for (const candidate of envelope.entries) {
      const entry = parseEntry(candidate)
      if (entry === undefined) {
        dropped += 1
        continue
      }
      entries.push(entry)
    }
    if (dropped > 0) this.report('reuse-entry-invalid', `${this.indexPath} 中有 ${dropped} 条记录不合法，已跳过`)
    return entries.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  }

  /** Whole-index atomic write. Caller holds {@link lockKey}. */
  private async writeIndex(entries: readonly ReuseEntry[]): Promise<void> {
    const sorted = [...entries].sort(
      (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
    )
    const payload = `${JSON.stringify({ schemaVersion: REUSE_LIBRARY_SCHEMA_VERSION, entries: sorted }, null, 2)}\n`
    await mkdir(this.root, { recursive: true })
    await replaceFileAtomicOrDirect(temporaryPathFor(this.indexPath), this.indexPath, payload, nodeFilePrimitives)
  }

  /** Walk the requested paths (files or directories), never following symlinks. */
  private async collectFiles(sourceWorkspace: string, paths: readonly string[]): Promise<HarvestFile[]> {
    const files: HarvestFile[] = []
    let totalBytes = 0
    const addFile = async (relative: string, absolute: string): Promise<void> => {
      if (files.length + 1 > REUSE_LIBRARY_MAX_FILES) {
        throw new ReuseLibraryError(
          `单次最多沉淀 ${REUSE_LIBRARY_MAX_FILES} 个文件，当前选择已超限；请缩小 paths`,
          'limit',
        )
      }
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new ReuseLibraryError(`拒绝跟随符号链接: ${relative}`, 'symlink')
      if (!info.isFile()) throw new ReuseLibraryError(`不是普通文件: ${relative}`, 'not-file')
      // Check the size BEFORE reading: a 2 GB file must be rejected without
      // pulling it into memory first.
      if (info.size > REUSE_LIBRARY_MAX_FILE_BYTES) {
        throw new ReuseLibraryError(
          `文件 ${relative} 超过单文件上限 ${REUSE_LIBRARY_MAX_FILE_BYTES} 字节（实际 ${info.size}）`,
          'limit',
        )
      }
      if (totalBytes + info.size > REUSE_LIBRARY_MAX_TOTAL_BYTES) {
        throw new ReuseLibraryError(
          `本次沉淀总大小超过上限 ${REUSE_LIBRARY_MAX_TOTAL_BYTES} 字节；请缩小 paths`,
          'limit',
        )
      }
      const data = await readFile(absolute)
      if (data.length > REUSE_LIBRARY_MAX_FILE_BYTES) {
        throw new ReuseLibraryError(
          `文件 ${relative} 超过单文件上限 ${REUSE_LIBRARY_MAX_FILE_BYTES} 字节（实际 ${data.length}）`,
          'limit',
        )
      }
      totalBytes += data.length
      if (totalBytes > REUSE_LIBRARY_MAX_TOTAL_BYTES) {
        throw new ReuseLibraryError(
          `本次沉淀总大小超过上限 ${REUSE_LIBRARY_MAX_TOTAL_BYTES} 字节；请缩小 paths`,
          'limit',
        )
      }
      files.push({ path: relative, bytes: data.length, sha256: sha256Of(data), data })
    }
    const walk = async (relative: string, absolute: string): Promise<void> => {
      const info = await lstat(absolute).catch(() => undefined)
      if (info === undefined) throw new ReuseLibraryError(`路径不存在: ${relative}`, 'not-found')
      if (info.isSymbolicLink()) throw new ReuseLibraryError(`拒绝跟随符号链接: ${relative}`, 'symlink')
      if (info.isFile()) {
        await addFile(relative, absolute)
        return
      }
      if (!info.isDirectory()) throw new ReuseLibraryError(`不支持的路径类型（非文件/目录）: ${relative}`, 'not-file')
      const children = await readdir(absolute, { withFileTypes: true })
      children.sort((left, right) => left.name.localeCompare(right.name))
      for (const child of children) {
        const childRelative = normalizeReusePath(`${relative}/${child.name}`, `目录内路径 ${relative}`)
        if (child.isSymbolicLink()) {
          throw new ReuseLibraryError(`拒绝跟随符号链接: ${childRelative}`, 'symlink')
        }
        const childAbsolute = path.join(absolute, child.name)
        if (child.isDirectory()) await walk(childRelative, childAbsolute)
        else if (child.isFile()) await addFile(childRelative, childAbsolute)
        else throw new ReuseLibraryError(`不支持的路径类型（非文件/目录）: ${childRelative}`, 'not-file')
      }
    }
    const workspaceReal = await realpath(sourceWorkspace)
    for (const relative of paths) {
      const absolute = resolveInside(sourceWorkspace, relative, `paths ${relative}`)
      // `resolveInside` is lexical. Resolve the real path too, so an
      // intermediate symlinked directory cannot smuggle a workspace-outside
      // file into the library; then walk (which lstat-rejects the final link).
      let real: string
      try {
        real = await realpath(absolute)
      } catch {
        throw new ReuseLibraryError(`路径不存在: ${relative}`, 'not-found')
      }
      const insideReal = path.relative(workspaceReal, real)
      if (insideReal === '' || insideReal.startsWith('..') || path.isAbsolute(insideReal)) {
        throw new ReuseLibraryError(`拒绝跟随工作区外的符号链接/路径: ${relative}`, 'symlink')
      }
      await walk(relative, absolute)
    }
    return files
  }

  private kindOf(value: ReuseKind | undefined): ReuseKind {
    if (value === undefined) return 'other'
    if (!(REUSE_KINDS as readonly string[]).includes(value)) {
      throw new ReuseLibraryError(
        `未知复用类型 ${JSON.stringify(value)}；可选 ${REUSE_KINDS.join(' / ')}`,
        'invalid-input',
      )
    }
    return value
  }

  /** `lstat` that maps ENOENT to `undefined` (missing is not an error here). */
  private async lstatOrUndefined(target: string): Promise<Stats | undefined> {
    try {
      return await lstat(target)
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  /**
   * Reject a destination whose existing ancestors contain a symlink/non-directory.
   * Missing ancestors are allowed (the caller creates them).
   */
  private async assertNoSymlinkAncestors(base: string, relative: string): Promise<void> {
    let current = base
    for (const segment of relative.split('/').slice(0, -1)) {
      current = path.join(current, segment)
      const info = await this.lstatOrUndefined(current)
      if (info === undefined) return
      if (info.isSymbolicLink()) {
        throw new ReuseLibraryError(`拒绝写入符号链接目录: ${path.relative(base, current)}`, 'symlink')
      }
      if (!info.isDirectory()) {
        throw new ReuseLibraryError(`目标路径中的 ${segment} 不是目录`, 'not-directory')
      }
    }
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
