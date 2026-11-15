/**
 * engine/members.ts — factory_report / factory_inbox / factory_block / factory_message.
 *
 * The member-facing tools: a member reports progress (which is also what
 * parks a stage at its gate), reads its own mailbox, escalates a block, or
 * sends a coordination message.
 *
 * Moved here verbatim from the former single-file `src/tools/engine.ts`
 * (engineering review finding M5). Only this header, the imports and the
 * `export` keywords on cross-module helpers are new — no body was edited.
 *
 * @module dsh-code-factory/tools/engine/members
 */
import type { ToolCallContext } from '../context.js';
/** Arguments of {@link messageFactory}. */
export interface MessageFactoryInput {
    readonly factoryId: string;
    readonly to: string;
    readonly content: string;
    readonly kind?: string;
    readonly stage?: string;
    readonly round?: number;
    readonly deliver?: boolean;
}
/** Result of {@link messageFactory}. */
export interface MessageFactoryResult {
    readonly summary: string;
    readonly factoryId: string;
    readonly messageId: string;
    readonly from: string;
    readonly to: string;
    readonly kind: string;
    readonly stage?: string;
    readonly round?: number;
    readonly delivered: boolean;
    readonly mode?: string;
    readonly via?: string;
    readonly error?: string;
    readonly nextAction: string;
}
/**
 * Writes one mailbox message, optionally waking the recipient member.
 *
 * The mailbox line is the durable record; delivering it to a live member is the
 * accelerator. When delivery succeeds the line is stamped `deliveredAt` (the
 * store's `pending → delivered → read` tri-state), so the cockpit can show whether
 * the member actually received it.
 */
export declare function messageFactory(call: ToolCallContext, input: MessageFactoryInput): Promise<MessageFactoryResult>;
/** Arguments of {@link reportFromMember}. */
export interface MemberReportInput {
    readonly factoryId?: string;
    readonly status: string;
    readonly summary: string;
    readonly stage?: string;
    readonly artifacts?: string[];
    readonly commands?: string[];
    readonly next?: string;
}
/** Result of {@link reportFromMember}. */
export interface MemberReportResult {
    readonly summary: string;
    readonly factoryId: string;
    readonly role: string;
    readonly status: string;
    readonly stage: string;
    readonly settledAttempts: number;
    readonly artifactsRegistered: string[];
    readonly artifactRejected: string[];
    readonly messageId: string;
    readonly captainNotified: boolean;
    readonly nextAction: string;
}
/**
 * One member's work report: the durable hand-off back to the captain.
 *
 * It writes the member's status into the roster (so the scheduler stops treating
 * the attempt as outstanding), registers the artifacts the report names (the
 * artifact registry is the only hand-off surface between stages) and appends a
 * `report` message to the captain's mailbox. It never adjudicates anything: the
 * gate decides.
 */
export declare function reportFromMember(call: ToolCallContext, input: MemberReportInput): Promise<MemberReportResult>;
/** Arguments of {@link readMemberInbox}. */
export interface MemberInboxInput {
    readonly factoryId?: string;
    readonly limit?: number;
    readonly includeRead?: boolean;
    readonly markRead?: boolean;
}
/** One inbox row. */
export interface InboxRow {
    readonly id: string;
    readonly from: string;
    readonly content: string;
    readonly ts: number;
    readonly status: string;
    readonly kind?: string;
    readonly stage?: string;
}
/** Result of {@link readMemberInbox}. */
export interface MemberInboxResult {
    readonly summary: string;
    readonly factoryId: string;
    readonly role: string;
    readonly messages: InboxRow[];
    readonly markedRead: number;
    readonly remainingUnread: number;
    readonly nextAction: string;
}
/** Reads the member's own mailbox and (by default) marks it consumed. */
export declare function readMemberInbox(call: ToolCallContext, input: MemberInboxInput): Promise<MemberInboxResult>;
/** Arguments of {@link blockFromMember}. */
export interface MemberBlockInput {
    readonly reason: string;
    readonly factoryId?: string;
    readonly stage?: string;
    readonly need?: string;
}
/** Result of {@link blockFromMember}. */
export interface MemberBlockResult {
    readonly summary: string;
    readonly factoryId: string;
    readonly role: string;
    readonly stage: string;
    readonly blocked: boolean;
    readonly messageId: string;
    readonly need?: string;
    readonly nextAction: string;
}
/** Marks the member blocked and escalates to the captain. */
export declare function blockFromMember(call: ToolCallContext, input: MemberBlockInput): Promise<MemberBlockResult>;
