/**
 * dsh-code-factory — the plugin entry: **Agent Forge** 的 DSH 落地。
 *
 * A host-plane bundle plugin that turns one session into a multi-agent software
 * factory. The captain (the session's own agent) routes a brief to a task family,
 * assembles a roster, drives a 10-stage pipeline of durable sub-agent members,
 * adjudicates stage gates against real evidence (files, exit codes, git facts),
 * bounces work back along `failGoto` with a written corrective list, and finally
 * runs the 7-item Definition of Done before delivering.
 *
 * ## Activation order (deliberate)
 *
 *   1. **system prompt section** — the captain protocol, at order 118 (after the
 *      delegation-policy section at 117). Registering it first means the very
 *      first model request of a session already carries the two-phase staged
 *      protocol.
 *   2. **tools** — the 3 member tools before the 13 captain tools
 *      (`tools/index.ts`): `runtime/tool-surface` validates the member surface
 *      *before* the first spawn, so the window must not exist.
 *      The parent-chain delegation guard is installed here too: it is the
 *      defence-in-depth half of "members may not spawn subagents".
 *   3. **Web route** — the cockpit's single read-only data channel
 *      (`/plugins/code-factory/state`, API-CONTRACTS §7), mounted **only when this
 *      composition has a browser carrier** (`webServer` / `httpServer`, resolved
 *      defensively). The carrier is web-profile-only, so it is not injected; a
 *      headless composition keeps the whole tool surface and simply has no panel
 *      to poll. See {@link mountWebSurface} for the full rule.
 *   4. **slash command** — `/<factory>`, the deterministic activation surface
 *      (`src/command.ts`, frozen interface), registered through `ctx.inject` so a
 *      minimal composition without a command registry stays fully functional.
 *
 * Every registration goes through `ctx.effect(...)`, so HMR and plugin unload tear
 * down exactly what was added.
 *
 * ## Portable activation (the rule this file exists to keep)
 *
 * `inject` lists only the services the **tool surface** cannot work without
 * (`tools`, `subagents`, `systemPrompt`, `agents`). Everything that belongs to one
 * *host surface* — the browser carrier, the command registry, the workspace
 * registry — is resolved defensively and degrades instead of blocking. A plugin
 * that pends on `webServer` does not activate at all in a headless profile: the
 * observed failure was `code-factory (dsh-code-factory): pending (waiting for
 * service: webServer)` with **zero** `factory_*` tools registered. Web-only
 * features may go missing; the tool surface may not.
 *
 * ## What is NOT here
 *
 * No business logic: the domain layer (`src/domain`) owns the rules, the store
 * (`src/store`) owns durability, the runtime (`src/runtime`) owns member lifecycle
 * and gate execution, and `src/tools` owns the model-facing surface. This file
 * wires them together and resolves configuration.
 *
 * @module dsh-code-factory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { registerFactoryCommand } from './command.js'
import { validateDodItems } from './domain/dod.js'
import { validateAllPipelines } from './domain/pipeline.js'
import { validateRoleRegistry } from './domain/roles.js'
import { DEFAULT_MAX_MEMBERS } from './domain/router.js'
import {
  CAPTAIN_PROTOCOL,
  CAPTAIN_PROTOCOL_NAME,
  CAPTAIN_PROTOCOL_ORDER,
  CAPTAIN_PROTOCOL_SUMMARY,
} from './prompt/index.js'
import { installMemberDelegationGuard } from './runtime/compat.js'
import { DEFAULT_MEMBER_PROVIDER } from './runtime/provider-guard.js'
import { defaultReuseLibraryDir } from './store/library.js'
import { DEFAULT_STATE_DIR } from './store/store.js'
import { DEFAULT_TOOL_FEED_LIMIT, type FactoryToolConfig } from './tools/context.js'
import { registerFactoryTools } from './tools/index.js'
import { registerFactoryStateRoute } from './web/routes.js'

/* ---------------------------------------------------------------- identity */

/** Plugin name (`cordis.patch.yml` mounts the package name `dsh-code-factory`). */
export const name = 'code-factory'

