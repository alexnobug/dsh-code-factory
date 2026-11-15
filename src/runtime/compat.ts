/**
 * compat.ts — **the version-compatibility seam** for everything that talks to
 * `ctx.subagents`.
 *
 * Why one file (实施方案 §7「子代理继续唤醒跨版本语义漂移」, M4 risk #1):
 * The continuable-subagent surface is the youngest part of the harness. Method
 * names, delivery modes and the host-only delivery symbol have all moved between
 * 0.1.x releases, and the reference plugin keeps an audited seam
 * (`@nanmicoder/dsh-agent-teams/lib/harness-compat.js`) for exactly that reason.
 * Isolating every shape that could move here means a harness upgrade is a
 * one-file review instead of a hunt through the runtime.
 *
 * What is verified for **0.2.2-rc.3** (this project's pinned peer version):
 *
 * | surface | evidence |
 * |---|---|
 * | `runtime.startActivation(spec)` — flat `SubagentActivationSpec` | live `Service.listService {service:'subagents'}`; `dsh-subagent/lib/types/types.d.ts` |
 * | `runtime.sendMessage(sender, targetId, content, {signal})` (steer) | live service; `dsh-subagent/lib/types/index.d.ts` |
 * | `runtime.interrupt(targetId, authority)` | live service; `dsh-subagent/lib/types/index.d.ts` |
 * | `runtime.listDescendants(rootSessionId, signal?)` — recursive catalog read; depth=1 is direct children | live service; `dsh-subagent/lib/types/index.d.ts` |
 * | `runtime.drainDescendants(parents)` — close whole subagent trees | live service; `dsh-subagent/lib/types/index.d.ts` |
 * | `runtime.getProvider(name)` — provider lookup (no `list()` anymore) | live service; `dsh-subagent/lib/types/index.d.ts` |
 * | `Symbol.for('dsh.subagent.deliverPrompt')` — host-authored **queue vs steer** delivery | `dsh-subagent/lib/types/internal.d.ts` |
 * | `delegationDepthOf(agent)` | `dsh-subagent/lib/types/depth.d.ts` |
 *
 * The symbol-keyed deliverer is read through `Symbol.for(...)` instead of
 * `import { deliverSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'`:
 * the symbol is process-stable by construction, while a static value import of
 * that subpath hard-couples module *loading* to a harness generation that ships
 * it (the reference plugin warns about exactly this). The **type** is imported
 * (type-only imports are erased), so the shape stays compiler-checked.
 *
 * @module dsh-code-factory/runtime/compat
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'

import { logLine } from '../tools/context.js'

/* ---------------------------------------------------------- message source */

/**
 * Message-source vocabulary owned by this plugin.
 *
 * `MessageSourceMap` is merge-extensible by design ("each producer declares its
 * own `kind` in its own module"), so a member dispatch is never attributed to
 * the human user — the chat renders it as plugin-produced protocol text.
 * `command.ts` already adds `'code-factory-command'` for the same reason.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'code-factory': {
      readonly kind: 'code-factory'
      /** Factory the dispatch belongs to, when known. */
      readonly factoryId?: string
      /** Stage the dispatch is about, when known. */
      readonly stage?: string
      /** Role id being addressed, when known. */
      readonly role?: string
    }
  }
}

/** Provenance for one member-facing dispatch message. */
export interface DispatchSourceFields {
  readonly factoryId?: string
  readonly stage?: string
  readonly role?: string
}

/** Builds the message source for a member-facing dispatch. */
export function dispatchSource(fields: DispatchSourceFields = {}): MessageSource {
  const source: { kind: 'code-factory'; factoryId?: string; stage?: string; role?: string } = { kind: 'code-factory' }
  if (fields.factoryId !== undefined) source.factoryId = fields.factoryId
  if (fields.stage !== undefined) source.stage = fields.stage
  if (fields.role !== undefined) source.role = fields.role
  return source
}

/* --------------------------------------------------------------- helpers */

/** The single storage-boundary cast: durable ids are plain strings on disk. */
export function asSessionId(value: string): SessionId {
  return value as unknown as SessionId
}

