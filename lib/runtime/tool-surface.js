/**
 * tool-surface.ts — the **member tool surface**: what a member may see, and the
 * name-liveness check every spawn must pass first.
 *
 * Why this file exists (API-CONTRACTS §3 陷阱 #6):
 * a scoped `tools.restrict()` rejects **unknown names with a hard error**:
 *
 *   `tools.restrict() names unknown global tool "x"; known global tools: a, b, c`
 *   — `node_modules/@deepseek-ai/dsh-tools/lib/index.js:3004` (0.2.1-rc.2)
 *
 * A single unknown name therefore aborts **every** member spawn that lets the
 * host apply the filter. The reference plugin learned this the hard way (#163,
 * #164) and its fix is the model this module follows: resolve the filter against
 * the *running host's* registry view first, then let the caller retry without
 * any name the host reports as unknown (`compat.startWithLenientFilter`).
 *
 * 0.2.2-rc.3 note: `toolFilter` is no longer part of the public start request
 * (`SubagentStartRequest` / `SubagentActivationSpec` dropped it; host tool
 * composition comes from the preset). Captain tools are instead hidden from
 * delegated agents with step-admission conditions (`tools.register(..., { when })`
 * in `tools/captain.ts`). This module keeps the deny-list computation and
 * name-liveness preflight for diagnostics and for older hosts that still honour
 * the field; the 0.2.2 spawn does not send it.
 *
 * Why the member filter is **deny-based**, not `allow`-based:
 * `ToolRestriction.allow` means "keep only these global tools" — a three-entry
 * allow list would strip the member's own `read` / `write` / `edit` / `pwsh`
 * file tools, which is the opposite of what the pipeline needs (members must
 * really read the workspace and really write their artifact). The reference
 * plugin faces the same constraint and also filters with `deny`
 * (`@nanmicoder/dsh-agent-teams/lib/harness-compat.js:251`). The *"members only
 * get the 3 factory tools"* rule is therefore enforced the other way round:
 * every other `factory_*` tool is denied, so `factory_report` / `factory_inbox`
 * / `factory_block` are the only factory tools a member can see.
 *
 * API provenance:
 *  - `ctx.tools.get(name, scope?): ToolDefinition | undefined` — live
 *    `cordis_inspect_query` → host `Service.listService {service:'tools'}` and
 *    `node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts:691`.
 *  - `tools.view(scope).restrictableNames` — **runtime-only** surface: `view` is
 *    `private` in the 0.2.1-rc.2 `.d.ts` but is a plain prototype method in the
 *    shipped bundle (`dsh-tools/lib/index.js:3055`, field built at `:3065`).
 *    Probed defensively: absent ⇒ `undefined` ⇒ the static candidate list is
 *    validated name-by-name with `tools.get()` instead.
 *  - `ToolRestriction { allow?, deny? }` —
 *    `node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts:508`.
 *  - `run_code` is reserved by `tools.restrict()` and naming it throws
 *    (`dsh-tools/lib/index.js:3001`) — never emitted by this module.
 *
 * @module dsh-code-factory/runtime/tool-surface
 */
import { logLine } from '../tools/context.js';
import { describeError } from './compat.js';
/* ------------------------------------------------------------------ names */
/**
 * The three member-facing factory tools. This is the member's factory surface —
 * every one of the {@link CAPTAIN_TOOL_NAMES} below is denied for every member.
 *
 * Names are the stable operation names this plugin registers; they are the same
 * three the plan fixes (实施方案 §4.5 「成员工具（3 个）」).
 */
export const MEMBER_BASE_TOOL_NAMES = ['factory_report', 'factory_inbox', 'factory_block'];
/** The member's three factory tools, as a set (name-liveness check target). */
export const MEMBER_BASE_TOOL_SET = new Set(MEMBER_BASE_TOOL_NAMES);
/**
 * The captain-only factory tools (实施方案 §4.5 lists the original twelve; the
 * reuse library adds `factory_reuse`) — and the **single source of truth for the
 * captain tool set** (review finding M14).
 *
 * Nothing else may re-declare these names. `tools/captain.ts` registers exactly
 * this set and re-exports this array as `CAPTAIN_TOOL_ORDER`
 * (`tools/member.ts` does the same for `MEMBER_TOOL_NAMES` above), so adding,
 * renaming or retiring a captain tool is a one-line edit *here*.
 *
 * The array order **is** the registration order in `tools/captain.ts` — the
 * `effect(...)` calls there appear in this order — because that is the one
 * property a name list can carry that the definitions themselves do not. It is
 * the contract an offline structural assertion compares against; the member
 * deny-filter below does not care about order.
 *
 * Why a single list is load-bearing (the silent-drop failure mode this fixes):
 * every candidate is verified against the live registry before it enters a
 * filter, so a name that is listed here but *not* registered is quietly dropped
 * — it lands in `droppedUnknown` and never in `deny`, the member spawn still
 * succeeds, and `factory_x` silently stays visible to every member. Drift in
 * the other direction is worse: a tool that *is* registered but is missing from
 * this list is never denied to anyone, so a member can adjudicate. Neither
 * direction throws, and neither shows up in a spawn result — which is exactly
 * why the set must be declared once and asserted structurally.
 *
 * Also kept as the static fallback for compositions whose registry view is not
 * enumerable; `tools.get()` decides whether each name actually exists — that
 * per-name check is the runtime backstop against precisely the list ↔ registry
 * divergence described above (it degrades a stale name to "dropped", never to a
 * hard `tools.restrict()` failure).
 */
