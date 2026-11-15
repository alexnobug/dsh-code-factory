/**
 * member.ts — the **3 member tools** (`factory_report` / `factory_inbox` /
 * `factory_block`), as `defineTool` definitions.
 *
 * These are the member-facing factory tools. On DSH 0.2.2 the captain tools are
 * hidden from delegated agents by step-admission conditions (`tools.register(...,
 * { when })` in `tools/captain.ts`), while the spawn preflight refuses to create
 * a member before all three of these exist. That is the tool half of the depth-0
 * rule — a member works, reports and escalates, and never adjudicates. The
 * historical `toolFilter` list is still computed as an audit/preflight guard for
 * older hosts, but it is not sent on the 0.2.2 flat start spec.
 *
 * Identity is derived, never claimed: a member tool finds the factory by looking
 * for the calling session id in `members[].sessionId`, so a captain session that
 * calls `factory_report` gets a refusal telling it to use `factory_status`
 * instead of silently writing into someone else's roster row.
 *
 * @module dsh-code-factory/tools/member
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterPropertySpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

import { MEMBER_BASE_TOOL_NAMES } from '../runtime/tool-surface.js'
import { blockFromMember, readMemberInbox, reportFromMember } from './engine.js'
import { renderToolResult, resolveToolCall, type FactoryToolConfig } from './context.js'

/* ---------------------------------------------------------------- fragments */

/**
 * The three member tools, in registration order — an alias of
 * {@link MEMBER_BASE_TOOL_NAMES} in `runtime/tool-surface.ts`, which is the
 * **single source of truth** for the member tool set (review finding M14).
 *
 * The same array is what the spawn preflight validates against the live
 * registry, so this name must stay an alias and never be re-forked into a
 * literal: a name listed here but not registered makes every member spawn fail
 * its preflight, and a name registered but missing from the list stays reachable
 * for members.
 */
export const MEMBER_TOOL_NAMES: readonly string[] = MEMBER_BASE_TOOL_NAMES

/** Shared parameter: an explicit factory id (the member may belong to exactly one). */
const FACTORY_ID = {
  type: 'string',
  description: '工厂 id；成员通常只需要所属的那一个，省略时会自动解析（members[].sessionId === 本会话）。',
} as const satisfies ParameterPropertySpec

/** One inbox row. */
const INBOX_ROWS = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      from: { type: 'string', required: true },
      content: { type: 'string', required: true },
      ts: { type: 'number', required: true },
      status: { type: 'string', required: true },
      kind: { type: 'string' },
      stage: { type: 'string' },
    },
  },
} as const satisfies ValueSchemaSpec

/* ------------------------------------------------------------ registration */

/**
 * Registers the 3 member tools into the shared registry.
 *
 * Called before the captain tools (`tools/index.ts`): the spawn preflight in
 * `runtime/tool-surface` checks these names against the live registry, so they
 * must be registered in the same activation that will spawn members.
 *
 * @param ctx - host context with the `tools` service injected.
 * @param config - resolved plugin configuration.
 */
