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
import type { Context, LoggerService } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolRestriction } from '@deepseek-ai/dsh-tools';
import type { FactoryStore } from '../store/store.js';
import type { FactoryToolConfig, ToolCallContext } from '../tools/context.js';
import type { SubprocessRuntimeLike } from './commands.js';
import type { SchedulerInputs } from './scheduler.js';
/** Severity a fake logger can receive — the live `LoggerType` vocabulary. */
export type FakeLogLevel = 'debug' | 'info' | 'warn' | 'error';
/** One recorded log line (this is what an assertion reads back). */
export interface FakeLogRecord {
    readonly level: FakeLogLevel;
    /** The formatted line, i.e. exactly what `ctx.logger[level](...)` was given. */
    readonly text: string;
    /** Prefix added by {@link FakeLogger.child} loggers, outermost first. */
    readonly scopes: readonly string[];
}
/**
 * A `ctx.logger` that **records instead of dropping**, so *"this warning was
 * logged"* is assertable.
 *
 * It keeps the callable-with-methods shape of the real {@link LoggerService}
 * (`ctx.logger(name)` returns a named child logger, `ctx.logger.warn(...)` logs
 * on the root), because `logLine` uses the latter and a harness that only
 * implements the former would pass a broken host to the test.
 */
export interface FakeLogger extends LoggerService {
    /** Every recorded line, in call order. */
    readonly messages: FakeLogRecord[];
    /** The recorded lines with this severity, in call order. */
    recordsAt(level: FakeLogLevel): readonly FakeLogRecord[];
    /** The concatenated text of the recorded lines — the "did it log X?" helper. */
    text(): string;
    /** Whether any recorded line contains `needle`. */
    has(needle: string): boolean;
    /** Forget everything recorded so far (the records array itself is kept stable). */
    reset(): void;
}
/** The live spawn spec, trimmed to what a test can assert about. */
export interface FakeSpawnSpecLike {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly signal?: AbortSignal;
}
/** What one recorded spawn answers with. */
export interface FakeSpawnResult {
    /** Exit code the handle reports; `null` models a signalled process. */
    readonly exitCode: number | null;
    readonly stdout?: string;
    readonly stderr?: string;
    /** Signal field of the reported outcome (default `null`). */
    readonly signal?: NodeJS.Signals | null;
}
/** How one {@link createFakeSubprocess} double decides what each spawn answers. */
export type FakeSubprocessBehaviour = (spec: FakeSpawnSpecLike) => FakeSpawnResult;
/** Everything one recorded spawn is observable through. */
export interface FakeSpawnRecord {
    /** The spec the caller handed to `spawn`, verbatim (never filled in by the double). */
    readonly spec: FakeSpawnSpecLike;
    /** The exit code that was reported back to the caller. */
    readonly result: FakeSpawnResult;
    /** Whether the caller called `terminate()`. */
    terminated: boolean;
    /** Whether the caller awaited `waitForExit()`. */
    waitedForExit: boolean;
}
/**
 * A **recorded, process-free** stand-in for `ctx.subprocess` — the shape
 * {@link FakeMemberHostOptions.subprocess} and {@link createFakeSubprocess} hand
 * out.
 *
 * It is structurally the live service (`isSubprocessRuntime` accepts it, so the
 * gate runner selects its sanctioned `subprocess` path), and it never starts
 * anything: the caller decides every answer through
 * {@link FakeSubprocessBehaviour}, and every invocation lands in
 * {@link FakeSubprocessDouble.calls} for assertions. Real spawning stays
 * available via `commands.createNodeCommandRunner()` / `allowNodeFallback`, but
 * it is never implicit — a fake host that silently starts processes is a worse
 * trap than the one this double replaces.
 */
