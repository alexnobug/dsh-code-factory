/**
 * router.ts — task classification and team assembly (pure functions).
 *
 * Two rules are hard-coded here on purpose, because they are the product:
 *
 * 1. **Iron triangle** — every roster contains `pm` + `qa` + at least one
 *    `*_dev`. If the task-type table forgot one, the router adds it and says so
 *    in `reasoning`.
 * 2. **Security trigger** — a brief hitting 登录/鉴权/用户数据/支付/密码/token/对外
 *    (plus a small synonym set) forces `security_eng` into the roster, and the
 *    security role is **pinned**: the roster cap may never trim it.
 *
 * Roster cap: `maxMembers` (default {@link DEFAULT_MAX_MEMBERS}, derived from the
 * longest template roster — see {@link MAX_TEMPLATE_ROSTER}, so a default run
 * never has to trim). The cap is a **hard limit**: `team.length` never exceeds
 * it, and the mandatory floor (3, or 4 when the security path is live) is the
 * only thing allowed to survive it (`overCap: true` then reports the overrun).
 *
 * Over-cap rosters are trimmed along {@link TRIM_ORDER} — `perf` > `po` >
 * `tech_writer` first, then the optional specialists whose duty a retained role
 * can absorb (see `ROLE_FALLBACKS` in `roles.ts`). The mandatory corners and the
 * last `*_dev` are never trimmed.
 *
 * Trimming is **not silent**: a role the routed family's own template lists but
 * the cap forces out lands in {@link TrimResult.trimmedRequired}, and
 * {@link assembleTeam} mirrors it into `reasoning` together with
 * {@link capFor} — so a shortfall is said out loud and never quietly absorbed by
 * `ROLE_FALLBACKS` at dispatch time.
 *
 * ## Frontend platform | 前端细分
 *
 * `web_fullstack` (and any family that lists a frontend slot) declares the
 * generic `fe_dev` slot. {@link assembleTeam} detects the platform from the brief
 * ({@link frontendPlatformFor}: mini program > Flutter > Web) and replaces that
 * slot with the matching specialist (`web_dev` / `flutter_dev` /
 * `mini_program_dev`) before the cap is applied — so `required` contains the
 * specialist that is actually staffed, not the generic placeholder. The pipeline
 * templates keep the `fe_dev` slot; at dispatch time `resolveStageRoles` maps it
 * onto the real specialist through `ROLE_FALLBACKS`. A family that explicitly
 * lists a specialist is left alone (no duplicates), and `fe_dev` remains the
 * generic fallback for old records/rosters.
 *
 * PURITY CONTRACT (hard): no external imports, no Node API, no side effects,
 * deterministic for identical inputs.
 *
 * @module dsh-code-factory/domain/router
 */

import type { FrontendPlatform, SecuritySignalSource, TaskTypeDef, TeamDecision } from '../shared/types.js'
import { TASK_TYPES, defaultTaskType, getTaskType, widestTeamSize } from './task-types.js'
import {
  FRONTEND_SPECIALIST_ROLE_IDS,
  GENERIC_FRONTEND_ROLE_ID,
  ROUTER_ROLE_ID,
  SECURITY_ROLE_ID,
  TRIAD_BASE_ROLES,
  canonicalRoleId,
  isDevRoleId,
  isRoleId,
} from './roles.js'

/** Re-exported so callers can name the platform union without importing `shared` directly. */
export type { FrontendPlatform }

/* --------------------------------------------------------------- consts */

/** Hard floor: the iron triangle can never be cut below three members. */
export const MIN_TEAM_SIZE = 3

/**
 * The longest template roster. Each family contributes its declared roster plus
 * the corners the router guarantees; the security specialist is not counted here
 * because only a security brief injects it — that extra corner is what
 * {@link capFor} accounts for when reporting a shortfall.
 */
export const MAX_TEMPLATE_ROSTER: number = Math.max(MIN_TEAM_SIZE, widestTeamSize())