/**
 * Bare service keys this plugin needs **before it can do anything useful**.
 *
 * Only services the tool surface cannot work without are listed. Everything that
 * belongs to one host surface stays out and is resolved defensively instead:
 *
 * | key | why it is not injected |
 * |---|---|
 * | `webServer` / `httpServer` | web-profile-only browser carrier. Injecting it made the plugin `pending (waiting for service: webServer)` in every headless/tui composition — tools and all. See {@link mountWebSurface}. |
 * | `commands` | the slash command is a convenience surface; it is registered through `ctx.inject` so a composition without the command registry still gets the tools. |
 * | `workspaceRegistry` | read defensively inside `src/web/routes.ts` (discovered workspaces + live agent cwd). |
 * | `sessions` | never read: the plugin reaches the log through `exec.agent.session` (the calling agent's own session), so injecting it would only add a blocking dependency. |
 *
 * `agents` stays: `runtime/members.ts` uses it for the live liveness probe, and
 * every composition that can run a factory already has an agent registry.
 */
export const inject = ['tools', 'subagents', 'systemPrompt', 'agents'] as const

/**
 * Service keys that may carry the browser carrier, in priority order.
 *
 * `httpServer` is the older spelling the reference plugin
 * (`@nanmicoder/dsh-agent-teams`) also tries; a composition that mounts only that
 * key must still get the cockpit route.
 */
const WEB_SERVER_KEYS: readonly string[] = ['webServer', 'httpServer']

/* ------------------------------------------------------------------ config */

/**
 * Plugin configuration.
 *
 * Declared as an interface (all fields optional) **and** exported as a
 * schemastery value under the same name — the shape the reference plugin
 * `@nanmicoder/dsh-agent-teams` uses, and the one the loader expects: the type
 * gives `apply()` precise fields, the value validates/coerces the patch.
 * `apply()` still resolves every default itself, so a patch that omits a field
 * (or a composition that passes the raw row config) behaves identically.
 */
export interface Config {
  /** State directory leaf under `<session workspace>/` (default `.code-factory`). */
  stateDir?: string
  /**
   * Root of the **global** cross-project reuse library.
   *
   * Defaults to `path.join(process.env.DSH_HOME || os.homedir(), 'code-factory-library')`
   * (resolved in `apply()`); a relative value is resolved by the library itself.
   * The library is shared by every workspace/profile of this user, which is what
   * makes assets reusable *across* projects.
   */
  libraryDir?: string
  /** `ctx.subagents` provider used to spawn members (`spawn` / `fork`). */
  memberProvider?: string
  /**
   * Member-relative descendant budget. `0` (default) = members may not delegate.
   *
   * Implemented by step-admission conditions that hide captain factory tools
   * from delegated agents, plus the parent-chain guard below — **not** by
   * `maxDepth`, which cannot express it: `maxDepth: 0` rejects the member itself
   * (a captain at depth 0 has depth-1 children) and is not inherited by later
   * delegations. Delegation-shaped tools come from the host preset; the guard
   * refuses their calls from inside a factory tree.
   */
  memberMaxDepth?: number
  /** Roster cap; the iron triangle (`pm` + `qa` + one `*_dev`) is never trimmed. */
  maxMembers?: number
  /** System-prompt section order (default 118 — right after the delegation policy). */
  promptSectionOrder?: number
  /** Register the deterministic `/<factory>` activation command. */
  slashCommand?: boolean
  /** How many mailbox messages a `factory_status` feed keeps. */
  feedLimit?: number
  /**
   * Allow the node fallback command executor when `ctx.subprocess` is missing.
   * Default `false`: without an executor a `script` gate reports a refusal, never
   * a pass — a gate may not pass on evidence that does not exist.
   */
  allowNodeFallback?: boolean
}

/** Schemastery schema for {@link Config}. */
export const Config: z<Config> = z.object({
  stateDir: z.string().default(DEFAULT_STATE_DIR),
  // Resolved once at schema construction; `apply()` still keeps a runtime
  // fallback for raw-row configs that bypass validation.
  libraryDir: z.string().default(defaultReuseLibraryDir()),
  memberProvider: z.string().default(DEFAULT_MEMBER_PROVIDER),
  memberMaxDepth: z.natural().default(0),
  maxMembers: z.natural().min(1).default(DEFAULT_MAX_MEMBERS),
  promptSectionOrder: z.natural().default(CAPTAIN_PROTOCOL_ORDER),
  slashCommand: z.boolean().default(true),
  feedLimit: z.natural().default(DEFAULT_TOOL_FEED_LIMIT),
  allowNodeFallback: z.boolean().default(false),
})

