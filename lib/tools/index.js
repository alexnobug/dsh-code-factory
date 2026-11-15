/**
 * `src/tools` barrel — the plugin's entire model-facing surface, in one import.
 *
 * | module | what it owns |
 * |---|---|
 * | `context.ts` | one call's execution context: caller, `caller.session.header.cwd`, the per-workspace `FactoryStore`, the session-event bridge, and the shared result renderer |
 * | `engine.ts`  | the orchestration operations (plan / approve / dispatch / gate / status / message / DoD / halt / resume / deliver / delete + the member actions) |
 * | `captain.ts` | the 13 captain tool definitions |
 * | `member.ts`  | the 3 member tool definitions |
 *
 * {@link registerFactoryTools} is the only entry the plugin `apply()` calls, and
 * the order is deliberate: **member tools first**. `runtime/tool-surface`
 * validates that `factory_report` / `factory_inbox` / `factory_block` are in the
 * live registry *before* the first `startActivation`; registering them last would
 * open a window where every spawn fails.
 *
 * @module dsh-code-factory/tools
 */
import { registerFactoryCaptainTools } from './captain.js';
import { registerFactoryMemberTools } from './member.js';
export * from './context.js';
export * from './engine.js';
export { CAPTAIN_TOOL_ORDER, registerFactoryCaptainTools } from './captain.js';
export { MEMBER_TOOL_NAMES, registerFactoryMemberTools } from './member.js';
/**
 * Registers all 16 `factory_*` tools (3 member + 13 captain).
 *
 * Every definition is registered through `ctx.effect(...)` inside the two
 * register functions, so an HMR reload or a plugin unload removes exactly the
 * definitions this activation added (API-CONTRACTS §1.1).
 *
 * @param ctx - host context with the `tools` service injected.
 * @param config - resolved plugin configuration.
 */
export function registerFactoryTools(ctx, config) {
    registerFactoryMemberTools(ctx, config);
    registerFactoryCaptainTools(ctx, config);
}
//# sourceMappingURL=index.js.map