export const CAPTAIN_TOOL_NAMES = [
    'factory_plan',
    'factory_edit_plan',
    'factory_approve',
    'factory_dispatch',
    'factory_gate',
    'factory_status',
    'factory_reuse',
    'factory_message',
    'factory_dod_check',
    'factory_halt',
    'factory_resume',
    'factory_deliver',
    'factory_delete',
];
/** Every factory tool this plugin owns (captain + member). */
export const FACTORY_TOOL_NAMES = [...CAPTAIN_TOOL_NAMES, ...MEMBER_BASE_TOOL_NAMES];
/** Prefix that identifies a tool as owned by this plugin. */
export const FACTORY_TOOL_PREFIX = 'factory_';
/**
 * Names of *delegation* tools — the capability a member at delegation depth 0
 * must not have. The host's delegation tool name is composition configuration,
 * not a constant (`subagent` in one profile, `subagent_fork` in another; the
 * reference plugin documents the same #163/#164 hazard), so this list is a
 * candidate set that is intersected with the live registry.
 */
export const DELEGATION_TOOL_CANDIDATES = [
    'subagent',
    'subagent_fork',
    'send_message',
    'interrupt_agent',
    'list_agents',
    'workflow',
    'spawn_teammate',
];
/**
 * Registry-name patterns that also count as delegation / formal-team surfaces
 * when the registry is enumerable. `agent_teams_*` is the reference plugin's
 * team-management namespace: creating teams and reassigning tasks is the
 * captain's job, never a member's.
 */
export const DELEGATION_NAME_PATTERNS = [
    /^subagent(_|$)/i,
    /^agent_teams_/i,
    /^spawn_teammate$/i,
];
/** `tools.restrict()` refuses this reserved transport name outright. */
export const RESERVED_TOOL_NAME = 'run_code';
/**
 * Reads the host's registry view for one agent.
 *
 * The agent's own scope is the same scope the child's `tools.restrict()` will be
 * validated against, so an agent-scoped view is strictly better than none; when
 * no agent is supplied the plain context view is used.
 *
 * @param ctx - the plugin context (its `tools` service is the fallback probe).
 * @param agent - the delegating (captain) agent, whose scope chain the child
 *   joins. Optional so the probe also works before any agent exists.
 * @returns the probe; `restrictable` is `undefined` when the view is absent.
 */
export function probeToolSurface(ctx, agent) {
    const scoped = agent?.ctx;
    const runtime = (scoped?.tools ?? ctx.tools);
    const scope = agent?.ctx ?? ctx;
    let restrictable;
    if (typeof runtime?.view === 'function') {
        try {
            const names = runtime.view.call(runtime, scope)?.restrictableNames;
            restrictable = names instanceof Set ? names : undefined;
        }
        catch (error) {
            // A composition that reshaped `view` must not break spawning: fall back to
            // the per-name `tools.get()` check below. Reported because, with the view
            // gone, names that are restrictable but not `get`-able are silently dropped
            // from the member's surface — indistinguishable from "no view here".
            logLine(ctx, 'warn', `tools.view probe failed; falling back to per-name tools.get(): ${describeError(error)}`);
            restrictable = undefined;
        }
    }
    // The runtime backstop for the declared lists above (`CAPTAIN_TOOL_NAMES` /
    // `MEMBER_BASE_TOOL_NAMES`): `tools.get()` is what turns "listed" into
    // "really registered". A name that fails this check is dropped from the
    // filter instead of being forwarded to `tools.restrict()`, which rejects an
    // unknown name with a hard error that would abort the spawn.
    let getFailureReported = false;
    const isRegistered = (name) => {
        if (restrictable?.has(name) === true)
            return true;
        if (typeof runtime?.get !== 'function')
            return false;
        try {
            return runtime.get.call(runtime, name) !== undefined;
        }
        catch (error) {
            // `false` means "not registered" and the name is dropped from the filter.
            // A throwing `get` reaches the same answer for a different reason, so say
            // which one it was — once per probe, not once per candidate name.
            if (!getFailureReported) {
                getFailureReported = true;
                logLine(ctx, 'warn', `tools.get("${name}") threw; treating the name as unregistered: ${describeError(error)}`);
            }
            return false;
        }
    };
    return {
        restrictable,
        isRegistered,
        names: () => (restrictable === undefined ? undefined : [...restrictable]),
    };
}
/**
 * Preflight for hard requirement #1: the three member tools must exist before a
 * member is created.
 *
 * A member whose `factory_report` was silently filtered away can never complete
 * its task, so this is checked *before* the spawn instead of discovered as a
 * stuck member later. `tools.get(name)` reads the global layer directly, so the
 * check is authoritative even when the registry view is not enumerable.
 *
 * @param probe - a probe from {@link probeToolSurface}.
 * @returns the audit; `ok: false` must abort the spawn (fail loud).
 */