/* ------------------------------------------------------------------- apply */

/**
 * Mounts the plugin.
 *
 * @param ctx - host context (injects `tools`, `subagents`, `systemPrompt`,
 *   `agents`; the browser carrier and the command registry are optional and are
 *   resolved defensively).
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const configuredStateDir = typeof config.stateDir === 'string' ? config.stateDir.trim() : ''
  const stateDir = configuredStateDir === '' ? DEFAULT_STATE_DIR : configuredStateDir
  const promptSectionOrder = Number.isFinite(config.promptSectionOrder)
    ? Math.max(0, Math.trunc(config.promptSectionOrder as number))
    : CAPTAIN_PROTOCOL_ORDER
  const slashCommand = config.slashCommand !== false
  const toolConfig: FactoryToolConfig = {
    ctx,
    stateDir,
    libraryDir: config.libraryDir ?? defaultReuseLibraryDir(),
    memberProvider: config.memberProvider ?? DEFAULT_MEMBER_PROVIDER,
    memberMaxDepth: config.memberMaxDepth ?? 0,
    maxMembers: config.maxMembers ?? DEFAULT_MAX_MEMBERS,
    feedLimit: config.feedLimit ?? DEFAULT_TOOL_FEED_LIMIT,
    allowNodeFallback: config.allowNodeFallback === true,
  }

  // Registry self-check. The domain layer is pure and validated offline
  // (`scripts/verify.mjs`), but a broken registry means every gate verdict and
  // every roster would be wrong — louder here than a mysterious failure later.
  auditRegistries(ctx)

  /* 1. system prompt section: the captain protocol. */
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: CAPTAIN_PROTOCOL_NAME,
        order: promptSectionOrder,
        text: CAPTAIN_PROTOCOL,
      }),
    'code-factory: captain protocol section',
  )

  /* 2. tools: member surface first, then the captain surface. */
  registerFactoryTools(ctx, toolConfig)
  ctx.effect(
    () =>
      installMemberDelegationGuard(ctx, {
        memberDepth: toolConfig.memberMaxDepth,
        onRefused: (info) => {
          try {
            ctx.logger.warn(
              `[code-factory] 拒绝了一次成员委派（depth ${info.parentDepth} via ${info.call}）：成员不得再派生子代理`,
            )
          } catch {
            /* diagnostics must never break dispatch */
          }
        },
        onProbeError: (info) => {
          try {
            ctx.logger.warn(
              `[code-factory] 成员委派深度探测失败（via ${info.call}），本次不作拦截仅记录: ${info.reason}`,
            )
          } catch {
            /* diagnostics must never break dispatch */
          }
        },
      }),
    'code-factory: member delegation guard',
  )

  /* 3. Web route: the cockpit's only data channel — mounted only if this
        composition actually has a browser carrier. */
  mountWebSurface(ctx, stateDir)

  /* 4. slash command: deterministic activation, registered lazily so a
        composition without the command registry keeps the whole tool surface. */
  let commandSurfaceRegistered = false
  if (slashCommand) {
    ctx.inject(['commands'], (commandCtx) => {
      registerFactoryCommand(commandCtx, { enabled: true })
      commandSurfaceRegistered = true
    })
  }

  try {
    const commandState = !slashCommand ? '关' : commandSurfaceRegistered ? '已注册' : '配置开启，等待 commands 服务'
    ctx.logger.info(
      `[code-factory] 已激活：stateDir=${stateDir}，复用库=${toolConfig.libraryDir}，provider=${toolConfig.memberProvider}，`
        + `编制上限=${toolConfig.maxMembers}，斜杠命令=${commandState}。${CAPTAIN_PROTOCOL_SUMMARY}`,
    )
  } catch {
    /* logging must never break activation */
  }
}

/**
 * Audits the pure registries once per activation and reports problems loudly.
 *
 * A warning (not a throw): a broken template should be visible in the log and in
 * `scripts/verify.mjs` output, but refusing to activate would also disable the
 * tools the user needs to inspect the state.
 */
