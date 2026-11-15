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
import type { FrontendPlatform, SecuritySignalSource, TaskTypeDef, TeamDecision } from '../shared/types.js';
/** Re-exported so callers can name the platform union without importing `shared` directly. */
export type { FrontendPlatform };
/** Hard floor: the iron triangle can never be cut below three members. */
export declare const MIN_TEAM_SIZE = 3;
/**
 * The longest template roster. Each family contributes its declared roster plus
 * the corners the router guarantees; the security specialist is not counted here
 * because only a security brief injects it — that extra corner is what
 * {@link capFor} accounts for when reporting a shortfall.
 */
export declare const MAX_TEMPLATE_ROSTER: number;
/**
 * Default roster cap. **Derived from the templates on purpose**: a cap below
 * {@link MAX_TEMPLATE_ROSTER} would silently trim the very specialists the
 * selected template requires (H3 — `web_fullstack` needs 11 roles, the old
 * hard-coded 8 dropped `ui_designer`/`sys_arch`/`db_arch`, and `ROLE_FALLBACKS`
 * quietly handed the design stage to its own implementers). Deriving it means a
 * template that grows can never silently outgrow the default again — the
 * relationship is a computation, not a comment.
 */
export declare const DEFAULT_MAX_MEMBERS: number;
/**
 * Roster floor for a given routing decision: three mandatory corners, plus the
 * security specialist when the security path is live (it is never trimmed).
 */
export declare function teamFloor(securityTriggered: boolean): number;
/**
 * Roles the router must never trim for one family: the family's own roster plus
 * the mandatory corners, plus `security_eng` when the security path is live.
 * Order follows `type.team`; unknown spellings are dropped, `router` never
 * appears. The security role is counted whether or not the template lists it —
 * a security brief injects it, so it is required by construction.
 */
export declare function requiredRolesFor(taskTypeId: string, securityTriggered?: boolean): readonly string[];
/**
 * The cap a family actually needs: its own roster plus the mandatory corners,
 * plus `security_eng` when the security path is live.
 *
 * This is a **read-only query for reporting** — the number a caller must pass as
 * `maxMembers` to staff the family without trimming. It deliberately does *not*
 * raise a caller's cap: the cap stays a hard limit, and a cap below this value
 * is reported through {@link TrimResult.trimmedRequired} instead.
 */
export declare function capFor(taskTypeId: string, securityTriggered?: boolean): number;
/** Dev job used when a task type somehow ships without one. */
export declare const DEFAULT_DEV_ROLE = "be_dev";
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
export declare const SECURITY_TRIGGERS: readonly string[];
/**
 * Trim order when a roster exceeds the cap: left to right, first present wins.
 * Add-on jobs go first (spec: `perf` > `po` > `tech_writer`), then the design
 * specialists whose duty another retained role can absorb, then supporting
 * roles, then the security specialist (unless the trigger pinned it), and only
 * then the implementers — never the last one.
 */
export declare const TRIM_ORDER: readonly string[];
/** Where a live security verdict came from. Recorded so the plan can say so. */
export type { SecuritySignalSource };
/** Whether the brief takes the security path, which words caused it, and where. */
export interface SecuritySignal {
    readonly triggered: boolean;
    readonly hits: readonly string[];
    /**
     * `brief` when the plan-time brief already triggered, `document` when only a
     * later document did, `none` when nothing did. H4's whole point is that these
     * are different claims: the first is a guess from one sentence, the second is
     * read off the requirements document.
     */
    readonly source: SecuritySignalSource;
}
/** Scans a brief for the mandatory-security-path triggers. */
export declare function securitySignal(brief: string): SecuritySignal;
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
export declare function securitySignalForDocuments(brief: string, documents?: readonly (string | undefined)[]): SecuritySignal;
/**
 * Mini-program platform keywords.
 *
 * Ordered by the detection rule, not by string length: a brief naming a
 * mini-program framework is a mini program even if it also says "flutter".
 * The bare `微信`/`小程序` words are included because the product's own
 * vocabulary uses them interchangeably for WeChat mini programs.
 */
export declare const FRONTEND_MINI_KEYWORDS: readonly string[];
/** Flutter / Dart keywords. ASCII matches use word boundaries (see `matchesTrigger`). */
export declare const FRONTEND_FLUTTER_KEYWORDS: readonly string[];
/** Platform → specialist role. The single source of the mapping. */
export declare const FRONTEND_ROLE_BY_PLATFORM: Readonly<Record<FrontendPlatform, string>>;
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
export declare function frontendPlatformFor(brief: string): FrontendPlatform;
/**
 * The specialist role that fills the frontend slot for a platform.
 *
 * @param platform - one of the three detected platforms.
 * @returns the registered specialist id; Web when the value is somehow unknown.
 */
export declare function frontendRoleFor(platform: FrontendPlatform): string;
/**
 * Reverse lookup: the platform a specialist role belongs to.
 *
 * @param role - role id or alias (`web_dev` / `FT` / `小程序工程师`).
 * @returns the platform, or `undefined` when the role is not a frontend specialist.
 */
export declare function frontendPlatformOfRole(role: string): FrontendPlatform | undefined;
/** Keywords of `type` that the brief actually hit, in registry order. */
export declare function matchedKeywordsFor(brief: string, type: TaskTypeDef): readonly string[];
/**
 * Classifies a brief. Scoring is "how many of the family's keywords appear";
 * ties go to the family registered first (most expensive pipeline first) and a
 * brief that matches nothing falls back to the cheapest family
 * (`script_tool` / `lightweight`), exactly like the skeleton did.
 */
export declare function matchTaskType(brief: string): TaskTypeDef;
/** `true` when the roster satisfies the iron triangle. */
export declare function hasIronTriangle(team: readonly string[]): boolean;
/** The corners missing from a roster; `[]` means the triangle holds. */
export declare function triadViolations(team: readonly string[]): readonly string[];
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
    readonly team: readonly string[];
    /** Roles actually dropped, in drop order (optional roles first). */
    readonly trimmed: readonly string[];
    /**
     * Subset of `trimmed` whose roles the *current task type's template* actually
     * lists — the honest signal that the cap cut into the template's roster.
     */
    readonly trimmedRequired: readonly string[];
    /** True when the cap could not even hold the mandatory floor. */
    readonly overCap: boolean;
}
/** Canonicalises a roster: known roles only, no router hat, no duplicates. */
export declare function normaliseRoster(team: readonly string[]): readonly string[];
/** Sanitises the cap coming from tool arguments (the model writes it). */
export declare function sanitizeCap(maxMembers: number): number;
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
export declare function trimToCap(team: readonly string[], maxMembers?: number, pinned?: readonly string[], required?: readonly string[]): TrimResult;
/**
 * Routes a brief and assembles its roster: task family → default roster →
 * iron-triangle repair → security pin → cap trim. Pure and deterministic.
 */
export declare function assembleTeam(brief: string, maxMembers?: number): TeamDecision;