/**
 * Default roster cap. **Derived from the templates on purpose**: a cap below
 * {@link MAX_TEMPLATE_ROSTER} would silently trim the very specialists the
 * selected template requires (H3 — `web_fullstack` needs 11 roles, the old
 * hard-coded 8 dropped `ui_designer`/`sys_arch`/`db_arch`, and `ROLE_FALLBACKS`
 * quietly handed the design stage to its own implementers). Deriving it means a
 * template that grows can never silently outgrow the default again — the
 * relationship is a computation, not a comment.
 */
export const DEFAULT_MAX_MEMBERS: number = MAX_TEMPLATE_ROSTER

/**
 * Roster floor for a given routing decision: three mandatory corners, plus the
 * security specialist when the security path is live (it is never trimmed).
 */
export function teamFloor(securityTriggered: boolean): number {
  return MIN_TEAM_SIZE + (securityTriggered ? 1 : 0)
}

/**
 * Roles the router must never trim for one family: the family's own roster plus
 * the mandatory corners, plus `security_eng` when the security path is live.
 * Order follows `type.team`; unknown spellings are dropped, `router` never
 * appears. The security role is counted whether or not the template lists it —
 * a security brief injects it, so it is required by construction.
 */
export function requiredRolesFor(taskTypeId: string, securityTriggered = false): readonly string[] {
  const def = getTaskType(taskTypeId)
  const required: string[] = []
  const add = (role: string): void => {
    const canonical = canonicalRoleId(role)
    if (canonical === ROUTER_ROLE_ID) return
    if (!isRoleId(canonical)) return
    if (!required.includes(canonical)) required.push(canonical)
  }
  for (const role of def?.team ?? TRIAD_BASE_ROLES) add(role)
  for (const role of TRIAD_BASE_ROLES) add(role)
  if (securityTriggered) add(SECURITY_ROLE_ID)
  return required
}

/**
 * The cap a family actually needs: its own roster plus the mandatory corners,
 * plus `security_eng` when the security path is live.
 *
 * This is a **read-only query for reporting** — the number a caller must pass as
 * `maxMembers` to staff the family without trimming. It deliberately does *not*
 * raise a caller's cap: the cap stays a hard limit, and a cap below this value
 * is reported through {@link TrimResult.trimmedRequired} instead.
 */
export function capFor(taskTypeId: string, securityTriggered = false): number {
  return requiredRolesFor(taskTypeId, securityTriggered).length
}

/** Dev job used when a task type somehow ships without one. */
export const DEFAULT_DEV_ROLE = 'be_dev'

/**
 * Security trigger words, in four groups.
 *
 * H4: this list used to be 22 words — the specification's seven plus synonyms for
 * the same *mechanisms*. A brief that names a **business** instead of a mechanism
 * («做一个跑腿的微信小程序») hit nothing, so `securityTriggered` stayed false and
 * DoD item 4 (`securityOnly`) auto-passed as 「本次工厂未触发安全路径」 for an app
 * that has WeChat login, rider and customer phone numbers, home addresses and
 * payment. The verdict was wrong, and it was wrong in the direction that skips an
 * audit.
 *
 * The asymmetry that sets the policy: a **miss** silently marks a security path
 * inapplicable, while a **hit** costs one `security_eng` slot — a role every
 * template already lists and the router pins but never invents work for — plus a
 * `threat` stage that every fullstack pipeline already contains. So the
 * vocabulary errs toward firing. Words that only name a domain with no identity,
 * money or personal data in it stay out on purpose.
 *
 * Group order is stable and asserted (`scripts/verify.mjs` A6 iterates every
 * entry), so append to a group rather than reordering one.
 */
