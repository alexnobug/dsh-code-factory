/**
 * testing.ts — the **offline fake-host model** for `runtime/scheduler.ts`, as
 * executable documentation.
 *
 * ## Why this file exists
 *
 * The scheduler decides "is this member stranded?" from one probe:
 * `ctx.agents.get(sessionId)` — `undefined` means **no executor is running this
 * member right now**, which is the only state in which re-dispatching a fresh
 * attempt cannot duplicate work (see the `scheduler.ts` header for the evidence
 * chain). Any offline test of that rule therefore needs a fake host that can
 * answer the probe *truthfully*. A hand-rolled host that answers a constant
 * `undefined` cannot, and it fails in a way that looks like a scheduler bug:
 *
 * > **The false-`gone` mechanism.** A `startActivation` that returns a child id
 * > but never registers an Agent makes the *just-spawned* member look `gone` to
 * > the very next plan. The planner then (correctly, given its input) emits a
 * > **stranded recovery** — a fresh attempt with `consumesAttempt: true` —
 * > where the test expected `wait`. In t20/t21 this is exactly what turned
 * > assertions like *"a freshly spawned member is not re-dispatched"* red: the
 * > defect was in the fake host, not in the scheduler.
 *
 * So a fake host must model **residency**, and it must model it with the same
 * lifecycle the real service has:
 *
 * | test operation | what the real host does | what the fake must do |
 * |---|---|---|
 * | {@link FakeMemberHost.spawnChild} / a successful `startActivation` | `ctx.agents.create()` publishes the child Agent, so `agents.get(id)` resolves | **register** the id with a live status |
 * | {@link FakeMemberHost.drainChild} / `drainChildren` | releases the Activation; the durable session survives | **unregister** the id (catalog row stays) |
 * | {@link FakeMemberHost.killSession} / {@link FakeMemberHost.killAllSessions} | a host restart: no Activation survives, the session is still on disk | **unregister** the id — *only this* should emulate a cold start |
 *
 * Residency and durability are two different questions and this model keeps them
 * apart: `agents` answers "is somebody executing it?" (the liveness probe) while
 * `catalog` answers "does the durable child still exist?" (what
 * `members.reconcileMembers` reads through `listChildren`). A cold restart clears
 * the former and keeps the latter — modelling that as "everything is gone" is the
 * mistake this file prevents.
 *
 * ## Assertions that depend on it
 *
 * - *"a live executor is never re-dispatched"*: spawn a member, let the host
 *   register it, plan again → `wait`, `dispatches.length === 0`. Without
 *   registration this assertion fails with a spurious recovery.
 * - *"a gone executor is re-dispatched with a fresh attempt"*: `killSession(id)`
 *   (or `killAllSessions()`), plan again → a recovery decision with
 *   `consumesAttempt: true` and `stages[].attempts` +1. Without the registry the
 *   two cases are indistinguishable, so neither assertion means anything.
 * - *"once the executor is back the recovery stops"*: deliver a turn and let the
 *   fake mark the child `running` again → the next plan returns to `wait`.
 *
 * ## Usage
 *
 * ```ts
 * import { createFakeMemberHost } from 'dsh-code-factory/lib/runtime/testing.js'
 * import { planStageDispatch } from 'dsh-code-factory/lib/runtime/scheduler.js'
 *
 * const host = createFakeMemberHost()
 * await host.ctx.subagents.startActivation({ provider: 'spawn', label: 'PM', request: {}, signal, delivery: 'parent' })
 * const plan = planStageDispatch({ state, now: Date.now(), attempts: [], ...host.probes })
 * // host.calls.delivered / host.calls.startActivation / host.isResident(id) for assertions
 * ```
 *
 * The two failure modes worth testing against are available as options
 * ({@link FakeMemberHostOptions.withoutAgentRegistry} → the probe answers
 * `unknown`; {@link FakeMemberHostOptions.forgetEverySession} → every member looks
 * `gone`), so a suite can assert the *difference* instead of guessing at it.
 *
 * ## What a harness additionally needs (the two seams that used to be missing)
 *
 * Faking the agent services is not enough to drive a `factory_*` handler or a
 * gate, and a hand-rolled host used to hit two failures that look like product
 * bugs until you read the host's source:
 *
 * 1. **A tool call context.** Every handler takes a {@link ToolCallContext}, and
 *    building one by hand requires knowing that a spawn path dereferences the
 *    caller's `signal` (omitting it dies with `TypeError: Cannot read properties
 *    of undefined (reading 'aborted')`) and that the workspace is
 *    `caller.session.header.cwd`, which `workspaceOf` never falls back to
 *    `process.cwd()` for. {@link createToolCallContext} fills in both invariants
 *    instead of leaving them to be discovered by crashing.
 * 2. **A logger and a subprocess service.** Without `ctx.logger`, `logLine`
 *    swallows diagnostics and *"this warning was logged"* is untestable; without
 *    `ctx.subprocess`, anything that reaches the gate runner must hand-roll an
 *    executor. {@link createFakeMemberHost} now installs a **recording** logger
 *    and can install a **recorded** subprocess double
 *    ({@link FakeMemberHostOptions.subprocess}), and {@link createFakeSubprocess}
 *    builds the same double for a composition that wants the service without the
 *    fake agent registry.
 *
 * This module performs no I/O of its own (it never reads, writes or spawns
 * anything), never touches a real host, and is safe to import from any host-side
 * test or diagnostic. The file system comes in only as a path *test* —
 * `path.isAbsolute` for the workspace invariant.
 *
 * @module dsh-code-factory/runtime/testing
 */