export function registerFactoryMemberTools(ctx: Context, config: FactoryToolConfig): void {
  const effect = (name: string, dispose: () => void): void => {
    ctx.effect(() => dispose, `code-factory: tool ${name}`)
  }

  /* -------------------------------------------------------- factory_report */

  effect(
    'factory_report',
    ctx.tools.register(
      defineTool({
        name: 'factory_report',
        description:
          '成员向队长回报：把「这一阶段做到哪一步」写进工厂记录（成员状态 + 邮箱 + 工件登记）。'
          + '何时用：完成本阶段工件后（status=done）、需要说明进展时（working）、或无法继续时（blocked，或用 factory_block 详细说明）。'
          + '状态=done 后请停下等队长裁决门禁——**不要**自行宣布通过、也不要自行进入下一阶段。'
          + 'artifacts 里的路径必须是工作区相对路径，会被登记成阶段交接工件。',
        parameters: {
          status: {
            type: 'string',
            required: true,
            enum: ['working', 'done', 'blocked', 'note'],
            description: 'working=还在做；done=本阶段工件已完成，请队长裁决门禁；blocked=卡住；note=只留一条记录、不改状态。',
          },
          summary: { type: 'string', required: true, description: '一句话结论：做到了什么 / 卡在哪里（不要贴长日志）。' },
          factoryId: FACTORY_ID,
          stage: { type: 'string', description: '本次回报所属阶段 id；省略时用你当前所在阶段。' },
          artifacts: {
            type: 'array',
            items: { type: 'string' },
            description: '本次产出/改动的工件路径（工作区相对 POSIX，如 PRD.md、src/app.py）。',
          },
          commands: { type: 'array', items: { type: 'string' }, description: '你真实执行过的命令（会原样记录，供队长与门禁复核）。' },
          next: { type: 'string', description: '你需要队长/用户提供什么才能继续（可选）。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: { type: 'string', required: true },
              factoryId: { type: 'string', required: true },
              role: { type: 'string', required: true },
              status: { type: 'string', required: true },
              stage: { type: 'string', required: true },
              settledAttempts: { type: 'number', required: true },
              artifactsRegistered: { type: 'array', required: true, items: { type: 'string' } },
              artifactRejected: { type: 'array', required: true, items: { type: 'string' } },
              messageId: { type: 'string', required: true },
              captainNotified: { type: 'boolean', required: true },
              nextAction: { type: 'string', required: true },
            },
          },
          render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
          const call = resolveToolCall(exec, config)
          return await reportFromMember(call, args)
        },
      }),
    ),
  )

  /* --------------------------------------------------------- factory_inbox */

  effect(
    'factory_inbox',
    ctx.tools.register(
      defineTool({
        name: 'factory_inbox',
        description:
          '读你自己的邮箱（队长发来的派发单 / 打回单 / 指令），默认只取未读并把它们标记为已读。'
          + '何时用：收到唤醒后先看一眼有没有新指令；或不确定下一步做什么时。'
          + '想重看历史用 includeRead=true 且 markRead=false，避免把没处理的消息标记掉。',
        parameters: {
          factoryId: FACTORY_ID,
          limit: { type: 'number', description: '最多返回多少条（默认 20，最新的在后）。' },
          includeRead: { type: 'boolean', description: 'true 时连已读消息一起返回（默认只看未读）。' },
          markRead: { type: 'boolean', description: '设为 false 时只读不标记已读（默认读取后标记为已读）。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: { type: 'string', required: true },
              factoryId: { type: 'string', required: true },
              role: { type: 'string', required: true },
              messages: { ...INBOX_ROWS, required: true },
              markedRead: { type: 'number', required: true },
              remainingUnread: { type: 'number', required: true },
              nextAction: { type: 'string', required: true },
            },
          },
          render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
          const call = resolveToolCall(exec, config)
          return await readMemberInbox(call, args)
        },
      }),
    ),
  )

  /* --------------------------------------------------------- factory_block */

  effect(
    'factory_block',
    ctx.tools.register(
      defineTool({
        name: 'factory_block',
        description:
          '上报 BLOCKED：把「被什么挡住、需要什么」写进工厂记录并升级给队长（同时把你标记为 blocked，调度器不会再给你派活）。'
          + '何时用：缺少必要输入 / 契约矛盾 / 权限或环境不可用，且你无法在不越界的前提下继续时。'
          + '上报后停下等指令；不要绕过门禁、不要扩大工件边界、不要伪造证据。',
        parameters: {
          reason: { type: 'string', required: true, description: '卡住的具体原因（缺什么、谁挡住了、复现方式）。' },
          need: { type: 'string', description: '你需要队长/用户提供什么才能继续（越具体越好）。' },
          factoryId: FACTORY_ID,
          stage: { type: 'string', description: '出问题的阶段 id；省略时用你当前所在阶段。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: { type: 'string', required: true },
              factoryId: { type: 'string', required: true },
              role: { type: 'string', required: true },
              stage: { type: 'string', required: true },
              blocked: { type: 'boolean', required: true },
              messageId: { type: 'string', required: true },
              need: { type: 'string' },
              nextAction: { type: 'string', required: true },
            },
          },
          render: (_args, value) => renderToolResult(String(value.summary), value),
        },
        async execute(args, exec) {
          const call = resolveToolCall(exec, config)
          return await blockFromMember(call, args)
        },
      }),
    ),
  )
}
