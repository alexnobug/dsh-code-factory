/**
 * The host half of the cockpit's data channel (`docs/API-CONTRACTS.md` §7).
 *
 * One read-only HTTP route serves three request shapes:
 *
 * | request            | response                                       |
 * |--------------------|------------------------------------------------|
 * | `?id=<factoryId>`  | that factory's `FactorySnapshot`                |
 * | `?sessionId=<sid>` | the factory owned by that session               |
 * | no parameters      | the cross-workspace index of factory summaries  |
 *
 * ## Why workspace resolution lives here
 *
 * The client sends **identifiers only** — never a path, never a `stateDir`,
 * never a file name (§7.2). This module decides *what may be read*:
 *
 *  1. every workspace the host knows about, discovered defensively through the
 *     optional `workspaceRegistry` / `workspace` services (`<ws>/<stateDir>`);
 *  2. plus the cwd of live agents (`agents.list()`), which covers a workspace
 *     that was never registered but already has a session in it;
 *  3. for `?sessionId=`, the session's own workspace first, then every other
 *     discovered workspace.
 *
 * `factoryId` must pass `isSafeFactoryId()` before the store is touched at all, and
 * `sessionId` is only ever compared for equality — it is never joined into a
 * path. A request that fails validation is answered with 400 and performs no
 * filesystem access.
 *
 * ## Response rules (§7.3)
 *
 * GET only, `cache-control: no-store`, index rows carry five fields, and a miss
 * is a 404 — never an empty object, which the client would report as a link
 * failure instead of an empty state. An empty *index* is a 200 with an empty
 * list, because "no factory yet" is a state, not an error.
 *
 * @module dsh-code-factory/web/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import type { FactorySnapshot, FactoryState } from '../shared/types.js'
import { FactoryStore, isFactoryState, isSafeFactoryId, type FactorySummary } from '../store/store.js'
import { evolutionStats } from '../store/evolution.js'
import { buildFactoryIndex, buildFactorySnapshot, DEFAULT_FEED_LIMIT, type FactoryIndexEntry } from './snapshot.js'

/* ------------------------------------------------------------------ route */

/** Route path. Must stay byte-identical to `CODE_FACTORY_STATE_ROUTE` in `src/client/api.ts`. */
export const CODE_FACTORY_STATE_PATH = '/plugins/code-factory/state'

/** Default state directory leaf, matching `Config.stateDir` and `FactoryStore`. */
const DEFAULT_STATE_DIR = '.code-factory'

/** Longest accepted `sessionId`; longer values are rejected before any comparison. */
const MAX_SESSION_ID_LENGTH = 512

/** Workspace service keys, tried in order. Both are optional (§7.2). */
const WORKSPACE_SERVICE_KEYS = ['workspaceRegistry', 'workspace'] as const

/** Options accepted by {@link registerFactoryStateRoute}. */
export interface FactoryStateRouteOptions {
  /** State directory leaf under each workspace (`<workspace>/<stateDir>/…`). */
  readonly stateDir: string
  /** Newest messages kept per snapshot. Defaults to {@link DEFAULT_FEED_LIMIT}. */
  readonly feedLimit?: number
}

/* -------------------------------------------------------------- duck types */

/**
 * The shapes actually reached on the live host.
 *
 * Every service below is optional, composed differently per profile, and the
 * workspace/web-server services are not declared in this package's type space at
 * all — so the route duck-types what it finds instead of hard-injecting (§7.2).
 */