import path from 'node:path';
import { DEFAULT_TOOL_FEED_LIMIT } from '../tools/context.js';
import { DEFAULT_MAX_MEMBERS } from '../domain/router.js';
import { DEFAULT_MEMBER_PROVIDER } from './provider-guard.js';
import { MEMBER_BASE_TOOL_NAMES, CAPTAIN_TOOL_NAMES } from './tool-surface.js';
/* ------------------------------------------------------- the two services */
/** The four severity methods every logger façade carries, in `LoggerType` order. */
const LOG_LEVELS = ['error', 'info', 'warn', 'debug'];
/** Formats one log argument the way a `printf`-style sink would print it. */
function formatLogArgument(value) {
    if (typeof value === 'string')
        return value;
    if (value instanceof Error)
        return value.message;
    try {
        const text = JSON.stringify(value);
        return text === undefined ? String(value) : text;
    }
    catch {
        return String(value);
    }
}
/**
 * Builds a `ctx.logger` that records every line instead of dropping it.
 *
 * The returned value keeps the real service's two calling conventions — it is
 * itself a {@link LoggerService} (`logger.warn('...')` logs on the root) and
 * calling it creates a named child (`logger('store').warn('...')`, whose records
 * carry the name in {@link FakeLogRecord.scopes}). Root and children share one
 * `messages` array, so a test never has to know which façade a diagnostic came
 * through — only the scope differs.
 *
 * @param name - the root logger name (informational; it is not part of the record).
 * @returns the recording logger, with its `messages` array ready to assert on.
 */