export const SECURITY_TRIGGERS: readonly string[] = [
  // 1. mechanism — the specification's seven, in order, then the synonyms.
  '登录',
  '鉴权',
  '用户数据',
  '支付',
  '密码',
  'token',
  '对外',
  '认证',
  '授权',
  '权限',
  '越权',
  '隐私',
  '敏感数据',
  '加密',
  '密钥',
  'jwt',
  'oauth',
  'session',
  'signin',
  'signup',
  'password',
  'credit card',
  // 2. identity — a named account, a verifiable person, or a contact channel.
  '注册',
  '账号',
  '账户',
  '会员',
  '实名',
  '身份证',
  '手机号',
  '手机',
  '短信',
  '验证码',
  '收货地址',
  '地址',
  'openid',
  '微信',
  '小程序',
  '公众号',
  '支付宝',
  '人脸',
  '指纹',
  '第三方登录',
  '单点登录',
  'sso',
  // 3. money — anything that moves value.
  '订单',
  '退款',
  '结算',
  '提现',
  '钱包',
  '余额',
  '优惠券',
  '发票',
  '计费',
  '收费',
  '押金',
  '打赏',
  '佣金',
  '订阅',
  // 4. sensitive domain — personal data that is regulated or worth stealing.
  '医疗',
  '病历',
  '健康',
  '药品',
  '银行',
  '金融',
  '信贷',
  '保险',
  '征信',
  '学生',
  '学籍',
  '未成年人',
  '位置',
  '定位',
  '轨迹',
  '摄像头',
  '监控',
  '录音',
  '跑腿',
  '骑手',
]

/**
 * Trim order when a roster exceeds the cap: left to right, first present wins.
 * Add-on jobs go first (spec: `perf` > `po` > `tech_writer`), then the design
 * specialists whose duty another retained role can absorb, then supporting
 * roles, then the security specialist (unless the trigger pinned it), and only
 * then the implementers — never the last one.
 */
export const TRIM_ORDER: readonly string[] = [
  'perf',
  'po',
  'tech_writer',
  'ui_designer',
  'db_arch',
  'sys_arch',
  'api_designer',
  'reviewer',
  'devops',
  'security_eng',
  'web_dev',
  'flutter_dev',
  'mini_program_dev',
  'fe_dev',
  'be_dev',
]

/* -------------------------------------------------------------- signals */

/** Where a live security verdict came from. Recorded so the plan can say so. */
export type { SecuritySignalSource }

/** Whether the brief takes the security path, which words caused it, and where. */
export interface SecuritySignal {
  readonly triggered: boolean
  readonly hits: readonly string[]
  /**
   * `brief` when the plan-time brief already triggered, `document` when only a
   * later document did, `none` when nothing did. H4's whole point is that these
   * are different claims: the first is a guess from one sentence, the second is
   * read off the requirements document.
   */
  readonly source: SecuritySignalSource
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchesTrigger(lowerBrief: string, trigger: string): boolean {
  const needle = trigger.toLowerCase()
  // ASCII-ish triggers use word boundaries so "tokenizer" is not a token hit;
  // CJK triggers can only be matched as substrings.
  if (/^[a-z0-9_ -]+$/.test(needle) && /[a-z]/.test(needle)) {
    return new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(lowerBrief)
  }
  return lowerBrief.includes(needle)
}

/** Scans a brief for the mandatory-security-path triggers. */
export function securitySignal(brief: string): SecuritySignal {
  const lower = (brief ?? '').toLowerCase()
  const hits: string[] = []
  for (const trigger of SECURITY_TRIGGERS) {
    if (matchesTrigger(lower, trigger) && !hits.includes(trigger)) hits.push(trigger)
  }
  return { triggered: hits.length > 0, hits, source: hits.length > 0 ? 'brief' : 'none' }
}

/**
 * The security verdict over the brief **and** every document that arrived after
 * it.
 *
 * H4's second half: a brief names a business, the PRD names the mechanisms, so
 * the plan-time verdict can only be a first guess and the requirements stage has
 * to be able to revise it. This is the pure half of that revision — the caller
 * supplies the document bodies it already has (the requirements artifact, the
 * design docs), so this stays free of the filesystem like the rest of `domain/`.
 *
 * **Upward only, deliberately.** Once the path is live a factory has staffed
 * `security_eng`, pinned it against trimming, run the `threat` stage and stopped
 * skipping the `securityOnly` DoD item. A later document that no longer mentions
 * a trigger cannot un-run any of that, and demoting it would silently re-skip an
 * audit whose result is already on the record — so the union only ever grows.
 */
export function securitySignalForDocuments(
  brief: string,
  documents: readonly (string | undefined)[] = [],
): SecuritySignal {
  const fromBrief = securitySignal(brief)
  const hits = [...fromBrief.hits]
  let source: SecuritySignalSource = fromBrief.triggered ? 'brief' : 'none'
  for (const document of documents) {
    if (document === undefined) continue
    const fromDocument = securitySignal(document)
    for (const hit of fromDocument.hits) if (!hits.includes(hit)) hits.push(hit)
    if (fromDocument.triggered && source === 'none') source = 'document'
  }
  return { triggered: hits.length > 0, hits, source }
}

/* ------------------------------------------------------ frontend platform */

/**
 * Mini-program platform keywords.
 *
 * Ordered by the detection rule, not by string length: a brief naming a
 * mini-program framework is a mini program even if it also says "flutter".
 * The bare `微信`/`小程序` words are included because the product's own
 * vocabulary uses them interchangeably for WeChat mini programs.
 */
export const FRONTEND_MINI_KEYWORDS: readonly string[] = [
  '小程序',
  '微信',
  'wechat',
  'weapp',
  'uni-app',
  'uniapp',
  'taro',
  'mp-weixin',
  '支付宝小程序',
  '快应用',
  '抖音小程序',
]

/** Flutter / Dart keywords. ASCII matches use word boundaries (see `matchesTrigger`). */
export const FRONTEND_FLUTTER_KEYWORDS: readonly string[] = ['flutter', 'dart']

/** Platform → specialist role. The single source of the mapping. */
export const FRONTEND_ROLE_BY_PLATFORM: Readonly<Record<FrontendPlatform, string>> = {
  web: 'web_dev',
  flutter: 'flutter_dev',
  mini_program: 'mini_program_dev',
}

function matchesAnyKeyword(lowerBrief: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => matchesTrigger(lowerBrief, keyword))
}

