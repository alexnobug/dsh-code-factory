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
import path from 'node:path';
import { FactoryStore, isSafeFactoryId } from '../store/store.js';
/* --------------------------------------------------------------- constants */
/** Default feed bound handed to `ctx`-level configuration (`Config.feedLimit`). */
export const DEFAULT_TOOL_FEED_LIMIT = 12;
/* ------------------------------------------------------------------ errors */
/**
 * A tool-level refusal: the arguments, the factory id or the caller's authority
 * did not hold. Thrown out of `execute`, where the registry turns it into the
 * model-visible error text — the message is written for the model to act on, not
 * for a log reader (it always says what to do next).
 */
export class FactoryToolError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FactoryToolError';
    }
}
/** One `FactoryStore` per workspace + state directory, for the whole process. */
const STORES = new Map();
function storeFor(workspace, config) {
    const key = `${workspace}\u0000${config.stateDir}`;
    const existing = STORES.get(key);
    if (existing !== undefined)
        return existing;
    const store = new FactoryStore({
        workspace,
        stateDir: config.stateDir,
        onWarning: (warning) => logLine(config.ctx, 'warn', `${warning.code}: ${warning.message}`),
        onMalformedLine: (info) => logLine(config.ctx, 'warn', `跳过一个损坏的邮箱行 ${info.file}:${info.line} —— ${info.error}`),
    });
    STORES.set(key, store);
    return store;
}
/** The caller's workspace root, or a loud failure (never `process.cwd()`). */
export function workspaceOf(caller) {
    const raw = caller.session.header.cwd;
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new FactoryToolError('code-factory: 当前会话没有工作区目录（session.header.cwd 为空）—— code-factory 不会退回到 process.cwd()，'
            + '否则会把别的会话的工厂当成自己的。请在带工作区的会话里调用，或先设置会话工作区。');
    }
    const trimmed = raw.trim();
    if (!path.isAbsolute(trimmed)) {
        throw new FactoryToolError(`code-factory: 会话工作区必须是绝对路径，实际是 ${JSON.stringify(trimmed)} —— `
            + '相对路径会让插件用 process.cwd() 解释它，从而读错工作区。');
    }
    return trimmed;
}
/**
 * Resolves one tool call into its execution context.
 *
 * @param exec - the registry's run context (identity, caller, signal).
 * @param config - the resolved plugin configuration.
 * @returns the context every engine function takes.
 * @throws FactoryToolError when there is no calling agent or no usable workspace.
 */
export function resolveToolCall(exec, config) {
    const caller = exec.agent;
    if (caller === undefined) {
        throw new FactoryToolError('code-factory: 该工具必须由 Agent 调用（exec.agent 为空）—— 它需要一个会话作为队长/成员身份来定位工厂状态。');
    }
    const workspace = workspaceOf(caller);
    return {
        caller,
        callerId: String(caller.id),
        workspace,
        store: storeFor(workspace, config),
        signal: exec.signal,
        plugin: config.ctx,
        config,
    };
}
/* ------------------------------------------------------------------- ids */
/** Validates a model-supplied factory id, refusing anything path-shaped. */
export function requireFactoryId(raw) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') {
        throw new FactoryToolError('code-factory: 缺少 factoryId —— 先调用 factory_status（不带参数）列出本工作区的工厂，再把返回的 id 传进来。');
    }
    if (!isSafeFactoryId(value)) {
        throw new FactoryToolError(`code-factory: factoryId ${JSON.stringify(value)} 非法（只允许字母/数字/连字符，长度 1..64，首尾必须是字母或数字）。`);
    }
    return value;
}
/** Loads one factory record or explains what to do instead. */
export async function loadFactory(call, factoryId) {
    const state = await call.store.load(factoryId);
    if (state === undefined) {
        const known = await call.store.list();
        const ids = known.slice(0, 8).map((row) => `${row.id}(${row.phase})`);
        throw new FactoryToolError(`code-factory: 工作区 ${call.workspace} 下没有工厂 ${factoryId}。`
            + (ids.length > 0 ? ` 已知工厂: ${ids.join('、')}` : ' 当前没有任何工厂，先调用 factory_plan。'));
    }
    return state;
}
/** Refuses a call whose caller is not the factory's captain. */
export function requireCaptainOf(call, state) {
    if (state.captainSessionId !== call.callerId) {
        throw new FactoryToolError(`code-factory: 只有工厂 ${state.id} 的队长（会话 ${state.captainSessionId}）能执行这个操作，`
            + `当前会话是 ${call.callerId}。队长职责请交回原会话，或让原队长用 factory_delete 结束它。`);
    }
}
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
export async function readEvolutionLessons(call) {
    try {
        return await call.store.evolution.read();
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logLine(call.plugin, 'warn', `读取进化教训库失败（按无历史教训继续）: ${detail}`);
        return [];
    }
}
/**
 * Read-modify-write under the factory lock, returning the record that was saved.
 *
 * Uses {@link FactoryStore.withLock}, which orders the tasks of this process
 * *and* takes the on-disk lock, so a second host on the same workspace cannot
 * interleave its own read-modify-write with ours and silently drop one of the
 * two transitions.
 */
export async function mutateFactory(call, factoryId, fn) {
    return await call.store.withLock(factoryId, async () => {
        const state = await call.store.loadOrThrow(factoryId);
        const value = await fn(state);
        state.updatedAt = call.store.now();
        await call.store.save(state, { touch: false });
        return { value, state };
    });
}
/* ------------------------------------------------------------ diagnostics */
/** Logs through the plugin context; never throws, whatever the logger does. */
export function logLine(ctx, level, message) {
    try {
        ctx.logger[level](`[code-factory] ${message}`);
    }
    catch {
        /* diagnostics must never break a tool call */
    }
}
/* ------------------------------------------------------- result rendering */
/** Pretty JSON of any tool result, tolerating values without a JSON form. */
export function jsonText(value) {
    try {
        const text = JSON.stringify(value, null, 2);
        return text === undefined ? String(value) : text;
    }
    catch {
        return String(value);
    }
}
/**
 * The `ContentBlock[]` every tool's `output.render` returns: one text block with
 * a human-readable head line followed by the canonical value as pretty JSON, so
 * the model can read the verdict and still see every structured field.
 */
export function renderToolResult(head, value) {
    const trimmed = head.trim();
    return [{ type: 'text', text: trimmed === '' ? jsonText(value) : `${trimmed}\n\n${jsonText(value)}` }];
}
//# sourceMappingURL=context.js.map