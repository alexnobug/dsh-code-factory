/**
 * member.ts — the **3 member tools** (`factory_report` / `factory_inbox` /
 * `factory_block`), as `defineTool` definitions.
 *
 * These are the member-facing factory tools. On DSH 0.2.2 the captain tools are
 * hidden from delegated agents by step-admission conditions (`tools.register(...,
 * { when })` in `tools/captain.ts`), while the spawn preflight refuses to create
 * a member before all three of these exist. That is the tool half of the depth-0
 * rule — a member works, reports and escalates, and never adjudicates. The
 * historical `toolFilter` list is still computed as an audit/preflight guard for
 * older hosts, but it is not sent on the 0.2.2 flat start spec.
 *
 * Identity is derived, never claimed: a member tool finds the factory by looking
 * for the calling session id in `members[].sessionId`, so a captain session that
 * calls `factory_report` gets a refusal telling it to use `factory_status`
 * instead of silently writing into someone else's roster row.
 *
 * @module dsh-code-factory/tools/member
 */
import type { Context } from '@deepseek-ai/cordis';
import { type FactoryToolConfig } from './context.js';
/**
 * The three member tools, in registration order — an alias of
 * {@link MEMBER_BASE_TOOL_NAMES} in `runtime/tool-surface.ts`, which is the
 * **single source of truth** for the member tool set (review finding M14).
 *
 * The same array is what the spawn preflight validates against the live
 * registry, so this name must stay an alias and never be re-forked into a
 * literal: a name listed here but not registered makes every member spawn fail
 * its preflight, and a name registered but missing from the list stays reachable
 * for members.
 */
export declare const MEMBER_TOOL_NAMES: readonly string[];
/**
 * Registers the 3 member tools into the shared registry.
 *
 * Called before the captain tools (`tools/index.ts`): the spawn preflight in
 * `runtime/tool-surface` checks these names against the live registry, so they
 * must be registered in the same activation that will spawn members.
 *
 * @param ctx - host context with the `tools` service injected.
 * @param config - resolved plugin configuration.
 */
export declare function registerFactoryMemberTools(ctx: Context, config: FactoryToolConfig): void;