/**
 * Detects the frontend platform a brief implies.
 *
 * Priority is **mini program > Flutter > Web**: the narrower deployment target
 * wins (a WeChat mini program is not a "web page"), and Web is the default when
 * nothing narrower is named — including briefs that only say 「前端页面」.
 * Matching is case-insensitive; ASCII keywords require word boundaries so
 * `dart` cannot fire inside a random token, CJK words match as substrings.
 *
 * @param brief - the user's original brief, verbatim.
 * @returns `mini_program` | `flutter` | `web`; never `undefined`.
 */
export function frontendPlatformFor(brief: string): FrontendPlatform {
  const lower = (brief ?? '').toLowerCase()
  if (matchesAnyKeyword(lower, FRONTEND_MINI_KEYWORDS)) return 'mini_program'
  if (matchesAnyKeyword(lower, FRONTEND_FLUTTER_KEYWORDS)) return 'flutter'
  return 'web'
}

/**
 * The specialist role that fills the frontend slot for a platform.
 *
 * @param platform - one of the three detected platforms.
 * @returns the registered specialist id; Web when the value is somehow unknown.
 */
export function frontendRoleFor(platform: FrontendPlatform): string {
  return FRONTEND_ROLE_BY_PLATFORM[platform] ?? FRONTEND_ROLE_BY_PLATFORM.web
}

/**
 * Reverse lookup: the platform a specialist role belongs to.
 *
 * @param role - role id or alias (`web_dev` / `FT` / `小程序工程师`).
 * @returns the platform, or `undefined` when the role is not a frontend specialist.
 */
export function frontendPlatformOfRole(role: string): FrontendPlatform | undefined {
  const canonical = canonicalRoleId(role)
  for (const [platform, specialist] of Object.entries(FRONTEND_ROLE_BY_PLATFORM)) {
    if (specialist === canonical) return platform as FrontendPlatform
  }
  return undefined
}

/** How the generic frontend slot of one family's roster is resolved. */
interface FrontendSlotPlan {
  /** The family roster with `fe_dev` replaced by the detected specialist. */
  readonly team: readonly string[]
  /** Detected (or explicitly declared) platform; absent when the family has no frontend slot. */
  readonly platform?: FrontendPlatform
  /** The specialist that occupies the slot; absent when the family has none. */
  readonly role?: string
  /** True when a generic `fe_dev` slot was actually replaced. */
  readonly replaced: boolean
}

