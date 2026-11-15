/**
 * Browser half of the Code Factory plugin.
 *
 * The DSH Web shell does not import this entry as an ES module. `lib/client.js`
 * is loaded as a classic script that registers one CJS closure factory on
 * `window.__ModuleLoader__` (docs/API-CONTRACTS.md §2.2); the factory must
 * export `apply` and `inject`, and its `require()` resolves only the packages
 * the shell already provides (`react`, `react-dom`, `@deepseek-ai/*`).
 *
 * Layout contributions (docs/API-CONTRACTS.md §2.4):
 *
 *   `main`                        keyed/root   — the full-width cockpit panel
 *   `sidebar.panellist`           list/root    — the entry icon that opens it
 *   `conversation.chat.turnTail`  list/session — the per-turn factory summary
 *
 * Windows must never hijack another key: `main`'s reserved `conversation` key is
 * untouched, and every list entry uses a fresh `id`.
 *
 * ---------------------------------------------------------------------------
 * Type environment: declaration-only imports
 *
 * `Context.slots` is declared by `@deepseek-ai/dsh-client-ui-renderer`, and the
 * `sidebar.panellist` `SlotMap` entry by `@deepseek-ai/dsh-client-ui-sidebar`.
 * The shell provides both at runtime, so they stay `devDependencies`; they are
 * imported below purely for their declaration merging, and every one of these
 * `import type` statements is erased at build time (the bundle still `require`s
 * only `react` and `react/jsx-runtime`).
 *
 * With those declarations in the program, each `register()` call in this file is
 * checked against the real `SlotCore.register` overloads. That is what enforces
 * the kind/field split instead of leaving it to a comment: a keyed slot accepts
 * `key` + `priority`, a list slot accepts `id` + `order`, and a field the slot's
 * kind does not know is now a compile error rather than a silently ignored one.
 * ---------------------------------------------------------------------------
 *
 * @module dsh-code-factory/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Declaration-only: makes `Context.locale`'s merge and the typed
// `register`/`bind` overloads visible to this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Declaration-only: `Context.slots: SlotRegistry`, the typed registration face.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Declaration-only: `SlotMap['sidebar.panellist']` (and, through it, the
// ui-layout declarations for `SlotMap['main']` and `Context.layout`).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Declaration-only: the chat-owned `SlotMap` entries, including
// `conversation.chat.turnTail`.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// Declaration-only: `SessionStandardProps` (the `sessionId` seat every
// session-scope slot receives). It currently also arrives through chat's own
// type graph, but the card depends on it directly, so it is declared directly.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// The layout's compile-time brander. Bundled, not required: `dsh-brand` declares
// no `dsh.client` manifest, so the shell never registers it as a client module.
import { brandString } from '@deepseek-ai/dsh-brand'
import type { FactoryInjectedProps } from './FactoryCockpit.js'
import { FactoryCockpit, FactorySidebarEntry, FactoryTurnCard } from './FactoryCockpit.js'
import { CODE_FACTORY_STATE_ROUTE, FACTORY_POLL_MS } from './api.js'
import { CODE_FACTORY_LOCALE_NAMESPACE, en, zh } from './locales.js'
import { FACTORY_CSS } from './styles.js'

/* ---------------------------------------------------------------- identity */

/**
 * Re-exports for offline verification.
 *
 * The shell only consumes `apply` and `inject`, but the pure pieces below —
 * the presentational body, the payload validators, the stylesheet, and both
 * dictionaries — are what a headless check can assert against without a live
 * host. They cost nothing in the bundle: every one of them is already in it.
 */