export interface FakeSubprocessDouble extends SubprocessRuntimeLike {
    /** Every `spawn` call, in order. */
    readonly calls: readonly FakeSpawnRecord[];
    /** Forget every recorded call. */
    reset(): void;
    /** Every spec handed to `spawn`, in order (the *"what was invoked"* view). */
    readonly specs: readonly FakeSpawnSpecLike[];
}
/** Live status a fake member can report. */
export type FakeAgentStatus = 'idle' | 'running';
/** One resident fake agent. */
export interface FakeAgent {
    readonly id: string;
    status: FakeAgentStatus;
}
/** One durable catalog row (survives a cold restart, unlike residency). */
export interface FakeCatalogRow {
    readonly id: string;
    readonly label: string;
    readonly mode: 'continuable' | 'one-shot';
    readonly createdAt: number;
}
/** Everything a fake host recorded, for assertions. */
export interface FakeHostCalls {
    /** Every `startActivation` spec, in order. */
    readonly startActivation: {
        readonly provider: string;
        readonly label: string;
        readonly delivery: 'parent' | 'caller';
        readonly toolFilter?: ToolRestriction;
        readonly promptText?: string;
    }[];
    /** Every delivered turn: which child, which mode, which text. */
    readonly delivered: {
        readonly childId: string;
        readonly mode: 'queue' | 'steer';
        readonly text: string;
    }[];
    /** Every interrupt request. */
    readonly interrupted: string[];
    /** Every drain request. */
    readonly drained: string[];
    /** Every `listChildren` catalogue read (mutable counter: it is incremented in place). */
    catalogReads: number;
}
/** Knobs for {@link createFakeMemberHost}. */
export interface FakeMemberHostOptions {
    /** Provider name this host registers (default `'spawn'`). */
    readonly provider?: string;
    /** Deterministic child ids; defaults to `child-1`, `child-2`, … */
    readonly nextChildId?: () => string;
    /** Deliveries reject with this error (e.g. a `NOT_RESUMABLE` `SubagentError`). */
    readonly deliveryError?: Error;
    /** `startActivation` rejects with this message. */
    readonly spawnError?: string;
    /** Tools the fake registry reports (defaults to the real member + captain tools). */
    readonly registeredTools?: readonly string[];
    /**
     * Omit `ctx.agents` entirely — the **probe-unavailable** composition, where the
     * planner can only answer `unknown` and must fail safe (`wait`, no recovery).
     */
    readonly withoutAgentRegistry?: boolean;
    /**
     * Keep `ctx.agents` but answer `undefined` for every id — the **naive fake
     * host**. Every member, including one that was just spawned, is classified
     * `gone`, so the planner emits a recovery. Use it only to prove that a suite
     * would catch that regression.
     */
    readonly forgetEverySession?: boolean;
    /**
     * The logger `ctx.logger` answers with. Defaults to a fresh
     * {@link FakeLogger}, which is what makes *"this warning was logged"*
     * assertable through {@link FakeMemberHost.logger}; pass your own (still
     * recorded) logger to keep an existing suite's logger while gaining the rest
     * of the fake host.
     */
    readonly logger?: FakeLogger;
    /**
     * Install a **recorded** `ctx.subprocess` double, so `probeSubprocessRuntime`
     * answers `available` and the gate runner selects its `subprocess` path
     * without any process being started. Omitted ⇒ the service is absent, exactly
     * as before.
     */
    readonly subprocess?: FakeSubprocessBehaviour;
}
/** The fake host handed to a test. */
export interface FakeMemberHost {
    /** `Context`-shaped plugin context (`subagents` / `agents` / `tools` / `logger` / `get`). */
    readonly ctx: Context;
    /**
     * The recording logger installed as `ctx.logger` — always present, whether it
     * was supplied through {@link FakeMemberHostOptions.logger} or created here.
     * This is the read-back side of an assertion about `logLine`.
     */
    readonly logger: FakeLogger;
    /**
     * The recorded subprocess double, when
     * {@link FakeMemberHostOptions.subprocess} was supplied. `probeSubprocessRuntime`
     * finds it through `ctx.get('subprocess')`, so a runner built on {@link ctx}
     * selects the `subprocess` executor on its own.
     */
    readonly subprocess?: FakeSubprocessDouble;
    /** Resident agents, keyed by child id. */
    readonly agents: Map<string, FakeAgent>;
    /** Durable catalog rows, keyed by child id (survive {@link killSession}). */
    readonly catalog: Map<string, FakeCatalogRow>;
    readonly calls: FakeHostCalls;
    /**
     * Probes ready to spread into `planStageDispatch(...)`.
     *
     * **Empty in `withoutAgentRegistry` mode** — that is the point: a composition
     * with no agent registry has no liveness probe at all, and the scheduler's
     * "unknown probe" path is only reachable when `isLive` is *absent* (returning
     * `false` would mean something entirely different: "the probe answered, and no
     * executor exists" ⇒ `gone`).
     */
    readonly probes: Partial<Pick<SchedulerInputs, 'isLive' | 'isRunning'>>;
    /** Register a resident child — what a real `startActivation` does by publishing the Agent. */
    spawnChild(childId: string, status?: FakeAgentStatus, label?: string): void;
    /** Mark a resident child `running` — what accepting a turn does. */
    markRunning(childId: string): void;
    /** Unregister a resident child — what `drainChildren` does (session survives). */
    drainChild(childId: string): void;
    /** Emulate a cold restart of **one** member session: residency gone, session kept. */
    killSession(childId: string): void;
    /** Emulate a host restart: every Activation gone, every durable session kept. */
    killAllSessions(): void;
    /** Whether the planner's liveness probe would find an executor. */
    isResident(childId: string): boolean;
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
export declare function createFakeLogger(name?: string): FakeLogger;
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
export declare function createFakeSubprocess(behaviour?: FakeSubprocessBehaviour): FakeSubprocessDouble;
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
export declare function createFakeMemberHost(options?: FakeMemberHostOptions): FakeMemberHost;
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
export declare function naiveProbes(): Partial<Pick<SchedulerInputs, 'isLive' | 'isRunning'>>;
/** Re-exported for tests that need the symbol the fake host installs. */
export declare const FAKE_HOST_DELIVER_SYMBOL_KEY = "dsh.subagent.deliverPrompt";
/** Structural helper: is this value one of the fake host's agents? */
export declare function isFakeAgent(value: unknown): value is FakeAgent;
/** Knobs for {@link createToolCallContext}. */
export interface ToolCallContextOptions {
    /** The plugin context every handler is given (`config.ctx` / `call.plugin`). */
    readonly plugin: Context;
    /**
     * The absolute workspace root. It must be absolute: it becomes
     * `caller.session.header.cwd`, and `workspaceOf` never falls back to
     * `process.cwd()` — the same host serves several workspaces from one process,
     * so a relative value would silently read another session's factories.
     */
    readonly workspace: string;
    /** The store bound to `<workspace>/<stateDir>` — supplied, never invented. */
    readonly store: FactoryStore;
    /**
     * The calling agent. Omit for a default captain-shaped caller built from
     * {@link workspace}; supply one to act as a specific captain or member.
     * A supplied caller is still validated, because a harness's own caller is
     * exactly where a missing `cwd` hides.
     */
    readonly caller?: Agent;
    /**
     * A supplied caller's id, when it differs from `String(caller.id)`.
     */
    readonly callerId?: string;
    /**
     * Caller cancellation, forwarded to every spawn / delivery / command. Omit for
     * a fresh, never-aborted signal — spawning paths dereference it immediately, so
     * "no signal" is not a realistic caller and is never produced.
     */
    readonly signal?: AbortSignal;
    /**
     * The resolved plugin configuration. `config.ctx` always points at
     * {@link plugin} and `config.stateDir` at the store's own state directory.
     * Every *other* field the caller supplies is used verbatim; one they leave out
     * keeps the value `apply()` would have resolved for a default install
     * (`memberProvider: 'spawn'`, `memberMaxDepth: 0`, `maxMembers: 11`,
     * `feedLimit: 12`, `allowNodeFallback: false`) rather than becoming
     * `undefined` — handlers read these without a guard. A test that needs a
     * different install must say so here.
     */
    readonly config?: Partial<FactoryToolConfig>;
}
/** The default caller id, so two harnesses produce the same `captainSessionId`. */
export declare const FAKE_CALLER_ID = "harness-captain";
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
export declare function createToolCallContext(options: ToolCallContextOptions): ToolCallContext;
