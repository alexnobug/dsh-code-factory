/**
 * `member.tokens` —— 成员已烧掉多少 token，从**真实会话日志**里数出来。
 *
 * ## 这个模块要解决的问题
 *
 * `MemberRecord.tokens` 曾经是一个只写 `0` 的字段：`src/store/store.ts` 建成员时写死
 * `tokens: 0`，`src/tools/engine/plumbing.ts` 的 `freshMemberRecords` 也写死 `tokens: 0`，
 * 之后再没有任何一处写过它。于是驾驶舱顶栏那个 `TOKENS` 计数永远是 `0`，而
 * `src/store/state.ts` 的 `totalTokens` 只是把一串假零加了个总和。
 * 评审报告把它记成功能完整性的唯一缺口（"`member.tokens` 永远为 0"）。
 *
 * ## 真数从哪里来
 *
 * 宿主把会话日志暴露成 `ctx.get("sessionQuery")`（可选服务，见 `listService` 契约）。
 * `readSession(sessionId)` 返回**完整**的 `SessionEvent[]`，其中
 * `assistant/message` 事件带 `usage?: TokenUsage`：
 *
 * ```ts
 * 'assistant/message': { turn; step; message; stream; usage?: TokenUsage; interrupted?: true }
 * TokenUsage = { inputTokens; outputTokens; totalTokens?; cacheReadTokens?; cacheWriteTokens?; reasoningTokens? }
 * ```
 *
 * 注意 `listEvents(sessionId)` **不能**用来做这件事：它返回的是轻量记录
 * `SessionEventRecord = { sessionId, seq, type, time, surface }`，**没有 `data`**，所以没有用量。
 * 只有 `readSession` / `observeSession` 才拿得到事件正文。
 *
 * ## 三个刻意的选择
 *
 * 1. **结构化最小面，不 import 宿主类型。** 本模块只依赖 `Context`，服务形状按
 *    `src/runtime/tool-surface.ts` 与 `src/runtime/commands.ts` 已经确立的写法就地声明
 *    （"public API is typed separately"）。宿主把 `readSession` 换个签名不会让这里编译不过，
 *    而是让 `probeTokenSource` 报 `unusable`——和 `probeSubprocessRuntime` 同一种失配语义。
 * 2. **只算本会话自己烧的。** `SessionLogSnapshot.inheritedEventCount` 之前的那些事件是从
 *    父会话继承来的（`assistant/message` 会带 `usage`），把它们算进成员头上等于虚报。
 *    所以前 `inheritedEventCount` 条事件直接跳过。
 * 3. **永不抛。** 读不到就返回 `undefined`，由调用方保留旧值。计量是**统计**，不是门禁：
 *    它不该让 `factory_report` 失败、更不该让一个正在干活的成员因为日志读不出来而被记成 0。
 *
 * ## 代价
 *
 * `readSession` 会重放整条逻辑日志，所以每次调用是 O(事件数)。调用点因此选在
 * **成员回报**这种低频、且成员刚刚烧过 token 的时刻，而不是每次状态读取。驾驶舱看到的
 * 是"最后一次回报时的累计值"，这不是实时数字——它只是**真数字**。
 */

import type { Context } from '@deepseek-ai/cordis'

/** 最小 `TokenUsage` 面。宿主是 `{ inputTokens; outputTokens; totalTokens?; … }`。 */
interface TokenUsageLike {
  readonly inputTokens?: unknown
  readonly outputTokens?: unknown
  readonly totalTokens?: unknown
}

/** 最小 `SessionEvent` 面。只关心 `assistant/message` 的 `usage`。 */
interface SessionEventLike {
  readonly type?: unknown
  readonly data?: { readonly usage?: TokenUsageLike | null } | null
}

/** 最小 `SessionLogSnapshot` 面。 */
interface SessionLogSnapshotLike {
  readonly events?: readonly SessionEventLike[] | null
  readonly inheritedEventCount?: unknown
}

/** 最小 `sessionQuery` 面。 */
interface SessionQueryLike {
  readSession?: (sessionId: string) => Promise<SessionLogSnapshotLike>
}

/**
 * `ctx.get("sessionQuery")` 的探测结论。
 *
 * `available` 之后仍可能读单条会话失败（会话被清理、日志损坏），那种失败由
 * {@link measureMemberTokens} 返回 `undefined` 表达，不是 `unusable`。
 */
export type TokenSourceProbe =
  | { readonly status: 'available' }
  | { readonly status: 'absent'; readonly reason: string }
  | { readonly status: 'unusable'; readonly reason: string }