/**
 * Resolves the frontend slot of a family roster.
 *
 * Rules, in order:
 *  1. a family that already names an explicit specialist wins — no second
 *     frontend role is added, and its own platform is reported;
 *  2. a family with a generic `fe_dev` slot gets the detected specialist;
 *  3. a family with no frontend slot is untouched (`frontendPlatform` stays absent).
 *
 * @param team - the task family's declared roster.
 * @param brief - the user's brief (platform detection input).
 * @returns the roster to seed plus the platform/role to report.
 */
function planFrontendSlot(team: readonly string[], brief: string): FrontendSlotPlan {
  const canonicalTeam = team.map(canonicalRoleId)
  const explicit = canonicalTeam.find((role) => FRONTEND_SPECIALIST_ROLE_IDS.includes(role))
  if (explicit !== undefined) {
    const platform = frontendPlatformOfRole(explicit)
    return {
      team: [...team],
      ...(platform === undefined ? {} : { platform }),
      role: explicit,
      replaced: false,
    }
  }
  if (!canonicalTeam.includes(GENERIC_FRONTEND_ROLE_ID)) return { team: [...team], replaced: false }
  const platform = frontendPlatformFor(brief)
  const role = frontendRoleFor(platform)
  return {
    team: team.map((entry) => (canonicalRoleId(entry) === GENERIC_FRONTEND_ROLE_ID ? role : entry)),
    platform,
    role,
    replaced: true,
  }
}

/* ---------------------------------------------------------- task routing */

/** Keywords of `type` that the brief actually hit, in registry order. */
export function matchedKeywordsFor(brief: string, type: TaskTypeDef): readonly string[] {
  const lower = (brief ?? '').toLowerCase()
  return type.keywords.filter((word) => lower.includes(word.toLowerCase()))
}

/**
 * Classifies a brief. Scoring is "how many of the family's keywords appear";
 * ties go to the family registered first (most expensive pipeline first) and a
 * brief that matches nothing falls back to the cheapest family
 * (`script_tool` / `lightweight`), exactly like the skeleton did.
 */
export function matchTaskType(brief: string): TaskTypeDef {
  const lower = (brief ?? '').toLowerCase()
  let best: TaskTypeDef = defaultTaskType()
  let bestScore = 0
  for (const def of TASK_TYPES) {
    const score = def.keywords.filter((word) => lower.includes(word.toLowerCase())).length
    if (score > bestScore) {
      best = def
      bestScore = score
    }
  }
  return best
}

/* ------------------------------------------------------------ team rules */

/** `true` when the roster satisfies the iron triangle. */
export function hasIronTriangle(team: readonly string[]): boolean {
  const canonical = team.map(canonicalRoleId)
  return (
    TRIAD_BASE_ROLES.every((role) => canonical.includes(role)) &&
    canonical.some((role) => isDevRoleId(role))
  )
}

/** The corners missing from a roster; `[]` means the triangle holds. */
export function triadViolations(team: readonly string[]): readonly string[] {
  const canonical = team.map(canonicalRoleId)
  const missing: string[] = []
  for (const role of TRIAD_BASE_ROLES) {
    if (!canonical.includes(role)) missing.push(role)
  }
  if (!canonical.some((role) => isDevRoleId(role))) missing.push('<one *_dev>')
  return missing
}

/**
 * Result of applying the roster cap.
 *
 * The cap is a **hard limit**: `team.length > cap` is never returned, not even
 * when the mandatory floor does not fit into it. A roster that genuinely cannot
 * fit is reported instead — `overCap` plus the names of what was dropped — so a
 * caller can surface the shortfall rather than let it surface later as a silent
 * `ROLE_FALLBACKS` substitution at dispatch time. `trimmedRequired` mirrors the
 * way `pipeline.resolveStageRoles` reports its `missing` list.
 */
export interface TrimResult {
  readonly team: readonly string[]
  /** Roles actually dropped, in drop order (optional roles first). */
  readonly trimmed: readonly string[]
  /**
   * Subset of `trimmed` whose roles the *current task type's template* actually
   * lists — the honest signal that the cap cut into the template's roster.
   */
  readonly trimmedRequired: readonly string[]
  /** True when the cap could not even hold the mandatory floor. */
  readonly overCap: boolean
}