/** Compact one-line description of a thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/** `content` for one model-visible text message. */
export function textContent(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/* -------------------------------------------------------- prompt delivery */

/** How a member message was delivered. */
export type MemberDeliveryMode = 'queue' | 'steer'

/** Which host path carried the delivery. */
export type MemberDeliveryVia = 'host-deliver' | 'sendMessage'

/** Result of one successful member delivery. */
export interface MemberDeliveryReceipt {
  readonly messageId: string
  readonly mode: MemberDeliveryMode
  readonly via: MemberDeliveryVia
}

/** The process-stable symbol of the host-only prompt deliverer. */
const DELIVER_PROMPT_SYMBOL = Symbol.for('dsh.subagent.deliverPrompt')

/**
 * The exact host method type, taken from the harness's own declaration
 * (`dsh-subagent/lib/types/internal.d.ts:33-35`) plus the caller-side `this`, so
 * the call below is compiler-checked instead of duck-typed by hand.
 */
type HostDeliverFn = (
  this: Context['subagents'],
  parent: Agent,
  childId: SessionId,
  content: ContentBlock[],
  source: MessageSource,
  signal: AbortSignal,
  delivery: MemberDeliveryMode,
) => Promise<MessageId>

/** Reads the symbol-keyed deliverer off the live runtime, if this build has it. */
function delivererOf(runtime: Context['subagents']): HostDeliverFn | undefined {
  const table = runtime as unknown as Record<symbol, unknown>
  const candidate = table[DELIVER_PROMPT_SYMBOL]
  return typeof candidate === 'function' ? (candidate as HostDeliverFn) : undefined
}

/**
 * Delivers one host-authored message to a durable direct child.
 *
 * `mode: 'queue'` is the dispatch path — the message becomes its own turn, so a
 * second stage or a rework note is never merged into a step the member is
 * already running. `mode: 'steer'` lands at the nearest step boundary, which is
 * what an urgent interrupt/notice wants.
 *
 * When the host-only deliverer is absent (an older or reshaped harness),
 * `sendMessage` is the documented public fallback: "a running target admits it
 * at the nearest step boundary; an idle target starts a turn, and an absent
 * direct child cold-resumes from persistence" (`lib/types/index.d.ts:143-156`).
 * The fallback is reported in the receipt (`via`) instead of being hidden, and
 * it still satisfies the one thing dispatch needs — waking an idle member.
 *
 * @param runtime - `ctx.subagents`.
 * @param parent - the exact live direct parent (the captain agent).
 * @param childId - the member's durable child session id.
 * @param text - the message body.
 * @param signal - caller cancellation, owning the call until inbox acceptance.
 * @param mode - queue a distinct turn (default) or steer the nearest step.
 * @returns the accepted message id and the path that carried it.
 * @throws when neither delivery path is available or the host rejects the send.
 */
export async function deliverToMember(
  runtime: Context['subagents'],
  parent: Agent,
  childId: string,
  text: string,
  signal: AbortSignal,
  mode: MemberDeliveryMode = 'queue',
  source: MessageSource = dispatchSource(),
): Promise<MemberDeliveryReceipt> {
  const content = textContent(text)
  const target = asSessionId(childId)
  const deliverer = delivererOf(runtime)
  if (deliverer !== undefined) {
    const messageId = await deliverer.call(runtime, parent, target, content, source, signal, mode)
    return { messageId: String(messageId), mode, via: 'host-deliver' }
  }
  if (typeof runtime.sendMessage !== 'function') {
    throw new Error(
      'code-factory: 该 host 既没有 Symbol.for("dsh.subagent.deliverPrompt") 投递器，也没有 sendMessage —— '
        + '无法向成员投递消息（成员叫不醒）。请确认 @deepseek-ai/dsh-subagent 版本与 composition。',
    )
  }
  const messageId = await runtime.sendMessage(parent, target, content, { signal })
  return { messageId: String(messageId), mode: 'steer', via: 'sendMessage' }
}

/**
 * Requests cancellation of one member's current turn.
 *
 * Fire-and-return, and deliberately never throwing: an interrupt is
 * best-effort cleanup (`interrupt` documented "an absent target … is an
 * accepted no-op"), and a failing interrupt must not fail the tool call that
 * asked for it. The caller records the outcome for the feed.
 *
 * @param runtime - `ctx.subagents`.
 * @param parent - the exact live direct parent (the captain agent).
 * @param childId - the member's durable child session id.
 * @returns `true` when the authority was accepted, `false` for a failed call.
 */
export function interruptMemberTurn(
  runtime: Context['subagents'],
  parent: Agent,
  childId: string,
): { readonly ok: boolean; readonly error?: string } {
  try {
    runtime.interrupt(asSessionId(childId), { kind: 'ancestor', agent: parent })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

/**
 * Releases selected resident children of one parent.
 *
 * Successor of the removed `drainContinuableChildren(parent, childIds)`: the
 * 0.2.1 surface spells the same operation `drainChildren` — "Release selected
 * resident direct children of one exact live parent" — while
 * `drainDescendants(parents)` closes admission for whole forests and is the
 * host's own teardown path, which would over-reach here.
 *
 * @param runtime - `ctx.subagents`.
 * @param parent - the exact live direct parent.
 * @param childIds - durable child ids to release.
 * @returns `{ok:false, error}` instead of throwing, so a teardown path can
 *   report per-member failures and still finish draining the rest.
 */
export async function drainMemberChildren(
  runtime: Context['subagents'],
  parent: Agent,
  childIds: readonly string[],
): Promise<{ readonly ok: boolean; readonly error?: string }> {
  if (childIds.length === 0) return { ok: true }
  try {
    if (typeof runtime.drainDescendants === 'function') {
      // 0.2.2 removed the selected-child drain. `drainDescendants([parent])`
      // closes the exact captain's whole subagent tree, which is the factory's
      // member set for halt/delete/archive cleanup.
      await runtime.drainDescendants([parent])
      return { ok: true }
    }
    // Legacy/test host fallback: 0.2.1 exposed selected-child drain.
    const legacy = runtime as unknown as {
      drainChildren?: (parent: Agent, ids: readonly string[]) => Promise<void>
    }
    if (typeof legacy.drainChildren === 'function') {
      await legacy.drainChildren(parent, childIds.map((id) => asSessionId(id)))
      return { ok: true }
    }
    return { ok: false, error: 'code-factory: 该 host 不提供 drainDescendants/drainChildren，成员无法回收' }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}

/** One direct-child catalog row, reduced to what a factory needs. */
export interface MemberChildRow {
  readonly id: string
  readonly label: string | undefined
  readonly mode: 'one-shot' | 'continuable' | 'unknown'
  readonly createdAt: number | undefined
}

/**
 * Reads the parent's durable direct-child catalog.
 *
 * Used to reconcile `factory.json` against reality after a restart (a member
 * whose session id is still recorded but whose catalog row is gone must not be
 * woken blindly). Rows are mapped defensively: the projection shape has changed
 * between harness generations (`activity` was added then made residency-only),
 * so anything unrecognised degrades to `mode: 'unknown'` instead of throwing.
 *
 * @param runtime - `ctx.subagents`.
 * @param parentSessionId - the captain's session id.
 * @param signal - optional cancellation.
 * @param onReadError - optional sink for *why* the catalog could not be read.
 *   The `undefined` return already tells the caller "unreadable" (it becomes
 *   `catalogReadable: false`); without this sink the reason is lost, which is the
 *   difference between "the harness has no catalog" and "reading it threw".
 * @returns the rows, or `undefined` when the catalog could not be read at all.
 */
export async function listMemberChildren(
  runtime: Context['subagents'],
  parentSessionId: string,
  signal?: AbortSignal,
  onReadError?: (detail: string) => void,
): Promise<readonly MemberChildRow[] | undefined> {
  try {
    if (typeof runtime.listDescendants === 'function') {
      // `listChildren` was removed in 0.2.2; the recursive list is the supported
      // catalog reader. Keep only direct children (depth 1), which is what the
      // factory reconciliation contract needs, and skip branch diagnostics.
      const rows = await runtime.listDescendants(asSessionId(parentSessionId), signal)
      const direct: MemberChildRow[] = []
      for (const row of rows) {
        if (row.kind !== 'child' || row.depth !== 1) continue
        const mode = row.mode === 'one-shot' || row.mode === 'continuable' ? row.mode : 'unknown'
        direct.push({
          id: String(row.id),
          label: typeof row.label === 'string' ? row.label : undefined,
          mode,
          createdAt: undefined,
        })
      }
      return direct
    }
    // Legacy/test host fallback.
    const legacy = runtime as unknown as {
      listChildren?: (parentSessionId: SessionId, signal?: AbortSignal) => Promise<readonly {
        id: SessionId
        label?: string
        mode?: string
        createdAt?: number
      }[]>
    }
    if (typeof legacy.listChildren !== 'function') return undefined
    const rows = await legacy.listChildren(asSessionId(parentSessionId), signal)
    return rows.map((row) => ({
      id: String(row.id),
      label: typeof row.label === 'string' ? row.label : undefined,
      mode: row.mode === 'one-shot' || row.mode === 'continuable' ? row.mode : 'unknown',
      createdAt: typeof row.createdAt === 'number' ? row.createdAt : undefined,
    }))
  } catch (error) {
    onReadError?.(`subagent catalog read failed for session ${parentSessionId}: ${describeError(error)}`)
    return undefined
  }
}

/* ------------------------------------------------------ lenient toolFilter */

/**
 * Names a `tools.restrict()` rejection reported as unknown, or an empty list for
 * every other failure.
 *
 * The host names the offenders verbatim and quotes only them:
 * `tools.restrict() names unknown global tool "x", "y"; known global tools: a, b`
 * (`dsh-tools/lib/index.js:2908`). Quoted names are therefore exactly the
 * unknown ones — the "known" list is comma-joined without quotes.
 *
 * @param error - the thrown value.
 * @returns the unknown names; empty when the failure is not an unknown-name report.
 */
export function unknownToolNamesFromError(error: unknown): readonly string[] {
  const message = describeError(error)
  if (!message.includes('unknown global tool')) return []
  return [...message.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '').filter((name) => name.length > 0)
}

/** `SubagentError` / `HarnessError` code carried by a failure, when present. */
export function errorCodeOf(error: unknown): string | undefined {
  const code = (error as { readonly code?: unknown } | undefined)?.code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

/**
 * True when a member delivery failed because the child session can never be
 * resumed — the one failure that re-delivering cannot fix.
 *
 * The harness raises this class of failure from the cold-resume path:
 *  - `SubagentError('subagent "<id>" is unavailable', 'NOT_RESUMABLE')` —
 *    `dsh-subagent/lib/index.js:1911` and `:1938`
 *  - `SubagentError('subagent "<id>" has no supported continuation state and
 *    cannot be resumed; choose a different target', 'NOT_RESUMABLE')` —
 *    `dsh-subagent/lib/index.js:1917`
 *  - the remote face maps the same code to `subagent/not-resumable` ("subagent
 *    cannot be resumed") — `dsh-subagent/lib/index.js:78`
 *
 * `HarnessError.code` is the primary criterion
 * (`dsh-llm/lib/types/error.d.ts:12-14`: `readonly code: string`); the message
 * phrases are the fallback for a re-wrapped error that lost its code. The
 * deliberately-excluded sibling is `subagent/delivery-unavailable` ("the child
 * exists but its inbox cannot admit the message now",
 * `dsh-subagent/lib/types/control-types.d.ts:129-132`) — that one is temporary,
 * so it must NOT cost the member its session.
 *
 * @param message - `describeError(error)` from the failed delivery.
 * @param code - `errorCodeOf(error)`, when the caller still holds the raw error.
 * @returns whether the session is provably unresumable.
 */
export function isUnresumableDeliveryError(message: string, code?: string): boolean {
  if (code !== undefined && code.toUpperCase() === 'NOT_RESUMABLE') return true
  const text = typeof message === 'string' ? message : ''
  if (text.includes('subagent/not-resumable')) return true
  return /cannot be resumed|no supported continuation state/i.test(text)
}

/** Outcome of one lenient start attempt. */
export interface LenientStartResult<T> {
  readonly value: T
  /** The filter that finally succeeded (after any drops). */
  readonly filter: ToolRestriction
  /** Names removed from the original filter because the host rejected them. */
  readonly dropped: readonly string[]
}

/**
 * Starts a member, dropping any filter name the host reports as unknown and
 * retrying.
 *
 * Ported from the reference plugin's audited strategy
 * (`harness-compat.js:288`): resolution against the registry view only covers
 * hosts that expose one, so the start itself must survive a name that is
 * registered-but-not-restrictable or a composition that mounted differently.
 * The retry only runs while the filter **strictly shrinks**, so a persistent
 * failure (or any non-unknown-name error) propagates untouched — this can never
 * spin.
 *
 * @param start - performs one start attempt for the given filter.
 * @param filter - the filter to attempt first.
 * @returns the started value, the winning filter, and every name dropped.
 */
export async function startWithLenientFilter<T>(
  start: (filter: ToolRestriction) => Promise<T>,
  filter: ToolRestriction,
): Promise<LenientStartResult<T>> {
  let current: ToolRestriction = { ...filter }
  const dropped: string[] = []
  for (;;) {
    try {
      const value = await start(current)
      return { value, filter: current, dropped }
    } catch (error) {
      const unknown = unknownToolNamesFromError(error)
      const remaining = {
        ...(current.allow !== undefined ? { allow: current.allow.filter((name) => !unknown.includes(name)) } : {}),
        ...(current.deny !== undefined ? { deny: current.deny.filter((name) => !unknown.includes(name)) } : {}),
      }
      const before = (current.allow?.length ?? 0) + (current.deny?.length ?? 0)
      const after = (remaining.allow?.length ?? 0) + (remaining.deny?.length ?? 0)
      if (unknown.length === 0 || after >= before) throw error
      dropped.push(...unknown)
      current = remaining
    }
  }
}

/* -------------------------------------------------- delegation depth guard */

/** Options for {@link installMemberDelegationGuard}. */
export interface MemberDelegationGuardOptions {
  /**
   * Member-relative descendant budget. `0` (default) means members may not
   * delegate at all: any delegation whose parent is itself a member is refused.
   */
  readonly memberDepth?: number
  /** Optional observer for a refused delegation (feed / session event). */
  readonly onRefused?: (info: { readonly parentDepth: number; readonly call: string }) => void
  /**
   * Optional observer for a delegation call whose parent depth could not be read.
   * The guard still stands down (that is the only safe answer), but a depth probe
   * that throws is precisely the call the depth budget exists to bound, so it is
   * reported instead of vanishing.
   */
  readonly onProbeError?: (info: { readonly call: string; readonly reason: string }) => void
}

/** One guarded runtime method. */
interface GuardedMethod {
  readonly key: string
  readonly descriptor: PropertyDescriptor | undefined
  readonly installed: (...args: unknown[]) => unknown
}

function parentOf(args: readonly unknown[]): unknown {
  const first = args[0] as { request?: { parent?: unknown }; parent?: unknown } | undefined
  return first?.request?.parent ?? first?.parent
}

/**
 * Installs the parent-chain delegation guard above the running runtime.
 *
 * **Why this exists**: `SubagentStartRequest.maxDepth` cannot express
 * "this member may not delegate". It is documented as an *absolute cap on this
 * creation* — "its computed depth must be less than or equal to this non-negative
 * safe integer" — and the continuation manager enforces exactly that
 * (`dsh-subagent/lib/types/child-agent.js:32-38`: `childDepth = parent + 1`, then
 * `childDepth > maxDepth ⇒ SubagentDepthError`). A captain at depth 0 has depth-1
 * children, so `maxDepth: 0` **rejects the member itself**; and the cap is not
 * inherited by the member's own later delegations, so it buys no descendant
 * budget at all. The reference plugin reached the same conclusion and forwards no
 * `maxDepth` (`members.js:534-536`), enforcing the budget with a guard instead.
 *
 * Members are therefore bounded twice: their toolFilter hides every delegation
 * tool (`computeMemberToolFilter`), and this guard refuses a delegation call
 * whose parent chain is already inside the factory. The guard is defence in
 * depth — it also covers a renamed or dynamically registered delegation tool.
 *
 * 0.2.1-rc.2 moved the start-time filter out of the public start request (the
 * host composes a fresh child from the preset composition), so on that host this
 * guard is the *remaining* runtime-enforced boundary for member delegation.
 *
 * The wrapper preserves the exact receiver and is restored from the original own
 * descriptor on dispose; when the method is inherited (no own descriptor) the
 * own property is deleted again, so a cordis reload leaves the runtime as it was.
 *
 * @param ctx - the plugin context (injects `subagents`).
 * @param options - descendant budget and refusal observer.
 * @returns the disposer that removes both guards.
 */
export function installMemberDelegationGuard(
  ctx: Context,
  options: MemberDelegationGuardOptions = {},
): () => void {
  const memberDepth = options.memberDepth ?? 0
  const runtime = ctx.subagents
  if (runtime === undefined || runtime === null) return () => undefined
  const table = runtime as unknown as Record<string, unknown>
  const guarded: GuardedMethod[] = []

  const wrap = (key: string): void => {
    const original = table[key]
    if (typeof original !== 'function') return
    const originalFn = original as (...args: unknown[]) => unknown
    const descriptor = Object.getOwnPropertyDescriptor(runtime, key)
    const installed = function guardedDelegation(this: unknown, ...args: unknown[]): unknown {
      const parent = parentOf(args)
      let depth: number | undefined
      if (parent !== undefined && parent !== null) {
        try {
          depth = delegationDepthOf(parent as Agent)
        } catch (error) {
          // Unreadable depth means "cannot prove this call is inside the factory",
          // so the guard lets it through — but that is exactly the delegation the
          // depth budget exists to bound, and it must not disappear without trace.
          options.onProbeError?.({ call: key, reason: describeError(error) })
          depth = undefined
        }
      }
      if (depth !== undefined && depth > memberDepth) {
        options.onRefused?.({ parentDepth: depth, call: key })
        throw new Error(
          `code-factory: 成员（委派深度 ${depth}）不得再派生子代理 —— 这是工厂的深度 0 约束。`
            + '请改用 factory_report / factory_block 把问题上报队长。',
        )
      }
      return originalFn.apply(this === undefined ? runtime : this, args)
    }
    try {
      Object.defineProperty(runtime, key, {
        value: installed,
        writable: true,
        configurable: true,
        enumerable: descriptor?.enumerable ?? false,
      })
    } catch {
      // A frozen or proxy-wrapped runtime cannot be wrapped; the delegation
      // guard stands down rather than replacing the runtime. On a host that
      // honours the start-time filter the member surface is still narrowed;
      // on 0.2.1 (which does not) this is the remaining boundary, so a failed
      // installation is reported by the caller's own feed, never hidden here.
      return
    }
    guarded.push({ key, descriptor, installed })
  }

  wrap('start')
  wrap('startActivation')

  return () => {
    for (const entry of guarded) {
      const current = Object.getOwnPropertyDescriptor(runtime, entry.key)
      if (current?.value !== entry.installed) continue
      if (entry.descriptor === undefined) {
        Reflect.deleteProperty(runtime, entry.key)
      } else {
        Object.defineProperty(runtime, entry.key, entry.descriptor)
      }
    }
    guarded.length = 0
  }
}

/* ------------------------------------------------------------- providers */

/**
 * Reads one provider for diagnostics. Kept here because `getProvider` / `list`
 * are part of the same version-sensitive registry surface as the rest of this
 * file; the *policy* decision lives in `provider-guard.ts`.
 *
 * @param ctx - the plugin context.
 * @param name - the provider name.
 * @returns the provider or `undefined`.
 */
export function lookupProvider(ctx: Context, name: string): SubagentProvider | undefined {
  const runtime = ctx.subagents
  if (runtime === undefined || runtime === null || typeof runtime.getProvider !== 'function') return undefined
  try {
    return runtime.getProvider(name)
  } catch (error) {
    // `undefined` says "no such provider" to every caller — and `provider-guard`
    // turns that into the refusal message "没有名叫 … 的 provider / 当前已注册:
    // （无）", which would be asserting something the registry refused to answer.
    logLine(ctx, 'warn', `subagent provider lookup failed for "${name}": ${describeError(error)}`)
    return undefined
  }
}

/**
 * True when this provider can establish continuable children.
 *
 * Method presence **is** the capability: "Method presence selects local
 * activation execution. Providers without it execute through `start` and do not
 * accept subsequent messages" (`dsh-subagent/lib/types/types.d.ts:327-340`).
 * This is deliberately not a `SubagentCapabilities` check — those flags describe
 * which *start-time options* a backend honours, while a provider without
 * `prepareContinuable` cannot establish a continuable child at all.
 *
 * @param provider - the provider to test.
 * @returns whether a continuable start may be attempted.
 */
export function supportsContinuable(provider: SubagentProvider | undefined): boolean {
  return provider !== undefined && provider !== null && typeof provider.prepareContinuable === 'function'
}

/** Message id type re-export so callers need one import for the seam. */
export type { MessageId }
