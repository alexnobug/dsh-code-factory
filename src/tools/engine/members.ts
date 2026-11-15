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

import { randomUUID } from 'node:crypto'
import { MESSAGE_KINDS } from '../../shared/types.js'
import type { MessageKind } from '../../shared/types.js'
import { ROLE_IDS, canonicalRoleId, isRoleId, roleTitle } from '../../domain/roles.js'
import { findMember, sendToMember } from '../../runtime/members.js'
import { measureMemberTokens } from '../../runtime/tokens.js'
import { transitionMember } from '../../store/state.js'
import { mailboxStatus } from '../../store/store.js'
import { FactoryToolError, loadFactory, requireCaptainOf, requireFactoryId, mutateFactory } from '../context.js'
import type { ToolCallContext } from '../context.js'

import { isMessageKind, optional, required, clip, optionalCount, resolveReportedStage, artifactStageId, settleAttempts, parkStageAtGate, postMail, resolveMemberFactory } from './plumbing.js'

/* ---------------------------------------------------------------- message */

/** Arguments of {@link messageFactory}. */
export interface MessageFactoryInput {
  readonly factoryId: string
  readonly to: string
  readonly content: string
  readonly kind?: string
  readonly stage?: string
  readonly round?: number
  readonly deliver?: boolean
}
/** Result of {@link messageFactory}. */
export interface MessageFactoryResult {
  readonly summary: string
  readonly factoryId: string
  readonly messageId: string
  readonly from: string
  readonly to: string
  readonly kind: string
  readonly stage?: string
  readonly round?: number
  readonly delivered: boolean
  readonly mode?: string
  readonly via?: string
  readonly error?: string
  readonly nextAction: string
}
/**
 * Writes one mailbox message, optionally waking the recipient member.
 *
 * The mailbox line is the durable record; delivering it to a live member is the
 * accelerator. When delivery succeeds the line is stamped `deliveredAt` (the
 * store's `pending → delivered → read` tri-state), so the cockpit can show whether
 * the member actually received it.
 */
export async function messageFactory(call: ToolCallContext, input: MessageFactoryInput): Promise<MessageFactoryResult> {
  const factoryId = requireFactoryId(input.factoryId)
  const state = await loadFactory(call, factoryId)
  requireCaptainOf(call, state)
  const content = required(input.content, 'content（消息正文）')
  const rawTo = required(input.to, 'to（收件人：captain 或角色 id）')
  const to = rawTo === 'captain' ? 'captain' : canonicalRoleId(rawTo)
  if (to !== 'captain' && (!isRoleId(to) || to === 'router')) {
    throw new FactoryToolError(
      `code-factory: 收件人 ${JSON.stringify(rawTo)} 既不是 captain 也不是注册角色。可用角色: ${ROLE_IDS.filter((id) => id !== 'router').join('、')}。`,
    )
  }
  const kindRaw = optional(input.kind)
  if (kindRaw !== undefined && !isMessageKind(kindRaw)) {
    throw new FactoryToolError(`code-factory: 未知消息类型 ${JSON.stringify(kindRaw)}。可用: ${MESSAGE_KINDS.join('、')}。`)
  }
  const kind: MessageKind = kindRaw ?? 'system'
  const stage = optional(input.stage)
  const round = optionalCount(input.round)

  let delivered = false
  let mode: string | undefined
  let via: string | undefined
  let error: string | undefined
  const member = to === 'captain' ? undefined : findMember(state, to)
  if (to !== 'captain' && member === undefined) {
    error = `工厂 ${factoryId} 的编制里没有角色 ${to}：消息只写入邮箱，不会被任何成员读到。`
  } else if (member !== undefined && input.deliver !== false) {
    if (member.sessionId === undefined || member.sessionId === '') {
      error = `成员 ${to} 还没有会话 id（${member.spawnError ?? '尚未创建'}）：消息已写入邮箱，等它被创建后即可读到。`
    } else {
      const send = await sendToMember(call.plugin, call.caller, member, content, call.signal, {
        mode: 'queue',
        ...(stage === undefined ? {} : { stage }),
      })
      delivered = send.ok
      mode = send.mode
      via = send.via
      if (!send.ok) error = send.error
    }
  }

  const message = await postMail(call, factoryId, {
    id: randomUUID(),
    from: 'captain',
    to,
    content,
    kind,
    ...(stage === undefined ? {} : { stage }),
    ...(round === undefined ? {} : { round }),
    ...(delivered ? { deliveredAt: call.store.now() } : {}),
  })

  return {
    summary:
      `消息已写入 ${to} 的邮箱（${message.id}）`
      + (delivered
        ? `，并已投递给成员会话（${mode ?? 'queue'}${via === undefined ? '' : `/${via}`}）。`
        : to === 'captain'
          ? '（队长自己的审计频道）。'
          : '，但未能投递给成员。')
      + (error === undefined ? '' : ` ${error}`),
    factoryId,
    messageId: message.id,
    from: message.from,
    to: message.to,
    kind,
    ...(stage === undefined ? {} : { stage }),
    ...(round === undefined ? {} : { round }),
    delivered,
    ...(mode === undefined ? {} : { mode }),
    ...(via === undefined ? {} : { via }),
    ...(error === undefined ? {} : { error }),
    nextAction: '继续用 factory_status 看进度；给成员的下一条指令可以直接复用这次投递。',
  }
}
/* --------------------------------------------------------- member actions */

