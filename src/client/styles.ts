/**
 * Cockpit styling: theme tokens + a small scoped stylesheet.
 *
 * Two hard rules from docs/API-CONTRACTS.md §2.5:
 *
 *   1. **Every semantic colour is a `--dsw-alias-*` token.** The panel must
 *      render correctly in both light and dark themes, so no status is ever
 *      expressed with a hard-coded hex value.
 *   2. **The 12 role colours are the prototype's classification palette.** They
 *      have no token because they carry no meaning; they are decoration. They
 *      are always mixed toward `--dsw-alias-label-primary`, which keeps the
 *      chip legible on a light background too. If `color-mix()` is unavailable
 *      the declaration is dropped and the text falls back to the inherited
 *      label colour — the chip never becomes unreadable.
 *
 * Layout is CSS-in-JS over a fixed set of `.cf-*` class names: inline style
 * objects cannot express media queries. Responsive behaviour follows the
 * **browser viewport**, never the width the host hands to the panel: the DSH
 * app sidebar can expand/collapse without changing the cockpit's column mode.
 * Do not reintroduce container queries here — see {@link FACTORY_CSS}.
 *
 * @module dsh-code-factory/client/styles
 */

import type { AlertSeverity, FactoryPhase, MemberStatus, MessageKind, StageStatus } from '../shared/types.js'
import type { FactoryLinkStatus } from './api.js'

/* ---------------------------------------------------------------- tokens */

/**
 * The verified theme tokens this panel uses (docs/API-CONTRACTS.md §2.5).
 *
 * Values are `string`: every consumer interpolates them into a `var(...)`
 * expression or hands them to an inline style, where the literal identity of
 * each token adds nothing but a const assertion.
 */
export const TOKEN = {
  bgBase: 'var(--dsw-alias-bg-base)',
  bgLayer1: 'var(--dsw-alias-bg-layer-1)',
  bgLayer2: 'var(--dsw-alias-bg-layer-2)',
  bgOverlay: 'var(--dsw-alias-bg-overlay)',
  borderL1: 'var(--dsw-alias-border-l1)',
  borderL2: 'var(--dsw-alias-border-l2)',
  brand: 'var(--dsw-alias-brand-primary)',
  labelPrimary: 'var(--dsw-alias-label-primary)',
  labelSecondary: 'var(--dsw-alias-label-secondary)',
  success: 'var(--dsw-alias-state-success-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  idle: 'var(--dsw-alias-state-idle-primary)',
  sidebarFill: 'var(--dsw-specific-sidebar-fill)',
}

/* ------------------------------------------------------- semantic colours */

/** Member lifecycle → semantic token. `working` is the only "live" state. */
export const MEMBER_STATUS_COLOR: Readonly<Record<MemberStatus, string>> = {
  staged: TOKEN.idle,
  idle: TOKEN.idle,
  working: TOKEN.brand,
  rework: TOKEN.warn,
  blocked: TOKEN.error,
  done: TOKEN.success,
  error: TOKEN.error,
  removed: TOKEN.idle,
}

/** Members whose LED pulses (still owed work). */
export const PULSING_MEMBER_STATUS: Readonly<Record<MemberStatus, boolean>> = {
  staged: false,
  idle: false,
  working: true,
  rework: true,
  blocked: false,
  done: false,
  error: false,
  removed: false,
}

/** Stage lifecycle → semantic token. */
export const STAGE_STATUS_COLOR: Readonly<Record<StageStatus, string>> = {
  pending: TOKEN.idle,
  active: TOKEN.brand,
  gate: TOKEN.warn,
  passed: TOKEN.success,
  rejected: TOKEN.error,
}

/** Mailbox message kind → semantic token (the feed's left rule). */
export const FEED_KIND_COLOR: Readonly<Record<MessageKind, string>> = {
  system: TOKEN.idle,
  dispatch: TOKEN.brand,
  handoff: TOKEN.brand,
  report: TOKEN.success,
  approval: TOKEN.warn,
  blocked: TOKEN.warn,
  reject: TOKEN.error,
}

/** Factory phase → semantic token. */
export const PHASE_COLOR: Readonly<Record<FactoryPhase, string>> = {
  staged: TOKEN.warn,
  running: TOKEN.brand,
  halted: TOKEN.warn,
  delivered: TOKEN.success,
  discarded: TOKEN.idle,
}

/** Host link status → semantic token. */
export const LINK_COLOR: Readonly<Record<FactoryLinkStatus, string>> = {
  idle: TOKEN.idle,
  connecting: TOKEN.warn,
  live: TOKEN.success,
  stale: TOKEN.warn,
  error: TOKEN.error,
}

/** Alert severity → semantic token: `action` is the danger colour, `attention` the warning colour. */
export const ALERT_SEVERITY_COLOR: Readonly<Record<AlertSeverity, string>> = {
  action: TOKEN.error,
  attention: TOKEN.warn,
}

/* -------------------------------------------------- role classification */

/**
 * Decorative palette keyed by the registry's **canonical** role ids.
 *
 * Keys mirror `src/domain/roles.ts` exactly — the registry roster (including the
 * frontend specialists) plus the add-on jobs — so a lesson card for a role this
 * factory never staffed still gets that role's own colour. Two non-roster parties (`captain` / `system`)
 * are parties the feed can name but the roster never contains; the legacy
 * `sec_eng` spelling is kept as the one alias still found in records written
 * before the registry renamed the security job. Purely decorative: never a
 * status signal.
 */
