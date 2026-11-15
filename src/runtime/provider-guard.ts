/**
 * provider-guard.ts — the provider preflight every member spawn runs first.
 *
 * The rule this module implements (API-CONTRACTS §1.4, re-verified against the
 * 0.2.2-rc.3 `.d.ts`): a **continuable** child is established by the
 * continuation manager, and the one provider capability that decides whether a
 * provider can establish one is `prepareContinuable` — "Method presence selects
 * local activation execution. Providers without it execute through start and do
 * not accept subsequent messages" (`types.d.ts:327-340`).
 *
 * `SubagentCapabilities` is a separate, narrower contract: the start-time options
 * a backend supports (`agentOptions` / `agentPreset` / `outputSchema` /
 * `depthLimit`, `types.d.ts:109-121`), which the host validates against the
 * actual start request. This guard deliberately does not duplicate that
 * validation; it decides only what a *continuable* spawn depends on — the
 * service and the `prepareContinuable` method.
 *
 * What moved in 0.2.2-rc.3: the start request is flat and `persona` /
 * `toolFilter` are gone; the persona is merged into the initial prompt and
 * captain tools are hidden from delegated agents by step-admission conditions.
 * Provider discovery also lost `list()`; only `getProvider(name)` remains. See
 * `docs/API-CONTRACTS.md` §1.4.
 *
 * There is no silent degradation anywhere in this file: an unsupported provider
 * produces a typed error that names the problem and the fix.
 *
 * @module dsh-code-factory/runtime/provider-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { lookupProvider, supportsContinuable } from './compat.js'

/* ------------------------------------------------------------------ verdict */

/** Outcome of a provider preflight. `ok: false` must abort the spawn. */
export interface MemberProviderVerdict {
  readonly ok: boolean
  /** The provider name that was requested. */
  readonly name: string
  /** The resolved provider when it exists (even when it is not continuable). */
  readonly provider?: SubagentProvider
  /** Every registered provider name, for the error message. */
  readonly available: readonly string[]
  /** Registered providers that *do* support continuable children. */
  readonly continuableCapable: readonly string[]
  /** Short machine-ish code for the failure kind. */
  readonly code?: 'no-service' | 'empty-name' | 'no-provider' | 'not-continuable'
  /** Human-readable reason plus the suggested fix, empty when `ok`. */
  readonly reason?: string
}

/* ------------------------------------------------------------------- error */

/** Error thrown by {@link requireMemberProvider}; carries the full verdict. */
export class MemberProviderError extends Error {
  readonly verdict: MemberProviderVerdict

  constructor(verdict: MemberProviderVerdict) {
    super(verdict.reason ?? `code-factory: subagent provider "${verdict.name}" 不可用于成员创建`)
    this.name = 'MemberProviderError'
    this.verdict = verdict
  }
}

/* --------------------------------------------------------------- functions */

/** The default provider name used by `Config.memberProvider` (API-CONTRACTS §1.1). */
export const DEFAULT_MEMBER_PROVIDER = 'spawn'

/**
 * Inspects one provider without throwing.
 *
 * @param ctx - the plugin context (injects `subagents`).
 * @param name - the provider name from plugin config.
 * @returns the verdict; `ok: false` carries the reason and the suggestion.
 */
export function inspectMemberProvider(ctx: Context, name: string): MemberProviderVerdict {
  const requested = typeof name === 'string' ? name.trim() : ''
  // 0.2.2 removed provider enumeration (`list()`); `getProvider` is the only
  // lookup. Report what the requested name resolves to instead of inventing a
  // registry listing.
  const requestedProvider = requested === '' ? undefined : lookupProvider(ctx, requested)
  const available = requestedProvider === undefined ? [] : [requested]
  const continuableCapable = requestedProvider !== undefined && supportsContinuable(requestedProvider) ? [requested] : []

  if (ctx.subagents === undefined || ctx.subagents === null || typeof ctx.subagents.startActivation !== 'function') {
    return {
      ok: false,
      name: requested,
      available,
      continuableCapable,
      code: 'no-service',
      reason:
        'code-factory: 本 composition 没有可用的 ctx.subagents.startActivation —— continuable 子代理服务缺失。'
        + '请确认 @deepseek-ai/dsh-subagent 已挂载（插件 inject 需要包含 "subagents"）。',
    }
  }

  if (requested.length === 0) {
    return {
      ok: false,
      name: requested,
      available,
      continuableCapable,
      code: 'empty-name',
      reason:
        'code-factory: memberProvider 为空，无法创建成员。'
        + '请把 Config.memberProvider 设为已注册的 provider 名（例如 "spawn"）；'
        + '0.2.2 的 subagent 服务不再枚举全部 provider，无法在这里列出候选。',
    }
  }

  const provider = requestedProvider
  if (provider === undefined) {
    return {
      ok: false,
      name: requested,
      available,
      continuableCapable,
      code: 'no-provider',
      reason:
        `code-factory: 没有名叫 "${requested}" 的子代理 provider。`
        + '0.2.2 的 subagent 服务不再枚举全部 provider；请确认 profile 挂载了 '
        + `@deepseek-ai/dsh-subagent-spawn-in-process，并把 Config.memberProvider 设为 "provider 注册名"（例如 "${DEFAULT_MEMBER_PROVIDER}"）。`,
    }
  }

  if (!supportsContinuable(provider)) {
    return {
      ok: false,
      name: requested,
      provider,
      available,
      continuableCapable,
      code: 'not-continuable',
      reason:
        `code-factory: provider "${provider.name}" 没有实现 prepareContinuable，无法建立 durable（可继续唤醒的）成员。`
        + '请换用实现了 prepareContinuable 的 provider（例如 "spawn"）。'
        + '注意：continuable 能力只由 prepareContinuable 决定 —— 别拿一次性 start 的能力开关去推断。',
    }
  }

  return { ok: true, name: requested, provider, available, continuableCapable }
}

/**
 * Resolves the member provider or fails loud.
 *
 * @param ctx - the plugin context.
 * @param name - the provider name from plugin config.
 * @returns the provider.
 * @throws {MemberProviderError} when the provider is missing or not continuable.
 */
export function requireMemberProvider(ctx: Context, name: string): SubagentProvider {
  const verdict = inspectMemberProvider(ctx, name)
  if (!verdict.ok || verdict.provider === undefined) throw new MemberProviderError(verdict)
  return verdict.provider
}

/**
 * One-line diagnostic for the feed / `spawnError` field.
 *
 * @param verdict - a failed verdict.
 * @returns the reason, or a generic message for a passing verdict.
 */
export function describeProviderVerdict(verdict: MemberProviderVerdict): string {
  if (verdict.ok) return `provider "${verdict.name}" 可用于成员创建`
  return verdict.reason ?? `provider "${verdict.name}" 不可用`
}