export {
  ArtifactsContent,
  ArtifactsSection,
  CopyButton,
  DockModule,
  DodContent,
  DodSection,
  EvolutionContent,
  EvolutionSection,
  FactoryCockpit,
  FactoryCockpitBody,
  FactoryCockpitHeader,
  FactorySidebarEntry,
  FactoryTurnCard,
  FeedContent,
  FeedSection,
  FilterChip,
  IMPROVEMENT_FILTERS,
  IMPROVEMENT_PREVIEW_LIMIT,
  ImprovementsPanel,
  LayoutMenu,
  MessageRow,
  PANEL_MODULE_MIME,
  PanelBoard,
  RoleAvatar,
  RosterContent,
  RosterPanel,
  StageInspectorPanel,
  buildStageInspector,
  cockpitPollTarget,
  filterArtifacts,
  filterDod,
  filterFeedMessages,
  filterImprovements,
  filterLessons,
  filterMembers,
  improvementProposals,
  planModuleDrop,
  resolveLessonRole,
  sortArtifacts,
} from './FactoryCockpit.js'
export type {
  ArtifactFilterOptions,
  ArtifactSortMode,
  ArtifactsContentProps,
  ArtifactsSectionProps,
  DockModuleProps,
  DodContentProps,
  DodFilter,
  DodSectionProps,
  EvolutionContentProps,
  EvolutionSectionProps,
  FactoryCockpitBodyProps,
  FactoryCockpitHeaderProps,
  FactoryCockpitProps,
  FactoryInjectedProps,
  FactorySidebarEntryProps,
  FactoryTurnCardProps,
  FeedContentProps,
  FeedFilterOptions,
  FeedKindFilter,
  FeedSectionProps,
  ImprovementFilterMode,
  ImprovementsPanelProps,
  LayoutMenuProps,
  LessonFilterMode,
  MemberSortMode,
  MemberStatusFilter,
  PanelBoardProps,
  PanelModuleMeta,
  RosterContentProps,
  RosterPanelProps,
  StageInspector,
  StageInspectorPanelProps,
  StageInspectorRole,
} from './FactoryCockpit.js'
export {
  DEFAULT_COLUMN_WIDTHS,
  DEFAULT_MODULE_COLUMN,
  LAYOUT_STORAGE_KEY,
  MAX_COLUMN_WIDTH,
  MAX_MODULE_HEIGHT,
  MIN_COLUMN_WIDTH,
  MIN_MODULE_HEIGHT,
  PANEL_COLUMN_IDS,
  PANEL_MODULE_IDS,
  clearModuleHeight,
  createDefaultLayout,
  hideModule,
  isModuleVisible,
  isPanelColumnId,
  isPanelModuleId,
  modulePlacement,
  moveModule,
  normaliseLayout,
  readLayout,
  resetLayout,
  serializeLayout,
  setColumnWidth,
  setModuleCollapsed,
  setModuleHeight,
  showModule,
  toggleModuleCollapsed,
  visibleModuleIds,
  writeLayout,
} from './layout.js'
export type {
  LayoutStorage,
  PanelColumnId,
  PanelColumnWidths,
  PanelLayout,
  PanelModuleId,
} from './layout.js'
export {
  CODE_FACTORY_STATE_ROUTE,
  FACTORY_ID_PARAM,
  FACTORY_POLL_MS,
  SESSION_ID_PARAM,
  currentSessionId,
  factoryStateUrl,
  isFullSnapshot,
  namesFactory,
  normalizeEvolution,
  normalizeFactories,
  normalizeImprovement,
  normalizePayload,
  normalizeSnapshot,
  useFactoryState,
  useNow,
} from './api.js'
export type {
  FactoryEntry,
  FactoryLinkStatus,
  FactoryStateFeed,
  NormalizedPayload,
  PollTarget,
  UseFactoryStateOptions,
} from './api.js'
export { CODE_FACTORY_LOCALE_NAMESPACE, en, zh } from './locales.js'
export type { CodeFactoryLocaleKey, CodeFactoryTranslate } from './locales.js'
export {
  FACTORY_CSS,
  FALLBACK_ROLE_COLORS,
  FEED_KIND_COLOR,
  LINK_COLOR,
  MEMBER_STATUS_COLOR,
  PHASE_COLOR,
  STAGE_STATUS_COLOR,
  TOKEN,
  roleInk,
  roleSwatch,
  wash,
} from './styles.js'
export {
  IMPROVEMENT_LIMIT,
  IMPROVEMENT_MIN_EVIDENCE,
  deriveImprovements,
  improvementStats,
} from '../domain/improvements.js'
export type { ImprovementStats, ImprovementTargetDecision } from '../domain/improvements.js'

/**
 * Required services, as bare cordis service keys.
 *
 * `slots` is the renderer-provided composition registry this plugin contributes
 * to, `locale` backs the `codeFactory` dictionaries and the `t` seat, and
 * `layout` is what lets the entry points bring the panel to the front. The
 * shell provides all three; the type-only imports above are what make their
 * declarations visible to this program.
 */
export const inject = ['slots', 'locale', 'layout']

/** `main`-slot key of the cockpit panel; shared with the sidebar entry id. */
export const CODE_FACTORY_MAIN_KEY = 'code-factory'

/**
 * The single rank this plugin registers at, expressed in each slot's own
 * vocabulary: `priority` for the keyed `main` slot (cell shadow rank) and
 * `order` for the two list entries (ascending row order). One number, because
 * the cockpit and its entry points belong to the same visual rank.
 */
