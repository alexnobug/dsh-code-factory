/**
 * `src/runtime` barrel — the whole non-tool host runtime in one import.
 *
 * Layer map (实施方案 §4.2, adapted to the modules that actually exist):
 *
 * | module | role | side effects |
 * |---|---|---|
 * | `compat.ts` | version seam for `ctx.subagents` (delivery / interrupt / drain / registry view / depth guard) | only inside the guard installer |
 * | `provider-guard.ts` | provider existence + `prepareContinuable` preflight | none |
 * | `tool-surface.ts` | member tool surface + name-liveness checks | none |
 * | `members.ts` | member lifecycle: spawn → deliver → interrupt → drain | spawns agents, mutates the record handed in |
 * | `tokens.ts` | `member.tokens` 的真实来源：把宿主 `sessionQuery` 的会话日志折成用量 | reads session logs via `ctx.get("sessionQuery")` |
 * | `commands.ts` | command executor over `ctx.subprocess` (+ opt-in node fallback) | starts processes |
 * | `gates-runner.ts` | gate/DoD **execution**; the domain keeps the verdict | starts processes, reads artifacts |
 * | `scheduler.ts` | stage dispatch planning (pure) + apply | dispatches members |
 * | `testing.ts` | offline harness surface: fake host model (residency + durable catalog), recording logger, recorded subprocess double, `ToolCallContext` factory | none |
 *
 * Nothing here registers tools, routes or prompt sections — that is `apply()`'s
 * job in `src/index.ts`.
 *
 * @module dsh-code-factory/runtime
 */
export * from './compat.js';
export * from './provider-guard.js';
export * from './tool-surface.js';
export * from './members.js';
export * from './tokens.js';
export * from './commands.js';
export * from './gates-runner.js';
export * from './scheduler.js';
// Offline test model, exported on purpose: whoever writes the next scheduler
// harness must find it instead of hand-rolling a probe that classifies every
// member — including a just-spawned one — as stranded. The same surface also
// carries `createFakeLogger`, `createFakeSubprocess` and `createToolCallContext`,
// so a *tool* harness never has to rediscover the `signal` /
// `session.header.cwd` invariants by crashing.
export * from './testing.js';
//# sourceMappingURL=index.js.map