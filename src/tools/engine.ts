/**
 * engine.ts — the public surface of the factory orchestration engine.
 *
 * This file is a barrel: the 16 tool handlers and {@link ledgerFor} used to
 * live in this single ~3.3k-line module, and review finding M5 split them by
 * tool domain. The modules behind them are:
 *
 *   - `./engine/plumbing.js` — ledger/attempt bookkeeping, mailbox writes, the
 *     gate-runner + command-row adapters, the shared row shapes and the
 *     factory lookup used when a call does not name its factory;
 *   - `./engine/dod.js` — the definition-of-done projections;
 *   - `./engine/plan.js` — `factory_plan` / `factory_edit_plan`;
 *   - `./engine/dispatch.js` — `factory_approve` / `factory_dispatch`;
 *   - `./engine/gate.js` — `factory_gate`;
 *   - `./engine/status.js` — `factory_status`;
 *   - `./engine/reuse.js` — `factory_reuse` (cross-project reuse library);
 *   - `./engine/members.js` — `factory_report` / `factory_inbox` /
 *     `factory_block` / `factory_message`;
 *   - `./engine/delivery.js` — `factory_dod_check` / `factory_deliver` /
 *     `factory_halt` / `factory_resume` / `factory_delete`.
 *
 * The export set below is machine-checked: `scripts/engine-drill.mjs` stage
 * `00-surface` asserts that the **function** exports of `lib/tools/engine.js`
 * are exactly the 16 tool handlers plus `ledgerFor`. Never widen it — add a
 * helper to the module that needs it, not here.
 *
 * @module dsh-code-factory/tools/engine
 */

export { ledgerFor } from './engine/plumbing.js'
export type { PlanRoleRow, CommandRow, DodItemRow, DodSummaryRow } from './engine/plumbing.js'
export { planFactory, editFactoryPlan } from './engine/plan.js'
export type { PlanStageRow, PlanFactoryInput, PlanFactoryResult, EditPlanInput, EditPlanResult } from './engine/plan.js'
export { readFactoryStatus } from './engine/status.js'
export type { StatusStageRow, StatusMemberRow, StatusFactoryInput, UnreadRow, FeedRow, FactoryIndexRow, StaleMemberRow, ExecutorAudit, StatusFactoryResult } from './engine/status.js'
export { reuseFactory } from './engine/reuse.js'
export type { ReuseFactoryInput, ReuseFactoryResult, ReuseAction } from './engine/reuse.js'
export { approveFactory, dispatchFactory } from './engine/dispatch.js'
export type { DispatchRow, ApproveFactoryInput, ApproveFactoryResult, DispatchFactoryInput, DispatchFactoryResult } from './engine/dispatch.js'
export { gateFactory } from './engine/gate.js'
export type { GateFactoryInput, GateFactoryResult } from './engine/gate.js'
export { messageFactory, reportFromMember, readMemberInbox, blockFromMember } from './engine/members.js'
export type { MessageFactoryInput, MessageFactoryResult, MemberReportInput, MemberReportResult, MemberInboxInput, InboxRow, MemberInboxResult, MemberBlockInput, MemberBlockResult } from './engine/members.js'
export { checkDod, haltFactory, resumeFactory, deliverFactory, deleteFactory } from './engine/delivery.js'
export type { DodCheckInput, DodCheckResult, HaltFactoryInput, HaltFactoryResult, ResumeFactoryInput, ResumeFactoryResult, DeliverFactoryInput, DeliverFactoryResult, DeleteFactoryInput, DeleteFactoryResult } from './engine/delivery.js'