export const CODE_FACTORY_PANEL_RANK = 60

/** Stable id of the turn-tail contribution. */
export const CODE_FACTORY_TURN_CARD_ID = 'code-factory-summary'

/** Element id of the injected stylesheet, so HMR reloads reuse one node. */
export const CODE_FACTORY_STYLE_ID = 'dsh-code-factory-styles'

/* -------------------------------------------------------------- internals */

/**
 * Publish the cockpit stylesheet into `document.head`.
 *
 * A single owned node keeps the three contributions deduplicated and lets the
 * plugin disposer take the styles back out. HMR replaces the contents in place
 * so a reload does not flash the panel unstyled.
 *
 * @returns disposer removing the node this call created.
 */
function installStylesheet(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const existing = document.getElementById(CODE_FACTORY_STYLE_ID)
  const created = existing === null
  const style = existing instanceof HTMLStyleElement ? existing : document.createElement('style')
  if (created || !(existing instanceof HTMLStyleElement)) {
    style.id = CODE_FACTORY_STYLE_ID
    style.setAttribute('data-plugin', 'dsh-code-factory')
    document.head.appendChild(style)
  }
  style.textContent = FACTORY_CSS
  return () => {
    if (created) style.remove()
  }
}

/**
 * Apply the layout's compile-time panel brand to a `main` key.
 *
 * `ILayout.selectPanel` takes a `MainPanelId`, i.e. `Branded<'MainPanelId'>`
 * (`string & { readonly [BRAND]: … }`), so a plain `string` cannot be passed.
 * The value really is the registered `main` key — {@link CODE_FACTORY_MAIN_KEY}
 * is what the panel is registered under — and `brandString` is the framework's
 * own brander for exactly this bridge.
 *
 * `@deepseek-ai/dsh-brand` is intentionally bundled rather than required: it
 * declares no `dsh.client` manifest, so the shell never registers it with
 * `window.__ModuleLoader__` (see the computed external list in
 * `tsdown.config.ts`). Requiring it would throw in the browser and abort
 * activation of the whole plugin.
 *
 * @param key - a registered `main` key.
 * @returns the same string as a `MainPanelId`.
 */
function mainPanelId(key: string): MainPanelId {
  return brandString<MainPanelId>(key)
}

/**
 * Bring this plugin's central panel to the front.
 *
 * `selectPanel` throws when the key is not registered (for example while this
 * plugin is being torn down), so the click handler contains it.
 *
 * @param layout - the panel-navigation face published by `ctx.layout`.
 */
function openCockpitPanel(layout: Context['layout'] | undefined): void {
  try {
    layout?.selectPanel(mainPanelId(CODE_FACTORY_MAIN_KEY))
  } catch (error) {
    console.warn('code-factory: cannot select the cockpit panel', error)
  }
}

/* ------------------------------------------------------------------ apply */

/**
 * Client plugin body: register the typed dictionaries, publish the stylesheet,
 * and mount the cockpit plus its two entry points.
 *
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(CODE_FACTORY_LOCALE_NAMESPACE)

  ctx.effect(() => ctx.locale.register(CODE_FACTORY_LOCALE_NAMESPACE, { zh, en }), 'code-factory: dictionaries')
  ctx.effect(() => installStylesheet(), 'code-factory: stylesheet')

  const injected = (): FactoryInjectedProps => ({
    route: CODE_FACTORY_STATE_ROUTE,
    pollMs: FACTORY_POLL_MS,
    openCockpit: () => openCockpitPanel(ctx.layout),
  })

  ctx.effect(
    () =>
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: CODE_FACTORY_MAIN_KEY,
            priority: CODE_FACTORY_PANEL_RANK,
            locale: CODE_FACTORY_LOCALE_NAMESPACE,
            inject: injected,
          },
          FactoryCockpit,
        ),
      ),
    'code-factory: cockpit panel',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: CODE_FACTORY_MAIN_KEY,
            order: CODE_FACTORY_PANEL_RANK,
            label: () => t('entry.label'),
            locale: CODE_FACTORY_LOCALE_NAMESPACE,
            inject: injected,
          },
          FactorySidebarEntry,
        ),
      ),
    'code-factory: sidebar entry',
  )

  ctx.effect(
    () =>
      ctx.slots.inject('conversation.chat.turnTail', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: CODE_FACTORY_TURN_CARD_ID,
            order: 50,
            locale: CODE_FACTORY_LOCALE_NAMESPACE,
            inject: injected,
          },
          FactoryTurnCard,
        ),
      ),
    'code-factory: turn summary',
  )
}