/** Canonicalises a roster: known roles only, no router hat, no duplicates. */
export function normaliseRoster(team: readonly string[]): readonly string[] {
  const roster: string[] = []
  for (const role of team) {
    const canonical = canonicalRoleId(role)
    if (canonical === ROUTER_ROLE_ID) continue
    if (!isRoleId(canonical)) continue
    if (!roster.includes(canonical)) roster.push(canonical)
  }
  return roster
}

/** Sanitises the cap coming from tool arguments (the model writes it). */
export function sanitizeCap(maxMembers: number): number {
  if (!Number.isFinite(maxMembers)) return DEFAULT_MAX_MEMBERS
  return Math.max(1, Math.floor(maxMembers))
}

/**
 * Applies the roster cap. `pinned` roles are never dropped, and the last
 * `*_dev` is never dropped either — so a cap below the floor yields
 * `overCap: true` with the floor roster intact rather than a broken triangle.
 *
 * `required` names the roles the current routing decision needs (a template's
 * declared roster). The cap still wins — `team.length` never exceeds it — but
 * every required role the cap forces out is reported in `trimmedRequired`
 * instead of disappearing silently.
 */
export function trimToCap(
  team: readonly string[],
  maxMembers: number = DEFAULT_MAX_MEMBERS,
  pinned: readonly string[] = TRIAD_BASE_ROLES,
  required: readonly string[] = [],
): TrimResult {
  const cap = sanitizeCap(maxMembers)
  const roster = normaliseRoster(team)
  const pinnedSet = new Set<string>(pinned.map(canonicalRoleId))
  const requiredSet = new Set<string>(required.map(canonicalRoleId))
  if (roster.length <= cap) {
    return { team: roster, trimmed: [], trimmedRequired: [], overCap: false }
  }

  const keep = new Set(roster)
  const trimmed: string[] = []
  const trimmedRequired: string[] = []
  const devCount = (): number => [...keep].filter((role) => isDevRoleId(role)).length
  const drop = (role: string): void => {
    keep.delete(role)
    trimmed.push(role)
    if (requiredSet.has(role)) trimmedRequired.push(role)
  }

  // The floor is structural, not a function of what the caller passed as
  // `pinned`: the triad corners plus one `*_dev` plus every pinned role. It is
  // the only thing allowed to survive a cap that cannot hold it (`overCap`).
  const floor = new Set<string>(TRIAD_BASE_ROLES)
  for (const role of pinnedSet) floor.add(role)
  if (![...floor].some((role) => isDevRoleId(role))) {
    const firstDev = roster.find((role) => isDevRoleId(role))
    if (firstDev !== undefined) floor.add(firstDev)
  }

  for (const candidate of TRIM_ORDER) {
    if (keep.size <= cap) break
    const role = canonicalRoleId(candidate)
    if (!keep.has(role)) continue
    if (floor.has(role)) continue
    if (isDevRoleId(role) && devCount() <= 1) continue
    drop(role)
  }

  // TRIM_ORDER is not guaranteed to be exhaustive: anything else that still does
  // not fit is cut in roster order so the cap always holds. The floor is the
  // only thing allowed to survive it.
  if (keep.size > cap && keep.size > floor.size) {
    for (const role of roster) {
      if (keep.size <= cap) break
      if (!keep.has(role)) continue
      if (floor.has(role)) continue
      if (isDevRoleId(role) && devCount() <= 1) continue
      drop(role)
    }
  }

  const trimmedRoster = roster.filter((role) => keep.has(role))
  return { team: trimmedRoster, trimmed, trimmedRequired, overCap: trimmedRoster.length > cap }
}

/* --------------------------------------------------------- team assembly */

/**
 * Routes a brief and assembles its roster: task family → default roster →
 * iron-triangle repair → security pin → cap trim. Pure and deterministic.
 */
