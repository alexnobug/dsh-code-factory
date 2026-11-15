/**
 * roles.ts — the role registry.
 *
 * The **canonical 12** are a 1:1 port of the prototype's 角色注册表 (实施方案
 * §1.2 角色表 / `app/src/lib/data.ts` AGENTS): same twelve jobs, same codenames,
 * tiers, colours and duties. Role ids follow the prototype table **except the
 * security job**, which this registry calls `security_eng` because the router
 * rule and the task contract name it that way — the prototype's `sec_eng` stays
 * valid through {@link ROLE_ALIASES}, and {@link PROTOTYPE_ROLE_ID_ALIASES}
 * records the full mapping so the deviation is explicit rather than accidental.
 *
 * Two groups sit outside that canonical 12:
 *  - {@link EXTRA_ROLES} — optional add-ons (`perf` / `po` / `tech_writer`) the
 *    cap trims first;
 *  - {@link SPECIALIST_ROLES} — platform-specific frontend jobs
 *    (`web_dev` / `flutter_dev` / `mini_program_dev`) that the router assigns
 *    automatically into the frontend slot, with the generic `fe_dev` kept as the
 *    back-compat fallback.
 *
 * Every other spelling used by the Kimi skeleton, the captain protocol or early
 * docs (`security_eng`, `architect`, `frontend_dev`, `backend_dev`, `DBA`, …) is
 * accepted through {@link ROLE_ALIASES} and normalised by
 * {@link canonicalRoleId}.
 *
 * PURITY CONTRACT (hard): this module is compiled by BOTH tsc programs and is
 * bundled into the browser half, so it has **no external imports** (only the
 * sibling `shared/types.js` type contract), no Node API, no side effects and
 * no non-determinism. `tools` is deliberately omitted on every role: the member
 * tool surface is computed by the runtime from the host's *registered* tool
 * names (API-CONTRACTS 陷阱 #6 — a single unregistered name makes every spawn
 * fail), so the domain layer must not guess tool names.
 *
 * @module dsh-code-factory/domain/roles
 */
import type { RoleDef } from '../shared/types.js';
/**
 * The canonical roster, in prototype order (12 jobs).
 *
 * `router` is the captain's own dispatcher hat: it is registered so the cockpit
 * can render row 1 of the prototype roster and so routing vocabulary resolves,
 * but {@link import('./router.js').assembleTeam} never spawns it as a member.
 */
export declare const ROLES: readonly RoleDef[];
/**
 * Add-on jobs that are NOT part of the canonical 12 and are never auto-assigned
 * by the router. They exist because the roster cap has a defined trim order
 * (perf > po > tech_writer first) and because `factory_edit_plan` may add a
 * specialist to a running factory; they are trimmed before any canonical role.
 */
export declare const EXTRA_ROLES: readonly RoleDef[];
/**
 * Frontend specialists: platform-specific implementation jobs.
 *
 * They are **not** part of the canonical 12 (the prototype roster table stays
 * untouched) and they are not add-ons that get trimmed first either: the router
 * *auto-assigns* exactly one of them into the frontend slot (`fe_dev`) after
 * detecting the platform, and `ROLE_FALLBACKS` resolves the pipeline's generic
 * `fe_dev` stage slot to whichever specialist the team actually has.
 *
 * `fe_dev` survives as the generic/back-compat frontend role — an explicit old
 * roster, an old `factory.json` member row, and a brief whose platform cannot be
 * pinned down all still resolve to it.
 */
export declare const SPECIALIST_ROLES: readonly RoleDef[];
/** Canonical id → definition (12 entries). */
export declare const ROLE_BY_ID: Readonly<Record<string, RoleDef>>;
/** Canonical id plus add-on and specialist id → definition (18 entries). */
export declare const ALL_ROLE_BY_ID: Readonly<Record<string, RoleDef>>;
/** Canonical ids in roster order. */
export declare const ROLE_IDS: readonly string[];
/** The prototype roster size, asserted by `validateRoleRegistry`. */
export declare const CANONICAL_ROLE_COUNT = 12;
/**
 * Loose spellings accepted on input and normalised to canonical ids.
 * Keys are matched case-insensitively (`canonicalRoleId` lower-cases first).
 * Canonical ids are never keys here — they win by definition.
 */
export declare const ROLE_ALIASES: Readonly<Record<string, string>>;
/**
 * Prototype §1.2 role-table id → canonical id of this registry.
 *
 * All twelve entries are identity except the security job: the prototype table
 * writes `sec_eng`, while this registry (following the task's router rule) uses
 * `security_eng`. The map makes that single deviation explicit and
 * machine-checkable instead of a surprise — `validateRoleRegistry` asserts it
 * covers all twelve canonical ids exactly.
 */
export declare const PROTOTYPE_ROLE_ID_ALIASES: Readonly<Record<string, string>>;
/** The id of the dispatcher role (the captain's hat; never a member). */
export declare const ROUTER_ROLE_ID = "router";
/** The security specialist: pinned into any roster that triggered the security path. */
export declare const SECURITY_ROLE_ID = "security_eng";
/** Every id that denotes the security specialist. */
export declare const SECURITY_ROLE_IDS: readonly string[];
/**
 * The generic frontend role: a stage slot and a back-compat id, not the default
 * assignment any more. New rosters get one of {@link FRONTEND_SPECIALIST_ROLE_IDS}
 * and resolve the pipeline's `fe_dev` slot through `ROLE_FALLBACKS`.
 */
export declare const GENERIC_FRONTEND_ROLE_ID = "fe_dev";
/** Platform-specific frontend specialists, in detection preference order. */
export declare const FRONTEND_SPECIALIST_ROLE_IDS: readonly string[];
/** Suffix that marks an implementation job (`fe_dev`, `be_dev`, …). */
export declare const DEV_ROLE_SUFFIX = "_dev";
/** The two always-pinned corners of the iron triangle; the dev corner is dynamic. */
export declare const TRIAD_BASE_ROLES: readonly string[];
/**
 * Substitution ladder used by `pipeline.resolveStageRoles` when the roster cap
 * trimmed a stage's specialist (or the factory never staffed it): walk the list
 * left to right and take the first id present in the team. Never self-referent.
 * `[]` means "only the role itself can do it" (pinned roles).
 */
export declare const ROLE_FALLBACKS: Readonly<Record<string, readonly string[]>>;
/** Normalises any accepted spelling to a canonical role id (lower-cased, trimmed). */
export declare function canonicalRoleId(id: string): string;
/** Definition for any accepted spelling, canonical or add-on. */
export declare function getRole(id: string): RoleDef | undefined;
/** True when the spelling resolves to a registered job (canonical or add-on). */
export declare function isRoleId(id: string): boolean;
/** True when the spelling is one of the canonical 12. */
export declare function isCanonicalRoleId(id: string): boolean;
/** True for `*_dev` implementation jobs (accepts aliases such as `backend_dev`). */
export declare function isDevRoleId(id: string): boolean;
/** True for the security specialist under any spelling. */
export declare function isSecurityRole(id: string): boolean;
/** Chinese title for a role id, falling back to the raw id. */
export declare function roleTitle(id: string): string;
/** Result of a registry self-audit. */
export interface RegistryAudit {
    readonly ok: boolean;
    readonly errors: readonly string[];
}
/**
 * Pure registry audit, run by the offline self-check (and cheap enough for the
 * captain tool surface). Catches the class of bug that otherwise only shows up
 * as a missing member at spawn time.
 */
export declare function validateRoleRegistry(): RegistryAudit;