/** 一次成功计量的结果。 */
export interface TokenReading {
  /** `assistant/message` 事件用量之和；`totalTokens` 缺失时退化为 `input + output`。 */
  readonly total: number
  /** 参与求和的 `assistant/message` 事件条数（带 `usage` 的那些）。 */
  readonly messages: number
  /** 被跳过的继承事件条数，写进日志便于解释数字为什么比"整条会话"小。 */
  readonly inherited: number
}

const ABSENT_REASON = 'ctx.get("sessionQuery") 未返回服务：该组合没有会话日志后端，成员用量无法计量'
const UNUSABLE_REASON = 'sessionQuery 缺少 readSession(sessionId)，不符合服务契约'

/**
 * 解析可选服务 `sessionQuery`，得到一条**可解释**的结论。
 *
 * 与 `probeSubprocessRuntime` 同构：`absent`（服务不在）和 `unusable`（在但形状不对）
 * 是两种不同的失败，分开报是为了让 `factory_status` 能说清"到底缺什么"。
 */
export function probeTokenSource(ctx: Context | undefined): TokenSourceProbe {
  if (ctx === undefined) return { status: 'absent', reason: '没有插件上下文，无法解析 sessionQuery' }
  let carrier: unknown
  try {
    carrier = ctx.get('sessionQuery')
  } catch (error) {
    return { status: 'absent', reason: `ctx.get("sessionQuery") 抛出：${error instanceof Error ? error.message : String(error)}` }
  }
  if (carrier === undefined || carrier === null) return { status: 'absent', reason: ABSENT_REASON }
  const query = carrier as SessionQueryLike
  if (typeof query.readSession !== 'function') return { status: 'unusable', reason: UNUSABLE_REASON }
  return { status: 'available' }
}

/**
 * 把一条 `usage` 折算成 token 数。
 *
 * `totalTokens` 是宿主给的聚合值，优先用它；它缺失时用 `inputTokens + outputTokens`
 * （刻意**不含** `cacheReadTokens` / `cacheWriteTokens` / `reasoningTokens`：缓存读写在
 * 不同 provider 下是否已计入 input 并不一致，与其猜，不如只用两个确定非负的字段）。
 * 任何非有限值都按 `0` 处理——宁可少算，不可算出 `NaN` 再污染整个总和。
 */
function usageOf(usage: TokenUsageLike | null | undefined): number | undefined {
  if (usage === null || usage === undefined) return undefined
  const total = finiteOrUndefined(usage.totalTokens)
  if (total !== undefined) return total
  const input = finiteOrUndefined(usage.inputTokens)
  const output = finiteOrUndefined(usage.outputTokens)
  if (input === undefined && output === undefined) return undefined
  return (input ?? 0) + (output ?? 0)
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * 数出某个**会话**累计烧掉的 token。
 *
 * @param ctx 插件上下文；`undefined` 或没有 `sessionQuery` 时返回 `undefined`。
 * @param sessionId 成员会话 id（工厂里就是 `MemberRecord.sessionId`）。
 * @returns 计量结果；服务缺失、会话读不出来、或一个带用量的 `assistant/message` 都没有时返回 `undefined`。
 *
 * @remarks
 * 一次都没有用量的会话返回 `undefined` 而不是 `0`：这两者含义不同——`0` 是"量过了，确实没烧"，
 * `undefined` 是"没量到"。调用方据此决定是覆盖旧值还是保留旧值。
 */
export async function measureMemberTokens(
  ctx: Context | undefined,
  sessionId: string | undefined,
): Promise<TokenReading | undefined> {
  if (sessionId === undefined || sessionId === '') return undefined
  if (probeTokenSource(ctx).status !== 'available') return undefined
  const query = (ctx as Context).get('sessionQuery') as SessionQueryLike

  let snapshot: SessionLogSnapshotLike
  try {
    snapshot = await (query.readSession as (id: string) => Promise<SessionLogSnapshotLike>)(sessionId)
  } catch {
    // 会话可能已经被清理、日志可能校验不过。计量失败不影响工厂语义。
    return undefined
  }

  const events = Array.isArray(snapshot?.events) ? snapshot.events : undefined
  if (events === undefined) return undefined
  const inheritedRaw = finiteOrUndefined(snapshot?.inheritedEventCount)
  const inherited = inheritedRaw === undefined ? 0 : Math.min(Math.trunc(inheritedRaw), events.length)

  let total = 0
  let messages = 0
  for (let index = inherited; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const amount = usageOf(event.data?.usage)
    if (amount === undefined) continue
    total += amount
    messages += 1
  }
  if (messages === 0) return undefined
  return { total, messages, inherited }
}
