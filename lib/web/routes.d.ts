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
import type { Context } from '@deepseek-ai/cordis';
/** Route path. Must stay byte-identical to `CODE_FACTORY_STATE_ROUTE` in `src/client/api.ts`. */
export declare const CODE_FACTORY_STATE_PATH = "/plugins/code-factory/state";
/** Options accepted by {@link registerFactoryStateRoute}. */
export interface FactoryStateRouteOptions {
    /** State directory leaf under each workspace (`<workspace>/<stateDir>/…`). */
    readonly stateDir: string;
    /** Newest messages kept per snapshot. Defaults to {@link DEFAULT_FEED_LIMIT}. */
    readonly feedLimit?: number;
}
/**
 * Register the read-only factory state projection.
 *
 * @param ctx - host context; the web server is read defensively, never injected.
 * @param options - state directory leaf and optional feed bound.
 * @returns the disposer that unregisters the route.
 */
export declare function registerFactoryStateRoute(ctx: Context, options: FactoryStateRouteOptions): () => void;
