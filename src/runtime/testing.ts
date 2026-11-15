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

import path from 'node:path'

import type { Context, LoggerService } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'

import type { FactoryStore } from '../store/store.js'
import type { FactoryToolConfig, ToolCallContext } from '../tools/context.js'
import { DEFAULT_TOOL_FEED_LIMIT } from '../tools/context.js'
import { DEFAULT_MAX_MEMBERS } from '../domain/router.js'
import type { SubprocessHandleLike, SubprocessRuntimeLike } from './commands.js'
import { DEFAULT_MEMBER_PROVIDER } from './provider-guard.js'
import type { SchedulerInputs } from './scheduler.js'
import { MEMBER_BASE_TOOL_NAMES, CAPTAIN_TOOL_NAMES } from './tool-surface.js'

/* --------------------------------------------------------------- types */

/** Severity a fake logger can receive — the live `LoggerType` vocabulary. */
export type FakeLogLevel = 'debug' | 'info' | 'warn' | 'error'

/** One recorded log line (this is what an assertion reads back). */
export interface FakeLogRecord {
  readonly level: FakeLogLevel
  /** The formatted line, i.e. exactly what `ctx.logger[level](...)` was given. */
  readonly text: string
  /** Prefix added by {@link FakeLogger.child} loggers, outermost first. */
  readonly scopes: readonly string[]
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
  readonly messages: FakeLogRecord[]
  /** The recorded lines with this severity, in call order. */
  recordsAt(level: FakeLogLevel): readonly FakeLogRecord[]
  /** The concatenated text of the recorded lines — the "did it log X?" helper. */
  text(): string
  /** Whether any recorded line contains `needle`. */
  has(needle: string): boolean
  /** Forget everything recorded so far (the records array itself is kept stable). */
  reset(): void
}

/** The live spawn spec, trimmed to what a test can assert about. */
export interface FakeSpawnSpecLike {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly signal?: AbortSignal
}

/** What one recorded spawn answers with. */
export interface FakeSpawnResult {
  /** Exit code the handle reports; `null` models a signalled process. */
  readonly exitCode: number | null
  readonly stdout?: string
  readonly stderr?: string
  /** Signal field of the reported outcome (default `null`). */
  readonly signal?: NodeJS.Signals | null
}

/** How one {@link createFakeSubprocess} double decides what each spawn answers. */
export type FakeSubprocessBehaviour = (spec: FakeSpawnSpecLike) => FakeSpawnResult

/** Everything one recorded spawn is observable through. */
export interface FakeSpawnRecord {
  /** The spec the caller handed to `spawn`, verbatim (never filled in by the double). */
  readonly spec: FakeSpawnSpecLike
  /** The exit code that was reported back to the caller. */
  readonly result: FakeSpawnResult
  /** Whether the caller called `terminate()`. */
  terminated: boolean
  /** Whether the caller awaited `waitForExit()`. */
  waitedForExit: boolean
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
  readonly calls: readonly FakeSpawnRecord[]
  /** Forget every recorded call. */
  reset(): void
  /** Every spec handed to `spawn`, in order (the *"what was invoked"* view). */
  readonly specs: readonly FakeSpawnSpecLike[]
}

/** Live status a fake member can report. */
export type FakeAgentStatus = 'idle' | 'running'

/** One resident fake agent. */
export interface FakeAgent {
  readonly id: string
  status: FakeAgentStatus
}

/** One durable catalog row (survives a cold restart, unlike residency). */
export interface FakeCatalogRow {
  readonly id: string
  readonly label: string
  readonly mode: 'continuable' | 'one-shot'
  readonly createdAt: number
}

/** Everything a fake host recorded, for assertions. */
export interface FakeHostCalls {
  /** Every `startActivation` spec, in order. */
  readonly startActivation: { readonly provider: string; readonly label: string; readonly delivery: 'parent' | 'caller'; readonly toolFilter?: ToolRestriction; readonly promptText?: string }[]
  /** Every delivered turn: which child, which mode, which text. */
  readonly delivered: { readonly childId: string; readonly mode: 'queue' | 'steer'; readonly text: string }[]
  /** Every interrupt request. */
  readonly interrupted: string[]
  /** Every drain request. */
  readonly drained: string[]
  /** Every `listChildren` catalogue read (mutable counter: it is incremented in place). */
  catalogReads: number
}

