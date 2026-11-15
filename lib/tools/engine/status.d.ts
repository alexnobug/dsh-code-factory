/**
 * engine/status.ts — factory_status.
 *
 * The read-only cockpit projection: the factory index, the stage/member/feed
 * rows, the DoD summary, the executor audit that explains stranded members,
 * and the single next action the caller should take.
 *
 * Moved here verbatim from the former single-file `src/tools/engine.ts`
 * (engineering review finding M5). Only this header, the imports and the
 * `export` keywords on cross-module helpers are new — no body was edited.
 *
 * @module dsh-code-factory/tools/engine/status
 */
import type { FactoryState, ArtifactRecord, ImprovementStatus, ImprovementTarget } from '../../shared/types.js';
import type { ToolCallContext } from '../context.js';
import type { DodItemRow, DodSummaryRow } from './plumbing.js';
/** One stage row of a live status projection. */
export interface StatusStageRow {
    readonly id: string;
    readonly name: string;
    readonly status: string;
    readonly round: number;
    readonly attempts: number;
    readonly roles: string[];
    readonly parallel: boolean;
    readonly humanApproval: boolean;
    readonly gateType: string;
    readonly failGoto?: string;
    readonly lastGateOk?: boolean;
    readonly lastGateDetail?: string;
}
/** One member row of a live status projection. */
export interface StatusMemberRow {
    readonly role: string;
    readonly title: string;
    readonly codename: string;
    readonly tier: string;
    readonly duties: string;
    readonly status: string;
    readonly tokens: number;
    readonly stage?: string;
    readonly sessionId?: string;
    readonly spawnError?: string;
    readonly provider?: string;
    readonly model?: string;
}
/** Arguments of {@link readFactoryStatus}. */
export interface StatusFactoryInput {
    readonly factoryId?: string;
    readonly sessionId?: string;
    readonly feedLimit?: number;
}
/** One unread-count row. */
export interface UnreadRow {
    readonly key: string;
    readonly unread: number;
}
/** One feed row. */
export interface FeedRow {
    readonly id: string;
    readonly from: string;
    readonly to: string;
    readonly content: string;
    readonly ts: number;
    readonly status: string;
    readonly kind?: string;
    readonly stage?: string;
}
/** One index row. */
export interface FactoryIndexRow {
    readonly id: string;
    readonly name: string;
    readonly phase: string;
    readonly taskType: string;
    readonly pipeline: string;
    readonly updatedAt: number;
}
/** One roster row whose recorded status no longer matches the executor probe. */
export interface StaleMemberRow {
    readonly role: string;
    /** The status recorded in `factory.json` (always `working` or `rework` here). */
    readonly status: string;
    /** Durable member session id the probe answered about (may be empty). */
    readonly sessionId: string;
    /** Stage the member claimed to be working on, when it recorded one. */
    readonly stage?: string;
    readonly reason: string;
}
/**
 * **Read-only** explanation of members whose status nobody is executing.
 *
 * Two buckets, because they demand different actions from the captain:
 *
 *  - `stale`（已过期，probe verdict `gone`）— 执行者不在场：`factory_dispatch` 会把状态收敛为
 *    `idle` 并按 stranded 恢复重新派发；本轮 `factory_status` 只解释、不改。
 *  - `uncertain`（待确认，probe verdict `unknown`）— 本 composition 没有可用的 liveness 探针
 *    （或成员没有会话 id），无法判定执行者是否在场：不要据此下"卡死"的结论。
 *
 * The wording and the criteria come from `runtime/scheduler` (`reconcileStrandedMembers` /
 * `memberExecutorVerdict`), so the explanation cannot drift from what a dispatch will do.
 */