export const FALLBACK_ROLE_COLORS: Readonly<Record<string, string>> = {
  /* The two feed-only parties. */
  captain: '#22d3ee',
  system: '#94a3b8',
  /* The canonical twelve (src/domain/roles.ts). */
  router: '#22d3ee',
  pm: '#60a5fa',
  ui_designer: '#e879f9',
  sys_arch: '#a78bfa',
  db_arch: '#818cf8',
  api_designer: '#38bdf8',
  security_eng: '#fbbf24',
  fe_dev: '#34d399',
  be_dev: '#2dd4bf',
  reviewer: '#fb923c',
  qa: '#f87171',
  devops: '#94a3b8',
  /* Add-on jobs the registry can staff on request. */
  perf: '#a3e635',
  po: '#f0abfc',
  tech_writer: '#7dd3fc',
  /* Frontend specialists (the split of the old `fe_dev` job). These MUST match
     `src/domain/roles.ts` exactly: the host colour wins when the snapshot carries
     one, and this palette is the fallback for lesson rows whose role this factory
     never staffed (old snapshots / cross-factory lessons). */
  web_dev: '#10b981',
  flutter_dev: '#06b6d4',
  mini_program_dev: '#ec4899',
  /* Legacy spelling of `security_eng`, still present in old lesson records. */
  sec_eng: '#fbbf24',
}