export function validateMemberBaseTools(probe) {
    const registered = [];
    const missing = [];
    for (const name of MEMBER_BASE_TOOL_NAMES) {
        if (probe.isRegistered(name))
            registered.push(name);
        else
            missing.push(name);
    }
    const ok = missing.length === 0;
    return {
        ok,
        missing,
        registered,
        reason: ok
            ? `成员基础工具已注册: ${registered.join(' / ')}`
            : `成员基础工具未注册: ${missing.join(' / ')} —— 先注册它们（本插件的 member 工具面）再创建成员，`
                + '否则成员无法上报，工厂会卡死',
    };
}
function isDelegationName(name) {
    if (DELEGATION_TOOL_CANDIDATES.includes(name))
        return true;
    return DELEGATION_NAME_PATTERNS.some((pattern) => pattern.test(name));
}
/**
 * Computes the member `toolFilter`.
 *
 * Candidates come from the live registry when it is enumerable (`factory_*`
 * other than the member's three, plus every delegation-shaped name), and from
 * the static lists otherwise. Either way each candidate is verified with
 * {@link ToolSurfaceProbe.isRegistered} before it enters the filter, so the
 * returned filter cannot contain a name `tools.restrict()` would reject.
 *
 * @param probe - a probe from {@link probeToolSurface}.
 * @param input - member depth and extra denials.
 * @returns the filter plus the audit of what was denied and what was dropped.
 */
export function computeMemberToolFilter(probe, input = {}) {
    const memberDepth = input.memberDepth ?? 0;
    const enumerate = probe.names();
    const keep = new Set(input.keep ?? []);
    const factoryCandidates = enumerate === undefined
        ? [...CAPTAIN_TOOL_NAMES]
        : enumerate.filter((name) => name.startsWith(FACTORY_TOOL_PREFIX) && !MEMBER_BASE_TOOL_SET.has(name));
    const delegationCandidates = enumerate === undefined
        ? [...DELEGATION_TOOL_CANDIDATES]
        : [...DELEGATION_TOOL_CANDIDATES, ...enumerate.filter((name) => isDelegationName(name))];
    const candidates = [...factoryCandidates];
    if (memberDepth < 1)
        candidates.push(...delegationCandidates);
    candidates.push(...(input.extraDeny ?? []));
    const denied = [];
    const droppedUnknown = [];
    const factoryDenied = [];
    const seen = new Set();
    for (const candidate of candidates) {
        if (typeof candidate !== 'string' || candidate.length === 0)
            continue;
        if (candidate === RESERVED_TOOL_NAME) {
            droppedUnknown.push(candidate);
            continue;
        }
        if (seen.has(candidate))
            continue;
        seen.add(candidate);
        if (MEMBER_BASE_TOOL_SET.has(candidate) || keep.has(candidate))
            continue;
        if (!probe.isRegistered(candidate)) {
            droppedUnknown.push(candidate);
            continue;
        }
        denied.push(candidate);
        if (candidate.startsWith(FACTORY_TOOL_PREFIX))
            factoryDenied.push(candidate);
    }
    const summary = `成员工具面: 保留 ${MEMBER_BASE_TOOL_NAMES.join(' / ')} + 宿主编码工具；`
        + `拒绝 ${denied.length} 个（factory_* ${factoryDenied.length}${memberDepth < 1 ? '，全部委派工具' : ''}）`
        + (droppedUnknown.length > 0 ? `；剔除未注册名 ${droppedUnknown.length} 个` : '');
    return { filter: { deny: denied }, denied, droppedUnknown, factoryDenied, summary };
}
/**
 * Validates a filter against the live registry: the names in it that
 * `tools.restrict()` would refuse (a name the host does not know, or the
 * reserved transport name).
 *
 * The offline engine drill asserts with it that the filters this plugin really
 * builds — `computeMemberToolFilter`, possibly shrunk by
 * `compat.startWithLenientFilter` — carry no such name, so a spawn cannot be
 * aborted by a filter the plugin itself produced (`scripts/engine-drill.mjs`,
 * stages `00-surface` and `04-approve`).
 *
 * @param probe - a probe from {@link probeToolSurface}.
 * @param filter - the candidate filter.
 * @returns the unknown names (empty when the filter is safe to forward).
 */
export function unknownFilterNames(probe, filter) {
    const names = [...(filter.allow ?? []), ...(filter.deny ?? [])];
    return names.filter((name) => !probe.isRegistered(name) || name === RESERVED_TOOL_NAME);
}
//# sourceMappingURL=tool-surface.js.map