export function createFakeLogger(name = 'test') {
    const messages = [];
    const build = (scopes) => {
        const write = (level) => (...args) => {
            messages.push({ level, text: args.map(formatLogArgument).join(' '), scopes });
        };
        const facade = ((childName) => {
            if (childName === undefined)
                return facade;
            return build([...scopes, childName]);
        });
        Object.defineProperty(facade, 'name', { value: name, enumerable: true });
        Object.defineProperty(facade, 'messages', { value: messages, enumerable: true });
        facade.recordsAt = (level) => messages.filter((entry) => entry.level === level);
        facade.text = () => messages.map((entry) => `${entry.level}: ${entry.text}`).join('\n');
        facade.has = (needle) => messages.some((entry) => entry.text.includes(needle));
        facade.reset = () => {
            messages.length = 0;
        };
        for (const level of LOG_LEVELS)
            facade[level] = write(level);
        return facade;
    };
    return build([]);
}
/** The reader the double exposes for one collected stream. */
function fakeOutputReader(text) {
    return {
        readFrom: (fromByte) => ({
            text: fromByte >= text.length ? '' : text.slice(fromByte),
            nextOffset: text.length,
            lossy: false,
        }),
    };
}
/**
 * Builds a **recorded, process-free** `ctx.subprocess` double.
 *
 * Every `spawn` is recorded before it is answered, so a test can assert both
 * questions separately: *what was invoked* ({@link FakeSubprocessDouble.specs} —
 * argv, cwd, the caller's signal, stdio bounds) and *what the caller did with
 * the answer* ({@link FakeSubprocessDouble.calls} — the reported exit code, plus
 * whether the caller terminated or awaited the handle).
 *
 * @param behaviour - decides the answer for one spec; defaults to a clean
 *   `exitCode: 0` with no output, which is the least surprising default for a
 *   gate that only needs "the command ran and succeeded".
 * @returns the double, ready to spread into a context as `ctx.subprocess`.
 */
export function createFakeSubprocess(behaviour = () => ({ exitCode: 0 })) {
    const calls = [];
    const spawn = (spec) => {
        const result = behaviour(spec);
        const record = { spec, result, terminated: false, waitedForExit: false };
        calls.push(record);
        const stdout = result.stdout ?? '';
        const stderr = result.stderr ?? '';
        let settled = false;
        const done = Promise.resolve({
            exitCode: result.exitCode,
            signal: result.signal ?? null,
        });
        return {
            collected: {
                stdout: fakeOutputReader(stdout),
                stderr: fakeOutputReader(stderr),
            },
            done: done.then((outcome) => {
                settled = true;
                return outcome;
            }),
            terminate() {
                record.terminated = true;
            },
            async waitForExit() {
                record.waitedForExit = true;
                return settled;
            },
        };
    };
    return {
        resolveExecutable: async (command) => command,
        spawn,
        calls,
        get specs() {
            return calls.map((record) => record.spec);
        },
        reset() {
            calls.length = 0;
        },
    };
}
/* ----------------------------------------------------------- the model */
/** Default child-id allocator: `child-1`, `child-2`, … */
function defaultChildIds() {
    let index = 0;
    return () => {
        index += 1;
        return `child-${index}`;
    };
}
const DEFAULT_TOOLS = [...MEMBER_BASE_TOOL_NAMES, ...CAPTAIN_TOOL_NAMES, 'read', 'write', 'pwsh'];
/**
 * Builds a fake host that models agent residency and the durable catalog, plus
 * the two services a handler reaches for by other means: a **recording**
 * `ctx.logger` and, on request, a **recorded** `ctx.subprocess`.
 *
 * @param options - provider name, failure injection, the two deliberate
 *   anti-models (`withoutAgentRegistry`, `forgetEverySession`), the logger and
 *   the optional subprocess double.
 * @returns the host, its recorded calls, its logger, and its probes.
 */
