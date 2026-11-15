/**
 * context.ts — the **shared execution context** every `factory_*` tool resolves
 * before it touches anything, plus the small result-rendering helpers the tool
 * definitions share.
 *
 * Three rules are enforced here and nowhere else, so no tool can forget them:
 *
 *  1. **A calling agent is mandatory.** `exec.agent` is the only identity a tool
 *     has; a call without it is a composition bug, not something to guess around
 *     (`exec.signal` is the caller's cancellation and is forwarded everywhere a
 *     spawn, a delivery or a command runs).
 *
 *  2. **The workspace root is ALWAYS `caller.session.header.cwd`**
 *     (API-CONTRACTS §3 陷阱 #3). `process.cwd()` is never consulted, not even as
 *     a fallback: the harness serves several workspaces from one process, so a
 *     relative or missing `cwd` is rejected loudly instead of silently reading
 *     another session's factories. A relative value is refused too — making it
 *     absolute would require `process.cwd()`, which is exactly the bug.
 *
 *  3. **One `FactoryStore` per (workspace, stateDir).** The store has no internal
 *     mutex and its paths are derived from its constructor, so handing the same
 *     pair the same instance keeps every lock key (`store.lockKey(id)`) and every
 *     on-disk path stable across tool calls. Store diagnostics flow to the plugin
 *     logger instead of vanishing: a corrupt mailbox line and a failed atomic
 *     rename are both things the user should be able to see.
 *
 * Session events are deliberately **not** written by this plugin.
 *
 * An out-of-repo plugin cannot append a custom session-event type: the
 * persistence read path refuses a log containing a type outside the harness's
 * known set *unless the event carries the envelope's `ignorable` marker*, and
 * `Session.append` offers no way to set that marker. Appending `code-factory/*`
 * therefore made every session that used this plugin unreadable
 * (`session contains event type "code-factory/planned" … refusing to interpret
 * the log`). The durable truth is the factory directory
 * (`factory.json` / `artifacts.json` / `inbox/*.jsonl`), the harness records
 * `tool/call` + `tool/result` for every `factory_*` call itself, and the cockpit
 * feed is projected from the mailbox — nothing here needs a session event.
 *
 * @module dsh-code-factory/tools/context
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { FactoryState, LessonRecord } from '../shared/types.js';
import { FactoryStore } from '../store/store.js';
/** Default feed bound handed to `ctx`-level configuration (`Config.feedLimit`). */
export declare const DEFAULT_TOOL_FEED_LIMIT = 12;
/**
 * A tool-level refusal: the arguments, the factory id or the caller's authority
 * did not hold. Thrown out of `execute`, where the registry turns it into the
 * model-visible error text — the message is written for the model to act on, not
 * for a log reader (it always says what to do next).
 */
export declare class FactoryToolError extends Error {
    constructor(message: string);
}
/**
 * Everything a tool needs that comes from the plugin entry rather than from the
 * call: the resolved `Config` plus the plugin context (used for `subagents`,
 * `agents`, logging and the gate executor's `subprocess` lookup).
 */
export interface FactoryToolConfig {
    /** The plugin context `apply()` received. */
    readonly ctx: Context;
    /** State directory leaf under the workspace (`.code-factory` by default). */
    readonly stateDir: string;
    /** `ctx.subagents` provider name used for member spawns (`spawn` / `fork`). */
    readonly memberProvider: string;
    /** Member-relative descendant budget; `0` means members may not delegate. */
    readonly memberMaxDepth: number;
    /** Roster cap used when a tool call does not supply one. */
    readonly maxMembers: number;
    /** How many mailbox messages a status/feed projection keeps. */
    readonly feedLimit: number;
    /**
     * Allow the node fallback executor when `ctx.subprocess` is unavailable.
     * Default `false`: a gate that cannot run a template command reports a refusal
     * (never a pass), which is the honest outcome; a composition that wants gates to
     * work without a subprocess service opts in explicitly.
     */
    readonly allowNodeFallback: boolean;
    /**
     * Root of the **global** reuse library (`<dir>/index.json` + `<dir>/entries/…`).
     *
     * Optional so offline tool contexts / fake hosts stay source-compatible; when
     * omitted the engine falls back to `defaultReuseLibraryDir()` (DSH_HOME or the
     * OS home directory + `code-factory-library`). The plugin entry passes the
     * resolved `config.libraryDir` here.
     */
    readonly libraryDir?: string;
}
/** Everything one tool call resolves once, before any I/O. */
export interface ToolCallContext {
    /** The exact live calling agent (captain or member). */
    readonly caller: Agent;
    /** `String(caller.id)` — the session id as the durable records store it. */
    readonly callerId: string;
    /** Absolute workspace root: `caller.session.header.cwd`. */
    readonly workspace: string;
    /** Store bound to `<workspace>/<stateDir>`. */
    readonly store: FactoryStore;
    /** Caller cancellation, forwarded to every spawn / delivery / command. */
    readonly signal: AbortSignal;
    /** The plugin context (services + logger). */
    readonly plugin: Context;
    /** Resolved plugin configuration. */
    readonly config: FactoryToolConfig;
}
/** The caller's workspace root, or a loud failure (never `process.cwd()`). */
export declare function workspaceOf(caller: Agent): string;
/**
 * Resolves one tool call into its execution context.
 *
 * @param exec - the registry's run context (identity, caller, signal).
 * @param config - the resolved plugin configuration.
 * @returns the context every engine function takes.
 * @throws FactoryToolError when there is no calling agent or no usable workspace.
 */
export declare function resolveToolCall(exec: ToolRunContext, config: FactoryToolConfig): ToolCallContext;
/** Validates a model-supplied factory id, refusing anything path-shaped. */
export declare function requireFactoryId(raw: unknown): string;
/** Loads one factory record or explains what to do instead. */
export declare function loadFactory(call: ToolCallContext, factoryId: string): Promise<FactoryState>;
/** Refuses a call whose caller is not the factory's captain. */
export declare function requireCaptainOf(call: ToolCallContext, state: FactoryState): void;
/**
 * Reads the workspace evolution ledger once, degrading to `[]` on any failure.
 *
 * Callers that inject lessons (approve / dispatch / rework / plan) read the
 * ledger through this helper so a corrupt `evolution.json` can never turn a
 * dispatch into an error: the history block is an optimisation for the members,
 * not a precondition for the pipeline.
 *
 * @param call - the resolved tool call (carries the store and the logger).
 * @returns the ledger rows in the store's deterministic order, or `[]`.
 */
export declare function readEvolutionLessons(call: ToolCallContext): Promise<readonly LessonRecord[]>;
/**
 * Read-modify-write under the factory lock, returning the record that was saved.
 *
 * Uses {@link FactoryStore.withLock}, which orders the tasks of this process
 * *and* takes the on-disk lock, so a second host on the same workspace cannot
 * interleave its own read-modify-write with ours and silently drop one of the
 * two transitions.
 */
export declare function mutateFactory<T>(call: ToolCallContext, factoryId: string, fn: (state: FactoryState) => T | Promise<T>): Promise<{
    readonly value: T;
    readonly state: FactoryState;
}>;
/** Logs through the plugin context; never throws, whatever the logger does. */
export declare function logLine(ctx: Context, level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
/** Pretty JSON of any tool result, tolerating values without a JSON form. */
export declare function jsonText(value: unknown): string;
/**
 * The `ContentBlock[]` every tool's `output.render` returns: one text block with
 * a human-readable head line followed by the canonical value as pretty JSON, so
 * the model can read the verdict and still see every structured field.
 */
export declare function renderToolResult(head: string, value: unknown): ContentBlock[];