/** Knobs for {@link createFakeMemberHost}. */
export interface FakeMemberHostOptions {
  /** Provider name this host registers (default `'spawn'`). */
  readonly provider?: string
  /** Deterministic child ids; defaults to `child-1`, `child-2`, … */
  readonly nextChildId?: () => string
  /** Deliveries reject with this error (e.g. a `NOT_RESUMABLE` `SubagentError`). */
  readonly deliveryError?: Error
  /** `startActivation` rejects with this message. */
  readonly spawnError?: string
  /** Tools the fake registry reports (defaults to the real member + captain tools). */
  readonly registeredTools?: readonly string[]
  /**
   * Omit `ctx.agents` entirely — the **probe-unavailable** composition, where the
   * planner can only answer `unknown` and must fail safe (`wait`, no recovery).
   */
  readonly withoutAgentRegistry?: boolean
  /**
   * Keep `ctx.agents` but answer `undefined` for every id — the **naive fake
   * host**. Every member, including one that was just spawned, is classified
   * `gone`, so the planner emits a recovery. Use it only to prove that a suite
   * would catch that regression.
   */
  readonly forgetEverySession?: boolean
  /**
   * The logger `ctx.logger` answers with. Defaults to a fresh
   * {@link FakeLogger}, which is what makes *"this warning was logged"*
   * assertable through {@link FakeMemberHost.logger}; pass your own (still
   * recorded) logger to keep an existing suite's logger while gaining the rest
   * of the fake host.
   */
  readonly logger?: FakeLogger
  /**
   * Install a **recorded** `ctx.subprocess` double, so `probeSubprocessRuntime`
   * answers `available` and the gate runner selects its `subprocess` path
   * without any process being started. Omitted ⇒ the service is absent, exactly
   * as before.
   */
  readonly subprocess?: FakeSubprocessBehaviour
}

/** The fake host handed to a test. */
export interface FakeMemberHost {
  /** `Context`-shaped plugin context (`subagents` / `agents` / `tools` / `logger` / `get`). */
  readonly ctx: Context
  /**
   * The recording logger installed as `ctx.logger` — always present, whether it
   * was supplied through {@link FakeMemberHostOptions.logger} or created here.
   * This is the read-back side of an assertion about `logLine`.
   */
  readonly logger: FakeLogger
  /**
   * The recorded subprocess double, when
   * {@link FakeMemberHostOptions.subprocess} was supplied. `probeSubprocessRuntime`
   * finds it through `ctx.get('subprocess')`, so a runner built on {@link ctx}
   * selects the `subprocess` executor on its own.
   */
  readonly subprocess?: FakeSubprocessDouble
  /** Resident agents, keyed by child id. */
  readonly agents: Map<string, FakeAgent>
  /** Durable catalog rows, keyed by child id (survive {@link killSession}). */
  readonly catalog: Map<string, FakeCatalogRow>
  readonly calls: FakeHostCalls
  /**
   * Probes ready to spread into `planStageDispatch(...)`.
   *
   * **Empty in `withoutAgentRegistry` mode** — that is the point: a composition
   * with no agent registry has no liveness probe at all, and the scheduler's
   * "unknown probe" path is only reachable when `isLive` is *absent* (returning
   * `false` would mean something entirely different: "the probe answered, and no
   * executor exists" ⇒ `gone`).
   */
  readonly probes: Partial<Pick<SchedulerInputs, 'isLive' | 'isRunning'>>
  /** Register a resident child — what a real `startActivation` does by publishing the Agent. */
  spawnChild(childId: string, status?: FakeAgentStatus, label?: string): void
  /** Mark a resident child `running` — what accepting a turn does. */
  markRunning(childId: string): void
  /** Unregister a resident child — what `drainChildren` does (session survives). */
  drainChild(childId: string): void
  /** Emulate a cold restart of **one** member session: residency gone, session kept. */
  killSession(childId: string): void
  /** Emulate a host restart: every Activation gone, every durable session kept. */
  killAllSessions(): void
  /** Whether the planner's liveness probe would find an executor. */
  isResident(childId: string): boolean
}

/* ------------------------------------------------------- the two services */

/** The four severity methods every logger façade carries, in `LoggerType` order. */
const LOG_LEVELS: readonly FakeLogLevel[] = ['error', 'info', 'warn', 'debug']