interface WebServerLike {
  register(route: {
    readonly kind: 'prefix' | 'exact'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

interface WorkspaceLike {
  readonly path?: unknown
  readonly workspacePath?: unknown
  readonly cwd?: unknown
  readonly root?: unknown
  readonly dir?: unknown
  /** Sessions the registry already attributes to this workspace (`Workspace.sessionIds`). */
  readonly sessionIds?: unknown
}

interface WorkspaceRegistryLike {
  list?(): unknown
}

interface AgentLike {
  readonly id?: unknown
  readonly session?: { readonly header?: { readonly cwd?: unknown } }
}

interface AgentsLike {
  list?(): unknown
  get?(id: string): unknown
}

/* ---------------------------------------------------------------- helpers */

/** Read an optional service without assuming the key exists in this composition. */
function optionalService<T>(ctx: Context, key: string): T | undefined {
  const getter = (ctx as unknown as { get?: unknown }).get
  if (typeof getter !== 'function') return undefined
  try {
    const value = (getter as (key: string) => unknown).call(ctx, key)
    return (value ?? undefined) as T | undefined
  } catch {
    // A composition that throws for an unknown key must not take the route down.
    return undefined
  }
}

/** Await a possibly-absent accessor; any failure degrades to `undefined`. */
async function callQuietly<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

function toArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** The workspace directory behind one registry entry, under several plausible spellings. */
function workspacePathOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry
  if (entry === null || typeof entry !== 'object') return undefined
  const candidate = entry as WorkspaceLike
  for (const value of [candidate.path, candidate.workspacePath, candidate.cwd, candidate.root, candidate.dir]) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/** Normalise a directory to an absolute path, or `undefined` when unusable. */
function toAbsoluteDirectory(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  try {
    return path.resolve(trimmed)
  } catch {
    return undefined
  }
}

/**
 * `true` when the request targets the projection itself.
 *
 * A `prefix` registration hands over the full path (the reference plugin's asset
 * route proves this), so sub-paths below the mount are rejected; a composition
 * that hands over a prefix-stripped url (`/`) is accepted, because the mount
 * owns no children either way.
 */
function isStatePath(pathname: string): boolean {
  if (pathname === CODE_FACTORY_STATE_PATH || pathname === `${CODE_FACTORY_STATE_PATH}/`) return true
  return pathname === '' || pathname === '/'
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(payload)),
    ...headers,
  })
  res.end(payload)
}

/* ------------------------------------------------------------- registration */

/**
 * Register the read-only factory state projection.
 *
 * @param ctx - host context; the web server is read defensively, never injected.
 * @param options - state directory leaf and optional feed bound.
 * @returns the disposer that unregisters the route.
 */