export interface ExecutorAudit {
    readonly stale: StaleMemberRow[];
    readonly uncertain: StaleMemberRow[];
    readonly note: string;
}
/** One row of the workspace evolution summary shown by `factory_status`. */
export interface StatusLessonRow {
    readonly id: string;
    readonly role: string;
    readonly stage: string;
    readonly gateType: string;
    readonly kind: string;
    readonly text: string;
    readonly count: number;
    readonly lastAt: number;
    readonly resolvedAt?: number;
}
/** One derived plugin-improvement proposal row shown by `factory_status`. */
export interface StatusImprovementRow {
    readonly id: string;
    readonly title: string;
    readonly target: ImprovementTarget;
    readonly targetFile?: string;
    readonly suggestion: string;
    readonly rationale: string;
    readonly role?: string;
    readonly stage?: string;
    readonly evidenceCount: number;
    readonly status: ImprovementStatus;
    readonly lastAt: number;
}
/**
 * Derived plugin-improvement backlog shown beside the lesson roll-up.
 *
 * `total` / `open` / `validated` count **every** derived proposal, while
 * `proposals` lists only the hottest {@link IMPROVEMENTS_SHOWN} rows (a status
 * result is a focus surface, not a dump). The proposals are derived from the
 * durable ledger on each call, never persisted, so they cannot drift from the
 * lessons that justify them.
 */
export interface StatusImprovementsRow {
    readonly total: number;
    readonly open: number;
    readonly validated: number;
    readonly proposals: StatusImprovementRow[];
}
/**
 * Read-only summary of the workspace's evolution ledger.
 *
 * `total` / `recurring` / `resolved` / `lastAt` roll up the **whole** workspace
 * ledger (that is what makes a recurring mistake visible), while `lessons` is
 * only the newest 5 rows — the full archive lives in `.code-factory/evolution.json`,
 * the tool result is a status row, not a dump.
 *
 * `improvements` is the derived half: recurring lessons (count ≥ 2) become
 * plugin-improvement proposals. It is optional so a failed derivation omits the
 * field instead of fabricating an empty backlog.
 */
export interface StatusEvolutionRow {
    readonly total: number;
    readonly recurring: number;
    readonly resolved: number;
    readonly lastAt?: number;
    readonly lessons: StatusLessonRow[];
    readonly improvements?: StatusImprovementsRow;
}
/** Result of {@link readFactoryStatus}. */
export interface StatusFactoryResult {
    readonly summary: string;
    readonly scope: string;
    readonly workspace: string;
    readonly stateDir: string;
    readonly factoryId?: string;
    readonly name?: string;
    readonly phase?: string;
    readonly taskType?: string;
    readonly pipeline?: string;
    readonly planReviewState?: string;
    readonly securityTriggered?: boolean;
    readonly brief?: string;
    readonly captainSessionId?: string;
    readonly factoryFile?: string;
    readonly deliveryPath?: string;
    readonly members?: StatusMemberRow[];
    readonly stages?: StatusStageRow[];
    readonly currentStage?: string;
    readonly dod?: DodSummaryRow;
    readonly dodItems?: DodItemRow[];
    readonly artifacts?: ArtifactRecord[];
    readonly unread?: UnreadRow[];
    readonly feed?: FeedRow[];
    readonly factories?: FactoryIndexRow[];
    readonly executorAudit?: ExecutorAudit;
    readonly evolution?: StatusEvolutionRow;
    readonly notes: string[];
    readonly nextAction: string;
}
/**
 * Reads the durable truth for one factory (or the workspace index).
 *
 * With no `factoryId` the newest factory owned by the caller is used; a member
 * session resolves through its own roster row; an explicit `sessionId` is only
 * ever compared for equality (it never becomes a path).
 */
export declare function readFactoryStatus(call: ToolCallContext, input: StatusFactoryInput): Promise<StatusFactoryResult>;
/**
 * The next thing the captain should do, derived from the durable record.
 *
 * "Next" is `selectDispatchStage` — the first stage that has not passed — not
 * `activeStage`: after a rejection nothing is `active` any more, and the honest
 * answer is therefore "rework/redispatch that stage", never "all stages passed".
 *
 * The mapping is **status-first on purpose**. A stage sitting in `gate` has already
 * been evaluated: `factory_dispatch` has nothing to dispatch there (its own planner
 * answers `wait`), so pointing at it walks the reader into a dead end — in a real
 * rehearsal exactly that happened ("dispatch returned wait → the factory looks
 * stuck"). Every stage status therefore maps to the one tool that can actually move
 * it, and the gate status is split again by its own verdict because a passed gate
 * and a failed one need different calls (`advance` vs a rejection round).
 *
 * @param state - the durable factory record.
 * @param staleMembers - read-only audit rows (see {@link explainStaleMembers}) to
 *   mention, so a stale roster is never explained away as "a working member".
 * @returns one imperative sentence for the model.
 */
export declare function nextActionFor(state: FactoryState, staleMembers?: readonly StaleMemberRow[]): string;