/** Formats one log argument the way a `printf`-style sink would print it. */
function formatLogArgument(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
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
export function createFakeLogger(name = 'test'): FakeLogger {
  const messages: FakeLogRecord[] = []

  const build = (scopes: readonly string[]): FakeLogger => {
    const write = (level: FakeLogLevel) => (...args: readonly unknown[]): void => {
      messages.push({ level, text: args.map(formatLogArgument).join(' '), scopes })
    }
    const facade = ((childName?: string): FakeLogger => {
      if (childName === undefined) return facade
      return build([...scopes, childName])
    }) as unknown as FakeLogger
    Object.defineProperty(facade, 'name', { value: name, enumerable: true })
    Object.defineProperty(facade, 'messages', { value: messages, enumerable: true })
    facade.recordsAt = (level) => messages.filter((entry) => entry.level === level)
    facade.text = () => messages.map((entry) => `${entry.level}: ${entry.text}`).join('\n')
    facade.has = (needle) => messages.some((entry) => entry.text.includes(needle))
    facade.reset = () => {
      messages.length = 0
    }
    for (const level of LOG_LEVELS) facade[level] = write(level)
    return facade
  }

  return build([])
}

/** The reader the double exposes for one collected stream. */
function fakeOutputReader(text: string): { readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean } } {
  return {
    readFrom: (fromByte: number) => ({
      text: fromByte >= text.length ? '' : text.slice(fromByte),
      nextOffset: text.length,
      lossy: false,
    }),
  }
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
export function createFakeSubprocess(
  behaviour: FakeSubprocessBehaviour = () => ({ exitCode: 0 }),
): FakeSubprocessDouble {
  const calls: FakeSpawnRecord[] = []

  const spawn = (spec: FakeSpawnSpecLike): SubprocessHandleLike => {
    const result = behaviour(spec)
    const record: FakeSpawnRecord = { spec, result, terminated: false, waitedForExit: false }
    calls.push(record)
    const stdout = result.stdout ?? ''
    const stderr = result.stderr ?? ''
    let settled = false
    const done = Promise.resolve<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>({
      exitCode: result.exitCode,
      signal: result.signal ?? null,
    })
    return {
      collected: {
        stdout: fakeOutputReader(stdout),
        stderr: fakeOutputReader(stderr),
      },
      done: done.then((outcome) => {
        settled = true
        return outcome
      }),
      terminate(): void {
        record.terminated = true
      },
      async waitForExit(): Promise<boolean> {
        record.waitedForExit = true
        return settled
      },
    }
  }

  return {
    resolveExecutable: async (command: string) => command,
    spawn,
    calls,
    get specs(): readonly FakeSpawnSpecLike[] {
      return calls.map((record) => record.spec)
    },
    reset(): void {
      calls.length = 0
    },
  }
}

/* ----------------------------------------------------------- the model */

/** Default child-id allocator: `child-1`, `child-2`, … */
function defaultChildIds(): () => string {
  let index = 0
  return () => {
    index += 1
    return `child-${index}`
  }
}

const DEFAULT_TOOLS: readonly string[] = [...MEMBER_BASE_TOOL_NAMES, ...CAPTAIN_TOOL_NAMES, 'read', 'write', 'pwsh']

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
export function createFakeMemberHost(options: FakeMemberHostOptions = {}): FakeMemberHost {
  const providerName = options.provider ?? 'spawn'
  const nextChildId = options.nextChildId ?? defaultChildIds()
  const registeredTools = new Set(options.registeredTools ?? DEFAULT_TOOLS)
  const agents = new Map<string, FakeAgent>()
  const catalog = new Map<string, FakeCatalogRow>()
  const calls: FakeHostCalls = {
    startActivation: [],
    delivered: [],
    interrupted: [],
    drained: [],
    catalogReads: 0,
  }

  const spawnChild = (childId: string, status: FakeAgentStatus = 'idle', label = 'member'): void => {
    agents.set(childId, { id: childId, status })
    if (!catalog.has(childId)) {
      catalog.set(childId, { id: childId, label, mode: 'continuable', createdAt: Date.now() })
    }
  }

  const symbols = { deliver: Symbol.for('dsh.subagent.deliverPrompt') }
  const deliver = async (
    _parent: unknown,
    childId: string,
    content: readonly ContentBlock[],
    _source: MessageSource,
    _signal: AbortSignal,
    mode: 'queue' | 'steer',
  ): Promise<string> => {
    if (options.deliveryError !== undefined) throw options.deliveryError
    calls.delivered.push({
      childId,
      mode,
      text: content.map((block) => (block.type === 'text' ? block.text : '')).join(''),
    })
    // Accepting a turn starts a turn: a resident child becomes `running`. A
    // non-resident one would be cold-resumed by the real host, which is the
    // recoverable case the scheduler relies on — so it gets a resident agent too.
    const existing = agents.get(childId)
    if (existing === undefined) spawnChild(childId, 'running')
    else existing.status = 'running'
    return `msg-${calls.delivered.length}`
  }

  const subagents = {
    async startActivation(spec: {
      readonly provider: string
      readonly label: string
      /** 0.2.2 flat prompt (ContentBlock[]). */
      readonly prompt?: readonly ContentBlock[]
      /** Legacy 0.2.1 nested request; kept so older tests/hosts still run. */
      readonly request?: { readonly prompt?: readonly ContentBlock[]; readonly toolFilter?: ToolRestriction }
      readonly toolFilter?: ToolRestriction
      readonly delivery: 'parent' | 'caller'
    }): Promise<{ childId: string; messageId: string }> {
      if (options.spawnError !== undefined) throw new Error(options.spawnError)
      const childId = nextChildId()
      spawnChild(childId, 'running', spec.label)
      const prompt = spec.prompt ?? spec.request?.prompt
      const toolFilter = spec.toolFilter ?? spec.request?.toolFilter
      calls.startActivation.push({
        provider: spec.provider,
        label: spec.label,
        delivery: spec.delivery,
        ...(toolFilter === undefined ? {} : { toolFilter }),
        ...(prompt === undefined
          ? {}
          : { promptText: prompt.map((block) => (block.type === 'text' ? block.text : '')).join('') }),
      })
      return { childId, messageId: `msg-start-${calls.startActivation.length}` }
    },
    getProvider(name: string): { name: string; capabilities: Record<string, boolean>; prepareContinuable: () => Promise<unknown> } | undefined {
      if (name !== providerName) return undefined
      return {
        name: providerName,
        // Deliberately all-false: continuable children are gated by
        // `prepareContinuable` alone, and the scheduler must not read these flags.
        capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
        prepareContinuable: async () => ({}),
      }
    },
    list: (): string[] => [providerName],
    interrupt(childId: string): void {
      calls.interrupted.push(childId)
      const agent = agents.get(childId)
      if (agent !== undefined) agent.status = 'idle'
    },
    async drainDescendants(_parents: readonly unknown[]): Promise<void> {
      // 0.2.2 closes the whole tree; the fake has one parent, so drain every
      // resident child while keeping its durable catalog row.
      for (const childId of [...agents.keys()]) {
        calls.drained.push(childId)
        agents.delete(childId)
      }
    },
    async listDescendants(): Promise<readonly {
      readonly kind: 'child'
      readonly id: string
      readonly label: string
      readonly mode: 'continuable' | 'one-shot'
      readonly activity: 'running' | 'inactive'
      readonly parentId: string
      readonly depth: number
      readonly createdAt: number
    }[]> {
      calls.catalogReads += 1
      return [...catalog.entries()].map(([id, row]) => ({
        kind: 'child' as const,
        id,
        label: row.label,
        mode: row.mode,
        activity: agents.get(id)?.status === 'running' ? 'running' as const : 'inactive' as const,
        parentId: 'parent',
        depth: 1,
        createdAt: row.createdAt,
      }))
    },
    // Legacy 0.2.1 helpers remain for tests and old hosts.
    async drainChildren(_parent: unknown, childIds: readonly string[]): Promise<void> {
      for (const childId of childIds) {
        calls.drained.push(childId)
        agents.delete(childId)
      }
    },
    async listChildren(): Promise<readonly FakeCatalogRow[]> {
      calls.catalogReads += 1
      return [...catalog.values()]
    },
    [symbols.deliver]: deliver,
    async sendMessage(
      _sender: unknown,
      childId: string,
      content: readonly ContentBlock[],
      _opts: unknown,
    ): Promise<MessageId> {
      return (await deliver(undefined, childId, content, { kind: 'user' }, new AbortController().signal, 'steer')) as MessageId
    },
  }

  const agentsService = options.forgetEverySession === true ? { get: () => undefined } : { get: (id: string) => agents.get(id) }
  const tools = {
    get: (name: string) => (registeredTools.has(name) ? { name } : undefined),
    view: () => ({ restrictableNames: new Set(registeredTools) }),
  }
  const logger = options.logger ?? createFakeLogger('fake-member-host')
  const subprocess = options.subprocess === undefined ? undefined : createFakeSubprocess(options.subprocess)

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
    get(name: string) {
      return name === 'subprocess' ? subprocess : undefined
    },
    ...(options.withoutAgentRegistry === true ? {} : { agents: agentsService }),
  } as unknown as Context

  const probes: FakeMemberHost['probes'] =
    options.withoutAgentRegistry === true
      ? {} // no registry ⇒ no probe ⇒ the planner's `unknown` path (fail safe)
      : options.forgetEverySession === true
        ? naiveProbes()
        : {
            // Reads residency exactly like `members.memberLiveness` does, so a test
            // and the production probe cannot disagree about what "gone" means.
            isLive: (sessionId: string) => agents.has(sessionId),
            isRunning: (sessionId: string) => {
              const agent = agents.get(sessionId)
              return agent === undefined ? undefined : agent.status === 'running'
            },
          }

  return {
    ctx,
    logger,
    ...(subprocess === undefined ? {} : { subprocess }),
    agents,
    catalog,
    calls,
    probes,
    spawnChild,
    markRunning: (childId: string) => {
      const agent = agents.get(childId)
      if (agent !== undefined) agent.status = 'running'
    },
    drainChild: (childId: string) => {
      agents.delete(childId)
    },
    killSession: (childId: string) => {
      agents.delete(childId)
    },
    killAllSessions: () => {
      agents.clear()
    },
    isResident: (childId: string) => agents.has(childId),
  }
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
export function naiveProbes(): Partial<Pick<SchedulerInputs, 'isLive' | 'isRunning'>> {
  return { isLive: () => false, isRunning: () => undefined }
}

/** Re-exported for tests that need the symbol the fake host installs. */
export const FAKE_HOST_DELIVER_SYMBOL_KEY = 'dsh.subagent.deliverPrompt'

/** Structural helper: is this value one of the fake host's agents? */
export function isFakeAgent(value: unknown): value is FakeAgent {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { id?: unknown; status?: unknown }
  return typeof candidate.id === 'string' && (candidate.status === 'idle' || candidate.status === 'running')
}

/* ------------------------------------------------------- tool call context */

/**
 * The properties {@link createToolCallContext} reads off a caller. A fake
 * harness agent is deliberately this small: the only caller fields any engine
 * function touches are the identity (for `callerId` / `captainSessionId`
 * comparisons) and `session.header.cwd` (the workspace). Declaring that subset
 * keeps the factory honest about what it needs instead of widening the real
 * `Agent` type to admit a partial object.
 */
interface CallerShape {
  readonly id: string
  readonly session: { readonly header: { readonly cwd: string | undefined } }
}

/** Knobs for {@link createToolCallContext}. */
export interface ToolCallContextOptions {
  /** The plugin context every handler is given (`config.ctx` / `call.plugin`). */
  readonly plugin: Context
  /**
   * The absolute workspace root. It must be absolute: it becomes
   * `caller.session.header.cwd`, and `workspaceOf` never falls back to
   * `process.cwd()` — the same host serves several workspaces from one process,
   * so a relative value would silently read another session's factories.
   */
  readonly workspace: string
  /** The store bound to `<workspace>/<stateDir>` — supplied, never invented. */
  readonly store: FactoryStore
  /**
   * The calling agent. Omit for a default captain-shaped caller built from
   * {@link workspace}; supply one to act as a specific captain or member.
   * A supplied caller is still validated, because a harness's own caller is
   * exactly where a missing `cwd` hides.
   */
  readonly caller?: Agent
  /**
   * A supplied caller's id, when it differs from `String(caller.id)`.
   */
  readonly callerId?: string
  /**
   * Caller cancellation, forwarded to every spawn / delivery / command. Omit for
   * a fresh, never-aborted signal — spawning paths dereference it immediately, so
   * "no signal" is not a realistic caller and is never produced.
   */
  readonly signal?: AbortSignal
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
  readonly config?: Partial<FactoryToolConfig>
}

/** The default caller id, so two harnesses produce the same `captainSessionId`. */
export const FAKE_CALLER_ID = 'harness-captain'

/**
 * Absolute-path test for the workspace invariant.
 *
 * Deliberately the same single `path.isAbsolute` that `workspaceOf`
 * (`src/tools/context.ts`) uses — not a stricter "must be normalized" check that
 * would reject paths the engine itself accepts.
 */
function isAbsoluteWorkspace(value: string): boolean {
  return path.isAbsolute(value)
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
export function createToolCallContext(options: ToolCallContextOptions): ToolCallContext {
  const plugin = options.plugin
  if (plugin === undefined || plugin === null) {
    throw new TypeError(
      'createToolCallContext: `plugin` is required — it is the plugin context every handler receives as '
        + '`call.plugin` / `config.ctx` (services, logger and the `subprocess` lookup). A fake host '
        + '(createFakeMemberHost().ctx) is the usual value.',
    )
  }

  const workspace = typeof options.workspace === 'string' ? options.workspace.trim() : ''
  if (workspace === '') {
    throw new TypeError(
      'createToolCallContext: `workspace` is required — it is the absolute workspace root that becomes '
        + "`caller.session.header.cwd`. code-factory resolves every factory path from it and never falls "
        + 'back to `process.cwd()` (one host serves several workspaces), so it cannot be inferred here.',
    )
  }
  if (!isAbsoluteWorkspace(workspace)) {
    throw new TypeError(
      `createToolCallContext: \`workspace\` must be an absolute path, got ${JSON.stringify(workspace)} — `
        + 'a relative value would have to be resolved against `process.cwd()`, which is exactly the bug '
        + '`workspaceOf` refuses to fall back to.',
    )
  }

  if (options.store === undefined || options.store === null) {
    throw new TypeError(
      'createToolCallContext: `store` is required — it is the `FactoryStore` bound to '
        + '<workspace>/<stateDir>, and the factory deliberately does not construct one: two stores for the same '
        + 'workspace would not share the lock keys the durable writes rely on.',
    )
  }

  const supplied = options.caller as Agent | undefined
  const callerId = options.callerId ?? (supplied === undefined ? FAKE_CALLER_ID : String(supplied.id))
  if (callerId === '' || callerId === 'undefined') {
    throw new TypeError(
      'createToolCallContext: the caller has no usable `id` — it becomes `call.callerId`, which every '
        + 'ownership check compares against `state.captainSessionId` / `member.sessionId`. Pass `callerId` '
        + 'explicitly, or give the caller a string id.',
    )
  }

  const caller = supplied ?? defaultCaller(workspace, callerId)
  const callerCwd = (caller as CallerShape).session?.header?.cwd
  if (typeof callerCwd !== 'string' || callerCwd.trim() === '') {
    throw new TypeError(
      'createToolCallContext: `caller.session.header.cwd` is required and empty — it IS the workspace root '
        + '(`workspaceOf` reads nothing else and never falls back to `process.cwd()`). Either omit `caller` so '
        + `this factory builds one from \`workspace\`, or set its \`session.header.cwd\` to ${JSON.stringify(workspace)}.`,
    )
  }
  if (!isAbsoluteWorkspace(callerCwd)) {
    throw new TypeError(
      `createToolCallContext: \`caller.session.header.cwd\` must be an absolute path, got `
        + `${JSON.stringify(callerCwd)} — the same value is refused at tool time by \`workspaceOf\`, which will not `
        + 'resolve it against `process.cwd()`.',
    )
  }

  /*
   * A handler reads `call.config.memberProvider` (dispatch), `.maxMembers`
   * (plan), `.feedLimit` (status) and `.allowNodeFallback` (gate) *without* a
   * guard, so a context whose config omits them dies at the first tool call.
   * The defaults below are the same ones `apply()` resolves (`src/index.ts`),
   * so a harness that says nothing gets the shape a real install hands over.
   */
  const base = options.config
  const config = {
    ...base,
    ctx: base?.ctx ?? plugin,
    stateDir: base?.stateDir ?? options.store.stateDir,
    memberProvider: base?.memberProvider ?? DEFAULT_MEMBER_PROVIDER,
    memberMaxDepth: base?.memberMaxDepth ?? 0,
    maxMembers: base?.maxMembers ?? DEFAULT_MAX_MEMBERS,
    feedLimit: base?.feedLimit ?? DEFAULT_TOOL_FEED_LIMIT,
    allowNodeFallback: base?.allowNodeFallback ?? false,
  } as FactoryToolConfig

  return {
    caller,
    callerId,
    workspace: callerCwd,
    store: options.store,
    signal: options.signal ?? new AbortController().signal,
    plugin,
    config,
  }
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
function defaultCaller(workspace: string, callerId: string): Agent {
  return {
    id: callerId,
    session: { header: { name: 'captain', cwd: workspace } },
    isResident: false,
  } as unknown as Agent
}