/** Arguments of {@link reportFromMember}. */
export interface MemberReportInput {
  readonly factoryId?: string
  readonly status: string
  readonly summary: string
  readonly stage?: string
  readonly artifacts?: string[]
  readonly commands?: string[]
  readonly next?: string
}
/** Result of {@link reportFromMember}. */
export interface MemberReportResult {
  readonly summary: string
  readonly factoryId: string
  readonly role: string
  readonly status: string
  readonly stage: string
  readonly settledAttempts: number
  readonly artifactsRegistered: string[]
  readonly artifactRejected: string[]
  readonly messageId: string
  readonly captainNotified: boolean
  readonly nextAction: string
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
export async function reportFromMember(call: ToolCallContext, input: MemberReportInput): Promise<MemberReportResult> {
  const statusRaw = required(input.status, 'status（working / done / blocked / note）')
  if (!['working', 'done', 'blocked', 'note'].includes(statusRaw)) {
    throw new FactoryToolError(`code-factory: status 只能是 working / done / blocked / note，收到 ${JSON.stringify(statusRaw)}。`)
  }
  const summaryText = required(input.summary, 'summary（本次工作的一句话结论）')
  const resolved = await resolveMemberFactory(call, input.factoryId)
  const factoryId = resolved.state.id
  const requestedStageRaw = optional(input.stage)
  const stageId = requestedStageRaw !== undefined
    ? resolveReportedStage(resolved.state, requestedStageRaw)
    : artifactStageId(resolved.state, resolved.stage)
  const artifacts = (input.artifacts ?? []).map((item) => String(item).trim()).filter((item) => item !== '')
  const commands = (input.commands ?? []).map((item) => String(item).trim()).filter((item) => item !== '')
  const next = optional(input.next)
  // `member.tokens` 的真数：成员刚干完一段活、正要回报，正是刷新它的时刻。
  // 计量要读宿主的会话日志（异步），所以必须在同步的 mutate 之外先做完。
  const tokens = await measureMemberTokens(call.plugin, call.callerId)

  const { value } = await mutateFactory(call, factoryId, (state) => {
    const member = state.members.find((candidate) => candidate.sessionId === call.callerId)
    if (member === undefined) {
      throw new FactoryToolError(
        `code-factory: 会话 ${call.callerId} 已不在工厂 ${factoryId} 的编制里（可能被回收）——请把结论交给队长上报。`,
      )
    }
    const now = call.store.now()
    if (tokens !== undefined) member.tokens = tokens.total
    if (statusRaw === 'done') {
      transitionMember(member, 'done', now)
      member.currentStage = stageId
      parkStageAtGate(state, stageId, now)
    } else if (statusRaw === 'blocked') {
      transitionMember(member, 'blocked', now)
      member.currentStage = stageId
    } else if (statusRaw === 'working') {
      transitionMember(member, 'working', now)
      member.currentStage = stageId
      member.startedAt = member.startedAt ?? now
    }
    const role = canonicalRoleId(member.role)
    const settled = settleAttempts(state, role, stageId, call.store.now())
    return { role, memberStatus: member.status, settled }
  })

  const registered: string[] = []
  const rejected: string[] = []
  for (const path of artifacts) {
    try {
      await call.store.registerArtifact(factoryId, { path, by: value.role, stage: stageId }, { lock: true })
      registered.push(path)
    } catch (error) {
      rejected.push(`${path}（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  const body = [
    `【成员回报 · ${roleTitle(value.role)}】状态: ${statusRaw}`,
    `阶段: ${stageId}`,
    `结论: ${summaryText}`,
    artifacts.length > 0 ? `工件: ${artifacts.join('、')}` : '',
    commands.length > 0 ? `命令: ${commands.map((command) => `\`${command}\``).join('、')}` : '',
    next === undefined ? '' : `下一步需求: ${next}`,
  ]
    .filter((line) => line !== '')
    .join('\n')
  const message = await postMail(call, factoryId, {
    id: randomUUID(),
    from: value.role,
    to: 'captain',
    content: body,
    kind: statusRaw === 'blocked' ? 'blocked' : statusRaw === 'done' ? 'report' : 'handoff',
    stage: stageId,
  })

  return {
    summary:
      `${roleTitle(value.role)} 已回报「${statusRaw}」（阶段 ${stageId}）：${summaryText}`
      + (registered.length > 0 ? `；登记工件 ${registered.length} 个` : '')
      + (rejected.length > 0 ? `；${rejected.length} 个工件路径被拒绝` : '')
      + '。队长会据此裁决门禁。',
    factoryId,
    role: value.role,
    status: value.memberStatus,
    stage: stageId,
    settledAttempts: value.settled,
    artifactsRegistered: registered,
    artifactRejected: rejected,
    messageId: message.id,
    captainNotified: true,
    nextAction:
      statusRaw === 'done'
        ? '停下等队长裁决门禁；不要自行宣布通过，也不要自行进入下一个阶段。'
        : statusRaw === 'blocked'
          ? '等队长/用户给出判断；不要绕过门禁或扩大工件边界。'
          : '继续当前阶段的工作，完成后用 status=done 再回报一次。',
  }
}
/** Arguments of {@link readMemberInbox}. */
export interface MemberInboxInput {
  readonly factoryId?: string
  readonly limit?: number
  readonly includeRead?: boolean
  readonly markRead?: boolean
}
/** One inbox row. */
export interface InboxRow {
  readonly id: string
  readonly from: string
  readonly content: string
  readonly ts: number
  readonly status: string
  readonly kind?: string
  readonly stage?: string
}
/** Result of {@link readMemberInbox}. */
export interface MemberInboxResult {
  readonly summary: string
  readonly factoryId: string
  readonly role: string
  readonly messages: InboxRow[]
  readonly markedRead: number
  readonly remainingUnread: number
  readonly nextAction: string
}
/** Reads the member's own mailbox and (by default) marks it consumed. */
export async function readMemberInbox(call: ToolCallContext, input: MemberInboxInput): Promise<MemberInboxResult> {
  const resolved = await resolveMemberFactory(call, input.factoryId)
  const factoryId = resolved.state.id
  const role = resolved.role
  const limit = optionalCount(input.limit, 1) ?? 20
  const includeRead = input.includeRead === true

  const consumed = await call.store.consumeMailbox(factoryId, role, {
    read: {
      ...(includeRead ? {} : { unreadOnly: true }),
      limit,
    },
    markRead: input.markRead !== false,
  })
  const messages = consumed.messages
  const markedRead = consumed.markedRead
  const remaining = consumed.remainingUnread

  return {
    summary:
      `${roleTitle(role)} 的收件箱: 返回 ${messages.length} 条${includeRead ? '' : '（未读）'}`
      + (markedRead > 0 ? `，已标记已读 ${markedRead} 条` : '')
      + `，剩余未读 ${remaining} 条。`,
    factoryId,
    role,
    messages: messages.map((message) => ({
      id: message.id,
      from: message.from,
      content: clip(message.content, 1_200),
      ts: message.ts,
      status: mailboxStatus(message),
      ...(message.kind === undefined ? {} : { kind: message.kind }),
      ...(message.stage === undefined ? {} : { stage: message.stage }),
    })),
    markedRead,
    remainingUnread: remaining,
    nextAction:
      messages.length === 0
        ? '没有新指令：继续当前阶段的工件，完成后用 factory_report（status=done）回报。'
        : '按最新一条派发/打回单执行；不确定就 factory_report 说明现状，或 factory_block 上报。',
  }
}
/** Arguments of {@link blockFromMember}. */
export interface MemberBlockInput {
  readonly reason: string
  readonly factoryId?: string
  readonly stage?: string
  readonly need?: string
}
/** Result of {@link blockFromMember}. */
export interface MemberBlockResult {
  readonly summary: string
  readonly factoryId: string
  readonly role: string
  readonly stage: string
  readonly blocked: boolean
  readonly messageId: string
  readonly need?: string
  readonly nextAction: string
}
/** Marks the member blocked and escalates to the captain. */
export async function blockFromMember(call: ToolCallContext, input: MemberBlockInput): Promise<MemberBlockResult> {
  const reason = required(input.reason, 'reason（卡住的具体原因：缺什么、被什么挡住）')
  const resolved = await resolveMemberFactory(call, input.factoryId)
  const factoryId = resolved.state.id
  const requestedStageRaw = optional(input.stage)
  const stageId = requestedStageRaw !== undefined
    ? resolveReportedStage(resolved.state, requestedStageRaw)
    : artifactStageId(resolved.state, resolved.stage)
  const need = optional(input.need)
  // 卡住也要结算用量：成员到这一步烧掉的 token 同样是真数，不该因为这一轮没干完就不计。
  const tokens = await measureMemberTokens(call.plugin, call.callerId)

  const { value } = await mutateFactory(call, factoryId, (state) => {
    const member = state.members.find((candidate) => candidate.sessionId === call.callerId)
    if (member === undefined) {
      throw new FactoryToolError(`code-factory: 会话 ${call.callerId} 已不在工厂 ${factoryId} 的编制里。`)
    }
    if (tokens !== undefined) member.tokens = tokens.total
    transitionMember(member, 'blocked', call.store.now())
    member.currentStage = stageId
    const role = canonicalRoleId(member.role)
    settleAttempts(state, role, stageId, call.store.now())
    return role
  })

  const message = await postMail(call, factoryId, {
    id: randomUUID(),
    from: value,
    to: 'captain',
    content: [
      `【成员阻塞 · ${roleTitle(value)}】阶段 ${stageId}`,
      `原因: ${reason}`,
      need === undefined ? '' : `需要: ${need}`,
    ]
      .filter((line) => line !== '')
      .join('\n'),
    kind: 'blocked',
    stage: stageId,
  })

  return {
    summary: `${roleTitle(value)} 已上报 BLOCKED（阶段 ${stageId}）：${reason}。队长/用户裁决前请停止推进。`,
    factoryId,
    role: value,
    stage: stageId,
    blocked: true,
    messageId: message.id,
    ...(need === undefined ? {} : { need }),
    nextAction: '停下等待队长回复（用 factory_inbox 查收指令）；不要自行绕过门禁、改工件边界或伪造证据。',
  }
}
