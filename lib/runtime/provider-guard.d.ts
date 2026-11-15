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
import type { Context } from '@deepseek-ai/cordis';
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent';
/** Outcome of a provider preflight. `ok: false` must abort the spawn. */
export interface MemberProviderVerdict {
    readonly ok: boolean;
    /** The provider name that was requested. */
    readonly name: string;
    /** The resolved provider when it exists (even when it is not continuable). */
    readonly provider?: SubagentProvider;
    /** Every registered provider name, for the error message. */
    readonly available: readonly string[];
    /** Registered providers that *do* support continuable children. */
    readonly continuableCapable: readonly string[];
    /** Short machine-ish code for the failure kind. */
    readonly code?: 'no-service' | 'empty-name' | 'no-provider' | 'not-continuable';
    /** Human-readable reason plus the suggested fix, empty when `ok`. */
    readonly reason?: string;
}
/** Error thrown by {@link requireMemberProvider}; carries the full verdict. */
export declare class MemberProviderError extends Error {
    readonly verdict: MemberProviderVerdict;
    constructor(verdict: MemberProviderVerdict);
}
/** The default provider name used by `Config.memberProvider` (API-CONTRACTS §1.1). */
export declare const DEFAULT_MEMBER_PROVIDER = "spawn";
/**
 * Inspects one provider without throwing.
 *
 * @param ctx - the plugin context (injects `subagents`).
 * @param name - the provider name from plugin config.
 * @returns the verdict; `ok: false` carries the reason and the suggestion.
 */
export declare function inspectMemberProvider(ctx: Context, name: string): MemberProviderVerdict;
/**
 * Resolves the member provider or fails loud.
 *
 * @param ctx - the plugin context.
 * @param name - the provider name from plugin config.
 * @returns the provider.
 * @throws {MemberProviderError} when the provider is missing or not continuable.
 */
export declare function requireMemberProvider(ctx: Context, name: string): SubagentProvider;
/**
 * One-line diagnostic for the feed / `spawnError` field.
 *
 * @param verdict - a failed verdict.
 * @returns the reason, or a generic message for a passing verdict.
 */
export declare function describeProviderVerdict(verdict: MemberProviderVerdict): string;