/** Resolve a role's decorative swatch from the snapshot, falling back to the palette. */
export function roleSwatch(role: string, color?: string): string {
  if (color && /^#[0-9a-fA-F]{3,8}$/.test(color)) return color
  return FALLBACK_ROLE_COLORS[role] ?? '#7c8db0'
}

/** Legible role ink: the swatch pulled toward the theme's label colour. */
export function roleInk(swatch: string): string {
  return `color-mix(in oklab, ${swatch} 72%, ${TOKEN.labelPrimary})`
}

/**
 * A translucent wash of any colour — a token or a role swatch.
 *
 * @param color - any CSS colour, including a `--dsw-*` token reference.
 * @param percent - how much of it to keep.
 * @returns a `color-mix()` expression; engines without support drop the
 *   declaration and fall back to whatever the cascade already provided.
 */
export function wash(color: string, percent: number): string {
  return `color-mix(in oklab, ${color} ${percent}%, transparent)`
}

/* --------------------------------------------------------------- stylesheet */

/**
 * One scoped stylesheet for the cockpit, its sidebar entry, and the turn card.
 *
 * Responsive layout follows the **viewport**, not the host panel width. The DSH
 * app sidebar changes the width the host gives this panel; if the rules below
 * reacted to that width, expanding the sidebar would sink the right column while
 * collapsing it restored the wide three-column board — a layout the user cannot
 * control from inside the cockpit. Only the browser-window `@media` breakpoints
 * may stack the columns. (Container queries were removed for exactly this
 * reason: `.cf-root` no longer declares itself a query container.)
 */
export const FACTORY_CSS = `
.cf-root{
  position:relative;display:flex;flex-direction:column;box-sizing:border-box;
  width:100%;height:100%;min-height:0;flex:1 1 auto;overflow:hidden;
  background:${TOKEN.bgBase};color:${TOKEN.labelPrimary};
  font-size:12px;line-height:1.5;
}
.cf-mono{font-family:ui-monospace,SFMono-Regular,'JetBrains Mono','Cascadia Mono',Menlo,Consolas,'Noto Sans SC',monospace}
.cf-scan{
  position:absolute;inset:0;z-index:4;pointer-events:none;
  background:repeating-linear-gradient(to bottom,transparent 0 2px,color-mix(in oklab,${TOKEN.labelPrimary} 3%,transparent) 3px);
  opacity:.55;
}
.cf-scroll{scrollbar-width:thin;scrollbar-color:${TOKEN.borderL2} transparent}
.cf-scroll::-webkit-scrollbar{width:6px;height:6px}
.cf-scroll::-webkit-scrollbar-track{background:transparent}
.cf-scroll::-webkit-scrollbar-thumb{background:${TOKEN.borderL2};border-radius:3px}

/* ---------------------------------------------------------------- header */
.cf-header{
  flex:none;display:flex;align-items:center;gap:16px;flex-wrap:wrap;
  padding:8px 14px;border-bottom:1px solid ${TOKEN.borderL1};
  background:${TOKEN.bgLayer1};
}
.cf-brand{display:flex;align-items:center;gap:9px;min-width:0}
.cf-brand-name{font-size:13px;font-weight:700;letter-spacing:.18em;color:${TOKEN.brand}}
.cf-brand-sub{font-size:9px;letter-spacing:.2em;color:${TOKEN.labelSecondary};white-space:nowrap}
.cf-badge{
  display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:4px;
  border:1px solid ${TOKEN.borderL1};
  font-size:10px;letter-spacing:.16em;white-space:nowrap;
}
.cf-chip{
  display:inline-flex;align-items:center;gap:4px;padding:1px 5px;border-radius:3px;
  border:1px solid ${TOKEN.borderL2};font-size:9px;white-space:nowrap;
}
.cf-mission{flex:1 1 260px;min-width:180px}
.cf-mission-line{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:9px;letter-spacing:.12em;color:${TOKEN.labelSecondary}}
.cf-mission-text{
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  font-size:11px;font-weight:600;letter-spacing:.06em;color:${TOKEN.labelPrimary};
  max-width:100%;word-break:break-word;
}
.cf-mission-text-open{display:block;-webkit-line-clamp:unset;overflow:visible}
.cf-mission-tools{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:3px;font-size:8px;color:${TOKEN.labelSecondary}}
.cf-hits{
  flex:none;display:flex;align-items:center;gap:5px;flex-wrap:wrap;
  padding:4px 14px;border-bottom:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer1};
  font-size:9px;color:${TOKEN.labelSecondary};
}
.cf-bar{height:6px;border-radius:3px;background:${TOKEN.bgLayer2};overflow:hidden;margin-top:5px;border:1px solid ${TOKEN.borderL1}}
.cf-bar-fill{height:100%;border-radius:3px;transition:width .5s cubic-bezier(.22,1,.36,1)}
.cf-metrics{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.cf-metric{display:flex;flex-direction:column;gap:1px;min-width:54px}
.cf-metric-k{font-size:8px;letter-spacing:.18em;color:${TOKEN.labelSecondary}}
.cf-metric-v{font-size:12px;color:${TOKEN.labelPrimary}}
.cf-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.cf-select{
  appearance:none;padding:4px 22px 4px 8px;border-radius:4px;font-size:10px;
  color:${TOKEN.labelPrimary};background:${TOKEN.bgLayer2};
  border:1px solid ${TOKEN.borderL1};max-width:190px;
  background-image:linear-gradient(45deg,transparent 50%,${TOKEN.labelSecondary} 50%),linear-gradient(135deg,${TOKEN.labelSecondary} 50%,transparent 50%);
  background-position:calc(100% - 12px) 50%,calc(100% - 8px) 50%;
  background-size:4px 4px,4px 4px;background-repeat:no-repeat;
}
.cf-select:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-btn{
  display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:4px;cursor:pointer;
  font-size:10px;letter-spacing:.06em;color:${TOKEN.labelPrimary};
  background:${TOKEN.bgLayer2};border:1px solid ${TOKEN.borderL1};
}
.cf-btn:hover{border-color:${TOKEN.brand};color:${TOKEN.brand}}
.cf-btn-on{border-color:${wash(TOKEN.brand, 50)};color:${TOKEN.brand};background:${wash(TOKEN.brand, 10)}}
.cf-btn:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-linkish{
  display:inline-flex;align-items:center;gap:5px;padding:0;border:0;background:none;cursor:pointer;
  color:${TOKEN.brand};font-size:10px;letter-spacing:.08em;
}
.cf-linkish:hover{text-decoration:underline}

/* ---------------------------------------------------------------- alerts */
.cf-alerts{
  flex:none;display:flex;flex-direction:column;gap:4px;
  padding:7px 14px;border-bottom:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer1};
}
.cf-alert{
  display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;
  padding:4px 8px;border-radius:4px;border:1px solid;border-left-width:3px;
}
.cf-alert-title{font-size:11px;font-weight:700}
.cf-alert-detail{font-size:10px;color:${TOKEN.labelSecondary}}
.cf-alert-next{font-size:10px;color:${TOKEN.labelPrimary}}
.cf-alert-chip{
  display:inline-flex;align-items:center;gap:4px;padding:1px 5px;border-radius:3px;
  border:1px solid ${TOKEN.borderL2};font-size:9px;white-space:nowrap;color:${TOKEN.labelSecondary};
}
.cf-alert-more{font-size:9px;color:${TOKEN.labelSecondary}}

/* ------------------------------------------------------------------ body */
.cf-body{
  flex:1 1 auto;min-height:0;display:grid;
  grid-template-columns:var(--cf-left-w,248px) 6px minmax(0,1fr) 6px var(--cf-right-w,380px);
}
.cf-col{display:flex;flex-direction:column;min-width:0;min-height:0;background:${TOKEN.bgLayer1}}
.cf-left{border-right:1px solid ${TOKEN.borderL1};background:${TOKEN.sidebarFill}}
.cf-mid{background:${TOKEN.bgBase}}
.cf-right{border-left:1px solid ${TOKEN.borderL1}}
.cf-col-head{
  flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:8px 12px;border-bottom:1px solid ${TOKEN.borderL1};
}
.cf-col-title{font-size:9px;letter-spacing:.22em;color:${TOKEN.labelSecondary}}
.cf-col-note{font-size:9px;color:${TOKEN.labelSecondary}}
.cf-fill{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden}

/* ---------------------------------------------------------------- roster */
.cf-role{width:100%;border-left:2px solid transparent;color:inherit}
.cf-role:hover{background:${TOKEN.bgLayer2}}
.cf-role-on{background:${TOKEN.bgLayer2};border-left-color:${TOKEN.brand}}
.cf-role-row{display:flex;align-items:flex-start;gap:2px;padding-right:6px}
.cf-role-main{
  flex:1 1 auto;min-width:0;display:block;text-align:left;padding:7px 0 7px 12px;cursor:pointer;
  background:none;border:0;color:inherit;font:inherit;
}
.cf-role-main:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:-2px}
.cf-role-expand{align-self:flex-start;margin:6px 6px 0 0}
.cf-role-details{
  padding:3px 12px 8px 25px;display:flex;flex-direction:column;gap:3px;
  font-size:9px;color:${TOKEN.labelSecondary};border-top:1px dashed ${TOKEN.borderL1};
}
.cf-roster-tools{
  flex:none;display:flex;flex-direction:column;gap:5px;padding:7px 10px;
  border-bottom:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer1};
}
.cf-roster-tools .cf-chips{flex-wrap:nowrap;overflow-x:auto;padding-bottom:1px}
/* The roster tools stack vertically, so .cf-search's horizontal flex-basis
   (130px) would otherwise become a growable HEIGHT and stretch the field into a
   tall block. Pin it to one line here; the horizontal toolbar rules stay intact. */
.cf-roster-tools .cf-search{
  flex:0 0 auto;align-self:stretch;width:100%;max-width:none;
  box-sizing:border-box;height:26px;min-height:26px;max-height:26px;
}
.cf-roster-tools .cf-search input{height:100%;box-sizing:border-box}
.cf-role-top{display:flex;align-items:center;gap:7px}
.cf-role-name{flex:1 1 auto;min-width:0;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-role-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px;padding-left:25px;font-size:9px}
.cf-role-state{display:inline-flex;align-items:center;gap:5px;min-width:0}
.cf-role-note{margin-top:3px;padding-left:25px;font-size:9px;color:${TOKEN.labelSecondary};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-avatar{
  display:block;flex:none;
  font-family:ui-monospace,SFMono-Regular,'JetBrains Mono','Cascadia Mono',Menlo,Consolas,'Noto Sans SC',monospace;
}
.cf-led{width:8px;height:8px;border-radius:9999px;flex:none;background:currentColor}
.cf-led-pulse{animation:cf-led-pulse 1.5s ease-in-out infinite}
@keyframes cf-led-pulse{
  0%,100%{opacity:1;box-shadow:0 0 6px 1px currentColor}
  50%{opacity:.45;box-shadow:0 0 2px 0 currentColor}
}
.cf-legend{
  flex:none;padding:8px 12px;border-top:1px solid ${TOKEN.borderL1};
  font-size:9px;color:${TOKEN.labelSecondary};display:flex;flex-direction:column;gap:4px;
}
.cf-legend-row{display:flex;align-items:center;justify-content:space-between;gap:8px}

/* -------------------------------------------------------------- pipeline */
.cf-pipe{flex:none;padding:10px 14px 8px;border-bottom:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer1}}
.cf-pipe-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}
.cf-pipe-track{display:flex;align-items:center;gap:0;overflow-x:auto;padding-bottom:4px}
.cf-stage{
  position:relative;display:flex;align-items:center;gap:5px;flex:none;
  padding:5px 9px;border-radius:4px;border:1px solid;font-size:10px;white-space:nowrap;
  transition:border-color .3s ease,color .3s ease,background-color .3s ease;
}
.cf-stage-name{max-width:130px;overflow:hidden;text-overflow:ellipsis}
.cf-stage-status{font-size:8px;opacity:.8;white-space:nowrap}
.cf-stage-btn{cursor:pointer;font:inherit;font-family:inherit;appearance:none}
.cf-stage-btn:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-stage-on{box-shadow:inset 0 0 0 1px currentColor}
.cf-stage-goto{font-size:10px;opacity:.85}
.cf-conn{flex:none;margin:0 2px}
.cf-flow{stroke-dasharray:5 5;animation:cf-flow-dash 1.2s linear infinite}
@keyframes cf-flow-dash{to{stroke-dashoffset:-10}}
.cf-sweep{animation:cf-sweep 4.2s linear infinite;transform-origin:center}
@keyframes cf-sweep{to{transform:rotate(360deg)}}
.cf-pipe-legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;font-size:8px;letter-spacing:.1em;color:${TOKEN.labelSecondary}}
.cf-pipe-legend-item{display:inline-flex;align-items:center;gap:5px}

/* ----------------------------------------------------------- work output */
.cf-work{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.cf-work-head{flex:none;display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid ${TOKEN.borderL1}}
.cf-work-avatar{flex:none;display:flex;flex-direction:column;align-items:center;gap:3px}
.cf-work-code{font-size:8px;letter-spacing:.1em;line-height:1;white-space:nowrap}
.cf-work-id{flex:1 1 auto;min-width:0}
.cf-work-name{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600}
.cf-work-duties{font-size:9px;color:${TOKEN.labelSecondary};margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-work-side{flex:none;text-align:right;font-size:9px;color:${TOKEN.labelSecondary};display:flex;flex-direction:column;gap:3px;align-items:flex-end}
.cf-stream{flex:1 1 auto;min-height:0;overflow-y:auto;padding:10px 14px 16px;background:${TOKEN.bgBase}}
.cf-stream-head{font-size:9px;letter-spacing:.22em;color:${TOKEN.labelSecondary};margin-bottom:8px}
.cf-msg{
  border-left:3px solid;border-radius:0 4px 4px 0;padding:5px 8px;margin-bottom:7px;
  background:${TOKEN.bgLayer1};animation:cf-ev-in .35s cubic-bezier(.22,1,.36,1) both;
}
@keyframes cf-ev-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.cf-msg-meta{display:flex;align-items:center;gap:8px;font-size:8px;letter-spacing:.1em;color:${TOKEN.labelSecondary};flex-wrap:wrap}
.cf-msg-sender{display:inline-flex;align-items:center;gap:4px;min-width:0}
.cf-msg-body{margin-top:3px;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:${TOKEN.labelPrimary}}
.cf-cursor::after{content:'▊';margin-left:2px;color:${TOKEN.brand};animation:cf-cursor-blink .9s steps(1) infinite}
@keyframes cf-cursor-blink{50%{opacity:0}}
.cf-halt{flex:none;display:flex;align-items:center;gap:10px;padding:7px 14px;border-top:1px solid ${TOKEN.borderL1};font-size:9px;color:${TOKEN.labelSecondary}}
.cf-meter{flex:1 1 auto;height:4px;border-radius:2px;background:${TOKEN.bgLayer2};overflow:hidden;border:1px solid ${TOKEN.borderL1}}
.cf-meter-fill{height:100%;transition:width .5s cubic-bezier(.22,1,.36,1)}

/* ------------------------------------------------------------ right column
   One scroll container holds all three always-on sections. Each header sticks
   to the top of the scrollport while its own rows scroll under it; the section
   boundary supplies the divider so a pinned header still reads as a header. */
.cf-right-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column}
.cf-right-section{display:flex;flex-direction:column;min-width:0;min-height:0;flex:0 0 auto}
.cf-right-section + .cf-right-section{border-top:1px solid ${TOKEN.borderL1}}
.cf-right-head{
  position:sticky;top:0;z-index:2;flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:7px 12px;background:${TOKEN.bgLayer1};border-bottom:1px solid ${TOKEN.borderL1};
}
.cf-pad{padding:10px}
.cf-dod-summary{text-align:center;margin-top:12px;font-size:10px;color:${TOKEN.labelSecondary}}

/* --------------------------------------------------------------- evolution */
.cf-evo-stats{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
.cf-evo-stat{
  padding:2px 7px;border-radius:3px;border:1px solid ${TOKEN.borderL1};
  background:${TOKEN.bgLayer2};font-size:9px;color:${TOKEN.labelSecondary};white-space:nowrap;
}
.cf-evo-stat-recurring{border-color:${wash(TOKEN.warn, 40)};color:${TOKEN.warn}}
.cf-evo-stat-resolved{border-color:${wash(TOKEN.success, 40)};color:${TOKEN.success}}
.cf-lesson-resolved{border-color:${wash(TOKEN.success, 30)}}
.cf-lesson-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px;font-size:8px;color:${TOKEN.labelSecondary}}
.cf-lesson-meta .cf-ellipsis{min-width:0;max-width:130px}
.cf-lesson-count{color:${TOKEN.warn};font-weight:700}
.cf-lesson-count-once{color:${TOKEN.labelSecondary};font-weight:400}
.cf-lesson-ok{color:${TOKEN.success};border-color:${wash(TOKEN.success, 45)}}
.cf-evo-empty{padding:10px;border:1px dashed ${TOKEN.borderL1};border-radius:4px;color:${TOKEN.labelSecondary}}
.cf-evo-empty-title{font-size:10px;color:${TOKEN.labelPrimary};margin-bottom:3px}
.cf-evo-empty-body{font-size:9px;line-height:1.65}
.cf-evo-more{font-size:9px;color:${TOKEN.labelSecondary};text-align:center;margin-top:2px}
.cf-card{
  display:flex;align-items:flex-start;gap:9px;padding:7px 9px;border-radius:4px;
  background:${TOKEN.bgLayer2};border:1px solid ${TOKEN.borderL1};margin-bottom:6px;
  animation:cf-ev-in .35s cubic-bezier(.22,1,.36,1) both;
}
.cf-card-main{flex:1 1 auto;min-width:0}
.cf-card-name{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-card-sub{font-size:8px;color:${TOKEN.labelSecondary};margin-top:2px}
.cf-card-num{flex:none;font-size:9px;color:${TOKEN.labelSecondary}}
.cf-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ---------------------------------------------------------------- empty */
.cf-empty{
  margin:18px 12px;padding:22px 16px;border:1px dashed ${TOKEN.borderL1};border-radius:6px;
  text-align:center;color:${TOKEN.labelSecondary};
}
.cf-empty-title{font-size:11.5px;color:${TOKEN.labelPrimary};margin-bottom:5px}
.cf-empty-body{font-size:10px;line-height:1.7}
.cf-empty-wide{margin:0;border:0;border-radius:0}

/* ------------------------------------------------------------- turn card */
.cf-card-shell{
  margin:8px 0;padding:9px 11px;border-radius:6px;border:1px solid ${TOKEN.borderL1};
  background:${TOKEN.bgLayer1};display:flex;flex-direction:column;gap:7px;
}
.cf-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cf-card-stats{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:9px;color:${TOKEN.labelSecondary}}
/* The sidebar renders the panel row and its button; this package contributes
   the glyph only, so the wrapper carries no interactive affordances of its own
   (no cursor, no hover, no focus ring) — the shell's button owns all three.
   Edge length comes from the owner's requested size, so none is set here. */
.cf-entry-icon{
  display:inline-flex;align-items:center;justify-content:center;position:relative;
  line-height:0;flex:none;
}
.cf-entry-dot{
  position:absolute;top:1px;right:1px;width:6px;height:6px;border-radius:9999px;
  background:currentColor;color:${TOKEN.success};
}

/* ---------------------------------------------------- interactive chrome */
.cf-sr{
  position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0;
}
.cf-chev{flex:none;color:${TOKEN.labelSecondary};transition:transform .18s ease}
.cf-chev-closed{transform:rotate(-90deg)}
.cf-sec-toggle,.cf-module-toggle{
  flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px;
  padding:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer;text-align:left;
}
.cf-sec-toggle:hover .cf-col-title,.cf-module-toggle:hover .cf-col-title{color:${TOKEN.labelPrimary}}
.cf-sec-toggle:focus-visible,.cf-module-toggle:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:2px}
.cf-sec-body{min-width:0;display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
.cf-toolbar{
  flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  padding:6px 10px;border-bottom:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer1};
}
.cf-toolbar .cf-chips{flex-wrap:wrap}
.cf-search{
  display:inline-flex;align-items:center;gap:4px;min-width:110px;flex:1 1 130px;max-width:230px;
  max-height:26px;
  padding:2px 6px;border-radius:4px;border:1px solid ${TOKEN.borderL1};
  background:${TOKEN.bgLayer2};color:${TOKEN.labelSecondary};
}
.cf-search input{
  flex:1 1 auto;min-width:0;border:0;background:none;outline:none;
  color:${TOKEN.labelPrimary};font:inherit;font-size:10px;padding:2px 0;
}
.cf-search input::placeholder{color:${TOKEN.labelSecondary}}
.cf-search:focus-within{border-color:${TOKEN.brand}}
.cf-chips{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
.cf-chip-btn{
  display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:3px;cursor:pointer;
  border:1px solid ${TOKEN.borderL2};background:none;color:${TOKEN.labelSecondary};
  font:inherit;font-size:9px;letter-spacing:.04em;white-space:nowrap;
}
.cf-chip-btn:hover{color:${TOKEN.labelPrimary};border-color:${TOKEN.labelSecondary}}
.cf-chip-btn:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-chip-btn-on{color:${TOKEN.brand};border-color:${wash(TOKEN.brand, 45)};background:${wash(TOKEN.brand, 10)}}
.cf-chip-num{font-size:8px;opacity:.75;margin-left:1px}
.cf-tool-note{font-size:8px;color:${TOKEN.labelSecondary};margin-left:auto;white-space:nowrap}
.cf-tool-btn{
  display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:3px;cursor:pointer;
  border:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer2};color:${TOKEN.labelPrimary};
  font:inherit;font-size:9px;white-space:nowrap;
}
.cf-tool-btn:hover{border-color:${TOKEN.brand};color:${TOKEN.brand}}
.cf-tool-btn:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-tool-btn-on{border-color:${wash(TOKEN.brand, 50)};color:${TOKEN.brand};background:${wash(TOKEN.brand, 10)}}
.cf-tool-btn-danger{border-color:${wash(TOKEN.error, 45)};color:${TOKEN.error};background:${wash(TOKEN.error, 8)}}
.cf-tool-select{
  max-width:150px;padding:2px 16px 2px 5px;border-radius:3px;border:1px solid ${TOKEN.borderL1};
  background:${TOKEN.bgLayer2};color:${TOKEN.labelPrimary};font:inherit;font-size:9px;
}
.cf-icon-btn{
  display:inline-flex;align-items:center;justify-content:center;flex:none;
  width:20px;height:20px;padding:0;border-radius:3px;cursor:pointer;
  background:none;border:1px solid transparent;color:${TOKEN.labelSecondary};
}
.cf-icon-btn:hover{color:${TOKEN.labelPrimary};border-color:${TOKEN.borderL1};background:${TOKEN.bgLayer2}}
.cf-icon-btn:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-icon-btn-on{color:${TOKEN.brand};border-color:${wash(TOKEN.brand, 40)};background:${wash(TOKEN.brand, 10)}}
.cf-copy,.cf-improvement-copy{
  display:inline-flex;align-items:center;gap:3px;padding:0 5px;border-radius:3px;cursor:pointer;
  border:1px solid ${TOKEN.borderL2};background:none;color:${TOKEN.labelSecondary};
  font:inherit;font-size:8px;line-height:16px;white-space:nowrap;
}
.cf-copy:hover,.cf-improvement-copy:hover{color:${TOKEN.brand};border-color:${TOKEN.brand}}
.cf-copy:focus-visible,.cf-improvement-copy:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-copy-done,.cf-improvement-copy-done{color:${TOKEN.success};border-color:${wash(TOKEN.success, 45)}}
.cf-kv{display:flex;align-items:baseline;gap:6px;min-width:0}
.cf-kv-k{flex:none;color:${TOKEN.labelSecondary};font-size:8px;letter-spacing:.08em;min-width:58px}
.cf-kv-v{min-width:0;color:${TOKEN.labelPrimary};font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-kv-v-wrap{white-space:normal;word-break:break-word}
.cf-kv-v-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}

/* --------------------------------------------------------------- inspector */
.cf-inspector{
  flex:none;display:flex;flex-direction:column;min-height:0;max-height:36%;
  border-bottom:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer1};
}
.cf-inspector-head{flex:none;display:flex;align-items:center;gap:7px;padding:6px 12px;border-bottom:1px solid ${TOKEN.borderL1}}
.cf-inspector-title{
  flex:1 1 auto;min-width:0;font-size:9px;letter-spacing:.18em;color:${TOKEN.labelSecondary};
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.cf-inspector-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px 12px 10px}
.cf-inspect-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:3px 10px;margin-bottom:6px}
.cf-inspect-flags{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px}
.cf-inspect-section{margin-top:6px;padding-top:5px;border-top:1px dashed ${TOKEN.borderL1}}
.cf-inspect-heading{font-size:8px;letter-spacing:.14em;color:${TOKEN.labelSecondary};margin-bottom:3px}
.cf-inspect-roles{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.cf-role-inline{
  display:inline-flex;align-items:center;gap:4px;padding:1px 6px 1px 1px;border-radius:9999px;
  border:1px solid ${TOKEN.borderL1};background:${TOKEN.bgLayer2};font-size:8px;color:${TOKEN.labelPrimary};
}
.cf-gate-line{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:9px;line-height:1.65}
.cf-gate-k{flex:none;min-width:64px;color:${TOKEN.labelSecondary};font-size:8px}
.cf-gate-v{
  min-width:0;color:${TOKEN.labelPrimary};word-break:break-word;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.cf-gate-checks{margin-top:3px;padding-left:8px;border-left:1px solid ${TOKEN.borderL1}}
.cf-inspect-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:7px}

/* ---------------------------------------------------------------- messages */
.cf-msg-actions{display:inline-flex;align-items:center;gap:4px;margin-left:auto;flex-wrap:wrap}
.cf-msg-flag{font-size:8px;color:${TOKEN.labelSecondary}}
.cf-msg-flag-on{color:${TOKEN.success}}
.cf-unread-dot{width:5px;height:5px;border-radius:9999px;background:${TOKEN.brand};flex:none}
.cf-msg-body-clamp{
  display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;
}
.cf-msg-more{
  align-self:flex-start;margin-top:2px;padding:0;border:0;background:none;cursor:pointer;
  color:${TOKEN.brand};font:inherit;font-size:8px;letter-spacing:.06em;
}
.cf-msg-more:hover{text-decoration:underline}

/* --------------------------------------------------------------- artifacts */
.cf-art-head{
  flex:1 1 auto;min-width:0;display:flex;align-items:flex-start;gap:9px;padding:0;
  border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;
}
.cf-art-expanded{padding:5px 0 0;font-size:8px;color:${TOKEN.labelSecondary}}
.cf-art-actions{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-top:3px}
.cf-showmore{
  display:block;width:100%;margin:4px 0 2px;padding:4px 8px;border-radius:3px;cursor:pointer;
  border:1px dashed ${TOKEN.borderL1};background:none;color:${TOKEN.brand};font:inherit;font-size:9px;
}
.cf-showmore:hover{background:${TOKEN.bgLayer2}}
.cf-showmore:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}

/* --------------------------------------------------------------------- DoD */
.cf-dod-progress{display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:8px;color:${TOKEN.labelSecondary}}
.cf-dod-progress .cf-meter{height:4px}
.cf-dod-detail{
  display:flex;flex-direction:column;gap:2px;margin-top:4px;padding-top:4px;
  border-top:1px dashed ${TOKEN.borderL1};font-size:8px;color:${TOKEN.labelSecondary};
}
.cf-kind-chip{
  display:inline-flex;align-items:center;padding:0 4px;border-radius:2px;
  border:1px solid ${TOKEN.borderL2};font-size:8px;color:${TOKEN.labelSecondary};
}

/* --------------------------------------------------------------- evolution */
.cf-evo-toolbar{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:6px}
.cf-evo-detail{
  display:flex;flex-direction:column;gap:2px;margin-top:4px;padding-top:4px;
  border-top:1px dashed ${TOKEN.borderL1};font-size:8px;color:${TOKEN.labelSecondary};
}

/* ------------------------------------------------- plugin improvements */
.cf-improvements{margin-top:10px;padding-top:8px;border-top:1px solid ${TOKEN.borderL1}}
.cf-improvements-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.cf-improvements-title{font-size:9px;letter-spacing:.22em;color:${TOKEN.labelSecondary}}
.cf-improvements-note{font-size:9px;color:${TOKEN.labelSecondary}}
.cf-improvement-toolbar{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:6px}
.cf-improvement{
  display:flex;align-items:flex-start;gap:8px;padding:7px 9px;margin-bottom:6px;
  border:1px solid ${TOKEN.borderL1};border-radius:4px;background:${TOKEN.bgLayer1};
}
.cf-improvement-main{flex:1 1 auto;min-width:0}
.cf-improvement-status{
  display:inline-flex;align-items:center;padding:0 5px;border-radius:3px;border:1px solid;
  font-size:8px;white-space:nowrap;
}
.cf-improvement-toggle{
  align-self:flex-start;margin:0;padding:0;border:0;background:none;cursor:pointer;
  color:${TOKEN.brand};font:inherit;font-size:8px;letter-spacing:.06em;
}
.cf-improvement-toggle:hover{text-decoration:underline}
.cf-improvement-toggle:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}
.cf-improvement-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.cf-improvement-title{
  flex:1 1 auto;min-width:0;font-size:10px;font-weight:600;color:${TOKEN.labelPrimary};
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.cf-improvement-evidence{font-size:8px;font-weight:700;color:${TOKEN.warn};white-space:nowrap}
.cf-improvement-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px;font-size:8px;color:${TOKEN.labelSecondary}}
.cf-improvement-target{display:flex;align-items:baseline;gap:6px;min-width:0;margin-top:4px}
.cf-improvement-target-label{flex:none;font-size:8px;letter-spacing:.08em;color:${TOKEN.labelSecondary}}
.cf-improvement-target-none{font-size:8px;color:${TOKEN.labelSecondary}}
.cf-improvement-file{
  min-width:0;font-size:8px;color:${TOKEN.labelPrimary};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
.cf-improvement-suggestion{
  margin-top:3px;font-size:10px;line-height:1.55;color:${TOKEN.labelPrimary};
  white-space:pre-wrap;word-break:break-word;
}
.cf-improvement-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cf-improvement-rationale{
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  margin-top:3px;font-size:8px;line-height:1.5;color:${TOKEN.labelSecondary};
}
.cf-improvement-actions{display:flex;align-items:center;gap:6px;margin-top:4px}
.cf-improvement-empty{
  padding:7px 9px;border:1px dashed ${TOKEN.borderL1};border-radius:4px;
  font-size:9px;color:${TOKEN.labelSecondary};
}
.cf-improvement-more{
  display:block;width:100%;margin:3px 0 2px;padding:4px 8px;border-radius:3px;cursor:pointer;
  border:1px dashed ${TOKEN.borderL1};background:none;color:${TOKEN.brand};font:inherit;font-size:9px;
}
.cf-improvement-more:hover{background:${TOKEN.bgLayer2}}
.cf-improvement-more:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:1px}

/* ------------------------------------------------------- dockable modules */
.cf-board{position:relative}
.cf-board-stack{
  flex:1 1 auto;min-height:0;display:flex;flex-direction:column;
}
.cf-board-stack.cf-right-scroll{overflow-y:auto;overflow-x:hidden}
.cf-left .cf-board-stack{overflow-y:auto;overflow-x:hidden}
.cf-module{
  display:flex;flex-direction:column;min-width:0;min-height:0;
  flex:0 0 auto;position:relative;background:inherit;
}
.cf-module + .cf-module{border-top:1px solid ${TOKEN.borderL1}}
.cf-module[data-grow="true"],.cf-right-section[data-grow="true"]{flex:1 1 0}
.cf-module[data-collapsed="true"],.cf-right-section[data-collapsed="true"]{flex:0 0 auto}
.cf-module[data-dragging="true"],.cf-right-section[data-dragging="true"]{opacity:.55}
.cf-module-drop-before{box-shadow:inset 0 2px 0 ${TOKEN.brand}}
.cf-module-drop-after{box-shadow:inset 0 -2px 0 ${TOKEN.brand}}
.cf-board-col-over{outline:1px dashed ${wash(TOKEN.brand, 60)};outline-offset:-2px}
.cf-board-empty{
  display:flex;align-items:center;justify-content:center;flex:none;
  min-height:72px;margin:6px;padding:12px;border:1px dashed ${TOKEN.borderL1};
  border-radius:4px;color:${TOKEN.labelSecondary};font-size:9px;text-align:center;
}
.cf-drop-line{
  flex:none;height:3px;margin:0 6px;border-radius:2px;
  background:${TOKEN.brand};box-shadow:0 0 8px ${wash(TOKEN.brand, 55)};
}
.cf-module-head{
  flex:none;display:flex;align-items:center;gap:6px;
  padding:6px 9px;background:${TOKEN.bgLayer1};border-bottom:1px solid ${TOKEN.borderL1};
  cursor:grab;
}
.cf-module-head:active{cursor:grabbing}
.cf-module-grip{
  flex:none;color:${TOKEN.labelSecondary};font-size:10px;letter-spacing:2px;
  line-height:1;opacity:.75;user-select:none;
}
.cf-module-head .cf-col-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cf-module-body{
  flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden;
}
.cf-module[data-grow="false"] .cf-module-body,
.cf-right-section[data-grow="false"] .cf-module-body{flex:0 0 auto;overflow:visible}
/* The inspector was sized against the old fixed middle column; inside a dock
   module it simply fills the module body. */
.cf-module-body .cf-inspector,.cf-sec-body .cf-inspector{max-height:none;flex:1 1 auto;min-height:0;border-bottom:0}
.cf-module-empty{
  flex:1 1 auto;display:flex;align-items:center;justify-content:center;
  padding:12px;color:${TOKEN.labelSecondary};font-size:9px;text-align:center;
}
.cf-module-resize{
  flex:none;height:7px;cursor:row-resize;background:none;border:0;border-top:1px solid ${TOKEN.borderL1};
  padding:0;margin:0;
}
.cf-module-resize:hover,.cf-module-resize:focus-visible{background:${wash(TOKEN.brand, 22)};outline:none}
.cf-module-resize:focus-visible{box-shadow:inset 0 0 0 1px ${TOKEN.brand}}
.cf-module-menu-root{position:relative;flex:none;display:flex;align-items:center}
.cf-module-menu{
  position:absolute;right:0;top:calc(100% + 4px);z-index:40;
  display:flex;flex-direction:column;min-width:158px;padding:4px;border-radius:4px;
  border:1px solid ${TOKEN.borderL1};background:${TOKEN.bgOverlay};
  box-shadow:0 10px 26px ${wash(TOKEN.labelPrimary, 20)};
}
.cf-module-menu button{
  display:block;width:100%;text-align:left;padding:4px 7px;border:0;border-radius:3px;
  background:none;color:${TOKEN.labelPrimary};font:inherit;font-size:9px;cursor:pointer;white-space:nowrap;
}
.cf-module-menu button:hover,.cf-module-menu button:focus-visible{background:${TOKEN.bgLayer2};outline:none}
.cf-module-menu button:disabled{color:${TOKEN.labelSecondary};cursor:default;opacity:.55}
.cf-module-menu-sep{height:1px;margin:3px 2px;background:${TOKEN.borderL1}}
.cf-splitter{
  position:relative;flex:1 1 auto;min-width:6px;cursor:col-resize;background:none;border:0;
  padding:0;margin:0;align-self:stretch;
}
.cf-splitter::after{
  content:'';position:absolute;left:2px;top:0;bottom:0;width:2px;border-radius:1px;
  background:${TOKEN.borderL1};
}
.cf-splitter:hover::after,.cf-splitter:focus-visible::after{background:${TOKEN.brand}}
.cf-splitter:focus-visible{outline:2px solid ${TOKEN.brand};outline-offset:-2px}
.cf-layout-menu-root{position:relative;display:inline-flex}
.cf-layout-pop{
  position:absolute;right:0;top:calc(100% + 6px);z-index:60;
  width:360px;max-width:min(360px,calc(100vw - 28px));max-height:min(68vh,520px);
  overflow-y:auto;padding:8px;border-radius:6px;
  border:1px solid ${TOKEN.borderL1};background:${TOKEN.bgOverlay};
  box-shadow:0 14px 34px ${wash(TOKEN.labelPrimary, 22)};
}
.cf-layout-group{margin-bottom:6px}
.cf-layout-heading{font-size:8px;letter-spacing:.16em;color:${TOKEN.labelSecondary};padding:2px 3px 4px}
.cf-layout-row{
  display:flex;align-items:center;gap:3px;padding:3px 2px;
  border-top:1px dashed ${TOKEN.borderL1};
}
.cf-layout-row:first-of-type{border-top:0}
.cf-layout-name{
  flex:1 1 auto;min-width:0;font-size:10px;color:${TOKEN.labelPrimary};
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.cf-layout-row .cf-icon-btn{width:18px;height:18px;font-size:10px}
.cf-layout-footer{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:6px;border-top:1px solid ${TOKEN.borderL1}}
.cf-layout-muted{font-size:9px;color:${TOKEN.labelSecondary}}
.cf-layout-hidden-row{display:flex;align-items:center;gap:5px;padding:2px 2px}
.cf-layout-hidden-row .cf-layout-name{flex:1 1 auto}

/* ------------------------------------------------------------ responsive
   Viewport-only by contract: the host sidebar must never change the column
   mode. Keep these @media rules as the single source of responsive layout. */
@media (max-width:1180px){
  .cf-body{grid-template-columns:222px minmax(0,1fr)}
  .cf-splitter{display:none}
  .cf-right{grid-column:1/-1;border-left:0;border-top:1px solid ${TOKEN.borderL1};max-height:44vh}
}
@media (max-width:820px){
  .cf-body{grid-template-columns:minmax(0,1fr)}
  .cf-splitter{display:none}
  .cf-left,.cf-right{border-right:0;border-left:0;border-bottom:1px solid ${TOKEN.borderL1}}
  .cf-left{max-height:34vh}
  .cf-mid{min-height:52vh}
  .cf-inspector{max-height:40vh}
  .cf-right{max-height:48vh}
  .cf-header{gap:10px}
  .cf-actions{width:100%;margin-left:0;justify-content:flex-start}
}
@media (prefers-reduced-motion:reduce){
  .cf-led-pulse,.cf-flow,.cf-cursor::after,.cf-msg,.cf-card,.cf-sweep{animation:none}
}
`