export function createFakeMemberHost(options = {}) {
    const providerName = options.provider ?? 'spawn';
    const nextChildId = options.nextChildId ?? defaultChildIds();
    const registeredTools = new Set(options.registeredTools ?? DEFAULT_TOOLS);
    const agents = new Map();
    const catalog = new Map();
    const calls = {
        startActivation: [],
        delivered: [],
        interrupted: [],
        drained: [],
        catalogReads: 0,
    };
    const spawnChild = (childId, status = 'idle', label = 'member') => {
        agents.set(childId, { id: childId, status });
        if (!catalog.has(childId)) {
            catalog.set(childId, { id: childId, label, mode: 'continuable', createdAt: Date.now() });
        }
    };
    const symbols = { deliver: Symbol.for('dsh.subagent.deliverPrompt') };
    const deliver = async (_parent, childId, content, _source, _signal, mode) => {
        if (options.deliveryError !== undefined)
            throw options.deliveryError;
        calls.delivered.push({
            childId,
            mode,
            text: content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
        });
        // Accepting a turn starts a turn: a resident child becomes `running`. A
        // non-resident one would be cold-resumed by the real host, which is the
        // recoverable case the scheduler relies on — so it gets a resident agent too.
        const existing = agents.get(childId);
        if (existing === undefined)
            spawnChild(childId, 'running');
        else
            existing.status = 'running';
        return `msg-${calls.delivered.length}`;
    };
    const subagents = {
        async startActivation(spec) {
            if (options.spawnError !== undefined)
                throw new Error(options.spawnError);
            const childId = nextChildId();
            spawnChild(childId, 'running', spec.label);
            const prompt = spec.prompt ?? spec.request?.prompt;
            const toolFilter = spec.toolFilter ?? spec.request?.toolFilter;
            calls.startActivation.push({
                provider: spec.provider,
                label: spec.label,
                delivery: spec.delivery,
                ...(toolFilter === undefined ? {} : { toolFilter }),
                ...(prompt === undefined
                    ? {}
                    : { promptText: prompt.map((block) => (block.type === 'text' ? block.text : '')).join('') }),
            });
            return { childId, messageId: `msg-start-${calls.startActivation.length}` };
        },
        getProvider(name) {
            if (name !== providerName)
                return undefined;
            return {
                name: providerName,
                // Deliberately all-false: continuable children are gated by
                // `prepareContinuable` alone, and the scheduler must not read these flags.
                capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
                prepareContinuable: async () => ({}),
            };
        },
        list: () => [providerName],
        interrupt(childId) {
            calls.interrupted.push(childId);
            const agent = agents.get(childId);
            if (agent !== undefined)
                agent.status = 'idle';
        },
        async drainDescendants(_parents) {
            // 0.2.2 closes the whole tree; the fake has one parent, so drain every
            // resident child while keeping its durable catalog row.
            for (const childId of [...agents.keys()]) {
                calls.drained.push(childId);
                agents.delete(childId);
            }
        },
        async listDescendants() {
            calls.catalogReads += 1;
            return [...catalog.entries()].map(([id, row]) => ({
                kind: 'child',
                id,
                label: row.label,
                mode: row.mode,
                activity: agents.get(id)?.status === 'running' ? 'running' : 'inactive',
                parentId: 'parent',
                depth: 1,
                createdAt: row.createdAt,
            }));
        },
        // Legacy 0.2.1 helpers remain for tests and old hosts.
        async drainChildren(_parent, childIds) {
            for (const childId of childIds) {
                calls.drained.push(childId);
                agents.delete(childId);
            }
        },
        async listChildren() {
            calls.catalogReads += 1;
            return [...catalog.values()];
        },
        [symbols.deliver]: deliver,
        async sendMessage(_sender, childId, content, _opts) {
            return (await deliver(undefined, childId, content, { kind: 'user' }, new AbortController().signal, 'steer'));
        },
    };
    const agentsService = options.forgetEverySession === true ? { get: () => undefined } : { get: (id) => agents.get(id) };
    const tools = {
        get: (name) => (registeredTools.has(name) ? { name } : undefined),
        view: () => ({ restrictableNames: new Set(registeredTools) }),
    };
    const logger = options.logger ?? createFakeLogger('fake-member-host');
    const subprocess = options.subprocess === undefined ? undefined : createFakeSubprocess(options.subprocess);
    const ctx = {
        subagents,
        tools,
        logger,
        /**
         * The service lookup the gate runner uses. `subprocess` answers the recorded
         * double when one was requested and `undefined` otherwise — the real
         * `probeSubprocessRuntime` then reports `absent`, which is the honest
         * composition for a fake host that was not asked to run commands.
         */
        get(name) {
            return name === 'subprocess' ? subprocess : undefined;
        },
        ...(options.withoutAgentRegistry === true ? {} : { agents: agentsService }),
    };
    const probes = options.withoutAgentRegistry === true
        ? {} // no registry ⇒ no probe ⇒ the planner's `unknown` path (fail safe)
        : options.forgetEverySession === true
            ? naiveProbes()
            : {
                // Reads residency exactly like `members.memberLiveness` does, so a test
                // and the production probe cannot disagree about what "gone" means.
                isLive: (sessionId) => agents.has(sessionId),
                isRunning: (sessionId) => {
                    const agent = agents.get(sessionId);
                    return agent === undefined ? undefined : agent.status === 'running';
                },
            };
    return {
        ctx,
        logger,
        ...(subprocess === undefined ? {} : { subprocess }),
        agents,
        catalog,
        calls,
        probes,
        spawnChild,
        markRunning: (childId) => {
            const agent = agents.get(childId);
            if (agent !== undefined)
                agent.status = 'running';
        },
        drainChild: (childId) => {
            agents.delete(childId);
        },
        killSession: (childId) => {
            agents.delete(childId);
        },
        killAllSessions: () => {
            agents.clear();
        },
        isResident: (childId) => agents.has(childId),
    };
}
/**
 * The probes a **naive** fake host produces — the anti-model documented at the top
 * of this file.
 *
 * Kept as a named export so a suite can assert the regression it causes instead of
 * re-deriving it: with these probes a freshly spawned member is classified `gone`
 * and the planner answers with a stranded recovery.
 *
 * @returns probes that claim no member is ever resident.
 */