function auditRegistries(ctx: Context): void {
  try {
    const roles = validateRoleRegistry()
    const pipelines = validateAllPipelines()
    const dod = validateDodItems()
    const problems = [...roles.errors, ...pipelines.errors, ...dod.errors]
    if (problems.length === 0) return
    ctx.logger.warn(
      `[code-factory] 注册表自检发现 ${problems.length} 个问题（角色/流水线/DoD）；`
        + `请运行 \`pnpm verify\` 查看完整清单。前几条: ${problems.slice(0, 5).join('；')}`,
    )
  } catch (error) {
    try {
      ctx.logger.warn(`[code-factory] 注册表自检无法完成: ${error instanceof Error ? error.message : String(error)}`)
    } catch {
      /* ignore */
    }
  }
}

/* ---------------------------------------------------------- web carrier */

/**
 * The browser carrier service of this composition, or `undefined` when there is
 * none.
 *
 * `ctx.get(key)` returns `undefined` for a service this composition never
 * provides (and the untyped overload is the documented way to read a service
 * outside the typed `Context` surface), so this needs no cast. A composition that
 * throws for an unknown key is contained: a missing panel must never break
 * activation.
 */
function resolveWebServer(ctx: Context): unknown {
  for (const key of WEB_SERVER_KEYS) {
    try {
      const carrier: unknown = ctx.get(key)
      if (carrier !== undefined && carrier !== null) return carrier
    } catch {
      /* an unknown-key throw is "no carrier", not a failure */
    }
  }
  return undefined
}

/** True when a service name is one of the browser-carrier spellings. */
function isWebServerKey(name: string): boolean {
  return WEB_SERVER_KEYS.some((key) => key === name)
}

/**
 * Registers the cockpit's read-only state route **when, and only when, this
 * composition has a browser carrier**.
 *
 * Why it is not `inject`ed: `webServer` only exists in web profiles, so listing it
 * made the plugin pend forever in headless/tui compositions
 * (`pending (waiting for service: webServer)`) — the tools never registered at
 * all. The panel is a web-only feature; the tool surface is not.
 *
 * The three cases, in order:
 *
 *  1. **carrier present at activation** — the route is mounted immediately inside
 *     `ctx.effect`, exactly as before (web profiles are unchanged);
 *  2. **carrier bound later** — many plugins compose concurrently, so a web
 *     profile can provide the carrier *after* this plugin. The `internal/service`
 *     notification retries the mount, so that profile can never silently lose the
 *     panel (the reference plugin guards the same race);
 *  3. **no carrier ever** — nothing is mounted and nothing is thrown, but the
 *     absence is now reported at `warn` with the consequence spelled out.
 *     It used to be one `debug` line, which meant the user saw a panel stuck on
 *     「等待第一条工厂事件」 while the real cause — no `webServer` in this
 *     composition — was invisible at the default log level. Activation and all
 *     16 tools are unaffected either way; only the panel is.
 *
 * @param ctx - the plugin context.
 * @param stateDir - the resolved state directory leaf handed to the route.
 */
function mountWebSurface(ctx: Context, stateDir: string): void {
  let mounted = false

  const mount = (): void => {
    if (mounted || resolveWebServer(ctx) === undefined) return
    mounted = true
    ctx.effect(
      () => {
        try {
          return registerFactoryStateRoute(ctx, { stateDir })
        } catch (error) {
          // A carrier that rejects the route is an anomaly worth one line, but it
          // must not fail activation: the tool surface does not depend on it.
          try {
            ctx.logger.warn(
              `[code-factory] 驾驶舱状态路由注册失败，面板将不可用（工具面不受影响）: `
                + `${error instanceof Error ? error.message : String(error)}`,
            )
          } catch {
            /* logging must never break activation */
          }
          return () => undefined
        }
      },
      'code-factory: state route',
    )
  }

  mount()
  if (mounted) return

  // Case 2: wait for the carrier to be provided after this plugin.
  ctx.on('internal/service', (serviceName: string) => {
    if (isWebServerKey(serviceName)) mount()
  })

  try {
    ctx.logger.warn(
      '[code-factory] 本 composition 没有 webServer/httpServer：驾驶舱面板不会出现'
        + '（插件已激活，16 个工具与 mailbox 全部正常，只是没有可视化面板）。'
        + '需要面板就用 web profile 启动；`dsh plugin --profile web ls` 可确认该 profile 是否装了本插件。',
    )
  } catch {
    /* logging must never break activation */
  }
}
