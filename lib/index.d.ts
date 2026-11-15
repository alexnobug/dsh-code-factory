/**
 * dsh-code-factory — the plugin entry: **Agent Forge** 的 DSH 落地。
 *
 * A host-plane bundle plugin that turns one session into a multi-agent software
 * factory. The captain (the session's own agent) routes a brief to a task family,
 * assembles a roster, drives a 10-stage pipeline of durable sub-agent members,
 * adjudicates stage gates against real evidence (files, exit codes, git facts),
 * bounces work back along `failGoto` with a written corrective list, and finally
 * runs the 7-item Definition of Done before delivering.
 *
 * ## Activation order (deliberate)
 *
 *   1. **system prompt section** — the captain protocol, at order 118 (after the
 *      delegation-policy section at 117). Registering it first means the very
 *      first model request of a session already carries the two-phase staged
 *      protocol.
 *   2. **tools** — the 3 member tools before the 13 captain tools
 *      (`tools/index.ts`): `runtime/tool-surface` validates the member surface
 *      *before* the first spawn, so the window must not exist.
 *      The parent-chain delegation guard is installed here too: it is the
 *      defence-in-depth half of "members may not spawn subagents".
 *   3. **Web route** — the cockpit's single read-only data channel
 *      (`/plugins/code-factory/state`, API-CONTRACTS §7), mounted **only when this
 *      composition has a browser carrier** (`webServer` / `httpServer`, resolved
 *      defensively). The carrier is web-profile-only, so it is not injected; a
 *      headless composition keeps the whole tool surface and simply has no panel
 *      to poll. See {@link mountWebSurface} for the full rule.
 *   4. **slash command** — `/<factory>`, the deterministic activation surface
 *      (`src/command.ts`, frozen interface), registered through `ctx.inject` so a
 *      minimal composition without a command registry stays fully functional.
 *
 * Every registration goes through `ctx.effect(...)`, so HMR and plugin unload tear
 * down exactly what was added.
 *
 * ## Portable activation (the rule this file exists to keep)
 *
 * `inject` lists only the services the **tool surface** cannot work without
 * (`tools`, `subagents`, `systemPrompt`, `agents`). Everything that belongs to one
 * *host surface* — the browser carrier, the command registry, the workspace
 * registry — is resolved defensively and degrades instead of blocking. A plugin
 * that pends on `webServer` does not activate at all in a headless profile: the
 * observed failure was `code-factory (dsh-code-factory): pending (waiting for
 * service: webServer)` with **zero** `factory_*` tools registered. Web-only
 * features may go missing; the tool surface may not.
 *
 * ## What is NOT here
 *
 * No business logic: the domain layer (`src/domain`) owns the rules, the store
 * (`src/store`) owns durability, the runtime (`src/runtime`) owns member lifecycle
 * and gate execution, and `src/tools` owns the model-facing surface. This file
 * wires them together and resolves configuration.
 *
 * @module dsh-code-factory
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Plugin name (`cordis.patch.yml` mounts the package name `dsh-code-factory`). */
export declare const name = "code-factory";
/**
 * Bare service keys this plugin needs **before it can do anything useful**.
 *
 * Only services the tool surface cannot work without are listed. Everything that
 * belongs to one host surface stays out and is resolved defensively instead:
 *
 * | key | why it is not injected |
 * |---|---|
 * | `webServer` / `httpServer` | web-profile-only browser carrier. Injecting it made the plugin `pending (waiting for service: webServer)` in every headless/tui composition — tools and all. See {@link mountWebSurface}. |
 * | `commands` | the slash command is a convenience surface; it is registered through `ctx.inject` so a composition without the command registry still gets the tools. |
 * | `workspaceRegistry` | read defensively inside `src/web/routes.ts` (discovered workspaces + live agent cwd). |
 * | `sessions` | never read: the plugin reaches the log through `exec.agent.session` (the calling agent's own session), so injecting it would only add a blocking dependency. |
 *
 * `agents` stays: `runtime/members.ts` uses it for the live liveness probe, and
 * every composition that can run a factory already has an agent registry.
 */
export declare const inject: readonly ["tools", "subagents", "systemPrompt", "agents"];
/**
 * Plugin configuration.
 *
 * Declared as an interface (all fields optional) **and** exported as a
 * schemastery value under the same name — the shape the reference plugin
 * `@nanmicoder/dsh-agent-teams` uses, and the one the loader expects: the type
 * gives `apply()` precise fields, the value validates/coerces the patch.
 * `apply()` still resolves every default itself, so a patch that omits a field
 * (or a composition that passes the raw row config) behaves identically.
 */
export interface Config {
    /** State directory leaf under `<session workspace>/` (default `.code-factory`). */
    stateDir?: string;
    /**
     * Root of the **global** cross-project reuse library.
     *
     * Defaults to `path.join(process.env.DSH_HOME || os.homedir(), 'code-factory-library')`
     * (resolved in `apply()`); a relative value is resolved by the library itself.
     * The library is shared by every workspace/profile of this user, which is what
     * makes assets reusable *across* projects.
     */
    libraryDir?: string;
    /** `ctx.subagents` provider used to spawn members (`spawn` / `fork`). */
    memberProvider?: string;
    /**
     * Member-relative descendant budget. `0` (default) = members may not delegate.
     *
     * Implemented by step-admission conditions that hide captain factory tools
     * from delegated agents, plus the parent-chain guard below — **not** by
     * `maxDepth`, which cannot express it: `maxDepth: 0` rejects the member itself
     * (a captain at depth 0 has depth-1 children) and is not inherited by later
     * delegations. Delegation-shaped tools come from the host preset; the guard
     * refuses their calls from inside a factory tree.
     */
    memberMaxDepth?: number;
    /** Roster cap; the iron triangle (`pm` + `qa` + one `*_dev`) is never trimmed. */
    maxMembers?: number;
    /** System-prompt section order (default 118 — right after the delegation policy). */
    promptSectionOrder?: number;
    /** Register the deterministic `/<factory>` activation command. */
    slashCommand?: boolean;
    /** How many mailbox messages a `factory_status` feed keeps. */
    feedLimit?: number;
    /**
     * Allow the node fallback command executor when `ctx.subprocess` is missing.
     * Default `false`: without an executor a `script` gate reports a refusal, never
     * a pass — a gate may not pass on evidence that does not exist.
     */
    allowNodeFallback?: boolean;
}
/** Schemastery schema for {@link Config}. */
export declare const Config: z<Config>;
/**
 * Mounts the plugin.
 *
 * @param ctx - host context (injects `tools`, `subagents`, `systemPrompt`,
 *   `agents`; the browser carrier and the command registry are optional and are
 *   resolved defensively).
 * @param config - validated configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
