/**
 * task-types.ts — the five routable task families.
 *
 * Port of the prototype's 任务类型 → 编制映射 (Kimi 骨架 `TASK_TYPES`, extended
 * to the five families this project promises): `web_fullstack`, `api_only`,
 * `data_pipeline`, `script_tool`, `ml_model`.
 *
 * `team` is the **default** roster in suggested join order. It is a starting
 * point, not a promise: `router.assembleTeam` adds the mandatory iron triangle
 * and the security specialist, then enforces the roster cap.
 *
 * PURITY CONTRACT (hard): no external imports, no Node API, no side effects.
 *
 * @module dsh-code-factory/domain/task-types
 */
import type { TaskTypeDef } from '../shared/types.js';
/** The five families, most expensive pipeline first (the last entry is the fallback). */
export declare const TASK_TYPES: readonly TaskTypeDef[];
/**
 * Fallback family when no keyword matches: the cheapest pipeline. The router
 * guarantees this id is the **last** entry of {@link TASK_TYPES}, so "no match"
 * and "weakest match" resolve the same way.
 */
export declare const DEFAULT_TASK_TYPE_ID = "script_tool";
/** All family ids, in registry order. */
export declare const TASK_TYPE_IDS: readonly string[];
/** Every family id the project promises to route (schema for the self-check). */
export declare const REQUIRED_TASK_TYPE_IDS: readonly string[];
/** One family by id. */
export declare function getTaskType(id: string): TaskTypeDef | undefined;
/**
 * How many members one family's roster needs: its declared `team` plus the
 * corners the router guarantees (two of which every roster already lists, so
 * this is `team.length` today — the computation keeps it honest if a roster ever
 * forgets one). This is the number a roster cap must never fall below, which is
 * why {@link import('./router.js').DEFAULT_MAX_MEMBERS} is derived from it.
 */
export declare function requiredTeamSize(task: TaskTypeDef | undefined): number;
/** The widest family roster — the smallest cap that trims nothing, ever. */
export declare function widestTeamSize(): number;
/**
 * The fallback family. `DEFAULT_TASK_TYPE_ID` is ordinarily registered; if a
 * registry edit ever unregisters it, the last entry stands in, because planning
 * must still produce a pipeline. An empty registry is not a fallback case — it
 * is a broken build, so it says so instead of returning `undefined` under a
 * non-optional return type.
 */
export declare function defaultTaskType(): TaskTypeDef;