export function assembleTeam(brief: string, maxMembers: number = DEFAULT_MAX_MEMBERS): TeamDecision {
  const type = matchTaskType(brief)
  const signal = securitySignal(brief)
  // Resolve the frontend slot BEFORE the roster is built: `required` must name
  // the specialist that is actually staffed, and the cap/trim logic must never
  // mistake it for an optional role.
  const frontend = planFrontendSlot(type.team, brief)

  const roster: string[] = []
  const notes: string[] = []
  const add = (role: string): void => {
    const canonical = canonicalRoleId(role)
    if (canonical === ROUTER_ROLE_ID) return
    if (!isRoleId(canonical)) return
    if (!roster.includes(canonical)) roster.push(canonical)
  }

  // Iron triangle: requirement corner first, so `pm` always opens the roster.
  add('pm')
  for (const role of frontend.team) add(role)
  if (!roster.some((role) => isDevRoleId(role))) {
    add(DEFAULT_DEV_ROLE)
    notes.push(`铁三角补位：${DEFAULT_DEV_ROLE}`)
  }
  add('qa')

  if (signal.triggered) {
    if (!roster.includes(SECURITY_ROLE_ID)) notes.push(`安全触发补位：${SECURITY_ROLE_ID}`)
    add(SECURITY_ROLE_ID)
  }

  // `required` is what the routing decision itself asks for: the selected
  // family's declared roster — with the frontend slot already resolved to the
  // detected specialist — plus the iron triangle's corners. It is *reported*
  // against, not pinned — the cap stays a hard limit — so the caller learns which
  // template roles were cut instead of meeting them later as a silent
  // ROLE_FALLBACKS substitution. The dedupe matters: `web_fullstack` already
  // declares `security_eng`, so the injected specialist must not be counted twice.
  const required = [...new Set([...frontend.team, ...TRIAD_BASE_ROLES])]
  const pinned = [...TRIAD_BASE_ROLES]
  if (signal.triggered && !pinned.includes(SECURITY_ROLE_ID)) pinned.push(SECURITY_ROLE_ID)
  const { team, trimmed, trimmedRequired, overCap } = trimToCap(roster, maxMembers, pinned, required)
  const cap = sanitizeCap(maxMembers)
  const needed = capFor(type.id, signal.triggered)
  const floor = teamFloor(signal.triggered)
  if (trimmed.length > 0) notes.push(`裁剪 ${trimmed.join('、')}`)
  if (trimmedRequired.length > 0) {
    notes.push(
      `需要 ${needed} 人，当前上限 ${cap}，已裁掉 ${trimmedRequired.join('、')}，` +
        '这些岗位的阶段将退回 ROLE_FALLBACKS，请提高 maxMembers',
    )
  }
  if (overCap) {
    notes.push(`编制上限 ${cap} 低于铁三角地板 ${floor}，已保留强制岗位，超出上限 ${team.length - cap} 人`)
  }

  const typeHits = matchedKeywordsFor(brief, type)
  const securityHits = signal.hits.filter((hit) => !typeHits.includes(hit))
  const frontendNote =
    frontend.platform === undefined || frontend.role === undefined
      ? []
      : [`前端平台: ${frontend.platform} → ${frontend.role}`]
  const reasoning = [
    `命中 ${type.id}（${typeHits.length > 0 ? typeHits.join('、') : '无关键词，回退默认'}）`,
    ...frontendNote,
    signal.triggered
      ? `安全规则触发（${signal.hits.join('、')}）→ ${SECURITY_ROLE_ID} 已加入且不可裁剪`
      : '未触发安全规则',
    `编制 ${team.length}/${roster.length} 人 → 流水线 ${type.pipeline}`,
    ...notes,
  ].join('；')

  return {
    taskType: type.id,
    team,
    pipeline: type.pipeline,
    reasoning,
    matchedKeywords: [...typeHits, ...securityHits],
    securityTriggered: signal.triggered,
    securityHits: [...signal.hits],
    securitySource: signal.source,
    ...(frontend.platform === undefined || frontend.role === undefined
      ? {}
      : { frontendPlatform: frontend.platform, frontendRole: frontend.role }),
    ...(trimmed.length === 0 ? {} : { trimmed }),
    ...(trimmedRequired.length === 0 ? {} : { trimmedRequired }),
    ...(overCap ? { overCap } : {}),
  }
}