export function naiveProbes() {
    return { isLive: () => false, isRunning: () => undefined };
}
/** Re-exported for tests that need the symbol the fake host installs. */
export const FAKE_HOST_DELIVER_SYMBOL_KEY = 'dsh.subagent.deliverPrompt';
/** Structural helper: is this value one of the fake host's agents? */
export function isFakeAgent(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const candidate = value;
    return typeof candidate.id === 'string' && (candidate.status === 'idle' || candidate.status === 'running');
}
/** The default caller id, so two harnesses produce the same `captainSessionId`. */
export const FAKE_CALLER_ID = 'harness-captain';
/**
 * Absolute-path test for the workspace invariant.
 *
 * Deliberately the same single `path.isAbsolute` that `workspaceOf`
 * (`src/tools/context.ts`) uses — not a stricter "must be normalized" check that
 * would reject paths the engine itself accepts.
 */
function isAbsoluteWorkspace(value) {
    return path.isAbsolute(value);
}
/**
 * Builds the {@link ToolCallContext} one `factory_*` handler needs.
 *
 * Every harness used to hand-build this object, and two of its fields are traps
 * that are discovered by crashing rather than by reading:
 *
 *  - **`signal`**: the first spawn/delivery hands it to an `AbortSignal` API, so
 *    omitting it dies with `TypeError: Cannot read properties of undefined
 *    (reading 'aborted')`. This factory always supplies one.
 *  - **`workspace`**: it *is* `caller.session.header.cwd`, and `workspaceOf`
 *    never falls back to `process.cwd()`, so an absolute path (and a caller that
 *    carries it) is mandatory. This factory sets both from {@link
 *    ToolCallContextOptions.workspace}.
 *
 * What it does not do is guess: `workspace`, `store` and `plugin` are inputs
 * ({@link ToolCallContextOptions}), and a value it cannot fill in honestly — a
 * missing workspace, a relative one, a caller with no `cwd`, a caller with no
 * `id` — throws a message naming the field and what it is for.
 *
 * @param options - plugin, workspace, store, and the optional caller / signal / config.
 * @returns a context the engine functions accept, with the caller and callerId wired.
 * @throws TypeError when a required field is missing, empty or unusable.
 */