export function registerFactoryStateRoute(ctx: Context, options: FactoryStateRouteOptions): () => void {
  const rawStateDir = typeof options?.stateDir === 'string' ? options.stateDir.trim() : ''
  const stateDir = rawStateDir === '' ? DEFAULT_STATE_DIR : rawStateDir
  const feedLimit = options?.feedLimit ?? DEFAULT_FEED_LIMIT

  const webServer = optionalService<WebServerLike>(ctx, 'webServer') ?? optionalService<WebServerLike>(ctx, 'httpServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    // No web surface in this composition: the cockpit simply has nothing to poll.
    console.warn('[code-factory] no webServer service — the factory state route was not registered')
    return () => undefined
  }

  /** One store per workspace; its state root is `<workspace>/<stateDir>`. */
  const stores = new Map<string, FactoryStore>()
  /** Warning codes already printed, so a hot path cannot spam the host log. */
  const reportedWarnings = new Set<string>()
  const reportStoreWarning = (warning: { code: string; message: string }): void => {
    // The cockpit's store used to be built with no warning handler at all, which
    // made every degraded write (a failed rename, an unflushed file) invisible
    // here while the same event was logged on the tool path.
    if (reportedWarnings.has(warning.code)) return
    reportedWarnings.add(warning.code)
    console.warn(`[code-factory] ${warning.code}: ${warning.message}`)
  }
  const storeFor = (workspace: string): FactoryStore => {
    let store = stores.get(workspace)
    if (store === undefined) {
      store = new FactoryStore({ workspace, stateDir, onWarning: reportStoreWarning })
      stores.set(workspace, store)
    }
    return store
  }

  /** Every workspace directory this host can name, in priority order, deduplicated. */
  const discoverWorkspaces = async (): Promise<string[]> => {
    const found: string[] = []
    const seen = new Set<string>()
    const add = (value: unknown): void => {
      const resolved = toAbsoluteDirectory(value)
      if (resolved === undefined || seen.has(resolved)) return
      seen.add(resolved)
      found.push(resolved)
    }

    for (const key of WORKSPACE_SERVICE_KEYS) {
      const registry = optionalService<WorkspaceRegistryLike>(ctx, key)
      if (registry === undefined || typeof registry.list !== 'function') continue
      const listed = await callQuietly(() => registry.list!())
      for (const entry of toArray(listed)) add(workspacePathOf(entry))
    }

    const agents = optionalService<AgentsLike>(ctx, 'agents')
    if (agents !== undefined && typeof agents.list === 'function') {
      const live = await callQuietly(() => agents.list!())
      for (const agent of toArray(live)) add((agent as AgentLike | undefined)?.session?.header?.cwd)
    }

    return found
  }

  /** The cwd of one live session, when the host can name it. */
  const liveSessionCwd = async (sessionId: string): Promise<string | undefined> => {
    const agents = optionalService<AgentsLike>(ctx, 'agents')
    if (agents === undefined) return undefined

    if (typeof agents.get === 'function') {
      const direct = await callQuietly(() => agents.get!(sessionId))
      const cwd = toAbsoluteDirectory((direct as AgentLike | undefined)?.session?.header?.cwd)
      if (cwd !== undefined) return cwd
    }
    if (typeof agents.list === 'function') {
      const live = await callQuietly(() => agents.list!())
      for (const agent of toArray(live)) {
        const candidate = agent as AgentLike | undefined
        if (candidate?.id !== sessionId) continue
        const cwd = toAbsoluteDirectory(candidate.session?.header?.cwd)
        if (cwd !== undefined) return cwd
      }
    }
    return undefined
  }

  /**
   * The workspace a registry record already attributes this session to.
   *
   * `Workspace.sessionIds` is maintained by the host's canonical-cwd header
   * index, so it answers "which workspace owns this session" without needing a
   * live agent — the case that matters after a host restart (§7.2.3).
   */
  const registryWorkspaceForSession = async (sessionId: string): Promise<string | undefined> => {
    for (const key of WORKSPACE_SERVICE_KEYS) {
      const registry = optionalService<WorkspaceRegistryLike>(ctx, key)
      if (registry === undefined || typeof registry.list !== 'function') continue
      const listed = await callQuietly(() => registry.list!())
      for (const entry of toArray(listed)) {
        const ids = (entry as WorkspaceLike | null)?.sessionIds
        if (!Array.isArray(ids) || !ids.some((id) => id === sessionId)) continue
        const dir = toAbsoluteDirectory(workspacePathOf(entry))
        if (dir !== undefined) return dir
      }
    }
    return undefined
  }

  /** Listing rows of one workspace; an unreadable workspace contributes nothing. */
  const listQuietly = async (store: FactoryStore): Promise<readonly FactorySummary[]> => {
    const listed = await callQuietly(() => store.list())
    return listed ?? []
  }

  /** `undefined` = no such record; `'unreadable'` = present but not parseable. */
  const loadQuietly = async (
    store: FactoryStore,
    factoryId: string,
  ): Promise<FactoryState | undefined | 'unreadable'> => {
    try {
      return await store.load(factoryId)
    } catch {
      return 'unreadable'
    }
  }

  /**
   * Alert ids already announced, so a one-second poll cannot spam the host log.
   *
   * An id is *removed* again once it stops alerting, so a condition that clears
   * and comes back is announced again — the log stays a faithful record of "this
   * factory needed attention", not "this factory needed attention once".
   */
  const announcedAlerts = new Set<string>()

  /**
   * Surface every actionable alert in the host log, exactly once per occurrence.
   *
   * Why here: the host exposes no notification API (`docs/limitations.md` §10),
   * so `console.warn` — which the host captures — is the only channel that works
   * even when nobody has the panel open. The panel banner reads the same list.
   *
   * @param snapshot - the payload the client is about to receive.
   */
  function reportNewAlerts(snapshot: FactorySnapshot): void {
    const live = new Set<string>()
    for (const alert of snapshot.alerts) {
      if (alert.severity !== 'action') continue
      live.add(alert.id)
      if (announcedAlerts.has(alert.id)) continue
      announcedAlerts.add(alert.id)
      console.warn(
        `[code-factory] 需要处理 · ${snapshot.name}（${snapshot.id}）· ${alert.title}`
          + ` — ${alert.detail} → ${alert.next}`,
      )
    }
    for (const id of [...announcedAlerts]) {
      if (!live.has(id)) announcedAlerts.delete(id)
    }
  }

  /** Full snapshot for an existing record, including its side files. */
  const snapshotOf = async (store: FactoryStore, state: FactoryState): Promise<FactorySnapshot> => {
    const [artifacts, feed, evolution] = await Promise.all([
      store.listArtifacts(state.id),
      store.readAllMessages(state.id, { limit: feedLimit }),
      // Read the WHOLE ledger, not a pre-capped view: `buildFactorySnapshot`
      // filters by this factory's roster + recurring mistakes and keeps 12, and a
      // view capped here would let unrelated lessons evict the relevant ones
      // before the filter ever runs. Any failure (unreadable/corrupt file)
      // degrades to `undefined`, so the cockpit still renders the factory instead
      // of answering 500 for a side file.
      callQuietly(async () => {
        const lessons = await store.evolution.read()
        return { stats: evolutionStats(lessons), lessons }
      }),
    ])
    const snapshot = buildFactorySnapshot(state, {
      artifacts,
      feed,
      feedLimit,
      ...(evolution === undefined ? {} : { evolution }),
    })
    reportNewAlerts(snapshot)
    return snapshot
  }

  /** `?id=` — the exact factory, searched across every known workspace. */
  const findByFactoryId = async (factoryId: string): Promise<FactorySnapshot | undefined | 'unreadable'> => {
    for (const workspace of await discoverWorkspaces()) {
      const store = storeFor(workspace)
      const state = await loadQuietly(store, factoryId)
      if (state === 'unreadable') return 'unreadable'
      if (isFactoryState(state)) return await snapshotOf(store, state)
    }
    return undefined
  }

  /** `?sessionId=` — the session's factory, then its workspace's newest factory. */
  const findBySessionId = async (sessionId: string): Promise<FactorySnapshot | undefined> => {
    const discovered = await discoverWorkspaces()
    // The session's own workspace: the registry's attribution first (it survives
    // a host restart with no live agent), then the live agent's cwd.
    const own = (await registryWorkspaceForSession(sessionId)) ?? (await liveSessionCwd(sessionId))
    const ordered = own === undefined ? discovered : [own, ...discovered.filter((workspace) => workspace !== own)]

    // Pass 1: the factory that names this session as its captain. Works even when
    // the session is no longer live, as long as its workspace is still known.
    for (const workspace of ordered) {
      const store = storeFor(workspace)
      const hit = (await listQuietly(store)).find((row) => row.captainSessionId === sessionId)
      if (hit === undefined) continue
      const state = await loadQuietly(store, hit.id)
      if (isFactoryState(state)) return await snapshotOf(store, state)
    }

    // Pass 2: the session's own workspace, most recently updated factory (§7.2.3).
    if (own !== undefined) {
      const store = storeFor(own)
      const newest = (await listQuietly(store))[0]
      if (newest !== undefined) {
        const state = await loadQuietly(store, newest.id)
        if (isFactoryState(state)) return await snapshotOf(store, state)
      }
    }

    return undefined
  }

  /** No parameters — the cross-workspace index of summaries (§7.1). */
  const buildIndex = async (): Promise<FactoryIndexEntry[]> => {
    const rows: FactorySummary[] = []
    for (const workspace of await discoverWorkspaces()) rows.push(...(await listQuietly(storeFor(workspace))))
    return buildFactoryIndex(rows)
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
        return
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!isStatePath(url.pathname)) {
        sendJson(res, 404, { error: 'not found' })
        return
      }

      const rawFactoryId = url.searchParams.get('id')
      if (rawFactoryId !== null) {
        const factoryId = rawFactoryId.trim()
        if (!isSafeFactoryId(factoryId)) {
          // Rejected before any filesystem access: no traversal, no probing.
          sendJson(res, 400, { error: 'invalid factory id' })
          return
        }
        const found = await findByFactoryId(factoryId)
        if (found === 'unreadable') {
          sendJson(res, 500, { error: 'factory record unreadable' })
          return
        }
        if (found === undefined) {
          sendJson(res, 404, { error: 'factory not found' })
          return
        }
        sendJson(res, 200, found)
        return
      }

      const rawSessionId = url.searchParams.get('sessionId')
      if (rawSessionId !== null) {
        const sessionId = rawSessionId.trim()
        if (sessionId === '' || sessionId.length > MAX_SESSION_ID_LENGTH) {
          sendJson(res, 400, { error: 'invalid session id' })
          return
        }
        const found = await findBySessionId(sessionId)
        if (found === undefined) {
          sendJson(res, 404, { error: 'no factory for that session' })
          return
        }
        sendJson(res, 200, found)
        return
      }

      // No parameters: an empty index is a 200 with an empty list — the client
      // renders that as its waiting state, not as a link failure.
      sendJson(res, 200, { factories: await buildIndex() })
    } catch {
      // The route is a projection: never leak internals into the response.
      if (!res.headersSent) sendJson(res, 500, { error: 'factory state unavailable' })
      else res.end()
    }
  }

  return webServer.register({ kind: 'prefix', path: CODE_FACTORY_STATE_PATH, handler })
}
