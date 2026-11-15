/**
 * captain.ts — the **13 captain tools** (`factory_*`), as `defineTool` definitions.
 *
 * These are thin adapters: every one of them resolves the shared call context
 * (`context.ts`) and hands its arguments to one engine operation (`engine.ts`),
 * then returns that operation's result. Keeping the definitions thin is what lets
 * the engine be exercised offline (see `scripts/verify.mjs`'s siblings and the
 * harness used while implementing this task) and keeps the model-facing schema
 * honest — the declared `output.schema` mirrors the engine's result interface, so
 * `tsc` fails if a field is added or renamed on one side only.
 *
 * Contract notes (API-CONTRACTS §1.2):
 *  - `parameters` / `output.schema` use the tool DSL, **not** schemastery and not
 *    raw JSON Schema. Requiredness is the per-property `required: true`
 *    annotation; an optional property simply omits it.
 *  - `output` is mandatory, and `render` returns `ContentBlock[]`.
 *  - `execute` throws `FactoryToolError` for a refusal (unknown factory id, wrong
 *    phase, missing approval): the registry turns it into the model-visible error
 *    text, which is written to say what to do next.
 *
 * Registration order: the member tools are registered first (see
 * `tools/index.ts`), because `runtime/tool-surface` validates that
 * `factory_report` / `factory_inbox` / `factory_block` exist **before** the first
 * member spawn.
 *
 * @module dsh-code-factory/tools/captain
 */
import type { Context } from '@deepseek-ai/cordis';
import { type FactoryToolConfig } from './context.js';
/**
 * The captain tool names, in registration order — an alias of
 * {@link CAPTAIN_TOOL_NAMES} in `runtime/tool-surface.ts`, which is the **single
 * source of truth** for the captain tool set (review finding M14).
 *
 * It stays a separate exported *name* only because the registration order is the
 * thing worth asserting: the `effect(...)` calls below pass exactly these names,
 * in exactly this order, so an offline check can compare the two without a live
 * registry (`runtime/tool-surface` owns the *policy* side — what a member may
 * see; `MEMBER_TOOL_NAMES` in `member.ts` is the member-facing counterpart).
 *
 * Never re-fork this into its own literal: a literal that drifts from the policy
 * list drops a captain tool out of the member deny-filter **silently** — the
 * spawn still succeeds and the tool stays callable by members. See the M14 note
 * on `CAPTAIN_TOOL_NAMES` for the full failure mode.
 */
export declare const CAPTAIN_TOOL_ORDER: readonly string[];
/**
 * Registers the 13 captain tools into the shared registry.
 *
 * Every registration is wrapped in `ctx.effect(...)`, so an HMR reload or a
 * plugin unload removes exactly the definitions it added (API-CONTRACTS §1.1).
 *
 * @param ctx - host context with the `tools` service injected.
 * @param config - resolved plugin configuration (state dir, provider, cap, …).
 */
export declare function registerFactoryCaptainTools(ctx: Context, config: FactoryToolConfig): void;