export function createToolCallContext(options) {
    const plugin = options.plugin;
    if (plugin === undefined || plugin === null) {
        throw new TypeError('createToolCallContext: `plugin` is required — it is the plugin context every handler receives as '
            + '`call.plugin` / `config.ctx` (services, logger and the `subprocess` lookup). A fake host '
            + '(createFakeMemberHost().ctx) is the usual value.');
    }
    const workspace = typeof options.workspace === 'string' ? options.workspace.trim() : '';
    if (workspace === '') {
        throw new TypeError('createToolCallContext: `workspace` is required — it is the absolute workspace root that becomes '
            + "`caller.session.header.cwd`. code-factory resolves every factory path from it and never falls "
            + 'back to `process.cwd()` (one host serves several workspaces), so it cannot be inferred here.');
    }
    if (!isAbsoluteWorkspace(workspace)) {
        throw new TypeError(`createToolCallContext: \`workspace\` must be an absolute path, got ${JSON.stringify(workspace)} — `
            + 'a relative value would have to be resolved against `process.cwd()`, which is exactly the bug '
            + '`workspaceOf` refuses to fall back to.');
    }
    if (options.store === undefined || options.store === null) {
        throw new TypeError('createToolCallContext: `store` is required — it is the `FactoryStore` bound to '
            + '<workspace>/<stateDir>, and the factory deliberately does not construct one: two stores for the same '
            + 'workspace would not share the lock keys the durable writes rely on.');
    }
    const supplied = options.caller;
    const callerId = options.callerId ?? (supplied === undefined ? FAKE_CALLER_ID : String(supplied.id));
    if (callerId === '' || callerId === 'undefined') {
        throw new TypeError('createToolCallContext: the caller has no usable `id` — it becomes `call.callerId`, which every '
            + 'ownership check compares against `state.captainSessionId` / `member.sessionId`. Pass `callerId` '
            + 'explicitly, or give the caller a string id.');
    }
    const caller = supplied ?? defaultCaller(workspace, callerId);
    const callerCwd = caller.session?.header?.cwd;
    if (typeof callerCwd !== 'string' || callerCwd.trim() === '') {
        throw new TypeError('createToolCallContext: `caller.session.header.cwd` is required and empty — it IS the workspace root '
            + '(`workspaceOf` reads nothing else and never falls back to `process.cwd()`). Either omit `caller` so '
            + `this factory builds one from \`workspace\`, or set its \`session.header.cwd\` to ${JSON.stringify(workspace)}.`);
    }
    if (!isAbsoluteWorkspace(callerCwd)) {
        throw new TypeError(`createToolCallContext: \`caller.session.header.cwd\` must be an absolute path, got `
            + `${JSON.stringify(callerCwd)} — the same value is refused at tool time by \`workspaceOf\`, which will not `
            + 'resolve it against `process.cwd()`.');
    }
    /*
     * A handler reads `call.config.memberProvider` (dispatch), `.maxMembers`
     * (plan), `.feedLimit` (status) and `.allowNodeFallback` (gate) *without* a
     * guard, so a context whose config omits them dies at the first tool call.
     * The defaults below are the same ones `apply()` resolves (`src/index.ts`),
     * so a harness that says nothing gets the shape a real install hands over.
     */
    const base = options.config;
    const config = {
        ...base,
        ctx: base?.ctx ?? plugin,
        stateDir: base?.stateDir ?? options.store.stateDir,
        memberProvider: base?.memberProvider ?? DEFAULT_MEMBER_PROVIDER,
        memberMaxDepth: base?.memberMaxDepth ?? 0,
        maxMembers: base?.maxMembers ?? DEFAULT_MAX_MEMBERS,
        feedLimit: base?.feedLimit ?? DEFAULT_TOOL_FEED_LIMIT,
        allowNodeFallback: base?.allowNodeFallback ?? false,
    };
    return {
        caller,
        callerId,
        workspace: callerCwd,
        store: options.store,
        signal: options.signal ?? new AbortController().signal,
        plugin,
        config,
    };
}
/**
 * The default caller: a captain-shaped fake agent whose `session.header.cwd` is
 * the workspace, so `workspaceOf` resolves without a real session.
 *
 * @param workspace - the absolute workspace root.
 * @param callerId - the session id the caller reports.
 * @returns the caller, cast because a harness agent intentionally implements the
 *   subset of `Agent` that engine functions touch.
 */
function defaultCaller(workspace, callerId) {
    return {
        id: callerId,
        session: { header: { name: 'captain', cwd: workspace } },
        isResident: false,
    };
}
//# sourceMappingURL=testing.js.map